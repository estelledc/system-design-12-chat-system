import {
  AppError,
  AuthenticationError,
  DependencyError,
  NotFoundError,
  RequestConflictError,
  ValidationError,
} from './errors.js';
import { MESSAGE_NOTIFICATION_CHANNEL, SCHEMA_SQL } from './schema.js';

function dependencyFailure(error) {
  if (error instanceof AppError) return error;
  return new DependencyError('PostgreSQL operation failed', error);
}

function mapConversation(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    ownerId: row.owner_id,
    idempotencyKey: row.idempotency_key,
    requestDigest: row.request_digest,
    maxMembers: row.max_members,
    lastSequence: Number(row.last_sequence),
    createdAtMs: Number(row.created_at_ms),
    memberCount: row.member_count === undefined ? undefined : Number(row.member_count),
  };
}

function mapMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    conversationId: row.conversation_id,
    sequence: Number(row.sequence),
    senderId: row.sender_id,
    senderMembershipGeneration: Number(row.sender_membership_generation),
    clientMessageId: row.client_message_id,
    requestDigest: row.request_digest,
    content: row.content,
    acceptedAtMs: Number(row.accepted_at_ms),
  };
}

const conversationProjection = `conversation.*,
  (SELECT count(*)::integer FROM conversation_memberships AS membership
   WHERE membership.conversation_id = conversation.id
     AND membership.leave_after_sequence IS NULL) AS member_count`;

export class PostgresChatStore {
  constructor(pool) {
    this.pool = pool;
  }

  async migrate() {
    try {
      await this.pool.query(SCHEMA_SQL);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async ping() {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async ensureUsers(userIds, nowMs) {
    const ids = [...new Set(userIds)];
    try {
      await this.pool.query(
        `INSERT INTO users (id, created_at_ms)
         SELECT user_id, $2 FROM unnest($1::text[]) AS input(user_id)
         ON CONFLICT (id) DO NOTHING`,
        [ids, nowMs],
      );
      return ids.length;
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async createConversation(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        `SELECT ${conversationProjection}
         FROM conversations AS conversation
         WHERE owner_id = $1 AND idempotency_key = $2`,
        [input.ownerId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        const result = this.#classifyConversation(existing.rows[0], input.requestDigest);
        await client.query('COMMIT');
        return result;
      }
      const users = await client.query(
        `SELECT id FROM users WHERE id = ANY($1::text[]) AND status = 'active'`,
        [input.memberIds],
      );
      if (users.rowCount !== input.memberIds.length) throw new NotFoundError();
      await client.query(
        `INSERT INTO conversations (
           id, kind, owner_id, idempotency_key, request_digest, max_members, created_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          input.id,
          input.kind,
          input.ownerId,
          input.idempotencyKey,
          input.requestDigest,
          input.maxMembers,
          input.createdAtMs,
        ],
      );
      for (const userId of input.memberIds) {
        await client.query(
          `INSERT INTO conversation_memberships (
             conversation_id, user_id, generation, role, join_after_sequence, joined_at_ms
           ) VALUES ($1, $2, 1, $3, 0, $4)`,
          [input.id, userId, userId === input.ownerId ? 'owner' : 'member', input.createdAtMs],
        );
      }
      await client.query('COMMIT');
      return {
        created: true,
        conversation: {
          id: input.id,
          kind: input.kind,
          ownerId: input.ownerId,
          idempotencyKey: input.idempotencyKey,
          requestDigest: input.requestDigest,
          maxMembers: input.maxMembers,
          lastSequence: 0,
          createdAtMs: input.createdAtMs,
          memberCount: input.memberIds.length,
        },
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505' && error?.constraint === 'conversations_owner_key_uniq') {
        return this.#conversationAfterRace(input);
      }
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async addMember({ conversationId, actorId, userId, nowMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const conversation = await client.query(
        'SELECT kind, owner_id, max_members, last_sequence FROM conversations WHERE id = $1 FOR UPDATE',
        [conversationId],
      );
      const row = conversation.rows[0];
      if (!row || row.owner_id !== actorId) throw new NotFoundError();
      if (row.kind !== 'group') throw new ValidationError('direct conversation membership is immutable');
      const user = await client.query("SELECT id FROM users WHERE id = $1 AND status = 'active'", [userId]);
      if (!user.rows[0]) throw new NotFoundError();
      const active = await client.query(
        `SELECT generation, join_after_sequence FROM conversation_memberships
         WHERE conversation_id = $1 AND user_id = $2 AND leave_after_sequence IS NULL`,
        [conversationId, userId],
      );
      if (active.rows[0]) {
        await client.query('COMMIT');
        return {
          active: true,
          changed: false,
          generation: Number(active.rows[0].generation),
          joinAfterSequence: Number(active.rows[0].join_after_sequence),
        };
      }
      const count = await client.query(
        `SELECT count(*)::integer AS count FROM conversation_memberships
         WHERE conversation_id = $1 AND leave_after_sequence IS NULL`,
        [conversationId],
      );
      if (count.rows[0].count >= row.max_members) throw new ValidationError('conversation member limit reached');
      const generation = await client.query(
        `SELECT COALESCE(max(generation), 0)::bigint + 1 AS generation
         FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2`,
        [conversationId, userId],
      );
      await client.query(
        `INSERT INTO conversation_memberships (
           conversation_id, user_id, generation, role, join_after_sequence, joined_at_ms
         ) VALUES ($1, $2, $3, 'member', $4, $5)`,
        [conversationId, userId, generation.rows[0].generation, row.last_sequence, nowMs],
      );
      await client.query('COMMIT');
      return {
        active: true,
        changed: true,
        generation: Number(generation.rows[0].generation),
        joinAfterSequence: Number(row.last_sequence),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async leaveConversation({ conversationId, userId, nowMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const conversation = await client.query(
        'SELECT owner_id, last_sequence FROM conversations WHERE id = $1 FOR UPDATE',
        [conversationId],
      );
      const row = conversation.rows[0];
      if (!row) throw new NotFoundError();
      const latest = await client.query(
        `SELECT generation, leave_after_sequence FROM conversation_memberships
         WHERE conversation_id = $1 AND user_id = $2 ORDER BY generation DESC LIMIT 1`,
        [conversationId, userId],
      );
      if (!latest.rows[0]) throw new NotFoundError();
      if (row.owner_id === userId) throw new ValidationError('conversation owner cannot leave in v0.1');
      if (latest.rows[0].leave_after_sequence !== null) {
        await client.query('COMMIT');
        return {
          active: false,
          changed: false,
          generation: Number(latest.rows[0].generation),
          leaveAfterSequence: Number(latest.rows[0].leave_after_sequence),
        };
      }
      const updated = await client.query(
        `UPDATE conversation_memberships
         SET leave_after_sequence = $4, left_at_ms = $5
         WHERE conversation_id = $1 AND user_id = $2 AND generation = $3
           AND leave_after_sequence IS NULL`,
        [conversationId, userId, latest.rows[0].generation, row.last_sequence, nowMs],
      );
      if (updated.rowCount !== 1) throw new DependencyError('Current membership generation was not writable');
      await client.query('COMMIT');
      return {
        active: false,
        changed: true,
        generation: Number(latest.rows[0].generation),
        leaveAfterSequence: Number(row.last_sequence),
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async acceptMessage(input) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const conversation = await client.query(
        'SELECT last_sequence FROM conversations WHERE id = $1 FOR UPDATE',
        [input.conversationId],
      );
      if (!conversation.rows[0]) throw new NotFoundError();
      const existing = await client.query(
        'SELECT * FROM messages WHERE sender_id = $1 AND client_message_id = $2',
        [input.senderId, input.clientMessageId],
      );
      if (existing.rows[0]) {
        const result = this.#classifyMessage(existing.rows[0], input.requestDigest);
        await client.query('COMMIT');
        return result;
      }
      const membership = await client.query(
        `SELECT generation FROM conversation_memberships
         WHERE conversation_id = $1 AND user_id = $2 AND leave_after_sequence IS NULL`,
        [input.conversationId, input.senderId],
      );
      if (!membership.rows[0]) throw new NotFoundError();
      const sequence = Number(conversation.rows[0].last_sequence) + 1;
      const advanced = await client.query(
        'UPDATE conversations SET last_sequence = $2 WHERE id = $1',
        [input.conversationId, sequence],
      );
      if (advanced.rowCount !== 1) throw new DependencyError('Conversation sequence was not writable');
      const inserted = await client.query(
        `INSERT INTO messages (
           id, conversation_id, sequence, sender_id, sender_membership_generation,
           client_message_id, request_digest, content, accepted_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          input.id,
          input.conversationId,
          sequence,
          input.senderId,
          membership.rows[0].generation,
          input.clientMessageId,
          input.requestDigest,
          input.content,
          input.acceptedAtMs,
        ],
      );
      await client.query('SELECT pg_notify($1, $2)', [MESSAGE_NOTIFICATION_CHANNEL, input.id]);
      await client.query('COMMIT');
      return { created: true, message: mapMessage(inserted.rows[0]) };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (error?.code === '23505' && error?.constraint === 'messages_sender_client_uniq') {
        return this.#messageAfterRace(input);
      }
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async syncMessages({ conversationId, userId, afterSequence, limit }) {
    try {
      const membership = await this.pool.query(
        'SELECT 1 FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2 LIMIT 1',
        [conversationId, userId],
      );
      if (!membership.rows[0]) throw new NotFoundError();
      const messages = await this.pool.query(
        `SELECT message.* FROM messages AS message
         WHERE message.conversation_id = $1
           AND message.sequence > $2
           AND EXISTS (
             SELECT 1 FROM conversation_memberships AS membership
             WHERE membership.conversation_id = message.conversation_id
               AND membership.user_id = $3
               AND membership.join_after_sequence < message.sequence
               AND (
                 membership.leave_after_sequence IS NULL
                 OR message.sequence <= membership.leave_after_sequence
               )
           )
         ORDER BY message.sequence
         LIMIT $4`,
        [conversationId, afterSequence, userId, limit + 1],
      );
      const hasMore = messages.rows.length > limit;
      const page = messages.rows.slice(0, limit).map(mapMessage);
      return {
        messages: page,
        nextAfterSequence: hasMore ? page.at(-1).sequence : null,
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async issueRealtimeTicket({ userId, deviceId, ticketHash, nowMs, expiresAtMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const user = await client.query("SELECT id FROM users WHERE id = $1 AND status = 'active'", [userId]);
      if (!user.rows[0]) throw new NotFoundError();
      await client.query(
        `INSERT INTO devices (user_id, device_id, created_at_ms)
         VALUES ($1, $2, $3) ON CONFLICT (user_id, device_id) DO NOTHING`,
        [userId, deviceId, nowMs],
      );
      const device = await client.query(
        "SELECT status FROM devices WHERE user_id = $1 AND device_id = $2",
        [userId, deviceId],
      );
      if (device.rows[0]?.status !== 'active') throw new NotFoundError();
      const inserted = await client.query(
        `INSERT INTO realtime_tickets (
           ticket_hash, user_id, device_id, created_at_ms, expires_at_ms
         ) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (ticket_hash) DO NOTHING`,
        [ticketHash, userId, deviceId, nowMs, expiresAtMs],
      );
      await client.query('COMMIT');
      return { created: inserted.rowCount === 1 };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async consumeRealtimeTicket({ ticketHash, nowMs }) {
    try {
      const result = await this.pool.query(
        `UPDATE realtime_tickets AS ticket
         SET consumed_at_ms = $2
         FROM devices AS device, users AS app_user
         WHERE ticket.ticket_hash = $1
           AND ticket.consumed_at_ms IS NULL
           AND ticket.expires_at_ms > $2
           AND device.user_id = ticket.user_id
           AND device.device_id = ticket.device_id
           AND device.status = 'active'
           AND app_user.id = ticket.user_id
           AND app_user.status = 'active'
         RETURNING ticket.user_id, ticket.device_id`,
        [ticketHash, nowMs],
      );
      if (!result.rows[0]) throw new AuthenticationError();
      return { userId: result.rows[0].user_id, deviceId: result.rows[0].device_id };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async updateProgress({ userId, deviceId, conversationId, syncedThrough, readClaimedThrough, nowMs }) {
    const client = await this.#connect();
    try {
      await client.query('BEGIN');
      const conversation = await client.query(
        'SELECT last_sequence FROM conversations WHERE id = $1 FOR UPDATE',
        [conversationId],
      );
      if (!conversation.rows[0]) throw new NotFoundError();
      const device = await client.query(
        `SELECT 1 FROM devices WHERE user_id = $1 AND device_id = $2 AND status = 'active'`,
        [userId, deviceId],
      );
      const membership = await client.query(
        'SELECT 1 FROM conversation_memberships WHERE conversation_id = $1 AND user_id = $2 LIMIT 1',
        [conversationId, userId],
      );
      if (!device.rows[0] || !membership.rows[0]) throw new NotFoundError();
      const lastSequence = Number(conversation.rows[0].last_sequence);
      if (syncedThrough > lastSequence || readClaimedThrough > lastSequence) {
        throw new ValidationError('progress cannot exceed the committed conversation sequence');
      }
      for (const sequence of new Set([syncedThrough, readClaimedThrough])) {
        if (sequence === 0) continue;
        const visible = await client.query(
          `SELECT 1 FROM messages AS message
           WHERE message.conversation_id = $1 AND message.sequence = $2
             AND EXISTS (
               SELECT 1 FROM conversation_memberships AS relation
               WHERE relation.conversation_id = message.conversation_id
                 AND relation.user_id = $3
                 AND relation.join_after_sequence < message.sequence
                 AND (
                   relation.leave_after_sequence IS NULL
                   OR message.sequence <= relation.leave_after_sequence
                 )
             )`,
          [conversationId, sequence, userId],
        );
        if (!visible.rows[0]) throw new ValidationError('progress target is outside membership visibility');
      }
      const previous = await client.query(
        `SELECT synced_through, read_claimed_through FROM device_progress
         WHERE user_id = $1 AND device_id = $2 AND conversation_id = $3 FOR UPDATE`,
        [userId, deviceId, conversationId],
      );
      const oldSynced = Number(previous.rows[0]?.synced_through ?? 0);
      const oldRead = Number(previous.rows[0]?.read_claimed_through ?? 0);
      const nextSynced = Math.max(oldSynced, syncedThrough);
      const nextRead = Math.max(oldRead, readClaimedThrough);
      await client.query(
        `INSERT INTO device_progress (
           user_id, device_id, conversation_id, synced_through, read_claimed_through, updated_at_ms
         ) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, device_id, conversation_id) DO UPDATE
         SET synced_through = EXCLUDED.synced_through,
             read_claimed_through = EXCLUDED.read_claimed_through,
             updated_at_ms = EXCLUDED.updated_at_ms`,
        [userId, deviceId, conversationId, nextSynced, nextRead, nowMs],
      );
      await client.query('COMMIT');
      return {
        changed: nextSynced !== oldSynced || nextRead !== oldRead,
        syncedThrough: nextSynced,
        readClaimedThrough: nextRead,
        evidence: 'client_claim_accepted',
      };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw dependencyFailure(error);
    } finally {
      client.release();
    }
  }

  async realtimeEnvelope(messageId) {
    try {
      const message = await this.pool.query('SELECT * FROM messages WHERE id = $1', [messageId]);
      if (!message.rows[0]) return null;
      const mapped = mapMessage(message.rows[0]);
      const recipients = await this.pool.query(
        `SELECT user_id FROM conversation_memberships
         WHERE conversation_id = $1
           AND leave_after_sequence IS NULL
           AND join_after_sequence < $2
         ORDER BY user_id`,
        [mapped.conversationId, mapped.sequence],
      );
      return { message: mapped, recipientIds: recipients.rows.map((row) => row.user_id) };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async listenForMessages({ onMessage, onError = () => {} }) {
    const client = await this.#connect();
    let closed = false;
    let notificationChain = Promise.resolve();
    const notification = (event) => {
      if (event.channel !== MESSAGE_NOTIFICATION_CHANNEL || typeof event.payload !== 'string') return;
      notificationChain = notificationChain
        .then(() => onMessage(event.payload))
        .catch((error) => onError(error));
    };
    const clientError = (error) => {
      if (closed) return;
      closed = true;
      client.removeListener('notification', notification);
      client.removeListener('error', clientError);
      client.release(error);
      onError(dependencyFailure(error));
    };
    client.on('notification', notification);
    client.on('error', clientError);
    try {
      await client.query(`LISTEN ${MESSAGE_NOTIFICATION_CHANNEL}`);
    } catch (error) {
      client.removeListener('notification', notification);
      client.removeListener('error', clientError);
      client.release();
      throw dependencyFailure(error);
    }
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        client.removeListener('notification', notification);
        client.removeListener('error', clientError);
        await notificationChain;
        await client.query(`UNLISTEN ${MESSAGE_NOTIFICATION_CHANNEL}`).catch(() => {});
        client.release();
      },
    };
  }

  async stats() {
    try {
      const [conversations, messages, tickets, sockets, progress] = await Promise.all([
        this.pool.query('SELECT count(*)::integer AS count FROM conversations'),
        this.pool.query('SELECT count(*)::integer AS count FROM messages'),
        this.pool.query(`SELECT
          count(*) FILTER (WHERE consumed_at_ms IS NULL)::integer AS unused,
          count(*) FILTER (WHERE consumed_at_ms IS NOT NULL)::integer AS consumed
          FROM realtime_tickets`),
        this.pool.query('SELECT count(*)::integer AS count FROM conversation_memberships WHERE leave_after_sequence IS NULL'),
        this.pool.query('SELECT count(*)::integer AS count FROM device_progress'),
      ]);
      return {
        conversations: conversations.rows[0].count,
        messages: messages.rows[0].count,
        tickets: tickets.rows[0],
        activeMemberships: sockets.rows[0].count,
        deviceProgressRows: progress.rows[0].count,
      };
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async close() {
    await this.pool.end();
  }

  #classifyConversation(row, requestDigest) {
    if (row.request_digest !== requestDigest) throw new RequestConflictError();
    return { created: false, conversation: mapConversation(row) };
  }

  #classifyMessage(row, requestDigest) {
    if (row.request_digest !== requestDigest) throw new RequestConflictError();
    return { created: false, message: mapMessage(row) };
  }

  async #conversationAfterRace(input) {
    try {
      const result = await this.pool.query(
        `SELECT ${conversationProjection}
         FROM conversations AS conversation
         WHERE owner_id = $1 AND idempotency_key = $2`,
        [input.ownerId, input.idempotencyKey],
      );
      if (!result.rows[0]) throw new DependencyError('Conversation conflict was not readable');
      return this.#classifyConversation(result.rows[0], input.requestDigest);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async #messageAfterRace(input) {
    try {
      const result = await this.pool.query(
        'SELECT * FROM messages WHERE sender_id = $1 AND client_message_id = $2',
        [input.senderId, input.clientMessageId],
      );
      if (!result.rows[0]) throw new DependencyError('Message conflict was not readable');
      return this.#classifyMessage(result.rows[0], input.requestDigest);
    } catch (error) {
      throw dependencyFailure(error);
    }
  }

  async #connect() {
    try {
      return await this.pool.connect();
    } catch (error) {
      throw dependencyFailure(error);
    }
  }
}

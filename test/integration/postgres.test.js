import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import test, { after, beforeEach } from 'node:test';
import { Pool } from 'pg';
import { ChatService } from '../../src/chat-service.js';
import { AuthenticationError, RequestConflictError, ValidationError } from '../../src/errors.js';
import { PostgresChatStore } from '../../src/postgres-store.js';
import { MESSAGE_NOTIFICATION_CHANNEL } from '../../src/schema.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for PostgreSQL integration tests');

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 24 });
const store = new PostgresChatStore(pool);
const users = ['user-a', 'user-b', 'user-c', 'user-d'];

beforeEach(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await store.migrate();
  await store.ensureUsers(users, 1_700_000_000_000);
});

after(async () => {
  await pool.end();
});

async function createGroup(service, suffix = '0001', memberIds = ['user-b']) {
  return service.createConversation({
    ownerId: 'user-a',
    idempotencyKey: `conversation-key-${suffix}`,
    request: { kind: 'group', memberIds },
  });
}

test('concurrent acceptance assigns one contiguous per-conversation order', async () => {
  const service = new ChatService({ store });
  const { conversation } = await createGroup(service);
  const sends = Array.from({ length: 24 }, (_, index) => service.sendMessage({
    senderId: index % 2 === 0 ? 'user-a' : 'user-b',
    conversationId: conversation.id,
    clientMessageId: `client-message-${String(index).padStart(4, '0')}`,
    request: { content: `message-${index}` },
  }));
  const accepted = await Promise.all(sends);
  assert.ok(accepted.every((result) => result.created && result.evidence === 'accepted'));
  const sync = await service.syncMessages({
    userId: 'user-b',
    conversationId: conversation.id,
    afterSequence: 0,
    limit: 100,
  });
  assert.deepEqual(sync.messages.map((message) => message.sequence), Array.from({ length: 24 }, (_, index) => index + 1));
  assert.equal(new Set(sync.messages.map((message) => message.id)).size, 24);
});

test('message and conversation retries return one result or an explicit conflict', async () => {
  const service = new ChatService({ store });
  const first = await createGroup(service, 'retry', ['user-c', 'user-b']);
  const replay = await service.createConversation({
    ownerId: 'user-a',
    idempotencyKey: 'conversation-key-retry',
    request: { kind: 'group', memberIds: ['user-b', 'user-c'] },
  });
  assert.equal(replay.created, false);
  assert.equal(replay.conversation.id, first.conversation.id);
  await assert.rejects(
    service.createConversation({
      ownerId: 'user-a',
      idempotencyKey: 'conversation-key-retry',
      request: { kind: 'direct', memberIds: ['user-b'] },
    }),
    RequestConflictError,
  );

  const input = {
    senderId: 'user-a',
    conversationId: first.conversation.id,
    clientMessageId: 'same-client-message-0001',
    request: { content: 'same-content' },
  };
  const raced = await Promise.all([service.sendMessage(input), service.sendMessage(input)]);
  assert.equal(raced.filter((result) => result.created).length, 1);
  assert.equal(new Set(raced.map((result) => result.message.id)).size, 1);
  await assert.rejects(
    service.sendMessage({ ...input, request: { content: 'different-content' } }),
    RequestConflictError,
  );
});

test('membership generations define exact history visibility across leave and rejoin', async () => {
  let nowMs = 10_000;
  const service = new ChatService({ store, clock: () => nowMs++ });
  const { conversation } = await createGroup(service);
  const first = await service.sendMessage({
    senderId: 'user-a',
    conversationId: conversation.id,
    clientMessageId: 'history-message-0001',
    request: { content: 'visible-before-leave' },
  });
  const leave = await service.leaveConversation({ userId: 'user-b', conversationId: conversation.id });
  assert.equal(leave.leaveAfterSequence, first.message.sequence);
  await service.sendMessage({
    senderId: 'user-a',
    conversationId: conversation.id,
    clientMessageId: 'history-message-0002',
    request: { content: 'hidden-while-away' },
  });
  await assert.rejects(
    service.sendMessage({
      senderId: 'user-b',
      conversationId: conversation.id,
      clientMessageId: 'history-message-0003',
      request: { content: 'cannot-send-while-away' },
    }),
    (error) => error.code === 'not_found',
  );
  const rejoin = await service.addMember({
    actorId: 'user-a',
    conversationId: conversation.id,
    userId: 'user-b',
  });
  assert.equal(rejoin.generation, 2);
  assert.equal(rejoin.joinAfterSequence, 2);
  await service.sendMessage({
    senderId: 'user-b',
    conversationId: conversation.id,
    clientMessageId: 'history-message-0004',
    request: { content: 'visible-after-rejoin' },
  });
  const sync = await service.syncMessages({
    userId: 'user-b',
    conversationId: conversation.id,
    afterSequence: 0,
    limit: 100,
  });
  assert.deepEqual(sync.messages.map((message) => message.sequence), [1, 3]);
  await assert.rejects(
    service.leaveConversation({ userId: 'user-a', conversationId: conversation.id }),
    ValidationError,
  );
});

test('NOTIFY becomes observable after commit and disappears on rollback', async () => {
  const received = [];
  let resolveCommitted;
  let rejectCommitted;
  const committed = new Promise((resolve, reject) => {
    resolveCommitted = resolve;
    rejectCommitted = reject;
  });
  const listener = await store.listenForMessages({
    onMessage: (messageId) => {
      received.push(messageId);
      resolveCommitted(messageId);
    },
    onError: rejectCommitted,
  });
  try {
    const service = new ChatService({ store });
    const { conversation } = await createGroup(service);
    const accepted = await service.sendMessage({
      senderId: 'user-a',
      conversationId: conversation.id,
      clientMessageId: 'notification-message-0001',
      request: { content: 'committed' },
    });
    assert.equal(await Promise.race([
      committed,
      delay(2_000).then(() => { throw new Error('timed out waiting for committed notification'); }),
    ]), accepted.message.id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_notify($1, $2)', [MESSAGE_NOTIFICATION_CHANNEL, 'rolled-back']);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await delay(100);
    assert.deepEqual(received, [accepted.message.id]);
  } finally {
    await listener.close();
  }
});

test('realtime tickets are hashed, expiring, and consumable once', async () => {
  let nowMs = 20_000;
  const rawTicket = 'T'.repeat(43);
  const service = new ChatService({
    store,
    clock: () => nowMs,
    ticketGenerator: () => rawTicket,
    ticketTtlMs: 1_000,
  });
  const issued = await service.issueRealtimeTicket({ userId: 'user-b', request: { deviceId: 'device-b' } });
  assert.equal(issued.ticket, rawTicket);
  const stored = await pool.query('SELECT ticket_hash FROM realtime_tickets');
  assert.notEqual(stored.rows[0].ticket_hash, rawTicket);
  assert.equal((await service.consumeRealtimeTicket(rawTicket)).deviceId, 'device-b');
  await assert.rejects(service.consumeRealtimeTicket(rawTicket), AuthenticationError);

  const expiringTicket = 'E'.repeat(43);
  const expiring = new ChatService({
    store,
    clock: () => nowMs,
    ticketGenerator: () => expiringTicket,
    ticketTtlMs: 1_000,
  });
  await expiring.issueRealtimeTicket({ userId: 'user-b', request: { deviceId: 'device-b' } });
  nowMs += 1_000;
  await assert.rejects(expiring.consumeRealtimeTicket(expiringTicket), AuthenticationError);
});

test('per-device progress is monotonic and cannot claim invisible messages', async () => {
  let nowMs = 30_000;
  const service = new ChatService({
    store,
    clock: () => nowMs++,
    ticketGenerator: () => 'P'.repeat(43),
  });
  const { conversation } = await createGroup(service);
  await service.issueRealtimeTicket({ userId: 'user-b', request: { deviceId: 'device-b' } });
  await service.sendMessage({
    senderId: 'user-a',
    conversationId: conversation.id,
    clientMessageId: 'progress-message-0001',
    request: { content: 'visible' },
  });
  await service.leaveConversation({ userId: 'user-b', conversationId: conversation.id });
  await service.sendMessage({
    senderId: 'user-a',
    conversationId: conversation.id,
    clientMessageId: 'progress-message-0002',
    request: { content: 'not-visible' },
  });
  const advanced = await service.updateProgress({
    userId: 'user-b',
    conversationId: conversation.id,
    request: { deviceId: 'device-b', syncedThrough: 1, readClaimedThrough: 1 },
  });
  assert.equal(advanced.changed, true);
  assert.equal(advanced.evidence, 'client_claim_accepted');
  const replay = await service.updateProgress({
    userId: 'user-b',
    conversationId: conversation.id,
    request: { deviceId: 'device-b', syncedThrough: 0, readClaimedThrough: 0 },
  });
  assert.equal(replay.changed, false);
  assert.equal(replay.syncedThrough, 1);
  assert.equal(replay.readClaimedThrough, 1);
  await assert.rejects(
    service.updateProgress({
      userId: 'user-b',
      conversationId: conversation.id,
      request: { deviceId: 'device-b', syncedThrough: 2, readClaimedThrough: 1 },
    }),
    ValidationError,
  );
});

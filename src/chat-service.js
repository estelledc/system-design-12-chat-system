import { randomBytes, randomUUID } from 'node:crypto';
import { canonicalJson, sha256 } from './canonical.js';
import {
  normalizeAfterSequence,
  normalizeConversationRequest,
  normalizeDeviceId,
  normalizeIdempotencyKey,
  normalizeMessageRequest,
  normalizePageLimit,
  normalizeProgressRequest,
  normalizeRealtimeTicket,
  normalizeTicketRequest,
  normalizeUserId,
  normalizeUuid,
  safeInteger,
} from './contracts.js';
import { DependencyError } from './errors.js';

function publicConversation(conversation) {
  return {
    id: conversation.id,
    kind: conversation.kind,
    ownerId: conversation.ownerId,
    maxMembers: conversation.maxMembers,
    memberCount: conversation.memberCount,
    lastSequence: conversation.lastSequence,
    createdAtMs: conversation.createdAtMs,
  };
}

export function publicMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    sequence: message.sequence,
    senderId: message.senderId,
    content: message.content,
    acceptedAtMs: message.acceptedAtMs,
  };
}

export class ChatService {
  constructor({
    store,
    clock = Date.now,
    uuid = randomUUID,
    ticketGenerator = () => randomBytes(32).toString('base64url'),
    ticketTtlMs = 60_000,
  }) {
    this.store = store;
    this.clock = clock;
    this.uuid = uuid;
    this.ticketGenerator = ticketGenerator;
    this.ticketTtlMs = safeInteger(ticketTtlMs, 'ticket TTL', { min: 1_000, max: 300_000 });
  }

  async createConversation({ ownerId, idempotencyKey, request }) {
    const normalizedOwner = normalizeUserId(ownerId);
    const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
    const normalized = normalizeConversationRequest(request, normalizedOwner);
    const members = [normalizedOwner, ...normalized.memberIds].sort();
    const result = await this.store.createConversation({
      id: normalizeUuid(this.uuid(), 'generated conversation ID'),
      ownerId: normalizedOwner,
      idempotencyKey: normalizedKey,
      requestDigest: sha256(canonicalJson(normalized)),
      kind: normalized.kind,
      memberIds: members,
      maxMembers: normalized.kind === 'direct' ? 2 : 20,
      createdAtMs: this.#now(),
    });
    return { created: result.created, conversation: publicConversation(result.conversation) };
  }

  async addMember({ actorId, conversationId, userId }) {
    return this.store.addMember({
      actorId: normalizeUserId(actorId),
      conversationId: normalizeUuid(conversationId, 'conversationId'),
      userId: normalizeUserId(userId),
      nowMs: this.#now(),
    });
  }

  async leaveConversation({ userId, conversationId }) {
    return this.store.leaveConversation({
      userId: normalizeUserId(userId),
      conversationId: normalizeUuid(conversationId, 'conversationId'),
      nowMs: this.#now(),
    });
  }

  async sendMessage({ senderId, conversationId, clientMessageId, request }) {
    const normalizedSender = normalizeUserId(senderId);
    const normalizedConversation = normalizeUuid(conversationId, 'conversationId');
    const normalizedClientId = normalizeIdempotencyKey(clientMessageId, 'client message ID');
    const normalized = normalizeMessageRequest(request);
    const result = await this.store.acceptMessage({
      id: normalizeUuid(this.uuid(), 'generated message ID'),
      conversationId: normalizedConversation,
      senderId: normalizedSender,
      clientMessageId: normalizedClientId,
      requestDigest: sha256(canonicalJson({ conversationId: normalizedConversation, ...normalized })),
      content: normalized.content,
      acceptedAtMs: this.#now(),
    });
    return { created: result.created, message: publicMessage(result.message), evidence: 'accepted' };
  }

  async syncMessages({ userId, conversationId, afterSequence, limit }) {
    const result = await this.store.syncMessages({
      userId: normalizeUserId(userId),
      conversationId: normalizeUuid(conversationId, 'conversationId'),
      afterSequence: normalizeAfterSequence(afterSequence),
      limit: normalizePageLimit(limit),
    });
    return {
      messages: result.messages.map(publicMessage),
      nextAfterSequence: result.nextAfterSequence,
      evidence: 'server_sync_response',
    };
  }

  async issueRealtimeTicket({ userId, request }) {
    const normalizedUser = normalizeUserId(userId);
    const { deviceId } = normalizeTicketRequest(request);
    const nowMs = this.#now();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const ticket = normalizeRealtimeTicket(this.ticketGenerator());
      const result = await this.store.issueRealtimeTicket({
        userId: normalizedUser,
        deviceId,
        ticketHash: sha256(ticket),
        nowMs,
        expiresAtMs: nowMs + this.ticketTtlMs,
      });
      if (result.created) return { ticket, expiresAtMs: nowMs + this.ticketTtlMs, deviceId };
    }
    throw new DependencyError('Realtime ticket collision budget exhausted');
  }

  async consumeRealtimeTicket(ticket) {
    const normalized = normalizeRealtimeTicket(ticket);
    return this.store.consumeRealtimeTicket({ ticketHash: sha256(normalized), nowMs: this.#now() });
  }

  async updateProgress({ userId, conversationId, request }) {
    const normalized = normalizeProgressRequest(request);
    return this.store.updateProgress({
      userId: normalizeUserId(userId),
      conversationId: normalizeUuid(conversationId, 'conversationId'),
      ...normalized,
      nowMs: this.#now(),
    });
  }

  normalizeDeviceId(value) {
    return normalizeDeviceId(value);
  }

  #now() {
    return safeInteger(this.clock(), 'clock', { min: 0 });
  }
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../../src/canonical.js';
import { ChatService } from '../../src/chat-service.js';
import { DependencyError } from '../../src/errors.js';

const conversationId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';

test('service binds conversation idempotency to normalized input and strips internal fields', async () => {
  let captured;
  const service = new ChatService({
    store: {
      async createConversation(input) {
        captured = input;
        return { created: true, conversation: { ...input, lastSequence: 0, memberCount: input.memberIds.length } };
      },
    },
    clock: () => 1_700_000_000_000,
    uuid: () => conversationId,
  });
  const result = await service.createConversation({
    ownerId: 'user-a',
    idempotencyKey: 'conversation-key-0001',
    request: { kind: 'group', memberIds: ['user-c', 'user-b'] },
  });
  assert.deepEqual(captured.memberIds, ['user-a', 'user-b', 'user-c']);
  assert.match(captured.requestDigest, /^[0-9a-f]{64}$/);
  assert.equal(result.conversation.idempotencyKey, undefined);
  assert.equal(result.conversation.requestDigest, undefined);
});

test('message acceptance receipt is not labeled as delivery', async () => {
  let captured;
  const service = new ChatService({
    store: {
      async acceptMessage(input) {
        captured = input;
        return {
          created: true,
          message: { ...input, sequence: 1, senderMembershipGeneration: 1 },
        };
      },
    },
    clock: () => 1_700_000_000_123,
    uuid: () => messageId,
  });
  const result = await service.sendMessage({
    senderId: 'user-a',
    conversationId,
    clientMessageId: 'client-message-0001',
    request: { content: 'private message text' },
  });
  assert.equal(result.evidence, 'accepted');
  assert.equal(result.message.clientMessageId, undefined);
  assert.equal(result.message.requestDigest, undefined);
  assert.equal(captured.requestDigest, sha256(`{"content":"private message text","conversationId":"${conversationId}"}`));
});

test('ticket issuance stores only a hash and retries bounded collisions', async () => {
  const rawTickets = ['A'.repeat(43), 'B'.repeat(43)];
  const captured = [];
  const service = new ChatService({
    store: {
      async issueRealtimeTicket(input) {
        captured.push(input);
        return { created: captured.length === 2 };
      },
    },
    clock: () => 5_000,
    ticketGenerator: () => rawTickets[captured.length],
    ticketTtlMs: 10_000,
  });
  const result = await service.issueRealtimeTicket({ userId: 'user-a', request: { deviceId: 'device-a' } });
  assert.equal(result.ticket, rawTickets[1]);
  assert.equal(result.expiresAtMs, 15_000);
  assert.deepEqual(captured.map((input) => input.ticketHash), rawTickets.map(sha256));
  assert.ok(captured.every((input) => !Object.values(input).includes(result.ticket)));
});

test('ticket collision retry budget is fail-closed', async () => {
  const service = new ChatService({
    store: { async issueRealtimeTicket() { return { created: false }; } },
    ticketGenerator: () => 'C'.repeat(43),
  });
  await assert.rejects(
    service.issueRealtimeTicket({ userId: 'user-a', request: { deviceId: 'device-a' } }),
    DependencyError,
  );
});

test('sync and progress keep their evidence layers explicit', async () => {
  const service = new ChatService({
    store: {
      async syncMessages() {
        return {
          messages: [{
            id: messageId,
            conversationId,
            sequence: 4,
            senderId: 'user-a',
            content: 'hello',
            acceptedAtMs: 9,
            clientMessageId: 'hidden-client-id',
          }],
          nextAfterSequence: null,
        };
      },
      async updateProgress(input) {
        return { ...input, changed: true, evidence: 'client_claim_accepted' };
      },
    },
    clock: () => 10,
  });
  const sync = await service.syncMessages({ userId: 'user-b', conversationId, afterSequence: '0', limit: '50' });
  assert.equal(sync.evidence, 'server_sync_response');
  assert.equal(sync.messages[0].clientMessageId, undefined);
  const progress = await service.updateProgress({
    userId: 'user-b',
    conversationId,
    request: { deviceId: 'device-b', syncedThrough: 4, readClaimedThrough: 3 },
  });
  assert.equal(progress.evidence, 'client_claim_accepted');
});

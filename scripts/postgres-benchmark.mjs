import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Pool } from 'pg';
import { ChatService } from '../src/chat-service.js';
import { PostgresChatStore } from '../src/postgres-store.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL benchmark');

function rate(count, startedAt) {
  return Number((count / ((performance.now() - startedAt) / 1_000)).toFixed(3));
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 24 });
const store = new PostgresChatStore(pool);
try {
  await store.migrate();
  const suffix = randomUUID();
  const userIds = Array.from({ length: 10 }, (_, index) => `bench-user-${index}-${suffix}`);
  await store.ensureUsers(userIds, Date.now());
  const service = new ChatService({ store });
  const { conversation } = await service.createConversation({
    ownerId: userIds[0],
    idempotencyKey: `bench-conversation-${suffix}`,
    request: { kind: 'group', memberIds: userIds.slice(1) },
  });

  const messageCount = 180;
  const acceptanceStarted = performance.now();
  const accepted = [];
  for (let offset = 0; offset < messageCount; offset += 18) {
    accepted.push(...await Promise.all(
      Array.from({ length: Math.min(18, messageCount - offset) }, (_, index) => {
        const number = offset + index;
        return service.sendMessage({
          senderId: userIds[number % userIds.length],
          conversationId: conversation.id,
          clientMessageId: `bench-message-${suffix}-${number}`,
          request: { content: `benchmark payload ${number}` },
        });
      }),
    ));
  }
  const acceptancePerSecond = rate(messageCount, acceptanceStarted);
  assert.equal(new Set(accepted.map((result) => result.message.sequence)).size, messageCount);

  const syncStarted = performance.now();
  let afterSequence = 0;
  let synchronized = 0;
  do {
    const page = await service.syncMessages({
      userId: userIds[1],
      conversationId: conversation.id,
      afterSequence,
      limit: 50,
    });
    synchronized += page.messages.length;
    afterSequence = page.nextAfterSequence ?? 0;
    if (page.nextAfterSequence === null) break;
  } while (true);
  const synchronizedMessagesPerSecond = rate(synchronized, syncStarted);
  assert.equal(synchronized, messageCount);

  const ticketCount = 80;
  const ticketStarted = performance.now();
  for (let index = 0; index < ticketCount; index += 1) {
    const issued = await service.issueRealtimeTicket({
      userId: userIds[index % userIds.length],
      request: { deviceId: `bench-device-${index}` },
    });
    await service.consumeRealtimeTicket(issued.ticket);
  }
  const ticketRoundTripsPerSecond = rate(ticketCount, ticketStarted);

  process.stdout.write(`${JSON.stringify({
    kind: 'postgres_chat_benchmark_receipt',
    node: process.versions.node,
    postgres: (await pool.query('SHOW server_version')).rows[0].server_version,
    messages: messageCount,
    acceptancePerSecond,
    synchronizedMessagesPerSecond,
    ticketRoundTripsPerSecond,
  })}\n`);
} finally {
  await pool.end();
}

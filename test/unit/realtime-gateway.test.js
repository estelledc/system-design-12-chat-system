import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocket } from 'ws';
import { AuthenticationError } from '../../src/errors.js';
import { createRealtimeGateway } from '../../src/realtime-gateway.js';

const conversationId = '11111111-1111-4111-8111-111111111111';
const messageId = '22222222-2222-4222-8222-222222222222';
const validTicket = 'A'.repeat(43);

async function startGateway(overrides = {}) {
  let onMessage;
  let onListenerError;
  let listenerClosed = false;
  const logs = [];
  const store = {
    async realtimeEnvelope(id) {
      assert.equal(id, messageId);
      return {
        message: {
          id,
          conversationId,
          sequence: 7,
          senderId: 'user-a',
          clientMessageId: 'hidden-client-id',
          requestDigest: 'hidden-digest',
          content: 'private-text',
          acceptedAtMs: 1_700_000_000_000,
        },
        recipientIds: ['user-b'],
      };
    },
    async listenForMessages(listener) {
      onMessage = listener.onMessage;
      onListenerError = listener.onError;
      return { close: async () => { listenerClosed = true; } };
    },
    ...overrides.store,
  };
  const service = {
    async consumeRealtimeTicket(ticket) {
      if (ticket !== validTicket) throw new AuthenticationError();
      return { userId: 'user-b', deviceId: 'device-b' };
    },
    ...overrides.service,
  };
  const gateway = createRealtimeGateway({
    service,
    store,
    allowedOrigins: ['https://chat.example'],
    heartbeatMs: 60_000,
    logger: (record) => logs.push(record),
  });
  await gateway.startListener();
  gateway.server.listen(0, '127.0.0.1');
  await once(gateway.server, 'listening');
  return {
    gateway,
    logs,
    onMessage: (...args) => onMessage(...args),
    failListener: (error) => onListenerError(error),
    url: `ws://127.0.0.1:${gateway.server.address().port}`,
    listenerWasClosed: () => listenerClosed,
  };
}

async function stopGateway(gateway) {
  await gateway.close();
  gateway.server.close();
  await once(gateway.server, 'close');
}

test('gateway turns a durable notification into a labeled server-write receipt', async () => {
  const fixture = await startGateway();
  const client = new WebSocket(`${fixture.url}/v1/realtime?ticket=${validTicket}`, {
    origin: 'https://chat.example',
  });
  try {
    await once(client, 'open');
    assert.equal(fixture.gateway.connectionCount(), 1);
    const received = once(client, 'message');
    const receipt = await fixture.onMessage(messageId);
    const [data] = await received;
    const envelope = JSON.parse(data.toString('utf8'));
    assert.equal(envelope.type, 'message');
    assert.equal(envelope.evidence, 'server_socket_write_callback');
    assert.equal(envelope.message.sequence, 7);
    assert.equal(envelope.message.clientMessageId, undefined);
    assert.equal(receipt.socketWritesSucceeded, 1);
    assert.equal(receipt.evidence, 'server_socket_write_callbacks');
    const encodedLogs = JSON.stringify(fixture.logs);
    for (const secret of ['user-b', 'device-b', validTicket, 'hidden-client-id', 'private-text']) {
      assert.ok(!encodedLogs.includes(secret));
    }
  } finally {
    client.terminate();
    await stopGateway(fixture.gateway);
  }
  assert.equal(fixture.listenerWasClosed(), true);
});

test('gateway rejects an untrusted Origin before consuming a ticket', async () => {
  let consumed = 0;
  const fixture = await startGateway({
    service: {
      async consumeRealtimeTicket() {
        consumed += 1;
        return { userId: 'user-b', deviceId: 'device-b' };
      },
    },
  });
  const client = new WebSocket(`${fixture.url}/v1/realtime?ticket=${validTicket}`, {
    origin: 'https://attacker.example',
  });
  try {
    const [error] = await once(client, 'error');
    assert.match(error.message, /403/);
    assert.equal(consumed, 0);
  } finally {
    client.terminate();
    await stopGateway(fixture.gateway);
  }
});

test('gateway consumes exact ticket query and closes on client application frames', async () => {
  const fixture = await startGateway();
  const rejected = new WebSocket(`${fixture.url}/v1/realtime?ticket=${validTicket}&extra=1`, {
    origin: 'https://chat.example',
  });
  try {
    const [error] = await once(rejected, 'error');
    assert.match(error.message, /401/);
    const client = new WebSocket(`${fixture.url}/v1/realtime?ticket=${validTicket}`, {
      origin: 'https://chat.example',
    });
    await once(client, 'open');
    client.send('client payload is forbidden');
    const [code] = await once(client, 'close');
    assert.equal(code, 1008);
  } finally {
    rejected.terminate();
    await stopGateway(fixture.gateway);
  }
});

test('gateway health fails after the dedicated notification listener fails', async () => {
  const fixture = await startGateway();
  try {
    const healthy = await fetch(fixture.url.replace('ws:', 'http:') + '/healthz');
    assert.equal(healthy.status, 200);
    fixture.failListener(new Error('synthetic listener failure'));
    assert.equal(fixture.gateway.listenerState(), 'failed');
    const unhealthy = await fetch(fixture.url.replace('ws:', 'http:') + '/healthz');
    assert.equal(unhealthy.status, 503);
  } finally {
    await stopGateway(fixture.gateway);
  }
});

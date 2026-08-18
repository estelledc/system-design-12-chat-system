import assert from 'node:assert/strict';
import { once } from 'node:events';
import test from 'node:test';
import { createApiServer } from '../../src/http-server.js';
import { RequestConflictError } from '../../src/errors.js';

const conversationId = '11111111-1111-4111-8111-111111111111';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.close();
  await once(server, 'close');
}

test('API authenticates from the header and reports durable acceptance only', async () => {
  const calls = [];
  const logs = [];
  const service = {
    async sendMessage(input) {
      calls.push(input);
      return {
        created: true,
        message: { id: 'message-public', conversationId, sequence: 1, content: 'classified-text' },
        evidence: 'accepted',
      };
    },
  };
  const server = createApiServer({
    service,
    authTokens: new Map([['secret-bearer-token', 'user-a']]),
    logger: (record) => logs.push(record),
  });
  const baseUrl = await listen(server);
  try {
    const unauthorized = await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'classified-text' }),
    });
    assert.equal(unauthorized.status, 401);

    const accepted = await fetch(`${baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-bearer-token',
        'client-message-id': 'client-message-0001',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ content: 'classified-text' }),
    });
    assert.equal(accepted.status, 201);
    assert.equal((await accepted.json()).evidence, 'accepted');
    assert.equal(calls[0].senderId, 'user-a');
    const encodedLogs = JSON.stringify(logs);
    for (const secret of ['secret-bearer-token', 'user-a', 'client-message-0001', 'classified-text']) {
      assert.ok(!encodedLogs.includes(secret));
    }
  } finally {
    await close(server);
  }
});

test('API enforces JSON size and maps expected application errors', async () => {
  const server = createApiServer({
    service: {
      async createConversation() { throw new RequestConflictError(); },
    },
    authTokens: new Map([['secret-bearer-token', 'user-a']]),
    maximumBodyBytes: 16,
  });
  const baseUrl = await listen(server);
  try {
    const tooLarge = await fetch(`${baseUrl}/v1/conversations`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer secret-bearer-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ kind: 'direct', memberIds: ['user-b'] }),
    });
    assert.equal(tooLarge.status, 400);
    assert.deepEqual(await tooLarge.json(), { error: 'invalid_request' });

    const conflictServer = createApiServer({
      service: { async createConversation() { throw new RequestConflictError(); } },
      authTokens: new Map([['secret-bearer-token', 'user-a']]),
    });
    const conflictBase = await listen(conflictServer);
    try {
      const conflict = await fetch(`${conflictBase}/v1/conversations`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer secret-bearer-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ kind: 'direct', memberIds: ['user-b'] }),
      });
      assert.equal(conflict.status, 409);
      assert.deepEqual(await conflict.json(), { error: 'idempotency_conflict' });
    } finally {
      await close(conflictServer);
    }
  } finally {
    await close(server);
  }
});

test('sync accepts only one after and limit query parameter', async () => {
  let captured;
  const server = createApiServer({
    service: {
      async syncMessages(input) {
        captured = input;
        return { messages: [], nextAfterSequence: null, evidence: 'server_sync_response' };
      },
    },
    authTokens: new Map([['secret-bearer-token', 'user-a']]),
  });
  const baseUrl = await listen(server);
  try {
    const response = await fetch(
      `${baseUrl}/v1/conversations/${conversationId}/messages?after=4&limit=9`,
      { headers: { authorization: 'Bearer secret-bearer-token' } },
    );
    assert.equal(response.status, 200);
    assert.equal(captured.afterSequence, '4');
    assert.equal(captured.limit, '9');
    const ambiguous = await fetch(
      `${baseUrl}/v1/conversations/${conversationId}/messages?after=1&after=2`,
      { headers: { authorization: 'Bearer secret-bearer-token' } },
    );
    assert.equal(ambiguous.status, 400);
  } finally {
    await close(server);
  }
});

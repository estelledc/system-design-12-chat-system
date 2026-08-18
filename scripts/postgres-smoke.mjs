import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { Pool } from 'pg';
import { WebSocket } from 'ws';
import { PostgresChatStore } from '../src/postgres-store.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the PostgreSQL smoke test');

const authRecords = [
  { token: 'smoke-token-user-a-0001', userId: 'smoke-user-a' },
  { token: 'smoke-token-user-b-0001', userId: 'smoke-user-b' },
];
const origin = 'https://chat-smoke.example';
const sensitiveValues = [
  ...authRecords.flatMap((record) => [record.token, record.userId]),
  'smoke-conversation-key-0001',
  'smoke-client-message-0001',
  'smoke-client-message-0002',
  'smoke-client-message-0003',
  'accepted-before-api-crash',
  'written-to-live-socket',
  'committed-while-gateway-down',
];

function childProcess(command, extraEnvironment = {}) {
  const child = spawn(process.execPath, ['src/main.js', command], {
    cwd: new URL('..', import.meta.url),
    env: {
      ...process.env,
      ALLOWED_ORIGINS_JSON: JSON.stringify([origin]),
      AUTH_TOKENS_JSON: JSON.stringify(authRecords),
      HOST: '127.0.0.1',
      PORT: '0',
      ...extraEnvironment,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const events = new EventEmitter();
  const records = [];
  let stdoutBuffer = '';
  let stderr = '';
  let exited = false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const record = JSON.parse(line);
      records.push(record);
      events.emit('record', record);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = true;
      resolve({ code, signal, stderr });
    });
  });
  return { child, events, exit, records, hasExited: () => exited };
}

async function waitForRecord(processHandle, kind, timeoutMs = 5_000) {
  const existing = processHandle.records.find((record) => record.kind === kind);
  if (existing) return existing;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out waiting for ${kind}`));
    }, timeoutMs);
    const onRecord = (record) => {
      if (record.kind !== kind) return;
      cleanup();
      resolve(record);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      processHandle.events.removeListener('record', onRecord);
    };
    processHandle.events.on('record', onRecord);
  });
}

async function stopProcess(processHandle) {
  if (!processHandle || processHandle.hasExited()) return processHandle?.exit;
  processHandle.child.kill('SIGTERM');
  const result = await processHandle.exit;
  assert.equal(result.code, 0, result.stderr);
  return result;
}

async function jsonRequest(baseUrl, path, { method = 'GET', token = authRecords[0].token, headers = {}, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const setupPool = new Pool({ connectionString: process.env.DATABASE_URL });
await setupPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
await new PostgresChatStore(setupPool).migrate();
await setupPool.end();

const processes = [];
let socket;
try {
  const crashingApi = childProcess('serve-api', { CRASH_AFTER_NEW_MESSAGE_ACCEPTED: '1' });
  processes.push(crashingApi);
  const crashingReady = await waitForRecord(crashingApi, 'api_listening');
  const crashingBase = `http://127.0.0.1:${crashingReady.port}`;
  const conversationResponse = await jsonRequest(crashingBase, '/v1/conversations', {
    method: 'POST',
    headers: { 'idempotency-key': 'smoke-conversation-key-0001' },
    body: { kind: 'group', memberIds: ['smoke-user-b'] },
  });
  assert.equal(conversationResponse.status, 201);
  const { conversation } = await conversationResponse.json();

  const interruptedRequest = jsonRequest(crashingBase, `/v1/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'client-message-id': 'smoke-client-message-0001' },
    body: { content: 'accepted-before-api-crash' },
  });
  await assert.rejects(interruptedRequest);
  const crashed = await crashingApi.exit;
  assert.equal(crashed.signal, 'SIGKILL');

  const api = childProcess('serve-api');
  processes.push(api);
  const apiReady = await waitForRecord(api, 'api_listening');
  const apiBase = `http://127.0.0.1:${apiReady.port}`;
  const replayResponse = await jsonRequest(apiBase, `/v1/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'client-message-id': 'smoke-client-message-0001' },
    body: { content: 'accepted-before-api-crash' },
  });
  assert.equal(replayResponse.status, 200);
  const replay = await replayResponse.json();
  assert.equal(replay.created, false);
  assert.equal(replay.message.sequence, 1);

  const gateway = childProcess('serve-realtime');
  processes.push(gateway);
  const gatewayReady = await waitForRecord(gateway, 'realtime_listening');
  const ticketResponse = await jsonRequest(apiBase, '/v1/realtime-tickets', {
    method: 'POST',
    token: authRecords[1].token,
    body: { deviceId: 'smoke-device-b' },
  });
  assert.equal(ticketResponse.status, 201);
  const ticket = await ticketResponse.json();
  sensitiveValues.push(ticket.ticket);
  socket = new WebSocket(`ws://127.0.0.1:${gatewayReady.port}/v1/realtime?ticket=${ticket.ticket}`, { origin });
  socket.on('error', () => {});
  await once(socket, 'open');
  const realtimeFrame = once(socket, 'message');
  const liveResponse = await jsonRequest(apiBase, `/v1/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'client-message-id': 'smoke-client-message-0002' },
    body: { content: 'written-to-live-socket' },
  });
  assert.equal(liveResponse.status, 201);
  const live = await liveResponse.json();
  const [frameData] = await realtimeFrame;
  const frame = JSON.parse(frameData.toString('utf8'));
  assert.equal(frame.message.id, live.message.id);
  assert.equal(frame.message.sequence, 2);
  assert.equal(frame.evidence, 'server_socket_write_callback');

  socket.terminate();
  socket = undefined;
  await stopProcess(gateway);
  const offlineResponse = await jsonRequest(apiBase, `/v1/conversations/${conversation.id}/messages`, {
    method: 'POST',
    headers: { 'client-message-id': 'smoke-client-message-0003' },
    body: { content: 'committed-while-gateway-down' },
  });
  assert.equal(offlineResponse.status, 201);

  const restartedGateway = childProcess('serve-realtime');
  processes.push(restartedGateway);
  await waitForRecord(restartedGateway, 'realtime_listening');
  const catchupResponse = await jsonRequest(
    apiBase,
    `/v1/conversations/${conversation.id}/messages?after=2&limit=50`,
    { token: authRecords[1].token },
  );
  assert.equal(catchupResponse.status, 200);
  const catchup = await catchupResponse.json();
  assert.deepEqual(catchup.messages.map((message) => message.sequence), [3]);
  assert.equal(catchup.evidence, 'server_sync_response');

  const progressResponse = await jsonRequest(apiBase, `/v1/conversations/${conversation.id}/progress`, {
    method: 'PUT',
    token: authRecords[1].token,
    body: { deviceId: 'smoke-device-b', syncedThrough: 3, readClaimedThrough: 2 },
  });
  assert.equal(progressResponse.status, 200);
  const progress = await progressResponse.json();
  assert.equal(progress.evidence, 'client_claim_accepted');

  const verifyPool = new Pool({ connectionString: process.env.DATABASE_URL });
  const stored = await verifyPool.query(
    'SELECT sequence, content FROM messages WHERE conversation_id = $1 ORDER BY sequence',
    [conversation.id],
  );
  const ticketHashes = await verifyPool.query('SELECT ticket_hash FROM realtime_tickets');
  await verifyPool.end();
  assert.deepEqual(stored.rows.map((row) => Number(row.sequence)), [1, 2, 3]);
  assert.deepEqual(stored.rows.map((row) => row.content), [
    'accepted-before-api-crash',
    'written-to-live-socket',
    'committed-while-gateway-down',
  ]);
  assert.ok(ticketHashes.rows.every((row) => row.ticket_hash !== ticket.ticket));

  const allLogs = JSON.stringify(processes.flatMap((processHandle) => processHandle.records));
  for (const secret of sensitiveValues) assert.ok(!allLogs.includes(secret), `structured log leaked: ${secret}`);

  process.stdout.write(`${JSON.stringify({
    kind: 'postgres_chat_smoke_receipt',
    apiCrashSignal: crashed.signal,
    retryCreated: replay.created,
    persistedSequences: stored.rows.map((row) => Number(row.sequence)),
    realtimeEvidence: frame.evidence,
    gatewayRestarted: true,
    catchupSequences: catchup.messages.map((message) => message.sequence),
    progressEvidence: progress.evidence,
    screenDisplayClaims: 0,
  })}\n`);
} finally {
  socket?.terminate();
  for (const processHandle of [...processes].reverse()) await stopProcess(processHandle);
}

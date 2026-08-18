import { once } from 'node:events';
import { Pool } from 'pg';
import {
  ChatService,
  PostgresChatStore,
  ValidationError,
  createApiServer,
  createRealtimeGateway,
  normalizeUserId,
} from './index.js';

function parseJsonEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    throw new ValidationError(`${name} must contain valid JSON`);
  }
}

function parseIntegerEnvironment(name, fallback, { min, max = Number.MAX_SAFE_INTEGER }) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function authTokenMap() {
  const records = parseJsonEnvironment('AUTH_TOKENS_JSON', []);
  if (!Array.isArray(records) || records.length < 1) {
    throw new ValidationError('AUTH_TOKENS_JSON must be a nonempty array');
  }
  const result = new Map();
  for (const record of records) {
    if (!record || typeof record.token !== 'string' || record.token.length < 16 || record.token.length > 256) {
      throw new ValidationError('each auth token must contain 16-256 characters');
    }
    const userId = normalizeUserId(record.userId);
    if (result.has(record.token) && result.get(record.token) !== userId) {
      throw new ValidationError('one auth token cannot map to multiple users');
    }
    result.set(record.token, userId);
  }
  return result;
}

function logger(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

async function closeServer(server) {
  if (!server.listening) return;
  server.close();
  await once(server, 'close');
}

async function run() {
  if (!process.env.DATABASE_URL) throw new ValidationError('DATABASE_URL is required');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 24 });
  const store = new PostgresChatStore(pool);
  const command = process.argv[2] ?? 'serve-api';
  let keepPoolOpen = false;
  try {
    await store.migrate();
    if (command === 'migrate') {
      logger({ kind: 'migration_complete' });
      return;
    }
    if (command === 'stats') {
      logger({ kind: 'chat_stats', ...(await store.stats()) });
      return;
    }
    if (!['serve-api', 'serve-realtime'].includes(command)) {
      throw new ValidationError('command must be migrate, stats, serve-api, or serve-realtime');
    }

    const authTokens = authTokenMap();
    await store.ensureUsers([...authTokens.values()], Date.now());
    const service = new ChatService({
      store,
      ticketTtlMs: parseIntegerEnvironment('REALTIME_TICKET_TTL_MS', 60_000, { min: 1_000, max: 300_000 }),
    });
    const host = process.env.HOST ?? '127.0.0.1';
    const defaultPort = command === 'serve-api' ? 3_000 : 3_001;
    const port = parseIntegerEnvironment('PORT', defaultPort, { min: 0, max: 65_535 });

    if (command === 'serve-api') {
      const server = createApiServer({
        service,
        authTokens,
        health: () => store.ping(),
        logger,
        afterMessageAccepted: async (result) => {
          if (process.env.CRASH_AFTER_NEW_MESSAGE_ACCEPTED === '1' && result.created) {
            process.kill(process.pid, 'SIGKILL');
          }
        },
      });
      server.listen(port, host);
      await once(server, 'listening');
      logger({ kind: 'api_listening', port: server.address().port });
      let shuttingDown = false;
      const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        await closeServer(server);
        await pool.end();
      };
      process.once('SIGTERM', shutdown);
      process.once('SIGINT', shutdown);
      keepPoolOpen = true;
      return;
    }

    const gateway = createRealtimeGateway({
      service,
      store,
      allowedOrigins: parseJsonEnvironment('ALLOWED_ORIGINS_JSON', []),
      health: () => store.ping(),
      logger,
      maximumPayloadBytes: parseIntegerEnvironment('MAX_WEBSOCKET_PAYLOAD_BYTES', 1_024, { min: 1, max: 65_536 }),
      maximumBufferedBytes: parseIntegerEnvironment('MAX_WEBSOCKET_BUFFERED_BYTES', 65_536, { min: 1, max: 16_777_216 }),
      heartbeatMs: parseIntegerEnvironment('WEBSOCKET_HEARTBEAT_MS', 30_000, { min: 1_000, max: 300_000 }),
    });
    await gateway.startListener();
    gateway.server.listen(port, host);
    await once(gateway.server, 'listening');
    logger({ kind: 'realtime_listening', port: gateway.server.address().port });
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      await closeServer(gateway.server);
      await gateway.close();
      await pool.end();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    keepPoolOpen = true;
  } finally {
    if (!keepPoolOpen) await pool.end();
  }
}

run().catch((error) => {
  process.stderr.write(`${JSON.stringify({
    kind: 'fatal',
    name: error?.name ?? 'Error',
    code: error?.code ?? 'internal_error',
  })}\n`);
  process.exitCode = 1;
});

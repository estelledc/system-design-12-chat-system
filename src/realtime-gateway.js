import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { publicMessage } from './chat-service.js';
import { normalizeAllowedOrigins, safeInteger } from './contracts.js';
import { AppError, AuthenticationError } from './errors.js';

function healthResponse(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'private, no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(encoded);
}

function rejectUpgrade(socket, status, reason) {
  if (socket.destroyed) return;
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\n`
      + 'Connection: close\r\n'
      + 'Content-Length: 0\r\n'
      + 'Cache-Control: no-store\r\n'
      + '\r\n',
  );
}

function ticketFromRequest(request) {
  let url;
  try {
    url = new URL(request.url, 'http://localhost');
  } catch {
    throw new AuthenticationError();
  }
  if (url.pathname !== '/v1/realtime') throw new AuthenticationError();
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== 'ticket' || url.searchParams.getAll('ticket').length !== 1) {
    throw new AuthenticationError();
  }
  return url.searchParams.get('ticket');
}

export function createRealtimeGateway({
  service,
  store,
  allowedOrigins,
  health = async () => true,
  logger = () => {},
  maximumPayloadBytes = 1_024,
  maximumBufferedBytes = 65_536,
  heartbeatMs = 30_000,
}) {
  const origins = normalizeAllowedOrigins(allowedOrigins);
  const payloadLimit = safeInteger(maximumPayloadBytes, 'maximum WebSocket payload', { min: 1, max: 65_536 });
  const bufferLimit = safeInteger(maximumBufferedBytes, 'maximum WebSocket buffer', { min: 1, max: 16_777_216 });
  const heartbeatInterval = safeInteger(heartbeatMs, 'heartbeat interval', { min: 1_000, max: 300_000 });
  const socketsByUser = new Map();
  const identityBySocket = new WeakMap();
  let notificationListener = null;
  let notificationState = 'starting';

  const server = createServer(async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/healthz') {
        if (notificationState !== 'ready') throw new Error('notification listener is not ready');
        await health();
        healthResponse(response, 200, { ok: true });
        return;
      }
      healthResponse(response, 404, { error: 'not_found' });
    } catch {
      healthResponse(response, 503, { error: 'dependency_unavailable' });
    }
  });
  const webSocketServer = new WebSocketServer({
    clientTracking: true,
    maxPayload: payloadLimit,
    noServer: true,
    perMessageDeflate: false,
  });

  function removeSocket(socket) {
    const identity = identityBySocket.get(socket);
    if (!identity) return;
    identityBySocket.delete(socket);
    const sockets = socketsByUser.get(identity.userId);
    sockets?.delete(socket);
    if (sockets?.size === 0) socketsByUser.delete(identity.userId);
    logger({ kind: 'realtime_connection_closed' });
  }

  webSocketServer.on('connection', (socket, request, identity) => {
    identityBySocket.set(socket, identity);
    const sockets = socketsByUser.get(identity.userId) ?? new Set();
    sockets.add(socket);
    socketsByUser.set(identity.userId, sockets);
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });
    socket.on('message', () => {
      logger({ kind: 'unexpected_client_frame' });
      socket.close(1008, 'server-to-client channel only');
    });
    socket.once('close', () => removeSocket(socket));
    socket.once('error', () => {
      logger({ kind: 'realtime_socket_error' });
    });
    logger({ kind: 'realtime_connection_opened' });
  });

  server.on('upgrade', (request, socket, head) => {
    socket.on('error', () => {});
    void (async () => {
      if (!origins.has(request.headers.origin)) {
        logger({ kind: 'realtime_upgrade_rejected', code: 'origin_not_allowed' });
        rejectUpgrade(socket, 403, 'Forbidden');
        return;
      }
      try {
        const identity = await service.consumeRealtimeTicket(ticketFromRequest(request));
        if (socket.destroyed) return;
        webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
          webSocketServer.emit('connection', webSocket, request, identity);
        });
      } catch (error) {
        const safe = error instanceof AppError ? error : new AppError('Internal error');
        const status = safe.status === 503 ? 503 : 401;
        logger({ kind: 'realtime_upgrade_rejected', code: safe.code });
        rejectUpgrade(socket, status, status === 503 ? 'Service Unavailable' : 'Unauthorized');
      }
    })();
  });

  async function writeToSocket(socket, encoded) {
    if (socket.readyState !== WebSocket.OPEN) return 'not_open';
    if (socket.bufferedAmount > bufferLimit) {
      logger({ kind: 'slow_consumer_terminated' });
      socket.terminate();
      return 'slow_consumer';
    }
    return new Promise((resolve) => {
      socket.send(encoded, (error) => {
        if (error) {
          logger({ kind: 'server_socket_write_callback', ok: false });
          resolve('failed');
          return;
        }
        logger({ kind: 'server_socket_write_callback', ok: true });
        resolve('succeeded');
      });
    });
  }

  async function publishMessage(messageId) {
    const envelope = await store.realtimeEnvelope(messageId);
    if (!envelope) {
      logger({ kind: 'notification_target_missing' });
      return {
        socketWritesSucceeded: 0,
        socketWritesFailed: 0,
        slowConsumersTerminated: 0,
        evidence: 'server_socket_write_callbacks',
      };
    }
    const encoded = JSON.stringify({
      type: 'message',
      message: publicMessage(envelope.message),
      evidence: 'server_socket_write_callback',
    });
    const writes = [];
    for (const userId of envelope.recipientIds) {
      for (const socket of socketsByUser.get(userId) ?? []) writes.push(writeToSocket(socket, encoded));
    }
    const results = await Promise.all(writes);
    const receipt = {
      socketWritesSucceeded: results.filter((result) => result === 'succeeded').length,
      socketWritesFailed: results.filter((result) => result === 'failed').length,
      slowConsumersTerminated: results.filter((result) => result === 'slow_consumer').length,
      evidence: 'server_socket_write_callbacks',
    };
    logger({ kind: 'realtime_publish_receipt', ...receipt });
    return receipt;
  }

  const heartbeat = setInterval(() => {
    for (const socket of webSocketServer.clients) {
      if (!socket.isAlive) {
        logger({ kind: 'heartbeat_timeout' });
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      try {
        socket.ping();
      } catch {
        logger({ kind: 'heartbeat_ping_failed' });
        socket.terminate();
      }
    }
  }, heartbeatInterval);
  heartbeat.unref();

  async function startListener() {
    if (notificationListener) return notificationListener;
    notificationListener = await store.listenForMessages({
      onMessage: publishMessage,
      onError: (error) => {
        notificationState = 'failed';
        logger({
          kind: 'notification_listener_failed',
          code: error instanceof AppError ? error.code : 'internal_error',
        });
      },
    });
    notificationState = 'ready';
    logger({ kind: 'notification_listener_ready' });
    return notificationListener;
  }

  async function close() {
    clearInterval(heartbeat);
    const listener = notificationListener;
    notificationListener = null;
    notificationState = 'closed';
    await listener?.close();
    for (const socket of webSocketServer.clients) socket.terminate();
    await new Promise((resolve) => webSocketServer.close(resolve));
  }

  return {
    server,
    webSocketServer,
    close,
    connectionCount: () => webSocketServer.clients.size,
    listenerState: () => notificationState,
    publishMessage,
    startListener,
  };
}

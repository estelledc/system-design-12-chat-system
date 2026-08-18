import { createServer } from 'node:http';
import { AppError, AuthenticationError, ValidationError } from './errors.js';

function json(response, status, body) {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'private, no-store',
    'content-length': Buffer.byteLength(encoded),
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(encoded);
}

async function readJson(request, maximumBytes) {
  if (!String(request.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
    throw new ValidationError('content-type must be application/json');
  }
  const declared = request.headers['content-length'];
  if (declared !== undefined && Number.isFinite(Number(declared)) && Number(declared) > maximumBytes) {
    throw new ValidationError('request body is too large');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > maximumBytes) throw new ValidationError('request body is too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ValidationError('request body is not valid JSON');
  }
}

function authenticate(request, authTokens) {
  const authorization = request.headers.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) throw new AuthenticationError();
  const userId = authTokens.get(authorization.slice('Bearer '.length));
  if (!userId) throw new AuthenticationError();
  return userId;
}

function pathIdentifier(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ValidationError('path identifier is invalid');
  }
}

function syncQuery(url) {
  const allowed = new Set(['after', 'limit']);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      throw new ValidationError('sync query parameters are invalid');
    }
  }
  return {
    afterSequence: url.searchParams.get('after') ?? undefined,
    limit: url.searchParams.get('limit') ?? undefined,
  };
}

export function createApiServer({
  service,
  authTokens,
  health = async () => true,
  logger = () => {},
  maximumBodyBytes = 16_384,
  afterMessageAccepted = async () => {},
}) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/healthz') {
        await health();
        json(response, 200, { ok: true });
        return;
      }
      const userId = authenticate(request, authTokens);
      if (request.method === 'POST' && url.pathname === '/v1/conversations') {
        const result = await service.createConversation({
          ownerId: userId,
          idempotencyKey: request.headers['idempotency-key'],
          request: await readJson(request, maximumBodyBytes),
        });
        logger({ kind: 'conversation_intake', created: result.created, memberCount: result.conversation.memberCount });
        json(response, result.created ? 201 : 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/realtime-tickets') {
        const result = await service.issueRealtimeTicket({
          userId,
          request: await readJson(request, maximumBodyBytes),
        });
        logger({ kind: 'realtime_ticket_issued' });
        json(response, 201, result);
        return;
      }
      const memberMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/members\/([^/]+)$/);
      if (memberMatch && request.method === 'PUT') {
        const result = await service.addMember({
          actorId: userId,
          conversationId: pathIdentifier(memberMatch[1]),
          userId: pathIdentifier(memberMatch[2]),
        });
        logger({ kind: 'membership_changed', active: true, changed: result.changed });
        json(response, 200, result);
        return;
      }
      if (memberMatch && request.method === 'DELETE' && pathIdentifier(memberMatch[2]) === 'me') {
        const result = await service.leaveConversation({
          userId,
          conversationId: pathIdentifier(memberMatch[1]),
        });
        logger({ kind: 'membership_changed', active: false, changed: result.changed });
        json(response, 200, result);
        return;
      }
      const messagesMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/messages$/);
      if (messagesMatch && request.method === 'POST') {
        const result = await service.sendMessage({
          senderId: userId,
          conversationId: pathIdentifier(messagesMatch[1]),
          clientMessageId: request.headers['client-message-id'],
          request: await readJson(request, maximumBodyBytes),
        });
        logger({ kind: 'message_intake', created: result.created, evidence: result.evidence });
        await afterMessageAccepted(result);
        json(response, result.created ? 201 : 200, result);
        return;
      }
      if (messagesMatch && request.method === 'GET') {
        const result = await service.syncMessages({
          userId,
          conversationId: pathIdentifier(messagesMatch[1]),
          ...syncQuery(url),
        });
        logger({ kind: 'message_sync', count: result.messages.length, hasNext: result.nextAfterSequence !== null });
        json(response, 200, result);
        return;
      }
      const progressMatch = url.pathname.match(/^\/v1\/conversations\/([^/]+)\/progress$/);
      if (progressMatch && request.method === 'PUT') {
        const result = await service.updateProgress({
          userId,
          conversationId: pathIdentifier(progressMatch[1]),
          request: await readJson(request, maximumBodyBytes),
        });
        logger({ kind: 'client_progress_claim', changed: result.changed, evidence: result.evidence });
        json(response, 200, result);
        return;
      }
      json(response, 404, { error: 'not_found' });
    } catch (error) {
      const safe = error instanceof AppError ? error : new AppError('Internal error');
      logger({ kind: 'request_failed', code: safe.code, status: safe.status });
      json(response, safe.status, { error: safe.code });
    }
  });
}

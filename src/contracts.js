import { AuthenticationError, ValidationError } from './errors.js';

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;

export function safeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new ValidationError(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

export function boundedIdentifier(value, label, { min = 1, max = 128 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max || !identifierPattern.test(value)) {
    throw new ValidationError(`${label} must be ${min}-${max} safe identifier characters`);
  }
  return value;
}

export function normalizeUserId(value) {
  return boundedIdentifier(value, 'userId', { max: 64 });
}

export function normalizeDeviceId(value) {
  return boundedIdentifier(value, 'deviceId', { max: 64 });
}

export function normalizeIdempotencyKey(value, label = 'idempotency key') {
  return boundedIdentifier(value, label, { min: 16, max: 128 });
}

export function normalizeUuid(value, label = 'identifier') {
  if (typeof value !== 'string' || !uuidPattern.test(value)) throw new ValidationError(`${label} must be a UUID`);
  return value.toLowerCase();
}

function exactObject(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ValidationError(`${label} must be an object`);
  }
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new ValidationError(`${label} contains unsupported fields`);
  return value;
}

export function normalizeConversationRequest(value, ownerId) {
  exactObject(value, new Set(['kind', 'memberIds']), 'conversation request');
  if (value.kind !== 'direct' && value.kind !== 'group') throw new ValidationError('kind must be direct or group');
  if (!Array.isArray(value.memberIds)) throw new ValidationError('memberIds must be an array');
  const members = value.memberIds.map(normalizeUserId);
  if (members.includes(ownerId)) throw new ValidationError('memberIds must not contain the owner');
  if (new Set(members).size !== members.length) throw new ValidationError('memberIds must be unique');
  if (value.kind === 'direct' && members.length !== 1) throw new ValidationError('direct conversations require one peer');
  if (value.kind === 'group' && (members.length < 1 || members.length > 19)) {
    throw new ValidationError('group conversations require 1-19 other members');
  }
  return { kind: value.kind, memberIds: [...members].sort() };
}

export function normalizeMessageRequest(value) {
  exactObject(value, new Set(['content']), 'message request');
  if (typeof value.content !== 'string' || value.content.trim().length === 0) {
    throw new ValidationError('content must be a nonempty string');
  }
  if (Buffer.byteLength(value.content) > 4_096) throw new ValidationError('content exceeds the 4 KiB UTF-8 limit');
  return { content: value.content };
}

export function normalizeTicketRequest(value) {
  exactObject(value, new Set(['deviceId']), 'ticket request');
  return { deviceId: normalizeDeviceId(value.deviceId) };
}

export function normalizeProgressRequest(value) {
  exactObject(value, new Set(['deviceId', 'syncedThrough', 'readClaimedThrough']), 'progress request');
  const result = {
    deviceId: normalizeDeviceId(value.deviceId),
    syncedThrough: safeInteger(value.syncedThrough, 'syncedThrough'),
    readClaimedThrough: safeInteger(value.readClaimedThrough, 'readClaimedThrough'),
  };
  if (result.readClaimedThrough > result.syncedThrough) {
    throw new ValidationError('readClaimedThrough cannot exceed syncedThrough');
  }
  return result;
}

export function normalizeAfterSequence(value) {
  if (value === undefined || value === null || value === '') return 0;
  return safeInteger(Number(value), 'after sequence');
}

export function normalizePageLimit(value, fallback = 50) {
  if (value === undefined || value === null || value === '') return fallback;
  return safeInteger(Number(value), 'page limit', { min: 1, max: 100 });
}

export function normalizeRealtimeTicket(value) {
  if (typeof value !== 'string' || !ticketPattern.test(value)) throw new AuthenticationError();
  return value;
}

export function normalizeAllowedOrigins(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > 20) {
    throw new ValidationError('allowed origins must be a nonempty array');
  }
  const origins = values.map((value) => {
    if (typeof value !== 'string' || value.length > 256) throw new ValidationError('allowed origin is invalid');
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new ValidationError('allowed origin is invalid');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
      throw new ValidationError('allowed origin must be an exact HTTP(S) origin');
    }
    return value;
  });
  if (new Set(origins).size !== origins.length) throw new ValidationError('allowed origins must be unique');
  return new Set(origins);
}

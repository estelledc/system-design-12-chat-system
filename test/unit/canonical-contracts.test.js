import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, sha256 } from '../../src/canonical.js';
import {
  normalizeAllowedOrigins,
  normalizeConversationRequest,
  normalizeMessageRequest,
  normalizePageLimit,
  normalizeProgressRequest,
  normalizeRealtimeTicket,
} from '../../src/contracts.js';
import { AuthenticationError, ValidationError } from '../../src/errors.js';

test('canonical JSON makes object key order irrelevant but preserves arrays', () => {
  const left = canonicalJson({ members: ['user-b', 'user-a'], kind: 'group' });
  const right = canonicalJson({ kind: 'group', members: ['user-b', 'user-a'] });
  assert.equal(left, right);
  assert.notEqual(left, canonicalJson({ kind: 'group', members: ['user-a', 'user-b'] }));
  assert.match(sha256(left), /^[0-9a-f]{64}$/);
});

test('conversation contracts sort peers and reject ambiguous membership', () => {
  assert.deepEqual(
    normalizeConversationRequest({ kind: 'group', memberIds: ['user-c', 'user-b'] }, 'user-a'),
    { kind: 'group', memberIds: ['user-b', 'user-c'] },
  );
  assert.throws(
    () => normalizeConversationRequest({ kind: 'direct', memberIds: ['user-a'] }, 'user-a'),
    ValidationError,
  );
  assert.throws(
    () => normalizeConversationRequest({ kind: 'group', memberIds: ['user-b', 'user-b'] }, 'user-a'),
    ValidationError,
  );
  assert.throws(
    () => normalizeConversationRequest({ kind: 'direct', memberIds: ['user-b'], extra: true }, 'user-a'),
    ValidationError,
  );
});

test('message and paging contracts apply byte and integer bounds', () => {
  assert.deepEqual(normalizeMessageRequest({ content: 'hello' }), { content: 'hello' });
  assert.throws(() => normalizeMessageRequest({ content: '界'.repeat(1_366) }), ValidationError);
  assert.equal(normalizePageLimit(undefined), 50);
  assert.equal(normalizePageLimit('100'), 100);
  assert.throws(() => normalizePageLimit('1.5'), ValidationError);
});

test('progress separates synchronized state from a client read claim', () => {
  assert.deepEqual(
    normalizeProgressRequest({ deviceId: 'device-a', syncedThrough: 9, readClaimedThrough: 7 }),
    { deviceId: 'device-a', syncedThrough: 9, readClaimedThrough: 7 },
  );
  assert.throws(
    () => normalizeProgressRequest({ deviceId: 'device-a', syncedThrough: 6, readClaimedThrough: 7 }),
    ValidationError,
  );
});

test('realtime tickets and origins use exact closed contracts', () => {
  const ticket = 'A'.repeat(43);
  assert.equal(normalizeRealtimeTicket(ticket), ticket);
  assert.throws(() => normalizeRealtimeTicket('short'), AuthenticationError);
  assert.deepEqual(
    [...normalizeAllowedOrigins(['https://chat.example', 'http://localhost:3000'])],
    ['https://chat.example', 'http://localhost:3000'],
  );
  assert.throws(() => normalizeAllowedOrigins(['https://chat.example/']), ValidationError);
  assert.throws(() => normalizeAllowedOrigins(['ws://chat.example']), ValidationError);
});

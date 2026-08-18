# API

All JSON routes use `Content-Type: application/json`. Except health, HTTP routes require
`Authorization: Bearer <configured synthetic token>`. Error bodies expose a stable code only:

```json
{"error":"invalid_request"}
```

Possible codes are `invalid_request`, `unauthorized`, `not_found`, `idempotency_conflict`, and `dependency_unavailable`.

## Create a conversation

`POST /v1/conversations`

Headers: `Idempotency-Key` with 16–128 safe identifier characters.

```json
{"kind":"group","memberIds":["user-b","user-c"]}
```

`direct` requires exactly one peer. `group` requires 1–19 peers in addition to the owner. Response is 201 when created and 200
for an exact replay. A key reused with different normalized intent returns 409.

## Change membership

- `PUT /v1/conversations/{conversationId}/members/{userId}`: group owner adds or reactivates a member.
- `DELETE /v1/conversations/{conversationId}/members/me`: caller leaves a group.

Both operations lock the conversation and return `active`, `changed`, `generation`, and the committed sequence boundary. Direct
membership is immutable, and the owner cannot leave in v0.1.

## Accept a message

`POST /v1/conversations/{conversationId}/messages`

Headers: `Client-Message-Id` with 16–128 safe identifier characters.

```json
{"content":"hello"}
```

Response is 201 when newly committed and 200 for an exact retry:

```json
{
  "created": true,
  "message": {
    "id": "22222222-2222-4222-8222-222222222222",
    "conversationId": "11111111-1111-4111-8111-111111111111",
    "sequence": 1,
    "senderId": "user-a",
    "content": "hello",
    "acceptedAtMs": 1700000000000
  },
  "evidence": "accepted"
}
```

`accepted` means the database transaction committed. It does not mean another device received or displayed the message.

## Synchronize history

`GET /v1/conversations/{conversationId}/messages?after=0&limit=50`

`after` defaults to 0 and is exclusive. `limit` defaults to 50 and is capped at 100. Only one value for each parameter is
accepted. The response contains ascending authorized messages, `nextAfterSequence` when another page exists, and evidence
`server_sync_response`.

The cursor is conversation-local. Never use one sequence to advance another conversation.

## Issue a real-time ticket

`POST /v1/realtime-tickets`

```json
{"deviceId":"device-a"}
```

The response returns a 43-character ticket, `expiresAtMs`, and the normalized device ID. The ticket is a short-lived secret. Use
it once and do not persist or log it. The reusable bearer is not accepted in the WebSocket URL.

## Open real-time receive

`GET /v1/realtime?ticket=<single-use-ticket>` with a WebSocket upgrade and exact allowed `Origin`.

Server message:

```json
{
  "type": "message",
  "message": {
    "id": "22222222-2222-4222-8222-222222222222",
    "conversationId": "11111111-1111-4111-8111-111111111111",
    "sequence": 1,
    "senderId": "user-a",
    "content": "hello",
    "acceptedAtMs": 1700000000000
  },
  "evidence": "server_socket_write_callback"
}
```

The evidence label describes only the server's local write callback. Clients must deduplicate and synchronize any sequence gap.
Client application frames are rejected with close code 1008.

## Record device progress

`PUT /v1/conversations/{conversationId}/progress`

```json
{"deviceId":"device-a","syncedThrough":8,"readClaimedThrough":7}
```

The device must have been registered by ticket issuance. Both values are monotonic and visibility-checked. The response evidence
is `client_claim_accepted`; it remains an authenticated software claim, not proof of physical storage, screen display, or human
reading.

## Health

`GET /healthz` is unauthenticated on both API and gateway processes. A 200 response proves that the process can query its current
PostgreSQL pool at that moment; gateway health also requires its dedicated notification listener to remain ready. It does not
prove end-to-end send, WebSocket, or catch-up health.

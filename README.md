# Evidence-first Chat System

A bounded chat-system practice that makes one question executable: after a send request, what can the service honestly prove?

The implementation accepts idempotent HTTP sends into PostgreSQL, assigns a contiguous sequence inside each conversation, and
uses WebSocket only as a low-latency advisory path. A missed real-time frame is repaired by authoritative HTTP catch-up. The
project deliberately distinguishes durable acceptance, a server socket write callback, a client synchronization claim, a client
read claim, screen display, and human reading.

This is a learning repository, not a production messenger or a capacity claim.

## What is implemented

- direct and small-group conversations with at most 20 active members;
- immutable text messages bounded to 4 KiB of UTF-8;
- sender-scoped idempotency through `(sender_id, client_message_id)`;
- one transactionally allocated sequence per conversation;
- historical membership generations for exact join/leave visibility;
- ordered HTTP catch-up after a conversation-local sequence;
- short-lived, hashed, single-use WebSocket tickets bound to a device;
- exact Origin allowlisting, bounded inbound frames, heartbeat, and slow-consumer termination;
- per-device monotonic synchronized-through and client-claimed-read-through progress;
- structured logs that omit reusable bearer values, tickets, raw identities, client message IDs, message text, and cursor bodies.

The slice excludes attachments, push, presence, edits, deletion, search, calls, end-to-end encryption, cross-region operation,
database failover, large groups, and production deployment.

## Architecture in one view

```text
sender                         PostgreSQL                         recipient
  | POST message                  |                                  |
  |------------------------------>| lock conversation               |
  |                               | assign sequence + insert         |
  |                               | pg_notify(message UUID)          |
  |                               | commit                           |
  |<-- accepted / exact replay ---|                                  |
  |                                                                  |
  |                         gateway LISTEN                            |
  |                               |-- fetch authoritative row ------>|
  |                               |        WebSocket write callback  |
  |                                                                  |
  |                         GET messages?after=n <-------------------|
  |                               |-- ordered authorized catch-up -->|
```

`NOTIFY` contains no message body and is not a queue. PostgreSQL tables remain the durable authority. More detail is in
[architecture](docs/architecture.md) and [ADR 0001](docs/adr/0001-postgres-conversation-log-and-advisory-websocket.md).

## Run locally

Requirements: Node.js 22 or newer, npm, and PostgreSQL 17.6.

```bash
npm ci --ignore-scripts
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/chat_system
export AUTH_TOKENS_JSON='[{"token":"replace-with-at-least-16-characters","userId":"demo-user-a"}]'
npm run check:ci
```

Start the API and real-time gateway as separate processes:

```bash
npm start
ALLOWED_ORIGINS_JSON='["http://localhost:3000"]' node src/main.js serve-realtime
```

The commands intentionally require explicit synthetic authentication configuration. Do not reuse production credentials.
Configuration and shutdown behavior are documented in [operations](docs/operations.md); routes and evidence labels are in
[API](docs/api.md).

## Verification boundary

`npm run check:ci` runs static repository checks, 17 pure tests, a dependency audit, real PostgreSQL integration tests, a
process-death/WebSocket/catch-up smoke, and a bounded benchmark. Public CI runs the same gate on Node 22, 24, and 26 with
PostgreSQL 17.6.

Passing those gates proves only the tested local invariants. It does not prove 5 million connections, the scenario throughput,
TLS termination, failover, device persistence, screen display, human reading, privacy compliance, or production acceptance.
See [verification](docs/verification.md) for exact receipts and exclusions.

## Research provenance

The prompt source is chapter 12 of `liquidslr/system-design-notes`, fixed at commit
`9d8388721e7231442763ad37398b8d82224aa68f`. That upstream snapshot has no license file, so this repository uses a clean-room
boundary: the closed-book contract was committed first, and no upstream prose, code, image, or diagram is copied. The later
[research log](docs/research-log.md) compares claims against the fixed chapter and current primary sources.

## Documents

- [Requirements and invariants](docs/requirements.md)
- [Architecture and failure flow](docs/architecture.md)
- [HTTP and WebSocket API](docs/api.md)
- [Threat model](docs/threat-model.md)
- [Operations](docs/operations.md)
- [Verification receipts](docs/verification.md)
- [Closed-book contract](docs/closed-book-contract.md)
- [Research log](docs/research-log.md)
- [Security policy](SECURITY.md)

Licensed under the [MIT License](LICENSE).

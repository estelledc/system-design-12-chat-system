# ADR 0001: PostgreSQL conversation log and advisory WebSocket delivery

## Status

Accepted for the v0.1 evidence slice.

## Context

The repository must make message acceptance, per-conversation order, membership races, multiple-device progress, low-latency
receive, missed real-time events, and reconnect repair executable. Introducing a sharded key-value store, broker, presence
service, push provider, and service discovery before those rules are testable would add authorities without defining their
failure relationships.

The fixed chapter correctly identifies WebSocket, conversation-local ordering, multiple-device synchronization, and hot group
fanout as central concerns. It does not define idempotent acceptance or membership boundaries, and its one global device cursor
cannot order IDs that are only local to separate groups.

## Decision

Use PostgreSQL 17.6 as the single durable v0.1 authority, HTTP for send/catch-up commands, and `ws` 8.21.3 for an advisory receive
connection.

1. Every conversation owns `last_sequence`. Create, add, leave, rejoin, and send transactions lock that row. Message insertion
   and sequence advancement commit together, giving contiguous committed order within one conversation only.
2. `(sender_id, client_message_id)` binds one immutable conversation/body digest. Exact retry returns the original ID/sequence;
   a different request conflicts, including after an ambiguous HTTP response.
3. Membership generations store an exclusive lower boundary (`join_after_sequence`) and inclusive upper boundary
   (`leave_after_sequence`). Synchronization returns a message only if its sequence lies inside one generation.
4. The send transaction also calls `pg_notify` with the opaque message UUID. A dedicated gateway connection commits `LISTEN` and
   then reacts by reading the authoritative message and active recipients. Duplicate or missed notifications are allowed.
5. Connected recipients may receive a full bounded message envelope. The gateway records only a server write callback; clients
   deduplicate and repair gaps through `GET .../messages?after=<conversation-sequence>`.
6. HTTP bearer authentication issues a 60-second one-use real-time ticket bound to a device. Only its SHA-256 hash is stored.
   Upgrade checks an exact origin allowlist and atomically consumes the ticket before creating a socket.
7. Each device has monotonic `synced_through` and `read_claimed_through` values per conversation. Claims cannot exceed the current
   conversation sequence or that user's membership visibility. They remain client claims.
8. Inbound WebSocket messages are unnecessary in v0.1 and are rejected. Payload, outbound buffer, connection lifetime, and
   heartbeat are bounded. A slow or dead client reconnects and catches up instead of retaining an unbounded queue.

## Alternatives rejected for this slice

- **WebSocket for durable sending:** still needs an idempotent command/result protocol and reconnect replay; it adds no evidence
  over bounded HTTP intake for this slice.
- **One global message ID and cursor:** a sortable allocator does not prove commit order, and one global serialization point is
  unnecessary when the user-visible order is per conversation.
- **Local IDs plus one user cursor:** IDs from separate conversations are incomparable and can skip messages.
- **Per-recipient inbox copies:** useful for large fanout/read tradeoffs, but introduces partial fanout, stale membership, and
  cleanup semantics that groups of 20 do not require.
- **Durable broker immediately:** would require an outbox/CDC, partition-key, consumer-offset, redelivery, and authorization
  contract. PostgreSQL notification is sufficient as a deliberately lossy wake-up because catch-up is authoritative.
- **Reusable bearer in the WebSocket URL:** likely to leak through URL logging. A short ticket reduces exposure but does not
  remove the need for TLS, log suppression, origin checks, expiry, and atomic consumption.
- **Cassandra/ScyllaDB because named products use it:** production case studies reveal workload-specific benefits and costs, not
  a correctness requirement for this bounded experiment.

## Consequences

- The conversation row makes order and membership races clear but is a hot serialization point. One very active conversation
  cannot scale beyond one database writer without redefining or partitioning its order contract.
- `LISTEN/NOTIFY` is low-latency and transactional with commit, but not the message log. Gateway restart and setup races can cause
  missing or duplicate frames; per-conversation catch-up is mandatory.
- Storing a full membership history makes authorization explainable, but large groups and frequent churn would need indexing,
  retention, and possibly snapshot strategies not present here.
- The one-use ticket works for browser-compatible upgrades without exposing the reusable bearer. It adds a database write per
  connection and still has a theft-before-use window.
- PostgreSQL can prove durable convergence in the tested service. It cannot prove device persistence, screen display, human
  reading, end-to-end encryption, database failover, 5 million sockets, 115,741 messages/second, or production suitability.

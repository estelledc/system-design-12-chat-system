# Research log and source corrections

## Snapshot and clean-room boundary

- Closed-book baseline: commit `d735d69d2711f67ab9e76216c7d67855c2bfe041`, written before reading the chapter.
- Secondary prompt source: `liquidslr/system-design-notes`, fixed commit
  `9d8388721e7231442763ad37398b8d82224aa68f`, chapter 12 tree
  `d9be908757dabf40628340cbbc841de593a1f2ac`, `Readme.md` blob
  `cf14843c84950c88fe20021a28fa54d590e5b6d9`.
- Public-source fetch and review date: 2026-08-19 (Asia/Shanghai).
- The fixed upstream tree has no license file. This repository copies no upstream prose, image, diagram, or code. The chapter is
  used only to identify the problem and compare mechanisms.

## Closed-book comparison

| Topic | Closed-book contract | Fixed chapter | Decision after comparison |
|---|---|---|---|
| Scope | one-to-one and groups up to 20; text up to 4 KiB | groups up to 100, text up to 100,000 characters, presence, push, permanent history | retain the smaller executable slice; large bodies, presence, push, and permanent retention each need separate contracts |
| Sender transport | HTTP acceptance, WebSocket low-latency receive | first says sender HTTP, later chooses WebSocket for both directions | use HTTP for the durable idempotent send command and WebSocket only for advisory receive in v0.1 |
| Durable store | PostgreSQL for one correctness slice | recommends a key-value store because it scales and named products use one | do not infer fitness from adoption; first prove ordering, membership, idempotency, and recovery in one authority |
| Ordering | committed sequence local to one conversation | message ID determines sequence; local per-group ID is presented as preferable to global ID | confirmed conversation-local order, but allocate it transactionally with the message instead of assuming ID generation equals commit order |
| Multi-device sync | cursor per conversation and device | one device variable `cur_max_message_id`; fetch recipient messages with larger IDs | reject the global cursor because locally generated IDs from different conversations are not comparable |
| Group delivery | conversation log queried by authorized members | copy group messages to every recipient inbox | omit recipient copies for groups of 20; fanout is an optimization with its own partial-write and deletion semantics |
| Real-time path | notification/frame can be missed; database catch-up repairs | persistent chat server connections “deliver and synchronize” | keep socket write, device sync claim, and human read separate; real-time is never the durable authority |
| Membership | join/leave sequence intervals and rejoin generations | group membership races are not specified | retain explicit intervals so a send racing leave has one database-defined side of the boundary |
| Failure/security | ambiguous response retry, gateway death, missed hint, tickets, origin, limits, slow consumers | generic retry/queue/server reassignment; no idempotency, auth, origin, frame limit, backpressure, or reconnect cursor | retain executable crash and security boundaries rather than treating a queue or service discovery as recovery |

## Corrections that shape the implementation

1. The chapter's global `cur_max_message_id` rule conflicts with its local-per-group message IDs. A device cursor will therefore
   be keyed by conversation; no comparison is made across conversations.
2. A Snowflake-like ID can be sortable without representing database commit order. The slice locks one conversation row and
   updates `last_sequence` in the same transaction as message insertion. A rollback consumes no committed sequence.
3. PostgreSQL documents that `NOTIFY` inside a transaction is delivered only after commit, but it also documents a setup race for
   `LISTEN`. The listener must commit `LISTEN`, inspect durable state, then treat later notifications as hints; early duplicates
   are harmless. Message content stays in tables, and a notification payload carries only an opaque message ID.
4. PostgreSQL row locks block writers/lockers of the same row until transaction end. Send, add, leave, and rejoin use the same
   conversation lock so sequence and membership boundaries are deterministic. This is also an explicit hot-row limitation.
5. RFC 6455 requires implementations to bound frame and reassembled-message sizes and defines Ping/Pong for responsiveness. The
   gateway will cap inbound payload, cap buffered outbound bytes, and terminate connections that fail heartbeat.
6. The browser WebSocket constructor accepts a URL and optional subprotocols, not an arbitrary authorization-header object. A
   bearer-authenticated HTTP endpoint will issue a random, hashed, single-use, short-lived ticket for the upgrade URL. This ticket
   design is a repository mitigation, not a WebSocket-standard authentication scheme; theft before consumption remains a risk.
7. RFC 6750 recommends bearer credentials in the authorization header and warns that URL credentials are likely to be logged.
   The reusable token stays in the header. The one-use ticket may appear in the upgrade URL, so request logging must discard the
   query string and the ticket must expire and atomically consume.
8. `ws` 8.21.3 was the current npm release observed on the review date; its tag resolves to commit
   `c791e707eab3c13dd9a261d2479c3cc4a49a6fed` and the project is MIT-licensed. Its documented `noServer` upgrade pattern allows
   authentication before `handleUpgrade`, and its Ping/Pong recipe informs the heartbeat implementation. Those examples do not
   supply this repository's authorization or receipt semantics.
9. Discord's 2023 engineering article is a dated production case study, not a universal database prescription. It shows both
   why channel/time buckets and sortable IDs helped its workload and how hot partitions, compaction, and operational toil still
   forced architectural change. v0.1 does not add Cassandra/ScyllaDB or consistent-hash routing without comparable evidence.

## Source-informed design decisions

- PostgreSQL 17.6 is the v0.1 authority for conversations, membership generations, messages, device progress, and hashed
  real-time tickets. One conversation row serializes only that conversation.
- Sending remains an HTTP command with sender-scoped idempotency. Receiving uses WebSocket for low latency, while HTTP catch-up
  after a per-conversation sequence is the recovery protocol.
- Message insert and `pg_notify` execute in one transaction. Notification loss or gateway absence cannot lose the durable
  message; clients detect and repair gaps from PostgreSQL.
- Group membership history uses `join_after_sequence` and optional `leave_after_sequence`. A user sees a message only when its
  sequence lies inside at least one membership generation.
- Real-time tickets contain 32 random bytes, are stored only as SHA-256 hashes, expire quickly, bind user/device, and are consumed
  by one atomic update. An exact origin allowlist is checked before upgrade; external deployments require TLS.
- Outbound socket buffering has a hard cap. Slow connections are closed and must use catch-up rather than accumulating unbounded
  memory. A `send` callback is recorded only as `server_socket_write_callback`, never `delivered`.

## Primary sources

- [RFC 6455: The WebSocket Protocol](https://www.rfc-editor.org/rfc/rfc6455.html)
- [WHATWG WebSockets Standard](https://websockets.spec.whatwg.org/)
- [PostgreSQL 17: `NOTIFY`](https://www.postgresql.org/docs/17/sql-notify.html)
- [PostgreSQL 17: `LISTEN`](https://www.postgresql.org/docs/17/sql-listen.html)
- [PostgreSQL 17: Explicit Locking](https://www.postgresql.org/docs/17/explicit-locking.html)
- [RFC 6750: OAuth 2.0 Bearer Token Usage](https://www.rfc-editor.org/rfc/rfc6750.html)
- [Node.js Crypto API](https://nodejs.org/api/crypto.html)
- [`ws` 8.21.3 README](https://github.com/websockets/ws/tree/8.21.3)
- [Discord: How Discord Stores Trillions of Messages](https://discord.com/blog/how-discord-stores-trillions-of-messages)

The public bodies above were fetched into temporary evidence bundles and passed the repository fetch verifier. Search snippets
were candidate discovery only. The WHATWG and Node pages are living documentation, the Discord article is a 2023 snapshot, and
the observed npm release can change; implementation claims stay bound to the dated review and tested lockfile.

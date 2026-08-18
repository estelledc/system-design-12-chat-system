# Architecture

## Authority and process boundaries

PostgreSQL 17.6 is the only durable authority. The API process handles authenticated commands and synchronization. The real-time
process owns browser-compatible WebSocket upgrades and a dedicated `LISTEN` connection. Both read the same tables.

| Component | Owns | Does not own |
|---|---|---|
| API | validation, bearer mapping, idempotent commands, HTTP responses | connection presence or real-time durability |
| PostgreSQL | conversation order, membership intervals, messages, tickets, progress | client/device state or human evidence |
| `NOTIFY` | post-commit wake-up carrying one message UUID | durable queue, replay, authorization, message body |
| real-time gateway | ticket consumption, Origin check, local sockets, bounded writes, heartbeat | message history, durable delivery, client acknowledgement |
| client protocol | deduplicate by message ID/sequence and catch up after last known sequence | server-side acceptance authority |

## Send transaction

1. Validate the bearer, conversation UUID, client message ID, and 4 KiB body.
2. Begin a transaction and lock the conversation row with `FOR UPDATE`.
3. If `(sender, client message ID)` exists, compare the immutable request digest. Return the original on equality or conflict on
   difference.
4. Require an active sender membership generation.
5. Increment `last_sequence`, insert the message referencing that generation, and call `pg_notify` with the message UUID.
6. Commit. PostgreSQL exposes the notification only after commit.
7. Return `accepted`. If the process dies between steps 6 and 7, the client's exact retry converges on the stored row.

The lock orders all sends and membership mutations inside one conversation. Different conversations do not share this lock.

## Membership intervals

Each membership generation stores an exclusive lower bound and optional inclusive upper bound:

```text
generation 1: join_after=0, leave_after=4  -> visible sequences 1..4
generation 2: join_after=7, leave_after=null -> visible sequences 8..
```

Sequences 5–7 remain invisible after rejoin. History is not rewritten when current membership changes. The sender message row
also references the generation that authorized it.

## Real-time path and gap repair

The gateway establishes `LISTEN` before accepting sockets. It processes notifications in listener order, fetches the committed
message and active recipients, then writes a bounded public envelope to local open sockets. Multiple gateway replicas may all
receive the hint, but only the replica holding a recipient's socket writes to it. Sequential notification handling is a bounded
ordering aid and also a gateway throughput ceiling; it is not a substitute for client gap detection.

`LISTEN/NOTIFY` can miss a gateway outage and is subject to a startup observation race. The design does not attempt notification
replay. A client keeps its last conversation sequence, treats every frame as a hint, deduplicates, detects a gap, and calls:

```text
GET /v1/conversations/{conversationId}/messages?after={lastSequence}&limit=100
```

The database query re-applies historical membership authorization and returns ascending committed sequences. This is the only
recovery path claimed by v0.1.

## WebSocket lifecycle

1. An authenticated HTTP request issues 32 random bytes encoded as a 43-character base64url ticket.
2. Only SHA-256(ticket), user, device, creation, expiry, and consume time are stored.
3. Upgrade requires `/v1/realtime?ticket=<one value>` and an exact configured HTTP(S) Origin.
4. The ticket is atomically consumed before `handleUpgrade`. A failed later handshake consumes the ticket; the client requests a
   new one.
5. Application data is server-to-client only. Any client message closes the connection with code 1008.
6. Ping/Pong detects dead peers. A socket above the outbound buffer cap is terminated and must catch up.

The query ticket can still leak before first use through infrastructure outside this process. TLS, query suppression at every
proxy, and a narrow expiry remain deployment requirements.

## Scaling boundaries

- A hot conversation is limited by one PostgreSQL row lock. Sharding by conversation can preserve local order, but migration and
  routing are outside this slice.
- The gateway keeps local in-memory socket registries. Horizontal scale requires load balancing but no sticky send correctness,
  because every gateway sees notifications and checks only its local sockets.
- PostgreSQL sends every notification to every listening gateway. Large replica counts or high send rates may require an
  outbox/broker partitioned by conversation or recipient. That change must preserve commit lineage and catch-up authority.
- Membership-history queries are indexed but unbenchmarked for large churn. Snapshot/retention strategies are undefined.
- Message bodies share the primary database in v0.1. Attachments and long bodies need a separate object/metadata contract.

## Deliberately absent components

There is no Redis presence cache, Kafka queue, recipient inbox fanout, Snowflake service, Cassandra/ScyllaDB cluster, push
provider, service discovery, or multi-region coordinator. Each could be useful under a measured workload, but none is necessary
to prove the current invariants.

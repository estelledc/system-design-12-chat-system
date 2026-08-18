# Closed-book contract: Chat System

## Evidence boundary

- Frozen on 2026-08-19 (Asia/Shanghai) from the title “Chat System” only.
- Chapter 12 of `liquidslr/system-design-notes` and external chat-design articles have not been read for this contract.
- The product rules, numbers, architecture, and tests below are repository assumptions. They are not claims about WhatsApp,
  Messenger, iMessage, Signal, Slack, Feishu, Doubao, or any other product.
- After this file is committed, source comparison may correct the design in a research log or ADR. It must not rewrite this
  baseline to make later evidence look like prior knowledge.

## One executable question

> After a client sends a message, what can the service truthfully prove across retries, concurrent senders, membership races,
> a missing real-time hint, reconnect catch-up, multiple devices, and process death?

The v0.1 answer will be a bounded one-to-one and small-group chat, not a full social network. PostgreSQL will be the durable
authority. A per-conversation sequence will define one explainable order. WebSocket delivery will be an optional low-latency path;
cursor-based synchronization remains the recovery path. Durable acceptance, server socket write, client synchronization claim,
and human reading are separate facts.

## Scenario arithmetic, not a forecast

Assume, only to shape the experiment:

- 20 million daily active users and 50 messages per active user per day: 1 billion messages/day, about 11,574/second average;
- a declared 10x peak: about 115,741 accepted messages/second;
- 5 million simultaneous connections during a peak window;
- 500 bytes of raw message body and identity metadata per accepted message: about 500 GB/day before indexes, WAL, replicas,
  membership history, receipts, encryption overhead, and retention;
- one-to-one conversations and groups of at most 20 current members in the executable slice;
- message bodies of at most 4 KiB and catch-up pages of at most 100 messages.

These assumptions show that connections, durable writes, and group recipient work scale differently. The repository will test
correctness on small fixtures and report bounded raw timing. It will not claim to sustain these scenario rates.

## Users and frozen product behavior

- An authenticated user can create a one-to-one or small-group conversation, add a member, leave, send bounded text, synchronize
  history, open a real-time connection through a short-lived ticket, and submit bounded synchronization/read claims.
- A client supplies a stable `client_message_id`. Success means one immutable message is committed with one conversation sequence;
  it does not mean another process, socket, device, screen, or human received it.
- Exact retry by the same sender and client ID returns the original message. Changed content or conversation under that identity
  conflicts. Different senders may reuse the same client ID without collision.
- Each conversation has a contiguous committed sequence allocated by the same row-locked transaction as the message. There is no
  cross-conversation order, causal order across independent clients, or trustworthy order from client clocks.
- A member added after sequence `n` may see messages strictly after `n`, not earlier history. A member who leaves after sequence
  `n` may still synchronize through `n` but cannot see or send later messages. Membership changes and message acceptance serialize
  on the conversation row so a race has one database-defined side of the boundary.
- A PostgreSQL notification or in-process publication may wake connected gateways after commit. It is a hint, not a durable
  queue. A missed hint is repaired by synchronizing messages after the last durable client cursor.
- A real-time frame may contain an accepted message envelope. A server write callback proves only the server-side socket action.
  The client must still deduplicate by message ID/sequence and later synchronize any gap.
- A device synchronization claim says that an authenticated client reported durable local progress through a sequence. A read
  claim says that the authenticated client reported presentation through a sequence. Neither proves physical storage, screen
  display, attention, comprehension, or the human who acted.
- A user may have multiple device IDs. Device synchronization progress is independent and monotonic. A conversation-level read
  projection may take the maximum accepted claim, but it remains a client assertion, not human evidence.

## Non-goals

- Attachments, image/video/audio storage, thumbnails, calls, live rooms, reactions, threads, edits, deletion/recall, search,
  mentions, typing indicators, push notifications, bots, moderation, spam detection, link previews, or billing.
- End-to-end encryption, key verification, encrypted backups, legal hold/erasure, child safety, abuse reporting, data residency,
  private-contact discovery, or metadata minimization beyond the explicit logging contract.
- Massive broadcast groups, channels, public communities, cross-region active-active writes, database failover, production
  capacity, deployment, SLA, or external acceptance.
- Exactly-once network delivery or human-visible delivery. The implementation may prove database idempotency and gap-free
  synchronization for its bounded authority only.

## State and consistency contract

### Planned source-of-truth records

- `users` and `devices`: synthetic authenticated actors and bounded device identity/status.
- `conversations`: type, creator, maximum members, and last committed sequence; this row serializes membership and sends.
- `conversation_memberships`: user, generation, join-after sequence, optional leave-after sequence, and timestamps.
- `messages`: conversation sequence, server ID, sender, client message ID, immutable request digest/body, and accepted time.
- `realtime_tickets`: hashed, short-lived, single-use tickets that bind user and device without putting the reusable bearer in a
  WebSocket URL.
- `device_progress`: monotonic synchronized-through and client-claimed-read-through sequence per device and conversation.
- `message_attempts` or bounded receipts only where an executed action needs durable lineage; no table is added solely for a
  diagram.

### Required invariants

1. **Stable message identity:** `(sender_id, client_message_id)` binds one immutable conversation and content digest forever;
   exact replay returns the same server message and sequence, while changed intent conflicts.
2. **Atomic sequence:** allocating the next conversation sequence and inserting the message are one transaction. A rollback
   consumes no committed position, and accepted messages form `1..last_sequence` without application-created gaps.
3. **One active membership generation:** a user has at most one active generation in a conversation. Rejoin creates a new
   generation rather than silently changing the old history boundary.
4. **Serialized membership boundary:** add, leave, rejoin, and send lock the conversation row. A message sequence is either inside
   or outside a membership interval; wall-clock tie-breaking is not used.
5. **Authorized synchronization:** each returned message sequence lies in the authenticated user's current or historical
   membership interval. A guessed cursor cannot widen that interval.
6. **Gap repair:** real-time is advisory. Synchronizing after sequence `n` returns the next authorized committed sequences in
   order; replaying a page cannot create a second message identity.
7. **Monotonic device progress:** synchronized/read claims never move backward, never exceed the conversation's committed
   sequence, and never cross the device user's membership boundary.
8. **Ticket confinement:** a real-time ticket is random, hashed at rest, short-lived, bound to one user/device, and consumed at
   most once. Reusable bearer tokens are accepted only in the HTTP authorization header.
9. **Receipt honesty:** `accepted`, `server_socket_write`, `client_synced_claim`, and `client_read_claim` remain distinct states.
   None is renamed `delivered` or `read_by_human` without stronger external evidence.
10. **Identity minimization:** application logs contain bounded state, counts, opaque correlation hashes, and reason codes, not
    bearer/ticket values, raw user/device IDs, client message IDs, message text, or synchronization cursor bodies.

## Minimal API and process boundary

Planned commands and routes, subject to source-informed ADR review:

- `POST /v1/conversations`: create a direct or group conversation with bounded initial members;
- `PUT /v1/conversations/{id}/members/{user}` and `DELETE /v1/conversations/{id}/members/me`: serialized membership changes;
- `POST /v1/conversations/{id}/messages`: bearer-authenticated idempotent acceptance;
- `GET /v1/conversations/{id}/messages?after=...&limit=...`: authoritative ordered catch-up;
- `POST /v1/realtime-tickets`: issue a one-use ticket for an authenticated device;
- `GET /v1/realtime?ticket=...` upgraded to WebSocket: low-latency envelopes and explicit gap metadata;
- `PUT /v1/conversations/{id}/progress`: monotonic client synchronization/read claims;
- separate `serve-api`, `serve-realtime`, `stats`, and migration commands where process separation makes a failure observable.

The first implementation choice is Node.js 22/24/26, built-in HTTP plus one locked WebSocket dependency, and PostgreSQL 17.6.
No Redis, Kafka, Cassandra, or service-discovery layer will be added until a current invariant or measured failure requires it.

## Failure windows to make executable

| Window | Expected durable evidence | Recovery rule |
|---|---|---|
| before send transaction commit | no accepted message or sequence | retry the same client message ID |
| after commit, before HTTP response | one accepted message exists; client sees an ambiguous timeout | retry converges to original ID and sequence |
| after commit, before real-time hint | durable message exists; connected recipient may see nothing | cursor catch-up returns it |
| gateway dies after socket write | server may have written; client receipt is unknown | reconnect and deduplicate/catch up after last durable cursor |
| concurrent sends | transaction lock chooses sequences | clients render sequence order, not request completion time |
| add/leave races with send | conversation lock commits one order | membership interval includes or excludes the message deterministically |
| same client retries on two API processes | unique identity and row lock converge | one message and one sequence; changed intent conflicts |
| device repeats or regresses progress | old/new claims coexist at boundary | store the monotonic maximum or reject an impossible claim |
| ticket copied or replayed | only a ticket hash remains after issue | expiry or first atomic consume rejects it |

## Acceptance evidence

1. Deterministic tests for canonical message identity, body/device bounds, cursor/ticket handling, receipt vocabulary, and safe logs.
2. Real PostgreSQL tests for concurrent send replay/conflict, contiguous per-conversation sequences, independent conversation
   progress, membership generation races, monotonic device progress, and atomic ticket consumption.
3. Real HTTP/WebSocket tests proving an authenticated recipient receives ordered envelopes while an outsider receives none;
   duplicate real-time frames remain harmless when followed by authoritative catch-up.
4. A process smoke that commits a message, kills the API before its response or the gateway around a real-time boundary, retries,
   reconnects from the last cursor, and proves one durable message with no gap and an explicit evidence-layer receipt.
5. A counterexample that socket write without client acknowledgement cannot be called device delivery, plus a missed-hint case
   recovered entirely from PostgreSQL.
6. A bounded benchmark for transactional acceptance, concurrent conversation serialization, and catch-up pages. Shared-runner
   time is reported with inputs and exclusions, never used as a production capacity promise.
7. Public CI on Node 22/24/26 with PostgreSQL 17.6, 0 skipped tests, pinned Actions, minimum permissions, lockfile, dependency
   audit, MIT license, clean default branch, exact commit, and run receipts.

## Questions reserved for source comparison

- Which functional and scale assumptions does the fixed chapter make, and which are synthetic, stale, or unsupported?
- Does it distinguish message acceptance, real-time transport, device receipt, and human read, or collapse them into “delivered”?
- How does it define one-to-one versus group ordering, multiple devices, membership changes, retries, and offline synchronization?
- Are WebSocket lifecycle, reconnect cursors, backpressure, slow consumers, gateway death, and missed events specified?
- Which storage/sharding choices are mechanisms versus requirements, and what migration or consistency assumptions do they hide?
- Which current primary sources are required for WebSocket security/lifecycle, PostgreSQL transaction semantics, HTTP bearer use,
  cryptographic ticket handling, and any dependency chosen after this baseline?

## Stop line

The repository is complete only when one minimal slice and all claimed acceptance receipts are public and green. If a feature
cannot be tied to a frozen requirement, observed failure, direct caller state, or security/data-integrity boundary, it will not
be added. The chapter comparison may change the design, but it cannot erase this baseline or upgrade a server-side event into
device/human delivery evidence.

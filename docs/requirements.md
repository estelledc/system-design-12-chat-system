# Requirements and invariants

## Product slice

An authenticated synthetic user can create a direct conversation or a group with at most 20 active members, accept immutable
text messages, synchronize authorized history, open a server-to-client WebSocket, leave or rejoin a group, and record per-device
progress claims.

The body limit is 4 KiB of UTF-8. History pages contain at most 100 messages. The implementation has no attachment, edit,
deletion, presence, push, search, public channel, call, moderation, end-to-end encryption, or cross-region contract.

## Scenario arithmetic

The closed-book exercise assumes 20 million daily active users, 50 messages per active user per day, a declared 10x peak, and
5 million simultaneous connections. That yields about 11,574 average sends/second and 115,741 peak sends/second. These are input
assumptions used to expose separate write, connection, and group-fanout costs. They are not measurements or forecasts.

The executable repository proves correctness only on bounded fixtures and reports raw shared-runner timings. No benchmark in
this repository establishes production capacity.

## Functional rules

1. A create request supplies an idempotency key. An exact replay returns the same conversation; changed normalized membership or
   type conflicts.
2. A message supplies a stable client message ID. The pair `(sender, client message ID)` permanently binds one conversation and
   content digest. Exact replay returns the original result; changed intent conflicts.
3. Every committed message receives the next sequence in its conversation. No order is claimed across conversations or from
   client clocks.
4. Adding, leaving, rejoining, and accepting messages serialize on the conversation row. The committed sequence decides which
   membership generation can see a racing message.
5. A joining member sees only sequences strictly above `join_after_sequence`. A leaving member retains visibility through
   `leave_after_sequence`. Rejoin creates a new interval.
6. HTTP synchronization returns only ordered sequences that lie inside at least one membership interval for the caller.
7. WebSocket is server-to-client only. A notification wakes a gateway, which rereads the authoritative message and current
   recipients. Missing or duplicate frames are repaired through HTTP synchronization.
8. Device progress never moves backward. A read claim cannot exceed the same request's synchronized-through value, the current
   conversation sequence, or the caller's membership visibility.
9. A reusable bearer is accepted only in the HTTP authorization header. WebSocket upgrade uses an exact Origin and a random,
   hashed, expiring, atomic one-use ticket.
10. A server write callback is not a device acknowledgement, screen display, or human read.

## Evidence vocabulary

| Label | What exists | What it does not prove |
|---|---|---|
| `accepted` | message row and sequence committed, or exact retry found them | a gateway, device, screen, or human received it |
| `server_socket_write_callback` | the WebSocket library completed its local send callback without an error | remote kernel receipt, device persistence, display, or reading |
| `server_sync_response` | server returned authorized committed rows after a cursor | client stored or displayed the response |
| `client_claim_accepted` | server accepted monotonic synchronized/read fields from an authenticated device identity | physical durability, display, attention, comprehension, or actor identity |

## Data invariants

- `conversations.last_sequence` equals the highest committed sequence in that conversation.
- `(conversation_id, sequence)` is unique; committed service-created messages are contiguous from 1.
- `(sender_id, client_message_id)` is unique and guarded by an immutable request digest.
- `(conversation_id, user_id)` has at most one membership row without a leave boundary.
- every message references the sender's exact membership generation.
- a ticket hash is unique and a successful consume writes `consumed_at_ms` atomically.
- `(user_id, device_id, conversation_id)` has one monotonic progress row.

## Explicit limits

- Groups contain 2–20 active users including the owner; direct membership is immutable after creation.
- The group owner cannot leave in v0.1 because ownership transfer and group deletion are not defined.
- Tickets live for 1–300 seconds by configuration; the default is 60 seconds.
- One process accepts at most 16 KiB HTTP bodies, 64 KiB outbound WebSocket buffering by default, and 1 KiB inbound frames by
  default. Inbound application frames are closed with policy code 1008 regardless of size.
- One conversation row is a deliberate serialization point and a known hot-key ceiling.

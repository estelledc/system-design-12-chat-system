# Threat model

## Protected assets

- reusable HTTP bearer values;
- one-use real-time tickets;
- raw user/device and client message identifiers;
- message content and conversation membership;
- authorization boundaries across membership generations;
- immutable idempotency bindings and per-conversation sequence integrity;
- device progress claims and their limited evidence meaning.

This repository uses synthetic identities and data. It does not implement the privacy, encryption, retention, deletion, abuse,
legal, or compliance controls required for a real messenger.

## Trust boundaries

1. HTTP clients are untrusted until the configured bearer maps to one synthetic user.
2. A browser WebSocket request is untrusted until its Origin is exactly allowed and its ticket is atomically consumed.
3. Application processes trust PostgreSQL as their durable authority but treat connection and query failures as dependency
   failures, not absent data.
4. PostgreSQL notifications and WebSocket frames are hints. Authorization is reread from tables, and clients recover from the
   durable log.
5. Client synchronization/read fields are authenticated assertions. The server cannot observe physical persistence, pixels,
   attention, comprehension, or which human held a device.

## Threats and implemented controls

| Threat | Current control | Residual risk |
|---|---|---|
| bearer disclosure in a URL | reusable bearer accepted only in HTTP header | upstream access logs and client storage are deployment concerns |
| WebSocket cross-site use | exact HTTP(S) Origin allowlist before ticket consumption | non-browser clients can forge Origin; the ticket remains required |
| ticket database disclosure | SHA-256 hash at rest, random 32-byte value, short expiry, atomic one-use consume | theft before first use and URL leakage outside this process remain possible |
| replayed send after timeout | sender/client ID uniqueness plus immutable request digest | client must retain the same ID for the same intent |
| changed request under old ID | explicit 409 conflict | no user-facing reconciliation workflow exists |
| membership race | conversation row lock and sequence intervals | one hot group serializes; owner transfer is absent |
| guessed conversation/cursor | UUID validation plus historical membership predicate | traffic analysis and existence timing are not comprehensively masked |
| oversized body/frame | 16 KiB HTTP body, 4 KiB message, configured WebSocket `maxPayload` | proxy and transport limits must also be configured |
| slow/dead socket | outbound buffer cap, Ping/Pong heartbeat, termination and catch-up | no admission control or global connection budget exists |
| missed/duplicate notification | durable message table and ordered catch-up | clients must implement gap detection correctly |
| log disclosure | bounded event kinds, counts, booleans, reason/evidence codes; no request URL logging | database/proxy/platform logs are outside repository control |
| receipt overclaim | distinct acceptance, socket-write, sync-response, and client-claim labels | downstream analytics/UI can still misuse labels |
| SQL injection | parameterized values; fixed notification channel | schema/operator access remains highly privileged |
| dependency compromise | exact lockfile, disabled install scripts in CI, high-severity audit, pinned Actions | audit is incomplete supply-chain assurance |

## Fail-closed behavior

- Invalid or duplicated ticket query fields return 401 without revealing ticket state.
- A disallowed Origin returns 403 before ticket consumption.
- Unknown membership and unauthorized resources use 404 to avoid a separate authorization oracle.
- Database failures become 503 and do not fall back to in-memory acceptance.
- A ticket consumed before a later handshake failure is not restored.
- A notification without an authoritative message row produces no frame.
- An outbound buffer above the cap terminates the socket; messages remain available through catch-up.
- The group owner cannot leave because ownership transfer semantics are undefined.

## Not implemented

- TLS termination, proxy configuration, rate limiting, credential rotation, secret storage, session revocation, audit retention;
- end-to-end encryption, transport certificate pinning, metadata minimization, encrypted backups, key management;
- account recovery, device verification, contact discovery, spam/abuse systems, reporting, blocking, moderation;
- data retention/deletion, legal hold, regional residency, backup restore, disaster recovery;
- tenant isolation, administrator authorization, production identity provider integration, penetration testing.

Do not deploy this learning slice with real identities or content.

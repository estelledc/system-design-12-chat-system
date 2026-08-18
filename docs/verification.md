# Verification

## Current receipt

The implementation is complete locally at the pure-test layer. Real PostgreSQL 17.6 execution and public CI receipts are pending
the first implementation push; this file will record immutable run and commit identifiers after that gate executes.

| Gate | Current result | What it proves |
|---|---|---|
| JavaScript syntax and repository policy | ready; not yet public | files parse and repository-required artifacts are present |
| pure tests | 17 passing, 0 skipped on the development runtime | contracts, service evidence labels, HTTP behavior, safe logs, and local WebSocket policy |
| dependency audit | 0 known high-severity findings at install time | npm advisory database found no issue at the configured threshold; not full supply-chain assurance |
| PostgreSQL integration | pending public PostgreSQL 17.6 run | concurrency, membership intervals, notification commit behavior, ticket consume, progress |
| process smoke | pending public PostgreSQL 17.6 run | ambiguous API response retry, real socket write, gateway outage, database catch-up |
| bounded benchmark | pending public PostgreSQL 17.6 run | raw timing for a small synthetic fixture, not production capacity |

## Full gate

```bash
npm ci --ignore-scripts
npm run check:ci
```

The full script executes:

1. repository file, syntax, portable-path, link, CI pin, lockfile, and evidence-language checks;
2. pure Node tests with no skip marker;
3. `npm audit --audit-level=high`;
4. PostgreSQL tests that reset a disposable `public` schema;
5. a process smoke that uses `SIGKILL` after commit but before the HTTP response, then restarts and retries;
6. a real WebSocket write followed by gateway downtime and ordered HTTP catch-up;
7. a bounded hot-conversation acceptance, history synchronization, and ticket round-trip benchmark.

## Tested counterexamples

- Two concurrent identical sends create one message identity; changed content under the same identity conflicts.
- A member who leaves at sequence 1, misses sequence 2, and rejoins after 2 sees sequences 1 and 3 but not 2.
- A transaction that calls `pg_notify` then rolls back emits no observed notification.
- A consumed or exactly expired real-time ticket is rejected.
- A device cannot advance progress to a sequence outside its historical visibility.
- A disallowed Origin is rejected before ticket consumption.
- A client application frame closes the server-to-client-only WebSocket with policy code 1008.
- Killing the API after database acceptance and before its response leaves one message; exact retry returns it.
- A message committed while the gateway is down is recovered through PostgreSQL catch-up after restart.

## Evidence boundaries

Even a fully green gate does not prove:

- production load, 5 million sockets, or the scenario rates in the requirements;
- cross-region consistency, database failover, backup restore, or zero data loss;
- TLS/proxy configuration or query suppression outside the Node processes;
- notification delivery during downtime; the design expects it to be missed;
- device receipt or durable local storage from a server socket write callback;
- screen display, accessibility announcement, human attention, comprehension, or authorship;
- end-to-end encryption, privacy compliance, abuse safety, legal retention/deletion, or external acceptance.

The smoke reports `screenDisplayClaims: 0` deliberately. A server-side callback must never be upgraded into a screen display or
human-read claim.

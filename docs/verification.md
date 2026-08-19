# Verification

## Current receipt

The identity-safe rewrite preserved every existing tree, message, and timestamp while mapping the four commits in order: `d735d69d2711f67ab9e76216c7d67855c2bfe041` → `0b4e1f40bca23b6dbaacb9ca52314cde9d15b4ca`, `edb7d227c8f96c54e199117cd32a11fdf865b902` → `e2688ba8b08c2fc0feb2e9a6a282ec3b8e1fb504`, `2bb5085d2029122650147b8f0c8dbd2589180ef6` → `70e468f0da25d39456ba2de9cc058505320c4978`, and `84f9f0cbac5312783e83c5cef427c18b7038eebd` → `353d585762d84ab76b63e5c86d467e59b0bb0581`.

The first public implementation gate passed the tree now at commit `70e468f0da25d39456ba2de9cc058505320c4978` in historical pre-rewrite GitHub Actions run [`32168305624`](https://github.com/estelledc/system-design-12-chat-system/actions/runs/32168305624). The run remains bound to the old commit object. All Node 22.23.2,
24.19.0, and 26.7.0 jobs used PostgreSQL 17.6 and completed the same full gate.

Current reachable `main` uses the repository owner's GitHub noreply identity. Rewritten baseline `353d585762d84ab76b63e5c86d467e59b0bb0581` passed [CI run 32225303274](https://github.com/estelledc/system-design-12-chat-system/actions/runs/32225303274) on Node 22, 24, and 26 with PostgreSQL 17.6 and the full quality gate.

| Gate | Current result | What it proves |
|---|---|---|
| JavaScript syntax and repository policy | 39 files checked in every matrix job | files parse and repository-required artifacts are present |
| pure tests | 17/17 passing per job, 0 skipped | contracts, service evidence labels, HTTP behavior, safe logs, and local WebSocket policy |
| dependency audit | 0 known high-severity findings in every job | npm advisory database found no issue at the configured threshold; not full supply-chain assurance |
| PostgreSQL integration | 6/6 passing per job, 0 skipped | concurrency, membership intervals, notification commit behavior, ticket consume, progress |
| process smoke | passed per job with the same semantic receipt | ambiguous API response retry, real socket write, gateway outage, database catch-up |
| bounded benchmark | completed per job; raw values below | timing for a small synthetic fixture, not production capacity |

The smoke receipt in all three jobs reported:

```json
{"apiCrashSignal":"SIGKILL","retryCreated":false,"persistedSequences":[1,2,3],"realtimeEvidence":"server_socket_write_callback","gatewayRestarted":true,"catchupSequences":[3],"progressEvidence":"client_claim_accepted","screenDisplayClaims":0}
```

Shared-runner benchmark inputs were one 10-member conversation, 180 accepted messages, paged synchronization of those 180
messages, and 80 issue/consume ticket round trips:

| Node | acceptance transactions/s | synchronized messages/s | ticket round trips/s |
|---|---:|---:|---:|
| 22.23.2 | 381.331 | 30,974.696 | 418.590 |
| 24.19.0 | 292.997 | 24,254.900 | 350.330 |
| 26.7.0 | 287.897 | 27,730.038 | 375.687 |

These single-run values include a shared GitHub runner and one local service container. They are observations, not stable
comparisons between Node versions or capacity promises.

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

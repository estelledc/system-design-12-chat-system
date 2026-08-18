# Operations

## Runtime matrix

- Node.js: 22, 24, or 26; `.node-version` selects 22 as the local baseline.
- PostgreSQL: 17.6 in Compose and CI.
- Processes: `serve-api` and `serve-realtime` are intentionally separate so their failure windows can be observed.

Install with the committed lockfile and disabled dependency lifecycle scripts:

```bash
npm ci --ignore-scripts
docker compose up -d postgres
export DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/chat_system
```

## Commands

| Command | Purpose |
|---|---|
| `node src/main.js migrate` | idempotently apply v0.1 tables and indexes |
| `node src/main.js stats` | print aggregate counts only |
| `node src/main.js serve-api` | start command, catch-up, ticket, progress, and health HTTP routes |
| `node src/main.js serve-realtime` | establish `LISTEN`, then start health and WebSocket upgrade handling |
| `npm run check` | static checks, pure tests, and high-severity dependency audit |
| `npm run test:postgres` | real database correctness tests; resets the configured `public` schema |
| `npm run smoke:postgres` | destructive process-death and reconnect smoke; resets the configured `public` schema |
| `npm run benchmark:postgres` | bounded raw timings; adds synthetic rows to the configured database |
| `npm run check:ci` | full gate in the order above |

Integration and smoke commands are destructive to the `public` schema. Use a disposable database only.

## Environment

| Variable | Required/default | Boundary |
|---|---|---|
| `DATABASE_URL` | required | PostgreSQL connection string; never print it |
| `AUTH_TOKENS_JSON` | required for servers | nonempty array of `{token,userId}`; token length 16–256 |
| `ALLOWED_ORIGINS_JSON` | required for gateway | nonempty exact HTTP(S) origins |
| `HOST` | `127.0.0.1` | listen address |
| `PORT` | API `3000`, gateway `3001` | 0 is allowed for test-assigned ports |
| `REALTIME_TICKET_TTL_MS` | `60000` | 1,000–300,000 milliseconds |
| `MAX_WEBSOCKET_PAYLOAD_BYTES` | `1024` | 1–65,536; inbound app messages are still forbidden |
| `MAX_WEBSOCKET_BUFFERED_BYTES` | `65536` | 1–16,777,216 |
| `WEBSOCKET_HEARTBEAT_MS` | `30000` | 1,000–300,000 milliseconds |
| `CRASH_AFTER_NEW_MESSAGE_ACCEPTED` | unset | smoke-only: `1` kills API after commit and before response |

## Startup order

1. PostgreSQL becomes reachable.
2. Run migrations from one controlled release step. `CREATE ... IF NOT EXISTS` makes v0.1 reruns safe but is not a general
   migration framework.
3. Start the real-time gateway. It completes `LISTEN` before binding its port.
4. Start API processes.
5. Verify each `/healthz`, then execute one synthetic send plus catch-up if an end-to-end readiness claim is needed. Gateway
   health fails if its dedicated notification connection reports an error, so an orchestrator can replace the process.

A health response proves only a current database query and, for the gateway, listener readiness. It does not exercise an actual
notification, upgrade, or synchronization.

## Shutdown

`SIGTERM` or `SIGINT` stops new HTTP acceptance, closes the notification listener and WebSockets, then ends the database pool.
Clients must interpret a gateway disconnect as an instruction to reconnect with a new ticket and synchronize after their last
conversation sequence.

## Failure playbook

### API dies around message acceptance

- The client retries the identical request with the same client message ID.
- 201 means the retry created it; 200 means an earlier attempt already committed.
- 409 means the ID was reused for different intent and must not be silently overwritten.

### Gateway or notification listener dies

- Restart the process; tickets already consumed by dead sockets are not reusable.
- Clients request new tickets and synchronize every active conversation after its last local sequence.
- Do not attempt to reconstruct history from notification logs.

### Slow consumer termination

- The gateway logs `slow_consumer_terminated` without identity or content.
- The client reconnects and catches up. Increasing the buffer is not the first repair because it can turn one slow peer into
  unbounded process memory.

### PostgreSQL unavailable

- Commands return 503; no in-memory fallback accepts messages.
- Gateway health fails and notification reads stop. Already open sockets do not become a durable queue.
- Recovery requires database restoration/failover procedures that this repository does not implement or test.

## Safe logging

Application logs may contain event kind, status/error code, counts, booleans, configured port, runtime version, and evidence
labels. They must not contain database URLs, bearers, tickets, user/device IDs, client message IDs, content, conversation/message
IDs, or cursor values. Infrastructure access logs must suppress `/v1/realtime` query strings independently.

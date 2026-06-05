# Time-Off Microservice + Mock HCM

A production-style distributed backend that manages employee time-off requests,
maintains local balance projections, synchronizes with an external HCM system,
and supports reconciliation — with a mock HCM service for integration testing.

See [Implementation Plan.md](./Implementation%20Plan.md) for the full phased plan.

## Documentation

- [docs/TRD.md](./docs/TRD.md) — technical design: decisions, trade-offs, reconciliation strategy, consistency model
- [docs/architecture.md](./docs/architecture.md) — component + sequence diagrams (request lifecycle, failure/compensation, reconciliation, concurrency)
- [docs/api-spec.md](./docs/api-spec.md) — full REST reference for both services
- Live OpenAPI/Swagger: **http://localhost:3000/docs** and **http://localhost:3100/docs**; static specs in [docs/](./docs/) (`npm run export:openapi`)

## Tech Stack

| Component         | Technology        |
| ----------------- | ----------------- |
| Backend Framework | NestJS            |
| Language          | TypeScript        |
| Database          | SQLite            |
| ORM               | Prisma            |
| Testing           | Jest + Supertest  |
| Scheduler         | NestJS Schedule   |
| API Spec          | OpenAPI / Swagger |

## Repository Structure

```text
/apps
  /timeoff-service   NestJS service: time-off APIs, balances, reconciliation
  /mock-hcm          NestJS service: simulated external HCM
/packages
  /shared-types      Domain types shared across services
/docs                TRD, architecture, API spec
/tests               Integration + e2e tests
/docker              Container assets
```

## Prerequisites

- Node.js 20+ (developed on v22)
- npm 10+

SQLite is file-based, so no database server or container is required.

## Setup

Dependencies are installed per app:

```bash
npm --prefix apps/timeoff-service install
npm --prefix apps/mock-hcm install
```

Generate the Prisma client (timeoff-service):

```bash
npm --prefix apps/timeoff-service exec prisma generate
```

## Running

```bash
# Time-off service (http://localhost:3000)
npm run start:timeoff:dev

# Mock HCM (http://localhost:3100)
npm run start:hcm:dev
```

## Database

The Prisma datasource uses SQLite via `DATABASE_URL="file:./dev.db"`
(see `apps/timeoff-service/.env`). The schema defines four tables:
`balances`, `requests`, `ledger` (append-only audit), and
`reconciliation_logs`. Apply migrations with:

```bash
npm run prisma:migrate
```

Inspect data with Prisma Studio:

```bash
npm run prisma:studio
```

Seed local balances (mirrors the mock HCM seed so the time-off APIs have pools
to reserve against in development):

```bash
npm run db:seed
```

## Time-Off Service

The time-off service (http://localhost:3000) owns request lifecycle and the
**local** balance projection. A request follows a reserve-then-commit flow so a
held balance is never double-spent:

```text
POST /requests   → validate available balance, reserve it, status RESERVED
        approve  → call HCM deduct; on success spend the hold locally → APPROVED
                   on HCM failure → roll the hold back, status FAILED_SYNC
        reject   → release the hold → REJECTED
```

`availableBalance = totalBalance − reservedBalance`. Reserving raises
`reservedBalance`; approval lowers both `totalBalance` and `reservedBalance`
(net-neutral to available, since it was already held); rejection lowers
`reservedBalance` only. Every movement appends an immutable `ledger` row.

| Method & path                | Purpose                                              |
| ---------------------------- | ---------------------------------------------------- |
| `POST /requests`             | Create a request; reserves balance (422 if short)    |
| `GET  /requests`             | List/filter requests (`?status=`, `?employeeId=`, `?locationId=`) |
| `GET  /requests/:id`         | Fetch a request (404 if unknown)                     |
| `POST /requests/:id/approve` | Confirm with HCM and deduct (409 unless RESERVED)    |
| `POST /requests/:id/reject`  | Release the reservation (409 unless RESERVED)        |
| `GET  /balances/:employeeId` | Local projected balance(s) with derived `available`  |
| `POST /reconcile`            | Reconcile the whole corpus now; returns a drift summary |
| `POST /reconcile/:employeeId`| Realtime refresh of one employee from HCM (404 if HCM doesn't know them) |
| `GET  /reconcile/logs`       | Recent `reconciliation_logs` entries (newest first)  |
| `GET  /metrics`              | Operational snapshot (request counters, HCM health, drift) |

```jsonc
// POST /requests
{ "employeeId": "EMP-001", "locationId": "LOC-NYC", "days": 5, "reason": "vacation" }
```

> Balances are pooled per `(employeeId, locationId)`, so a request names the
> `locationId` it draws from. An employee can hold independent pools at several
> locations; a request reserves against exactly the one it targets (unknown
> location → `404`, missing `locationId` → `400`). `GET /balances/:employeeId`
> returns all of an employee's per-location pools.

### Concurrency protection

Every balance mutation is **optimistically locked** on the `version` column: the
update only matches when the row still carries the version that was read, and it
bumps that version in the same statement. Two requests that read the same pool
and both try to reserve the now-stale snapshot can't both win — the loser's
guarded update touches zero rows, the read-modify-write is retried on fresh data,
and it either succeeds against the new balance or fails its own `available >=
days` check (`422`). This prevents **double allocation**: concurrent reservations
can never push `reservedBalance` above `totalBalance`.

```text
balance available = 10
  request A = 7  ─┐
  request B = 6  ─┴─→ exactly one reserves; the other gets 422 (now insufficient)
```

A retried write that still can't land after a small bound surfaces as `409`. See
the integration proof in
[requests.concurrency.spec.ts](apps/timeoff-service/src/requests/requests.concurrency.spec.ts).

### Reconciliation

The HCM is the **source of truth** for an employee's entitlement, so the local
projection can drift when the HCM changes outside our flow (an anniversary bonus,
an HR correction). A scheduled job (`@Cron`, every 10 min) pulls
`GET /balances/full-sync`, compares each HCM pool's `balance` against the local
`totalBalance`, and repairs any difference:

```text
for each HCM pool:
  no local pool   → create it from HCM
  total drifted   → set local total = HCM balance, append a RECONCILE ledger row
                    + a reconciliation_logs row (previous, corrected, drift)
  in sync         → leave it alone (no phantom write)
```

Only the entitlement **`totalBalance`** is reconciled — local `reservedBalance`
(pending holds not yet pushed to HCM) is never touched. The repair runs through
the same optimistic-lock guard as every balance write, so a user reservation
racing a repair can't be clobbered: the conflicted pool is skipped and settles on
the next pass (eventual consistency). The job is idempotent — a second run with no
new drift is a clean no-op — and an HCM outage is logged and swallowed by the cron
(the on-demand `POST /reconcile` surfaces it as `503`).

Trigger a pass on demand and inspect the audit trail:

```bash
curl -X POST http://localhost:3000/reconcile           # whole corpus (HCM full-sync)
curl -X POST http://localhost:3000/reconcile/EMP-001    # one employee, realtime (HCM per-employee read)
curl http://localhost:3000/reconcile/logs
```

`POST /reconcile/:employeeId` uses the HCM's **realtime per-employee API** to
refresh a single employee immediately — so an employee who just received a
work-anniversary bonus gets an accurate balance now instead of waiting for the
next sweep. Disable the scheduled (whole-corpus) sweep with `RECONCILE_DISABLED=true`.

### Failure handling & idempotency

Distributed calls fail, and clients retry. Three mechanisms keep that safe:

- **HCM retry policy** — the Axios client retries transient faults (network /
  timeout / 5xx) with bounded exponential backoff; deterministic `4xx` business
  rejections are surfaced verbatim and never retried.
- **Compensation** — if the HCM deduction can't be confirmed at approve time, the
  local hold is **rolled back** (a `RELEASE` ledger row returns the days to the
  pool) and the request is marked `FAILED_SYNC`. The total is never touched
  because it was never deducted. The deduct is sent with the request id as its
  `Idempotency-Key`, so if the HCM *had* in fact applied it, a later retry won't
  double-deduct and reconciliation pulls the authoritative total back down.
- **Defensive about HCM's responses** — we don't assume HCM always errors when it
  should. A *deterministic* HCM rejection (4xx — invalid combination, insufficient)
  is surfaced **verbatim** to the caller (retrying won't help); only *transient*
  faults (network / timeout / 5xx, retries exhausted) collapse to a `503`. And a
  `2xx` from HCM isn't trusted blindly — its returned balance is sanity-checked
  (a non-numeric body is treated as a failed sync; a negative balance is flagged).
  Either way the local hold is rolled back rather than committed on bad data.
- **Idempotency keys** — an optional `Idempotency-Key` header makes operations
  duplicate-safe. On `POST /requests`, repeating a key returns the original
  request instead of reserving a second time (a unique DB constraint settles
  concurrent races). The mock HCM honours the same header on `POST /balances/deduct`,
  applying a keyed deduct exactly once and replaying the original result.

```bash
# Reserve once even if the client sends it twice:
curl -X POST http://localhost:3000/requests -H "Idempotency-Key: abc-123" \
  -H "Content-Type: application/json" \
  -d '{ "employeeId": "EMP-001", "locationId": "LOC-NYC", "days": 3 }'
```

### Observability

Three things make the distributed flow operable:

- **Correlation IDs** — every request is tagged with an `x-correlation-id` (adopted
  from the inbound header or minted), echoed on the response, held in
  `AsyncLocalStorage`, and **forwarded to the HCM**. The mock HCM adopts it too, so
  a single operation shows the **same trace id in both services' logs** —
  e.g. a failed approval logs `[<id>] … FAILED_SYNC` in time-off and
  `[<id>] … simulating upstream error` in the HCM.
- **Structured logging** — a custom `LoggerService` routes every existing log line
  through a consistent shape (timestamp, level, context, correlationId). Pretty
  single-line by default; set `LOG_JSON=true` for machine-parseable JSON.
- **Metrics** — `GET /metrics` returns a live snapshot: request-lifecycle counters
  (`created`/`approved`/`rejected`/`failed_sync`), HCM health (`calls`/`failures`/
  `latencyMsAvg`/`latencyMsMax`), and reconciliation (`runs`/`repaired`/`created`/
  `driftAbsSum`).

```bash
curl http://localhost:3000/metrics
# → { "requests": { "created": 2, "approved": 1, "failed_sync": 1 },
#     "hcm": { "calls": 2, "failures": 1, "latencyMsAvg": 211, "latencyMsMax": 343 },
#     "reconciliation": { "runs": 0, "repaired": 0, "created": 0, "driftAbsSum": 0 } }
```

## Mock HCM Service

The mock HCM (http://localhost:3100) simulates the external HR system the
time-off service integrates with. It keeps its own **in-memory** balance store
(deliberately separate from the time-off Prisma DB) so it behaves like a true
external dependency. Balances are **pooled per location** — keyed by
`(employeeId, locationId)`. Seed: `EMP-001` @ `LOC-NYC` (30),
`EMP-002` @ `LOC-LON` (23), `EMP-100` @ `LOC-SF` (37).

| Method & path                | Purpose                                             |
| ---------------------------- | --------------------------------------------------- |
| `GET /balances/:employeeId`  | All per-location balances for one employee (404 if unknown) |
| `GET /balances/full-sync`    | Entire balance dataset (used by reconciliation)     |
| `POST /balances/deduct`      | Deduct days if sufficient (422 if not); honours `Idempotency-Key` |
| `POST /balances/adjust`      | Signed correction — anniversary bonus / HR fix      |
| `GET  /admin/failure-config` | Read current failure-simulation config              |
| `PUT  /admin/failure-config` | Tune failure simulation at runtime                  |

Request bodies:

```jsonc
// POST /balances/deduct
{ "employeeId": "EMP-001", "locationId": "LOC-NYC", "days": 5 }

// POST /balances/adjust   (amount is a signed delta)
{ "employeeId": "EMP-001", "locationId": "LOC-NYC", "amount": 3, "reason": "anniversary" }
```

### Failure simulation

Every HCM call passes through a configurable failure layer so integration tests
can exercise resilience. Config fields (all default to no-failure for
deterministic tests):

| Field         | Meaning                                              |
| ------------- | ---------------------------------------------------- |
| `timeoutRate` | Probability `[0..1]` a call stalls then fails `504`  |
| `errorRate`   | Probability `[0..1]` a call fast-fails `503`         |
| `latencyMs`   | Base artificial latency added to every call          |
| `timeoutMs`   | How long a simulated timeout stalls before throwing  |

Set via env (`HCM_TIMEOUT_RATE`, `HCM_ERROR_RATE`, `HCM_LATENCY_MS`,
`HCM_TIMEOUT_MS`) or at runtime:

```bash
curl -X PUT http://localhost:3100/admin/failure-config \
  -H "Content-Type: application/json" \
  -d '{ "timeoutRate": 0.2, "errorRate": 0.1 }'
```

## Testing

```bash
npm test        # unit + integration suites (both apps)
npm run test:e2e # end-to-end suites (both apps)
```

The suite is layered:

- **Unit** (no I/O) — balance math (`availableBalance = total − reserved`),
  `CreateRequestDto` validation rules, and request state-transition guards (404
  unknown / 409 only-`RESERVED`-can-be-approved), driven by mocked collaborators.
- **Integration** (real SQLite + Prisma, mocked HCM) — each owns a throwaway
  `test-*.db` (never `dev.db`), with the schema applied through the same
  connection. Covers optimistic-locking concurrency
  ([requests.concurrency.spec.ts](apps/timeoff-service/src/requests/requests.concurrency.spec.ts)),
  reconciliation drift repair
  ([reconciliation.spec.ts](apps/timeoff-service/src/reconciliation/reconciliation.spec.ts)),
  compensation + idempotency
  ([requests.failure.spec.ts](apps/timeoff-service/src/requests/requests.failure.spec.ts)),
  and HCM deduct idempotency
  ([balances.idempotency.spec.ts](apps/mock-hcm/src/balances/balances.idempotency.spec.ts)).
- **End-to-end** ([scenarios.e2e-spec.ts](apps/timeoff-service/test/scenarios.e2e-spec.ts))
  — boots **both** services in-process (the real mock HCM on a port, the time-off
  service against it over HTTP) and exercises the five plan scenarios:

  1. **Happy path** — request → approve → balance deducted locally *and* on HCM.
  2. **Concurrent requests** — 7×5 days against a 30 pool: exactly 6 reserve, no over-allocation.
  3. **HCM external mutation** — an out-of-band HCM change is repaired by `POST /reconcile`.
  4. **HCM failure** — a forced HCM error rolls the reservation back → `FAILED_SYNC`.
  5. **Duplicate requests** — a repeated `Idempotency-Key` reserves only once.

## Status

- [x] Phase 1 — Project setup (monorepo, services, SQLite + Prisma wiring)
- [x] Phase 2 — Database schema (balances, requests, ledger, reconciliation_logs)
- [x] Phase 3 — Mock HCM service (`/balances/*`, configurable failure simulation)
- [x] Phase 4 — Time-off APIs (request lifecycle, reserve/commit balances, HCM client)
- [x] Phase 5 — Concurrency protection (optimistic locking on `version`, retried RMW, concurrent test)
- [x] Phase 6 — Reconciliation job (scheduled HCM full-sync, drift repair, `reconciliation_logs`)
- [x] Phase 7 — Failure handling (compensation rollback, idempotency keys on create + HCM deduct)
- [x] Phase 8 — Test suite (unit + integration + 5-scenario cross-service e2e)
- [x] Phase 9 — Observability (correlation IDs, structured logging, `/metrics`)
- [x] Phase 10 — Documentation (README, TRD, architecture diagrams, OpenAPI specs)

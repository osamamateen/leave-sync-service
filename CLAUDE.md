# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A two-service NestJS backend demonstrating distributed-systems correctness: a
**timeoff-service** that manages leave requests and local balance projections,
and a **mock-hcm** that simulates the external HR system it syncs with. The work
is staged across 10 phases defined in [Implementation Plan.md](./Implementation%20Plan.md);
the current progress checklist lives at the bottom of [README.md](./README.md).
Design docs live in [docs/](./docs/) (TRD, architecture diagrams, API spec); the
`@nestjs/swagger` plugin (enabled in each `nest-cli.json`) powers `/docs` and the
static `docs/openapi.*.json` written by `npm run export:openapi`.
When implementing a phase, follow the plan's spec for that phase — the schema was
intentionally designed up front to support later phases without new migrations.

## Monorepo layout & the `npm --prefix` convention

This is a monorepo **without npm workspaces**. Each app under `apps/` has its own
`node_modules` and is installed/built/tested independently. The root
[package.json](./package.json) scripts are thin delegators using `npm --prefix`.
Always drive per-app work through that pattern:

```bash
# From repo root — preferred entry points:
npm run start:timeoff:dev      # timeoff-service, watch mode, http://localhost:3000
npm run start:hcm:dev          # mock-hcm, watch mode,      http://localhost:3100
npm run build                  # builds both apps
npm test                       # runs both apps' Jest suites

# Install deps (must be done per app):
npm --prefix apps/timeoff-service install
npm --prefix apps/mock-hcm install

# Single test file / single test name (run against one app):
npm --prefix apps/mock-hcm exec jest -- src/path/to.spec.ts
npm --prefix apps/timeoff-service exec jest -- -t "test name substring"

# Lint / format a single app:
npm --prefix apps/mock-hcm run lint
npm --prefix apps/mock-hcm run format

# E2E (Supertest, separate jest config):
npm --prefix apps/timeoff-service run test:e2e
```

`packages/shared-types/index.ts` is a loose `.ts` file (no package.json, not yet
imported anywhere). It is **manually kept in sync** with the Prisma models and the
mock-hcm response shapes — update it alongside schema/DTO changes; it is the
intended cross-service type contract.

## Prisma 7 + SQLite wiring (timeoff-service only)

The mock-hcm has **no database** (see below). All Prisma lives in
`apps/timeoff-service`. Several non-default choices are load-bearing — don't
"simplify" them:

- **Modern `prisma-client` generator**, not the legacy `prisma-client-js`. It
  emits TypeScript into `apps/timeoff-service/generated/prisma/` (gitignored,
  regenerate with `npm run prisma:generate`). Import the client from there
  (`../../generated/prisma/client`), not from `@prisma/client`.
- `moduleFormat = "cjs"` and `runtime = "nodejs"` in the generator block are
  required for NestJS's CommonJS output. Removing them reintroduces an
  `exports is not defined` runtime crash.
- **Driver adapter**: `PrismaService` constructs `PrismaClient` with
  `new PrismaBetterSqlite3({ url: DATABASE_URL })`. `better-sqlite3` bundles its
  own SQLite engine, so **no system SQLite install is needed** and the `dev.db`
  file is created on first connect.
- **Two places supply the DB URL, by design**: `prisma.config.ts` reads
  `DATABASE_URL` (via `import "dotenv/config"`) for the Prisma *CLI* (migrate /
  studio); `PrismaService` passes it to the *runtime* adapter. `main.ts` must keep
  `import 'dotenv/config'` as its **first line** or `DATABASE_URL` is undefined at
  boot. `PrismaService` reads `DATABASE_URL` in its **constructor** (not a
  module-level const), so it reflects the env in force when Nest instantiates the
  provider — this is what lets a test point it at a throwaway db before `compile()`.

```bash
npm run prisma:migrate    # prisma migrate dev (create + apply migration)
npm run prisma:generate   # regenerate the client after schema edits
npm run prisma:studio     # inspect data
npm run db:seed           # seed local balances (mirrors mock-hcm seed)
```

`db:seed` runs `prisma/seed.ts`, but **not** through ts-node: the generated
client uses nodenext `.js` import specifiers that ts-node's CommonJS resolver
can't map back to the `.ts` sources. The script therefore does `nest build &&
node dist/prisma/seed.js` — it reuses the same compilation as the app (the seed
is compiled into `dist/` alongside `src/`).

### Jest specs that touch the Prisma client

The same nodenext quirk plus the modern client's WASM engine mean any spec that
imports `PrismaService` needs **two** pieces of config already wired in
`apps/timeoff-service/package.json` — don't strip them:

- **`moduleNameMapper`** maps `^(\.{1,2}/.*)\.js$ → $1` so ts-jest resolves the
  generated client's `./internal/class.js`-style imports to their `.ts` sources.
- The `test` / `test:watch` / `test:cov` scripts run jest as
  `node --experimental-vm-modules node_modules/jest/bin/jest.js`. The flag is
  required because the `prisma-client` engine lazy-loads its WASM query compiler
  via ESM dynamic `import()`; without it you get `A dynamic import callback was
  invoked without --experimental-vm-modules`. (Plain `jest` is fine only for
  specs that never construct a Prisma client.)

DB-touching specs (see
[requests.concurrency.spec.ts](apps/timeoff-service/src/requests/requests.concurrency.spec.ts))
own an **isolated SQLite file**, never `dev.db`: set `process.env.DATABASE_URL`
to a unique `file:./test-*.db` **before** `Test.createTestingModule().compile()`
(the constructor read picks it up), then create the schema by running the DDL
through `prisma.$executeRawUnsafe` on that same connection — this sidesteps the
Prisma-CLI-vs-runtime relative-path duality entirely. Clean up the file (and its
`-wal`/`-shm`/`-journal` sidecars) in `afterAll`.

- **ts-jest runs transpile-only** in all four jest configs (the transform is
  `["ts-jest", { "isolatedModules": true }]`, valid because both tsconfigs already
  set `isolatedModules: true`). This is deliberate: ts-jest's default type-checking
  program intermittently throws `TS5103: Invalid value for '--ignoreDeprecations'`
  under TS 5.9 + parallel workers. Transpile-only kills that flake and is faster;
  `nest build` still does the full type-check, so safety isn't lost.

### End-to-end suite (cross-service)

[scenarios.e2e-spec.ts](apps/timeoff-service/test/scenarios.e2e-spec.ts) is a true
cross-service e2e: it **imports the mock-hcm `AppModule`** (`../../mock-hcm/src/...`,
which ts-jest compiles under timeoff's toolchain — mock-hcm has no exotic deps) and
`listen`s it on a throwaway port, then sets `HCM_BASE_URL` to that port **before**
booting the time-off app so its `HcmService` reaches the real mock over HTTP. The
time-off app uses an isolated `test-e2e-*.db` (DDL applied via the live connection)
seeded to mirror the HCM seed, and is reached through Supertest (no `listen`).
State is reset between scenarios via `BalanceStore.reset()` /
`FailureSimulatorService.setConfig()` and `prisma.*.deleteMany()` + re-seed; env
mutations are saved/restored in `beforeAll`/`afterAll` so the sibling
`app.e2e-spec.ts` (which uses the default `dev.db`) is unaffected. `test:e2e` runs
`--runInBand` with the same `--experimental-vm-modules` flag + `.js` mapper the
unit config needs.

**Cross-app module identity**: `jest-e2e.json` maps `@nestjs/common` and
`@nestjs/core` to timeoff's copies (`<rootDir>/../node_modules/...`). Without this,
the imported mock-hcm files resolve their *own* `@nestjs/common`, so a
`NotFoundException` mock-hcm throws is a different class than the one the running
app's exception filter does `instanceof` against — every HCM error collapses to
**500** instead of its real status (a 404/422 silently became 500). Pinning the
framework to a single copy makes mock-hcm's thrown statuses faithful in e2e.

### Schema design constraints (SQLite)

SQLite via Prisma has no native enums and no DB-computed columns, which shapes
[schema.prisma](apps/timeoff-service/prisma/schema.prisma):

- Enum-like fields (`status` on `Request`, `entryType` on `LedgerEntry`) are
  `String`; the allowed values are enforced in DTOs and mirrored in `shared-types`.
- A `Balance` is **pooled per location**: unique on `(employeeId, locationId)`.
  There is **no leave-type dimension** anywhere — a request just names the pool it
  draws from. A `Request` carries no `leaveType`.
- `Balance.availableBalance` is **not stored** — it is derived as
  `totalBalance - reservedBalance` in application code.
- `Balance.version` backs **optimistic locking** (Phase 5); `Request.idempotencyKey`
  is the unique key for **idempotency** (Phase 7).
- The `ledger` table is **append-only and immutable**: it has no `updatedAt`, and
  nothing should ever UPDATE or DELETE rows there. It is the audit trail of signed
  balance movements with a `balanceAfter` snapshot.

## Time-off request lifecycle (apps/timeoff-service)

Phase 4 wires three modules — `RequestsModule` depends on `BalancesModule` and
`HcmModule`. The flow is **reserve-then-commit** so a held balance is never
double-spent:

- **`POST /requests`** runs in a single `prisma.$transaction`: resolve the
  request's `(employeeId, locationId)` pool, create the `Request` as `RESERVED`,
  then `BalancesService.reserveBalance` (which re-checks `available >= days`, raises
  `reservedBalance`, writes a `RESERVE` ledger row). An insufficient balance
  throws `422` and the whole tx rolls back — **no PENDING row ever lingers**.
- **`approve`** calls the HCM **outside** the DB transaction (external I/O), then
  commits locally in a tx: `commitDeduction` lowers *both* `totalBalance` and
  `reservedBalance` (net-neutral to available, since the days were already held)
  and writes a `DEDUCT` row. If HCM fails, a **compensating tx** (Phase 7) rolls
  the hold back via `releaseReservation` (`RELEASE` row, days returned to the
  pool, total untouched) and sets `FAILED_SYNC` — terminal, so a re-approve hits
  `409`. The deduct carries `request.id` as its `Idempotency-Key`, so a retry that
  actually landed on HCM won't double-deduct; reconciliation later repairs the
  total. Only a `RESERVED` request can be approved/rejected (else `409`).
  **Defensive about HCM**: we don't assume HCM always errors when it should. A
  *deterministic* 4xx from HCM (invalid combination / insufficient) is re-thrown
  **verbatim** after rollback (`err instanceof HttpException && getStatus() < 500`);
  only transient faults collapse to `503`. A `2xx` is sanity-checked via
  `assertSaneHcmBalance` (a non-numeric balance throws → compensate; a negative
  balance is logged) rather than committed blindly.
- **`reject`** releases the hold (`RELEASE` ledger row) and sets `REJECTED`.

**Idempotency (Phase 7)**: `POST /requests` accepts an optional `Idempotency-Key`
header (not a body field — the global `ValidationPipe` whitelist only guards the
body). `RequestsService.create` short-circuits to the existing request when the
key is already stored, and on a concurrent race the unique `Request.idempotencyKey`
constraint throws `P2002`, which is caught and resolved to the winning row (so the
loser never reserves a second time). Requests without a key store `idempotencyKey`
as `NULL` (SQLite allows many NULLs under a unique index).

`BalancesService` is the **only** writer of balance/ledger rows; its
reserve/release/commit methods all take a `Prisma.TransactionClient` so callers
compose them into one atomic unit. Every mutation goes through `guardedUpdate`,
the **optimistic-locking** primitive (Phase 5): a conditional `updateMany` that
matches `{ id, version: <version read> }` and bumps `version` in the same
statement, so a stale concurrent writer's update touches **zero rows**. Zero rows
raises `OptimisticLockError`, which `RequestsService.withOptimisticRetry` catches
to re-run the whole `$transaction` on fresh data (bounded by `MAX_LOCK_RETRIES`;
exhaustion → `409`). The retried tx **re-reads the balance inside the
transaction** — reading outside then writing would defeat the version guard, so
`approve`/`reject` resolve the balance within the retried `$transaction` (only the
HCM call in `approve` stays outside). `updateMany` (not `update`) is required
because Prisma's unique-only `update` where can't carry the non-unique `version`
predicate. Net effect: two requests reserving the same pool can never push
`reservedBalance` past `totalBalance` (the loser retries into its own `422`, or
`409` if it can't settle).

## Reconciliation (apps/timeoff-service)

`ReconciliationModule` (Phase 6) repairs drift between the local projection and
the HCM. The HCM is the **source of truth** for the entitlement `totalBalance`;
local `reservedBalance` is local-only and is **never** reconciled.

- `ReconciliationService.reconcile()` pulls `HcmService.fullSync()` (batch / whole
  corpus), then per HCM pool: creates a missing local pool, repairs a drifted
  `totalBalance`, or skips an in-sync one (a cheap pre-check avoids opening a tx
  for in-sync pools, so there is **no phantom `version` bump**). The per-pool loop
  is factored into `applyRows`, shared with `reconcileEmployee(employeeId)` —
  `POST /reconcile/:employeeId`, which uses HCM's **realtime per-employee read**
  (`getByEmployee`) to refresh one employee on demand (e.g. right after a work-
  anniversary bonus) instead of waiting for the sweep; an unknown employee
  surfaces HCM's `404`. Both return a `ReconcileSummary`
  (`checked`/`repaired`/`created`/`drifts`); the whole-corpus path also backs the
  `@Cron(EVERY_10_MINUTES)` sweep (its `running` guard is whole-corpus only).
- The repair runs in a `$transaction` that **re-reads the pool fresh** (version
  guard), then goes through `BalancesService.reconcileTotal` — the *only* writer,
  which sets the total and appends an immutable `RECONCILE` ledger row — and
  writes a `reconciliation_logs` row. A user write racing the repair trips
  `OptimisticLockError`, which the job **swallows per-pool** (skip, settle next
  run) rather than retrying — reconciliation yields to live traffic.
- The cron **swallows** a failed `fullSync` (logged, scheduler keeps ticking);
  the controller path lets it surface as `503`. Disable the sweep with
  `RECONCILE_DISABLED=true` (guard checked inside the handler — the `@Cron`
  expression itself is a compile-time constant). A second run with no new drift
  is a clean no-op; `created` paths assume seed parity (one location/employee).

`HcmService` (`hcm/hcm.service.ts`) is the Axios client to the mock HCM: per-call
timeout + bounded retry with exponential backoff on transient faults (network /
timeout / 5xx), while deterministic `4xx` business rejections are surfaced
verbatim and **not** retried. Base URL/timeout/retries are env-tunable
(`HCM_BASE_URL`, `HCM_CLIENT_TIMEOUT_MS`, `HCM_CLIENT_RETRIES`). The request id is
sent as an `Idempotency-Key` header, which the mock now honours (Phase 7) — a
retried deduct with the same key applies once and replays the original result.

## Observability (Phase 9, `src/observability/`)

Three pieces, all in `apps/timeoff-service/src/observability/` (and mirrored,
minus metrics, in `apps/mock-hcm/src/observability/`):

- **Correlation IDs** — `correlation.ts` holds a per-request id in an
  `AsyncLocalStorage`; `correlationMiddleware` (wired in `AppModule.configure` via
  `forRoutes('*')`, so it's live under e2e too — not just `main.ts`) adopts the
  inbound `x-correlation-id` or mints one, echoes it on the response, and runs the
  request inside that context. `HcmService.sendInner` reads it and **forwards it to
  the HCM**; the mock adopts it via its own copy of the middleware, so one trace id
  appears in **both** services' logs.
- **Structured logging** — `StructuredLogger implements LoggerService`, installed
  with `app.useLogger(new StructuredLogger())` + `bufferLogs: true` in `main.ts`.
  Because it replaces the global logger, **every existing `new Logger(ctx)` call
  gains the correlationId with zero per-call-site changes**. Pretty by default;
  `LOG_JSON=true` → JSON. Not a DI provider (it reads ALS directly).
- **Metrics** — `MetricsService` (in `@Global ObservabilityModule`) holds
  process-lifetime counters; `GET /metrics` returns the snapshot. It is injected
  with **`@Optional()`** into `RequestsService`, `ReconciliationService`, and
  `HcmService` — load-bearing: it keeps `new HcmService()` / `new RequestsService(
  prisma, balances, hcm)` working in the unit specs and lets the integration test
  modules (which don't wire `ObservabilityModule`) resolve those services as
  `undefined` metrics. `HcmService.send` wraps `sendInner` to time the round-trip
  and flag a *transient* failure (only an exhausted-retry `503` counts as an HCM
  failure; a deterministic 4xx is a successful round-trip).

> **Request→balance mapping**: a `Request` carries a `locationId`, and balances
> are pooled per `(employeeId, locationId)`. `BalancesService.resolveBalance`
> looks the pool up by the compound unique key (`employeeId_locationId`) — an
> unknown location is a `404`. An employee can hold independent pools at multiple
> locations; each request reserves against exactly the one it names. `approve`
> uses `request.locationId` directly for the HCM deduct (no balance pre-read).

> **`start:prod` entry path**: `nest build` for timeoff-service emits to
> `dist/src/main.js` (not `dist/main.js` like mock-hcm), so the stock
> `"start:prod": "node dist/main"` script is wrong for this app. Use
> `npm run start:timeoff:dev` for local runs, or `node dist/src/main.js`.

## Mock HCM architecture (apps/mock-hcm)

The mock HCM models a real external dependency, so it keeps its balances in an
**in-memory store** (`balances/balance-store.ts`) that is deliberately separate
from the timeoff Prisma DB — never wire it to Prisma. Seed employees: `EMP-001`,
`EMP-002`, `EMP-100`. `BalanceStore.reset()` exists for test isolation.

Two gotchas that are easy to reintroduce:

- **Route order**: in `balances.controller.ts`, `@Get('full-sync')` must be
  declared *before* `@Get(':employeeId')`, otherwise Express matches `full-sync`
  as an employee id.
- **DTO merge**: with the global `ValidationPipe({ transform: true })`, a
  transformed DTO carries every optional field as an `undefined` own-property. The
  failure-config `setConfig` merges **only defined keys** for this reason — a blind
  `{ ...config, ...dto }` spread silently wipes untouched fields to `undefined`.
- **Deduct idempotency**: `POST /balances/deduct` honours an `Idempotency-Key`
  header (Phase 7). `BalanceStore` keeps a `key → result snapshot` map so a replay
  returns the original outcome without deducting twice. The check runs **after**
  `maybeFail` (a replay can still hit a simulated fault — idempotency means
  apply-once, not failure-free) and a **rejected** deduct is never remembered.
  `BalanceStore.reset()` clears this map too.

Every HCM operation first passes through `FailureSimulatorService.maybeFail()`
(latency → roll for `504` timeout → roll for `503` error). Failure rates default
to zero (deterministic tests) and are tunable at runtime via
`PUT /admin/failure-config` or env vars (`HCM_TIMEOUT_RATE`, `HCM_ERROR_RATE`,
`HCM_LATENCY_MS`, `HCM_TIMEOUT_MS`).

## Conventions shared by both services

- Both bootstrap a **global `ValidationPipe`** with
  `{ whitelist: true, forbidNonWhitelisted: true, transform: true }` in `main.ts`.
  Unknown body fields are rejected (`400`); input is coerced to DTO types. Validate
  with `class-validator` decorators on DTOs.
- Business-rule failures use semantic HTTP exceptions: `NotFoundException` (404)
  for unknown employee/balance, `UnprocessableEntityException` (422) for
  insufficient-balance / would-go-negative.
- Ports: timeoff-service `3000`, mock-hcm `3100` (override with `PORT`).
- TypeScript runs with `isolatedModules` + `emitDecoratorMetadata`. A type used
  only in a decorated signature (e.g. a controller return type) must be brought in
  with `import type` or it fails to compile (TS1272).

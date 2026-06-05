# Technical Requirements & Design (TRD)

**Time-Off Microservice + Mock HCM**

This document records *what* the system does and *why* it is built the way it
is — the architecture decisions, their trade-offs, and the consistency and
failure-handling strategy. For the visual model see
[architecture.md](./architecture.md); for the endpoint reference see
[api-spec.md](./api-spec.md).

---

## 1. Objective

Build a backend that lets employees request time off and managers approve it,
while keeping balances correct against an external **HCM** (Human Capital
Management) system that is the **source of truth** for entitlement. The hard part
is not the CRUD — it is **consistency between two systems** that can each change
independently, under concurrency and partial failure.

### Personas → requirements

| Persona | Need | How it is met |
| ------- | ---- | ------------- |
| Employee | Accurate balance, instant feedback | Local projection answers reads/reserves in-process (no HCM round-trip on the hot path); reconciliation keeps it true; `POST /reconcile/:employeeId` refreshes on demand |
| Manager | Approve knowing the data is valid | Approval confirms with the HCM (`deduct`) before committing; an invalid/insufficient request was already rejected at request time |

### The named challenges (from the brief) and where they land

1. *Time-Off is not the only writer of HCM* (anniversary / yearly refresh) → **Reconciliation** (§6).
2. *HCM has a realtime per-(employee, location) API* → used for the **deduct** (send) and the **per-employee refresh** (get).
3. *HCM has a batch endpoint for the whole corpus* → drives the **reconciliation sweep**.
4. *HCM should reject invalid combinations / insufficient balance, but may not always* → we **validate locally first** and are **defensive about HCM's responses** (§5, §7).

---

## 2. System overview

Two independently-deployed NestJS services:

- **timeoff-service** (`:3000`) — owns the request lifecycle and a **local
  projection** of balances in SQLite (Prisma). The system of engagement.
- **mock-hcm** (`:3100`) — simulates the external HCM with an **in-memory** store,
  a realtime per-pool API, a batch full-sync, and a **configurable failure
  simulator** (latency / timeout / error rates) so resilience is testable.

They communicate over HTTP. The mock HCM is deliberately *not* wired to the
time-off database — it behaves like a true external dependency.

---

## 3. Data model (timeoff-service)

| Table | Purpose | Notable columns |
| ----- | ------- | --------------- |
| `balances` | Local projection, one **pooled** row per `(employeeId, locationId)` | `totalBalance`, `reservedBalance`, `version` (optimistic lock). `availableBalance` is **derived** (`total − reserved`), not stored |
| `requests` | Request + lifecycle status | `locationId` (which pool), `days`, `status`, `idempotencyKey` (unique) |
| `ledger` | **Append-only, immutable** audit of every balance movement | `entryType` (`RESERVE`/`RELEASE`/`DEDUCT`/`RECONCILE`), signed `amount`, `balanceAfter` snapshot |
| `reconciliation_logs` | One row per drift correction | `previousBalance`, `correctedBalance`, `drift`, `source` |

`status ∈ {PENDING, RESERVED, APPROVED, REJECTED, FAILED_SYNC}`.

---

## 4. Request lifecycle — reserve-then-commit (saga)

A request never deducts HCM directly on creation. It follows a two-step saga so a
held balance is never double-spent and the slow/uncertain external call is pushed
to the approval boundary:

```
POST /requests        validate locally → reserve (hold) → status RESERVED
   approve            call HCM deduct → on OK spend the hold → APPROVED
                      on failure → roll the hold back → FAILED_SYNC
   reject             release the hold → REJECTED
```

- **Reserve** raises `reservedBalance` (available falls); `totalBalance` untouched.
- **Commit** (approve) lowers *both* `totalBalance` and `reservedBalance` — net-zero
  to available, because the days were already held.
- **Release** (reject / compensation) lowers `reservedBalance` only.

Every movement appends an immutable `ledger` row.

### Why this shape (and the trade-off)

- **Decision:** reserve locally on request; confirm with HCM at approval.
- **Why:** the Employee gets **instant feedback** from the local projection and the
  Manager's approval is the point where external agreement actually matters. It
  keeps the request path fast and available even if HCM is briefly slow.
- **Trade-off:** a request can be `RESERVED` locally and *then* fail HCM at approve
  → `FAILED_SYNC`. We accept deferred HCM agreement (backed by compensation +
  reconciliation) in exchange for availability and latency. The alternative —
  validating against HCM synchronously at request time — was rejected: it couples
  the hot path to HCM availability for marginal benefit, since the local projection
  is kept faithful by reconciliation and the authoritative check still happens at
  approve.

> **Distributed-transaction stance:** there is no 2-phase commit across the two
> systems (the HCM exposes no prepare/commit protocol). We use a **saga with a
> compensating action** instead, and lean on idempotency + reconciliation to
> converge — the pragmatic, realistic choice for an external HTTP dependency.

---

## 5. Concurrency — optimistic locking

**Problem:** two requests reading the same pool could both pass an
`available >= days` check and both reserve, over-allocating the balance.

**Decision:** every balance write goes through `guardedUpdate` — a conditional
`updateMany` that matches `{ id, version: <version read> }` and bumps `version` in
the same statement. A stale concurrent writer's update therefore touches **zero
rows**, which raises `OptimisticLockError`; `RequestsService.withOptimisticRetry`
re-runs the whole transaction on fresh data (bounded; exhaustion → `409`).

- **Why optimistic over pessimistic:** balance contention is low and short-lived;
  optimistic locking avoids held locks / deadlocks and is a clean fit for the
  "read-modify-write with a version" pattern. `updateMany` (not `update`) is
  required because Prisma's unique-only `update` where can't carry the non-unique
  `version` predicate.
- **Guarantee:** `reservedBalance` can never exceed `totalBalance`. Two requests
  for the same pool: one wins; the loser retries into its own `422` (now
  insufficient) or `409` (couldn't settle). Verified by a concurrent integration
  test ("balance 10, A=7 + B=6 → exactly one wins").

---

## 6. Reconciliation strategy

The HCM is the **source of truth for the entitlement `totalBalance`**; the local
projection drifts whenever the HCM changes outside our flow (anniversary bonus, HR
correction, yearly refresh). Local `reservedBalance` is **local-only and never
reconciled**.

Three entry points, one core (`applyRows`):

| Trigger | HCM API | Use |
| ------- | ------- | --- |
| `@Cron(EVERY_10_MINUTES)` sweep | batch `full-sync` | steady-state drift repair |
| `POST /reconcile` | batch `full-sync` | on-demand whole-corpus repair |
| `POST /reconcile/:employeeId` | **realtime** per-employee read | refresh one employee *now* (e.g. right after a bonus) |

Per HCM pool: **create** a missing local pool, **repair** a drifted `totalBalance`
(into a `$transaction` that re-reads under the version guard, writes a `RECONCILE`
ledger row + a `reconciliation_logs` row), or **skip** an in-sync one (a cheap
pre-check avoids opening a transaction — **no phantom `version` bump**).

- **Reconciliation yields to live traffic:** a user write racing a repair trips the
  same optimistic-lock guard; the job **swallows it per-pool** (skip, settle next
  run) rather than fighting the user — eventual consistency.
- **Resilience:** the cron **swallows** a failed `full-sync` (logged, keeps
  ticking); the on-demand endpoint surfaces it as `503`. Disable the sweep with
  `RECONCILE_DISABLED=true`.
- **Idempotent:** a second run with no new drift is a clean no-op.

---

## 7. Failure handling & defensiveness

| Mechanism | Behaviour |
| --------- | --------- |
| **Retry policy** | The HCM client retries *transient* faults (network / timeout / 5xx) with bounded exponential backoff. Deterministic `4xx` business rejections are **never** retried. |
| **Compensation** | If a deduct can't be confirmed at approve, the local hold is **rolled back** (`RELEASE` row) and the request marked `FAILED_SYNC`. The total was never touched. |
| **Idempotency** | `POST /requests` and `POST /balances/deduct` accept an `Idempotency-Key`. A replay returns the original result; the deduct carries `request.id` so an HCM retry won't double-deduct. A concurrent create race is settled by the unique `idempotencyKey` constraint. |
| **Don't trust HCM blindly** | A *deterministic* HCM `4xx` is surfaced **verbatim** (retrying won't help); only *transient* faults collapse to `503`. A `2xx` is **sanity-checked** — a non-numeric balance is treated as a failed sync; a negative balance is flagged. |
| **Local-first validation** | Invalid `(employee, location)` (`404`) and insufficient balance (`422`) are rejected **at request time, before HCM is ever called** — so we never depend on HCM to be the gatekeeper. |

This directly answers challenge #4: we *can* usually count on HCM's errors, but we
do not *rely* on them — our own projection is the first gate, and HCM's responses
are validated rather than trusted.

---

## 8. Dimensions & pooling

Balances are pooled per **`(employeeId, locationId)`**. There is **no leave-type
dimension** — a request names the location pool it draws against; an employee can
hold independent pools at multiple locations, each reserved independently. This
matches the brief's example dimensions (`locationId`, `employeeId`) and keeps the
model minimal. (Adding a dimension later is an additive schema change.)

---

## 9. Observability

- **Correlation IDs** — every request carries an `x-correlation-id` (adopted or
  minted), held in `AsyncLocalStorage`, echoed on the response, and **forwarded to
  the HCM**, which adopts it too — so one operation is traceable across **both**
  services' logs.
- **Structured logging** — a custom `LoggerService` gives every log line a
  consistent shape + the correlation id (`LOG_JSON=true` for JSON).
- **Metrics** — `GET /metrics`: request-lifecycle counters, HCM health
  (calls / failures / latency), reconciliation drift.

---

## 10. Consistency model & guarantees

- **Local atomicity:** request creation + reservation, and approval + deduction,
  are each a single SQLite transaction.
- **No double-allocation:** enforced by the version guard (§5).
- **No double-deduction at HCM:** enforced by the idempotency key (§7).
- **Cross-system convergence:** *eventual*. The local projection converges to the
  HCM truth via reconciliation; in between, a request is served from the
  projection. The append-only ledger is the audit trail of every movement.

---

## 11. Technology choices

| Choice | Why |
| ------ | --- |
| **NestJS** | DI, modules, lifecycle hooks, first-class scheduling (`@nestjs/schedule`) and Swagger; structures a clear separation of concerns. |
| **Prisma 7 + SQLite (`better-sqlite3`)** | Zero-infra, file-based DB — no server/container needed; `better-sqlite3` bundles its own engine. The `prisma-client` generator + driver adapter keep it fully typed. SQLite's single-writer model also makes the concurrency story easy to reason about while the optimistic-lock guard remains correct under true concurrency. |
| **Jest + Supertest** | Unit + integration (isolated SQLite per spec) + a real cross-service e2e. |

---

## 12. Known limitations & future work

- **`FAILED_SYNC` is terminal** — no automatic retry/resubmit path; recovery is a
  new request. A background re-drive of `FAILED_SYNC` requests would close this.
- **No authn/authz** — the Employee vs Manager distinction is modelled in the
  domain but not enforced (out of scope for this exercise).
- **Metrics are in-process & single-instance** — fine for one node; a real
  deployment would expose Prometheus and aggregate across instances.
- **Reconciliation `created` path assumes seed parity** — materialising a missing
  local pool from HCM works, but pruning local pools HCM no longer knows about is
  intentionally *not* done (HCM-only iteration).
- **Request-time HCM validation is deferred to approve** — a deliberate trade-off
  (§4), backed by compensation + reconciliation.

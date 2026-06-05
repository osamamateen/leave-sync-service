# Architecture

Visual companion to the [TRD](./TRD.md). Diagrams are [Mermaid](https://mermaid.js.org/)
and render on GitHub.

## 1. System context

Two independently-deployed services; the mock HCM is a stand-in for the real
external HR system and is deliberately not wired to the time-off database.

```mermaid
flowchart LR
  Client([Employee / Manager])

  subgraph TO["timeoff-service :3000"]
    direction TB
    RC[Requests]
    BS[Balances]
    REC[Reconciliation<br/>+ @Cron sweep]
    HC[HCM client]
    OBS[Observability<br/>correlation · logs · /metrics]
    DB[(SQLite<br/>balances · requests<br/>ledger · reconciliation_logs)]
    RC --> BS
    RC --> HC
    REC --> BS
    REC --> HC
    BS --> DB
  end

  subgraph HCM["mock-hcm :3100 (source of truth)"]
    direction TB
    HB[Balances<br/>realtime + full-sync]
    FS[Failure simulator<br/>latency / timeout / error]
    MEM[(in-memory store)]
    HB --> MEM
    HB -.-> FS
  end

  Client -->|REST| RC
  Client -->|REST| BS
  Client -->|REST| REC
  HC -->|deduct · get · full-sync<br/>x-correlation-id + Idempotency-Key| HB
```

## 2. Request lifecycle — state machine

```mermaid
stateDiagram-v2
  [*] --> RESERVED: POST /requests<br/>(reserve hold)
  RESERVED --> APPROVED: approve → HCM deduct OK
  RESERVED --> FAILED_SYNC: approve → HCM failure<br/>(roll hold back)
  RESERVED --> REJECTED: reject (release hold)
  APPROVED --> [*]
  REJECTED --> [*]
  FAILED_SYNC --> [*]
  note right of RESERVED
    only RESERVED can be
    approved/rejected (else 409)
  end note
```

## 3. Happy path — request then approve

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant R as RequestsService
  participant B as BalancesService
  participant DB as SQLite
  participant H as HCM

  C->>R: POST /requests {employeeId, locationId, days}
  rect rgb(238,246,255)
  note over R,DB: single transaction
  R->>B: resolveBalance(employeeId, locationId)
  B->>DB: findUnique (404 if no pool)
  R->>B: reserveBalance (available ≥ days? else 422)
  B->>DB: guarded update reserved+=days, version++ ; RESERVE ledger
  end
  R-->>C: 201 RESERVED

  C->>R: POST /requests/:id/approve
  R->>H: deduct {employeeId, locationId, days, Idempotency-Key}
  H-->>R: 200 {balance}
  R->>R: assertSaneHcmBalance(result)
  rect rgb(238,246,255)
  note over R,DB: single transaction
  R->>B: commitDeduction (total-=days, reserved-=days, version++) ; DEDUCT ledger
  end
  R-->>C: 200 APPROVED
```

## 4. Failure path — compensation

When the deduct can't be confirmed, the hold is rolled back and the request is
marked `FAILED_SYNC`. A deterministic HCM `4xx` is surfaced verbatim; a transient
fault (retries exhausted) becomes `503`.

```mermaid
sequenceDiagram
  autonumber
  participant C as Client
  participant R as RequestsService
  participant B as BalancesService
  participant H as HCM

  C->>R: POST /requests/:id/approve
  loop bounded retry (transient only)
    R->>H: deduct (Idempotency-Key = request.id)
    H--xR: timeout / 5xx
  end
  note over R: retries exhausted → ServiceUnavailable
  rect rgb(255,241,241)
  note over R,B: compensating transaction
  R->>B: releaseReservation (RELEASE ledger, days returned)
  R->>R: mark FAILED_SYNC
  end
  R-->>C: 503 (or the verbatim 4xx)
```

## 5. Reconciliation — drift repair

```mermaid
sequenceDiagram
  autonumber
  participant T as Cron / POST /reconcile(/:emp)
  participant REC as ReconciliationService
  participant H as HCM
  participant B as BalancesService
  participant DB as SQLite

  T->>REC: reconcile() | reconcileEmployee(emp)
  REC->>H: full-sync (batch)  |  getByEmployee (realtime)
  H-->>REC: [{employeeId, locationId, balance}]
  loop per HCM pool
    REC->>DB: find local pool
    alt missing
      REC->>DB: create from HCM
    else in sync (pre-check)
      REC->>REC: skip (no tx, no version bump)
    else drifted
      rect rgb(238,255,238)
      note over REC,DB: transaction (version-guarded)
      REC->>B: reconcileTotal → set total, RECONCILE ledger
      REC->>DB: write reconciliation_logs row
      end
    end
  end
  REC-->>T: { checked, repaired, created, drifts }
```

> The HCM is authoritative for `totalBalance` only; local `reservedBalance` (pending
> holds) is never reconciled. A user write racing a repair trips the optimistic-lock
> guard and is skipped (settled on the next run).

## 6. Concurrency guard

Two requests against the same pool can't both reserve: the conditional update is
keyed on the `version` each read, so the loser touches zero rows and retries on
fresh data — into its own `422`/`409`.

```mermaid
sequenceDiagram
  autonumber
  participant A as Request A (7d)
  participant B as Request B (6d)
  participant DB as balance {total:10, reserved:0, v:0}

  A->>DB: read v0 (avail 10)
  B->>DB: read v0 (avail 10)
  A->>DB: updateMany where v=0 → reserved 7, v=1 ✓
  B->>DB: updateMany where v=0 → 0 rows ✗ (OptimisticLockError)
  B->>DB: retry: read v1 (avail 3) → 6 > 3 → 422
```

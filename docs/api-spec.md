# API Reference

REST reference for both services. Each service also serves **live, interactive
OpenAPI/Swagger** docs and a machine-readable spec:

| | Swagger UI | Generated spec |
| --- | --- | --- |
| timeoff-service | http://localhost:3000/docs | [openapi.timeoff.json](./openapi.timeoff.json) |
| mock-hcm | http://localhost:3100/docs | [openapi.mock-hcm.json](./openapi.mock-hcm.json) |

Regenerate the static specs after changing controllers/DTOs:

```bash
npm run export:openapi   # writes docs/openapi.*.json from both apps
```

Conventions: JSON bodies; a global `ValidationPipe` rejects unknown body fields
(`400`) and coerces types. Business errors use semantic statuses — `404` unknown
employee/pool/request, `422` insufficient/would-go-negative, `409` invalid state
transition / unresolved lock, `503` transient HCM failure.

---

## timeoff-service (`:3000`)

### Requests

#### `POST /requests`
Create a request; reserves balance against the named pool.

Headers: optional `Idempotency-Key` (replaying a key returns the original request,
no second reservation). `X-Correlation-Id` is adopted if present, else minted.

```jsonc
// body
{ "employeeId": "EMP-001", "locationId": "LOC-NYC", "days": 5, "reason": "vacation" }
// 201
{ "id": "ckq…", "employeeId": "EMP-001", "locationId": "LOC-NYC",
  "days": 5, "status": "RESERVED", "reason": "vacation", "createdAt": "2026-…Z" }
```
- `404` no pool for `(employeeId, locationId)` · `422` insufficient available balance · `400` malformed body.

#### `GET /requests`
List/filter (newest first). Query: `employeeId`, `locationId`, `status`
(`PENDING|RESERVED|APPROVED|REJECTED|FAILED_SYNC`). Unknown query params → `400`.

```
GET /requests?status=RESERVED        # manager approval queue
GET /requests?employeeId=EMP-001     # an employee's history
```

#### `GET /requests/:id`
Fetch one request (`404` if unknown).

#### `POST /requests/:id/approve`
Confirm with the HCM and spend the hold → `APPROVED`.
- `409` unless `RESERVED` · `422`/`404` surfaced verbatim from a deterministic HCM
  rejection · `503` transient HCM failure (hold rolled back → `FAILED_SYNC`).

#### `POST /requests/:id/reject`
Release the hold → `REJECTED` (`409` unless `RESERVED`).

### Balances

#### `GET /balances/:employeeId`
All local pooled balances for one employee (`404` if none).

```jsonc
// 200
[ { "employeeId": "EMP-001", "locationId": "LOC-NYC",
    "totalBalance": 30, "reservedBalance": 5, "availableBalance": 25, "version": 1 } ]
```

### Reconciliation

| Method & path | Purpose |
| --- | --- |
| `POST /reconcile` | Whole-corpus pass (HCM `full-sync`). Returns `{ checked, repaired, created, drifts }` |
| `POST /reconcile/:employeeId` | Realtime refresh of one employee (HCM per-employee read); `404` if HCM doesn't know them |
| `GET /reconcile/logs?take=N` | Recent `reconciliation_logs` (newest first, cap 200) |

```jsonc
// POST /reconcile → 200
{ "checked": 3, "repaired": 1, "created": 0,
  "drifts": [ { "employeeId": "EMP-001", "locationId": "LOC-NYC",
               "previous": 24, "corrected": 30, "drift": 6 } ] }
```

### Observability

#### `GET /metrics`
```jsonc
{ "requests": { "created": 2, "approved": 1, "failed_sync": 1 },
  "hcm": { "calls": 2, "failures": 1, "latencyMsAvg": 211, "latencyMsMax": 343 },
  "reconciliation": { "runs": 0, "repaired": 0, "created": 0, "driftAbsSum": 0 } }
```
Every response also carries an `x-correlation-id` header.

---

## mock-hcm (`:3100`)

The external HR system stand-in. In-memory store; seed: `EMP-001`@`LOC-NYC` (30),
`EMP-002`@`LOC-LON` (23), `EMP-100`@`LOC-SF` (37).

### Balances

| Method & path | Purpose |
| --- | --- |
| `GET /balances/:employeeId` | All per-location balances for one employee (realtime read; `404` if unknown) |
| `GET /balances/full-sync` | Entire dataset (batch — drives reconciliation). **Declared before** `:employeeId`. |
| `POST /balances/deduct` | Deduct days if sufficient (`422` if not). Honours `Idempotency-Key` (apply-once + replay) |
| `POST /balances/adjust` | Signed correction — anniversary bonus / HR fix (`422` if it would go negative) |

```jsonc
// POST /balances/deduct
{ "employeeId": "EMP-001", "locationId": "LOC-NYC", "days": 5 }
// POST /balances/adjust  (amount is a signed delta)
{ "employeeId": "EMP-001", "locationId": "LOC-NYC", "amount": 10, "reason": "anniversary" }
// 200 (both)
{ "employeeId": "EMP-001", "locationId": "LOC-NYC", "balance": 25 }
```

### Failure simulation (admin)

| Method & path | Purpose |
| --- | --- |
| `GET /admin/failure-config` | Read current simulation config |
| `PUT /admin/failure-config` | Tune it at runtime |

```jsonc
// PUT /admin/failure-config  (all optional; only provided keys are merged)
{ "timeoutRate": 0.2, "errorRate": 0.1, "latencyMs": 0, "timeoutMs": 2000 }
```

---

## Environment variables

| Service | Var | Default | Meaning |
| --- | --- | --- | --- |
| timeoff | `DATABASE_URL` | `file:./dev.db` | SQLite location |
| timeoff | `HCM_BASE_URL` | `http://localhost:3100` | HCM endpoint |
| timeoff | `HCM_CLIENT_TIMEOUT_MS` | `3000` | per-call HCM timeout |
| timeoff | `HCM_CLIENT_RETRIES` | `2` | transient-fault retries |
| timeoff | `RECONCILE_DISABLED` | – | `true` disables the cron sweep |
| both | `PORT` | `3000` / `3100` | listen port |
| both | `LOG_JSON` | – | `true` → JSON structured logs |
| mock-hcm | `HCM_TIMEOUT_RATE` / `HCM_ERROR_RATE` | `0` | failure-simulation probabilities |
| mock-hcm | `HCM_LATENCY_MS` / `HCM_TIMEOUT_MS` | `0` / `2000` | latency / stall duration |

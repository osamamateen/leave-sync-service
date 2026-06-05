# Implementation Plan

# Time-Off Microservice + Mock HCM

## 1. Objective

Implement a production-style distributed backend system that:

* manages employee time-off requests
* maintains local balance projections
* synchronizes with external HCM
* supports reconciliation
* safely handles concurrency and failures
* includes a mock HCM service for integration testing

---

# 2. Recommended Tech Stack

| Component         | Technology        |
| ----------------- | ----------------- |
| Backend Framework | NestJS            |
| Language          | TypeScript        |
| Database          | SQLite        |
| ORM               | Prisma            |
| Testing           | Jest + Supertest  |
| Scheduler         | NestJS Schedule   |
| API Spec          | OpenAPI / Swagger |

---

# 3. Repository Structure

```text
/apps
  /timeoff-service
  /mock-hcm

/packages
  /shared-types

/docs
  TRD.md
  architecture.md
  api-spec.md

/tests
  /integration
  /e2e

/docker
docker-compose.yml
README.md
```

---

# 4. Development Phases

---

# Phase 1 — Project Setup

## Goals

* bootstrap services
* configure database
* establish local environment

---

## Tasks

### 1. Initialize Monorepo

```bash
mkdir examplehr-system
```

---

### 2. Create Services

```bash
nest new timeoff-service
nest new mock-hcm
```

---

### 3. Configure SQLite

SQLite is file-based, so no database server or Docker container is required.

Set the database URL in `.env`:

```env
DATABASE_URL="file:./dev.db"
```

In `schema.prisma`, configure the datasource:

```prisma
datasource db {
  provider = "sqlite"
  url      = env("DATABASE_URL")
}
```

---

### 4. Install Dependencies

```bash
npm install @nestjs/schedule
npm install prisma @prisma/client
npm install axios
npm install class-validator
```

---

### 5. Initialize Prisma

```bash
npx prisma init
```

---

# Deliverables

* working monorepo
* SQLite connected
* Prisma configured
* local environment functional

---

# Phase 2 — Database Schema

## Goals

Create all core entities.

---

## Tables

### balances

* employee_id
* leave_type
* total_balance
* reserved_balance
* version

---

### requests

* id
* employee_id
* days
* status

---

### ledger

* immutable audit entries

---

### reconciliation_logs

* sync tracking

---

## Tasks

### Create Prisma Models

```prisma
model Balance {
  employeeId       String
  leaveType        String
  totalBalance     Float
  reservedBalance  Float
  version          Int
}
```

---

### Run Migration

```bash
npx prisma migrate dev
```

---

# Deliverables

* database schema complete
* migrations working

---

# Phase 3 — Mock HCM Service

## Goals

Create realistic external dependency.

---

## APIs to Build

### GET /balances/:employeeId

Returns current balance.

---

### POST /balances/deduct

Deducts balance if sufficient.

---

### POST /balances/adjust

Simulates:

* anniversary bonus
* HR correction

---

### GET /balances/full-sync

Returns entire balance dataset.

---

## Additional Features

### Failure Simulation

Add configurable:

* timeout rate
* error rate

Example:

```json
{
  "timeoutRate": 0.2,
  "errorRate": 0.1
}
```

---

## Tasks

### Create HCM State Store

Simple DB table or in-memory store.

---

### Add Business Rules

Reject:

* insufficient balance
* invalid employee

---

### Add Delay Simulation

```ts
await sleep(2000)
```

---

# Deliverables

* fully working mock HCM
* realistic external behavior
* configurable failures

---

# Phase 4 — Time-Off APIs

## Goals

Implement core business logic.

---

## APIs

### POST /requests

Create time-off request.

---

### GET /requests/:id

Fetch request.

---

### POST /requests/:id/approve

Approve request.

---

### POST /requests/:id/reject

Reject request.

---

### GET /balances/:employeeId

Get local projected balance.

---

## Core Logic

### Request Flow

```text
1. Validate balance locally
2. Reserve balance transactionally
3. Create request
4. Call HCM
5. Confirm or rollback
```

---

## Tasks

### Create BalanceService

Methods:

* getAvailableBalance()
* reserveBalance()
* releaseReservation()

---

### Create RequestService

Methods:

* createRequest()
* approve()
* reject()

---

### Create HCM Client

Axios wrapper:

* retries
* timeout handling
* idempotency headers

---

# Deliverables

* request APIs operational
* local balance management complete
* HCM integration functional

---

# Phase 5 — Concurrency Protection

## Goals

Prevent double allocation.

---

## Tasks

### Add Optimistic Locking

Use:

* version field
* transactional updates

---

### Add Atomic Reservation Query

```sql
UPDATE balances
SET reserved_balance = reserved_balance + :days
WHERE available_balance >= :days
AND version = :version;
```

---

### Add Concurrent Request Tests

Scenario:

```text
balance = 10
request A = 7
request B = 6
```

Only one should succeed.

---

# Deliverables

* race conditions prevented
* transactional integrity verified

---

# Phase 6 — Reconciliation Job

## Goals

Repair drift between systems.

---

## Tasks

### Add Scheduler

Use NestJS cron.

Example:

```ts
@Cron("*/10 * * * *")
```

---

### Fetch HCM Balances

```ts
GET /balances/full-sync
```

---

### Compare Local vs HCM

```text
if local != hcm:
    repair local
```

---

### Write Reconciliation Logs

Track:

* previous balance
* corrected balance
* timestamp

---

# Deliverables

* periodic sync operational
* drift repair working

---

# Phase 7 — Failure Handling

## Goals

Handle distributed failures safely.

---

## Tasks

### Retry Policy

Use:

* exponential backoff
* retry limits

---

### Compensation Logic

If:

```text
local success
HCM failure
```

Then:

* rollback reservation
* mark FAILED_SYNC

---

### Idempotency Keys

Prevent duplicate processing.

---

# Deliverables

* resilient HCM integration
* duplicate-safe operations

---

# Phase 8 — Test Suite

## Goals

Demonstrate robustness.

---

# Unit Tests

### Balance calculations

### Validation rules

### State transitions

---

# Integration Tests

### Transaction safety

### Optimistic locking

### DB consistency

---

# End-to-End Tests

## Scenario 1 — Happy Path

```text
request → approval → balance deduction
```

---

## Scenario 2 — Concurrent Requests

Prevent over-allocation.

---

## Scenario 3 — HCM External Mutation

```text
HCM balance changed externally
→ reconciliation repairs local
```

---

## Scenario 4 — HCM Failure

```text
HCM timeout
→ rollback reservation
```

---

## Scenario 5 — Duplicate Requests

Ensure idempotency.

---

# Deliverables

* automated test suite
* concurrency tests
* integration coverage

---

# Phase 9 — Observability

## Goals

Provide debugging and operational visibility.

---

## Tasks

### Structured Logging

Log:

* request lifecycle
* reconciliation events
* HCM failures

---

### Metrics

Track:

* failed syncs
* reconciliation drift
* latency

---

### Request Correlation IDs

Trace distributed operations.

---

# Deliverables

* operational diagnostics
* traceable workflows

---

# Phase 10 — Documentation

## Goals

Finalize submission.

---

## Deliverables

### README

Include:

* setup steps
* architecture overview
* API examples

---

### TRD

Include:

* tradeoffs
* architecture decisions
* reconciliation strategy

---

### OpenAPI Spec

Swagger generation.

---

### Architecture Diagrams

Optional but recommended.

---

# 5. Recommended Development Order

```text
1. Setup project
2. Build Mock HCM
3. Build database schema
4. Build request APIs
5. Add balance reservations
6. Add HCM integration
7. Add reconciliation
8. Add concurrency protection
9. Add failure handling
10. Build tests
11. Finalize documentation
```

---

# 6. Estimated Timeline

| Phase          | Estimate |
| -------------- | -------- |
| Setup          | 0.5 day  |
| DB Schema      | 0.5 day  |
| Mock HCM       | 1 day    |
| APIs           | 1–2 days |
| Reconciliation | 0.5 day  |
| Concurrency    | 0.5 day  |
| Tests          | 1–2 days |
| Documentation  | 0.5 day  |

Total:
~5–7 days for polished implementation.

---

# 7. Final Notes

The most important aspects of this assignment are:

* consistency handling
* concurrency safety
* reconciliation strategy
* resilience to HCM failures
* quality of testing

The implementation should optimize for:

* correctness
* clarity
* operational realism
* maintainability

over unnecessary architectural complexity.

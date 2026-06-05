import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';

import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
// The real mock HCM, booted in-process on a port so the time-off service reaches
// it over HTTP exactly as it would in production (cross-service, black-box).
import { AppModule as HcmAppModule } from '../../mock-hcm/src/app.module';
import { BalanceStore } from '../../mock-hcm/src/balances/balance-store';
import { FailureSimulatorService } from '../../mock-hcm/src/common/failure-simulator.service';

// Phase 8 — end-to-end suite covering the five plan scenarios against both
// services running together. timeoff uses an isolated SQLite file (never dev.db),
// seeded to mirror the HCM seed; the HCM listens on a throwaway port.

const HCM_PORT = 3199;
const DB_NAME = `test-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
const DB_FILE = path.join(process.cwd(), DB_NAME);
const DB_SIDECARS = ['', '-journal', '-wal', '-shm'].map((s) => DB_FILE + s);

// Final-state schema (post all migrations). Keep in sync with schema.prisma.
const DDL = [
  `CREATE TABLE "requests" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "employeeId" TEXT NOT NULL, "locationId" TEXT NOT NULL, "days" REAL NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'PENDING', "idempotencyKey" TEXT, "reason" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
   )`,
  `CREATE TABLE "balances" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "employeeId" TEXT NOT NULL, "locationId" TEXT NOT NULL,
     "totalBalance" REAL NOT NULL DEFAULT 0, "reservedBalance" REAL NOT NULL DEFAULT 0,
     "version" INTEGER NOT NULL DEFAULT 0,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL
   )`,
  `CREATE TABLE "ledger" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "employeeId" TEXT NOT NULL, "entryType" TEXT NOT NULL,
     "amount" REAL NOT NULL, "balanceAfter" REAL, "requestId" TEXT, "note" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ledger_requestId_fkey" FOREIGN KEY ("requestId")
       REFERENCES "requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE
   )`,
  `CREATE TABLE "reconciliation_logs" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "employeeId" TEXT NOT NULL,
     "previousBalance" REAL NOT NULL, "correctedBalance" REAL NOT NULL, "drift" REAL NOT NULL,
     "source" TEXT NOT NULL DEFAULT 'FULL_SYNC',
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
   )`,
  `CREATE UNIQUE INDEX "balances_employeeId_locationId_key" ON "balances"("employeeId", "locationId")`,
  `CREATE UNIQUE INDEX "requests_idempotencyKey_key" ON "requests"("idempotencyKey")`,
];

// Local seed mirrors the mock HCM seed so reservations have pools to draw on.
const SEED = [
  { employeeId: 'EMP-001', locationId: 'LOC-NYC', totalBalance: 30 },
  { employeeId: 'EMP-002', locationId: 'LOC-LON', totalBalance: 23 },
  { employeeId: 'EMP-100', locationId: 'LOC-SF', totalBalance: 37 },
];

function rmDbFiles(): void {
  for (const f of DB_SIDECARS) if (fs.existsSync(f)) fs.rmSync(f);
}

describe('Time-off e2e scenarios', () => {
  let timeoff: INestApplication;
  let hcm: INestApplication;
  let prisma: PrismaService;
  let store: BalanceStore;
  let failures: FailureSimulatorService;
  let api: ReturnType<typeof request>;
  let hcmApi: ReturnType<typeof request>;
  const savedEnv: Record<string, string | undefined> = {};

  const pipe = () =>
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });

  beforeAll(async () => {
    rmDbFiles();
    // PrismaService / HcmService read these at construction — set before compile.
    for (const k of [
      'DATABASE_URL',
      'HCM_BASE_URL',
      'RECONCILE_DISABLED',
      'HCM_CLIENT_RETRIES',
    ]) {
      savedEnv[k] = process.env[k];
    }
    process.env.DATABASE_URL = `file:./${DB_NAME}`;
    process.env.HCM_BASE_URL = `http://localhost:${HCM_PORT}`;
    process.env.RECONCILE_DISABLED = 'true'; // drive reconciliation explicitly
    process.env.HCM_CLIENT_RETRIES = '1'; // keep the failure scenario quick

    // Boot the mock HCM on a real port.
    const hcmRef = await Test.createTestingModule({
      imports: [HcmAppModule],
    }).compile();
    hcm = hcmRef.createNestApplication();
    hcm.useGlobalPipes(pipe());
    await hcm.listen(HCM_PORT);
    store = hcmRef.get(BalanceStore);
    failures = hcmRef.get(FailureSimulatorService);

    // Boot the time-off service (its HcmService now points at HCM_PORT).
    const toRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    timeoff = toRef.createNestApplication();
    timeoff.useGlobalPipes(pipe());
    await timeoff.init();
    prisma = toRef.get(PrismaService);
    for (const stmt of DDL) await prisma.$executeRawUnsafe(stmt);

    api = request(timeoff.getHttpServer());
    hcmApi = request(hcm.getHttpServer());
  });

  afterAll(async () => {
    await timeoff?.close();
    await hcm?.close();
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmDbFiles();
  });

  // Reset both systems to seed state before each scenario.
  beforeEach(async () => {
    store.reset();
    failures.setConfig({ timeoutRate: 0, errorRate: 0, latencyMs: 0 });
    await prisma.ledgerEntry.deleteMany();
    await prisma.reconciliationLog.deleteMany();
    await prisma.request.deleteMany();
    await prisma.balance.deleteMany();
    for (const s of SEED) {
      await prisma.balance.create({ data: { ...s, reservedBalance: 0 } });
    }
  });

  const localBalance = async (emp: string) =>
    (await api.get(`/balances/${emp}`).expect(200)).body[0];

  it('Scenario 1 — happy path: request → approve → deducted on both sides', async () => {
    const created = await api
      .post('/requests')
      .send({ employeeId: 'EMP-001', locationId: 'LOC-NYC', days: 5 })
      .expect(201);
    expect(created.body.status).toBe('RESERVED');

    // Reserved locally, total unchanged.
    expect(await localBalance('EMP-001')).toMatchObject({
      totalBalance: 30,
      reservedBalance: 5,
      availableBalance: 25,
    });

    const approved = await api
      .post(`/requests/${created.body.id}/approve`)
      .expect(200);
    expect(approved.body.status).toBe('APPROVED');

    // Local hold spent; HCM deducted to match.
    expect(await localBalance('EMP-001')).toMatchObject({
      totalBalance: 25,
      reservedBalance: 0,
      availableBalance: 25,
    });
    const hcmBal = (await hcmApi.get('/balances/EMP-001').expect(200)).body[0];
    expect(hcmBal.balance).toBe(25);
  });

  it('Scenario 2 — concurrent requests: no over-allocation', async () => {
    // balance 30; 7 concurrent requests of 5 (= 35) → only 6 can fit.
    const statuses = await Promise.all(
      Array.from({ length: 7 }, () =>
        api
          .post('/requests')
          .send({ employeeId: 'EMP-001', locationId: 'LOC-NYC', days: 5 })
          .then((r) => r.status),
      ),
    );
    expect(statuses.filter((s) => s === 201)).toHaveLength(6);
    expect(statuses.filter((s) => s >= 400)).toHaveLength(1);

    const bal = await localBalance('EMP-001');
    expect(bal.reservedBalance).toBe(30);
    expect(bal.reservedBalance).toBeLessThanOrEqual(bal.totalBalance);
  });

  it('Scenario 3 — HCM external mutation: reconciliation repairs local', async () => {
    // HCM changes outside our flow (+10 bonus).
    await hcmApi
      .post('/balances/adjust')
      .send({
        employeeId: 'EMP-002',
        locationId: 'LOC-LON',
        amount: 10,
        reason: 'bonus',
      })
      .expect(200);
    expect((await localBalance('EMP-002')).totalBalance).toBe(23); // still stale

    const summary = await api.post('/reconcile').expect(200);
    expect(summary.body).toMatchObject({ repaired: 1 });
    expect((await localBalance('EMP-002')).totalBalance).toBe(33); // repaired

    const logs = await api.get('/reconcile/logs').expect(200);
    expect(logs.body[0]).toMatchObject({
      previousBalance: 23,
      correctedBalance: 33,
      drift: 10,
      source: 'FULL_SYNC',
    });
  });

  it('Scenario 4 — HCM failure: reservation rolled back, marked FAILED_SYNC', async () => {
    const created = await api
      .post('/requests')
      .send({ employeeId: 'EMP-100', locationId: 'LOC-SF', days: 4 })
      .expect(201);
    expect((await localBalance('EMP-100')).reservedBalance).toBe(4);

    failures.setConfig({ errorRate: 1 }); // every HCM call now fails
    await api.post(`/requests/${created.body.id}/approve`).expect(503);

    const after = (await api.get(`/requests/${created.body.id}`).expect(200))
      .body;
    expect(after.status).toBe('FAILED_SYNC');
    const bal = await localBalance('EMP-100');
    expect(bal.reservedBalance).toBe(0); // hold released
    expect(bal.totalBalance).toBe(37); // never deducted
  });

  it('Scenario 5 — duplicate requests: idempotent, reserved once', async () => {
    const body = { employeeId: 'EMP-001', locationId: 'LOC-NYC', days: 3 };
    const first = await api
      .post('/requests')
      .set('Idempotency-Key', 'dup-1')
      .send(body)
      .expect(201);
    const second = await api
      .post('/requests')
      .set('Idempotency-Key', 'dup-1')
      .send(body)
      .expect(201);

    expect(second.body.id).toBe(first.body.id);
    expect((await localBalance('EMP-001')).reservedBalance).toBe(3); // not 6
  });

  it('rejects a malformed request body at the HTTP boundary (400)', async () => {
    await api
      .post('/requests')
      .send({ employeeId: 'EMP-001', locationId: 'LOC-NYC', days: -1 })
      .expect(400);
    // missing the required locationId
    await api
      .post('/requests')
      .send({ employeeId: 'EMP-001', days: 1 })
      .expect(400);
    // unknown field is rejected by the whitelist
    await api
      .post('/requests')
      .send({
        employeeId: 'EMP-001',
        locationId: 'LOC-NYC',
        days: 1,
        hacker: true,
      })
      .expect(400);
  });

  it('lists requests filtered by status and employee (manager queue / history)', async () => {
    const a = await api
      .post('/requests')
      .send({ employeeId: 'EMP-001', locationId: 'LOC-NYC', days: 2 })
      .expect(201);
    await api
      .post('/requests')
      .send({ employeeId: 'EMP-002', locationId: 'LOC-LON', days: 3 })
      .expect(201);
    await api.post(`/requests/${a.body.id}/reject`).expect(200); // EMP-001 now REJECTED

    const reserved = (await api.get('/requests?status=RESERVED').expect(200))
      .body;
    expect(reserved).toHaveLength(1);
    expect(reserved[0].employeeId).toBe('EMP-002');

    const byEmp = (await api.get('/requests?employeeId=EMP-001').expect(200))
      .body;
    expect(byEmp).toHaveLength(1);
    expect(byEmp[0].status).toBe('REJECTED');

    // unknown query param rejected by the whitelist
    await api.get('/requests?bogus=1').expect(400);
  });

  it('refreshes a single employee from HCM on demand (POST /reconcile/:employeeId)', async () => {
    await hcmApi
      .post('/balances/adjust')
      .send({
        employeeId: 'EMP-100',
        locationId: 'LOC-SF',
        amount: 5,
        reason: 'bonus',
      })
      .expect(200);
    expect((await localBalance('EMP-100')).totalBalance).toBe(37); // stale until refreshed

    const summary = await api.post('/reconcile/EMP-100').expect(200);
    expect(summary.body).toMatchObject({ repaired: 1 });
    expect((await localBalance('EMP-100')).totalBalance).toBe(42); // refreshed from HCM

    // Other employees are untouched by a targeted refresh.
    expect((await localBalance('EMP-002')).totalBalance).toBe(23);

    // An employee HCM doesn't know surfaces a 404.
    await api.post('/reconcile/NOBODY').expect(404);
  });

  it('echoes a provided correlation id and mints one otherwise', async () => {
    // Provided id is adopted and echoed on the response.
    const provided = await api
      .post('/requests')
      .set('x-correlation-id', 'trace-abc-123')
      .send({ employeeId: 'EMP-001', locationId: 'LOC-NYC', days: 1 })
      .expect(201);
    expect(provided.headers['x-correlation-id']).toBe('trace-abc-123');

    // No inbound id → a fresh one is minted (uuid-shaped).
    const minted = await api.get('/metrics').expect(200);
    expect(minted.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('exposes operational metrics at GET /metrics', async () => {
    const before = (await api.get('/metrics').expect(200)).body;

    const created = await api
      .post('/requests')
      .send({ employeeId: 'EMP-002', locationId: 'LOC-LON', days: 2 })
      .expect(201);
    await api.post(`/requests/${created.body.id}/approve`).expect(200);

    const after = (await api.get('/metrics').expect(200)).body;
    expect(after.requests.created).toBe((before.requests.created ?? 0) + 1);
    expect(after.requests.approved).toBe((before.requests.approved ?? 0) + 1);
    // The approve drove a real HCM deduct, so HCM call count moved.
    expect(after.hcm.calls).toBeGreaterThan(before.hcm.calls);
    expect(after.hcm).toHaveProperty('latencyMsAvg');
  });
});

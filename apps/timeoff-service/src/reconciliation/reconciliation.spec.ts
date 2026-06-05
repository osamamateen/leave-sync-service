import { Test } from '@nestjs/testing';
import * as fs from 'fs';
import * as path from 'path';
import { ReconciliationService } from './reconciliation.service';
import { BalancesService } from '../balances/balances.service';
import { PrismaService } from '../prisma/prisma.service';
import { HcmService, HcmBalance } from '../hcm/hcm.service';

// Phase 6 — reconciliation. Drives reconcile() against a stubbed HCM full-sync
// and asserts local pools are repaired to the HCM truth, reserved holds are
// preserved, a RECONCILE ledger row + reconciliation_logs row are written, and
// in-sync pools are left alone. Runs against a throwaway SQLite file (never
// dev.db), schema applied through the same connection — mirrors the Phase 5
// concurrency spec.

const DB_NAME = `test-reconcile-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
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
];

function rmDbFiles(): void {
  for (const f of DB_SIDECARS) if (fs.existsSync(f)) fs.rmSync(f);
}

describe('Reconciliation (drift repair)', () => {
  let prisma: PrismaService;
  let reconciliation: ReconciliationService;
  // Mutable stub for the HCM full-sync payload each test controls.
  let hcmRows: HcmBalance[];
  const fullSync = jest.fn<Promise<HcmBalance[]>, []>(() =>
    Promise.resolve(hcmRows),
  );
  // Realtime per-employee read used by reconcileEmployee.
  const getByEmployee = jest.fn<Promise<HcmBalance[]>, [string]>();

  beforeAll(async () => {
    rmDbFiles();
    process.env.DATABASE_URL = `file:./${DB_NAME}`;

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        BalancesService,
        PrismaService,
        { provide: HcmService, useValue: { fullSync, getByEmployee } },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    reconciliation = moduleRef.get(ReconciliationService);
    await prisma.onModuleInit();
    await prisma.$executeRawUnsafe('PRAGMA journal_mode=WAL');
    for (const stmt of DDL) await prisma.$executeRawUnsafe(stmt);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    rmDbFiles();
  });

  // Fresh balances + clean audit tables before each scenario.
  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany();
    await prisma.reconciliationLog.deleteMany();
    await prisma.balance.deleteMany();
    fullSync.mockClear();
    getByEmployee.mockReset();
  });

  async function seed(
    employeeId: string,
    locationId: string,
    total: number,
    reserved = 0,
  ): Promise<void> {
    await prisma.balance.create({
      data: { employeeId, locationId, totalBalance: total, reservedBalance: reserved },
    });
  }

  it('repairs a local pool that drifted below the HCM truth (external bonus)', async () => {
    await seed('EMP-1', 'LOC-A', 20, 5); // local 20 total, 5 reserved
    hcmRows = [{ employeeId: 'EMP-1', locationId: 'LOC-A', balance: 26 }]; // HCM +6

    const summary = await reconciliation.reconcile();

    expect(summary).toMatchObject({ checked: 1, repaired: 1, created: 0 });
    expect(summary.drifts[0]).toMatchObject({
      employeeId: 'EMP-1',
      previous: 20,
      corrected: 26,
      drift: 6,
    });

    const bal = await prisma.balance.findFirstOrThrow({
      where: { employeeId: 'EMP-1' },
    });
    expect(bal.totalBalance).toBe(26);
    expect(bal.reservedBalance).toBe(5); // reserved holds preserved
    expect(bal.version).toBe(1); // one guarded write

    const ledger = await prisma.ledgerEntry.findMany({
      where: { entryType: 'RECONCILE' },
    });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ amount: 6, balanceAfter: 26 });

    const logs = await prisma.reconciliationLog.findMany();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      previousBalance: 20,
      correctedBalance: 26,
      drift: 6,
      source: 'FULL_SYNC',
    });
  });

  it('repairs downward drift (HCM correction) and leaves in-sync pools alone', async () => {
    await seed('EMP-1', 'LOC-A', 30); // will drift down
    await seed('EMP-2', 'LOC-B', 15); // already in sync
    hcmRows = [
      { employeeId: 'EMP-1', locationId: 'LOC-A', balance: 12 },
      { employeeId: 'EMP-2', locationId: 'LOC-B', balance: 15 },
    ];

    const summary = await reconciliation.reconcile();

    expect(summary).toMatchObject({ checked: 2, repaired: 1, created: 0 });
    const a = await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-1' } });
    const b = await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-2' } });
    expect(a.totalBalance).toBe(12);
    expect(a.version).toBe(1);
    expect(b.totalBalance).toBe(15);
    expect(b.version).toBe(0); // untouched — no phantom write

    expect(await prisma.reconciliationLog.count()).toBe(1);
  });

  it('materializes a local pool the HCM knows but we do not', async () => {
    hcmRows = [{ employeeId: 'EMP-NEW', locationId: 'LOC-C', balance: 40 }];

    const summary = await reconciliation.reconcile();

    expect(summary).toMatchObject({ checked: 1, repaired: 0, created: 1 });
    const created = await prisma.balance.findFirstOrThrow({
      where: { employeeId: 'EMP-NEW' },
    });
    expect(created).toMatchObject({
      totalBalance: 40,
      reservedBalance: 0,
      version: 0,
    });
  });

  it('is a no-op when everything is already in sync', async () => {
    await seed('EMP-1', 'LOC-A', 10);
    hcmRows = [{ employeeId: 'EMP-1', locationId: 'LOC-A', balance: 10 }];

    const summary = await reconciliation.reconcile();

    expect(summary).toMatchObject({ checked: 1, repaired: 0, created: 0 });
    expect(summary.drifts).toHaveLength(0);
    expect(await prisma.reconciliationLog.count()).toBe(0);
  });

  it('reconcileEmployee repairs just that employee via the realtime per-employee read', async () => {
    await seed('EMP-1', 'LOC-A', 20); // will drift
    await seed('EMP-2', 'LOC-B', 15); // must be left alone
    getByEmployee.mockResolvedValue([
      { employeeId: 'EMP-1', locationId: 'LOC-A', balance: 26 },
    ]);

    const summary = await reconciliation.reconcileEmployee('EMP-1');

    expect(getByEmployee).toHaveBeenCalledWith('EMP-1');
    expect(summary).toMatchObject({ checked: 1, repaired: 1, created: 0 });
    expect(
      (await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-1' } })).totalBalance,
    ).toBe(26);
    // The other employee was never read and never touched.
    expect(
      (await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-2' } })).totalBalance,
    ).toBe(15);
  });
});

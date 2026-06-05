import { Test } from '@nestjs/testing';
import { UnprocessableEntityException, HttpException } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { BalancesService } from '../balances/balances.service';
import { PrismaService } from '../prisma/prisma.service';
import { HcmService } from '../hcm/hcm.service';

// Phase 5 — concurrency protection. Fires genuinely concurrent createRequest
// calls against one pooled balance and asserts the optimistic-lock guard never
// lets reserved exceed total (no double allocation). Runs against a throwaway
// SQLite file in the app dir — never dev.db — created via the same connection
// the service uses, so there is no CLI / cwd path mismatch to manage.

const DB_NAME = `test-concurrency-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
const DB_FILE = path.join(process.cwd(), DB_NAME);
const DB_SIDECARS = ['', '-journal', '-wal', '-shm'].map((s) => DB_FILE + s);

// Final-state schema (post all migrations). Keep in sync with schema.prisma —
// this suite owns its own database rather than depending on a migrated dev.db.
const DDL = [
  `CREATE TABLE "requests" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "employeeId" TEXT NOT NULL,
     "locationId" TEXT NOT NULL,
     "days" REAL NOT NULL,
     "status" TEXT NOT NULL DEFAULT 'PENDING',
     "idempotencyKey" TEXT,
     "reason" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL
   )`,
  `CREATE TABLE "balances" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "employeeId" TEXT NOT NULL,
     "locationId" TEXT NOT NULL,
     "totalBalance" REAL NOT NULL DEFAULT 0,
     "reservedBalance" REAL NOT NULL DEFAULT 0,
     "version" INTEGER NOT NULL DEFAULT 0,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     "updatedAt" DATETIME NOT NULL
   )`,
  `CREATE TABLE "ledger" (
     "id" TEXT NOT NULL PRIMARY KEY,
     "employeeId" TEXT NOT NULL,
     "entryType" TEXT NOT NULL,
     "amount" REAL NOT NULL,
     "balanceAfter" REAL,
     "requestId" TEXT,
     "note" TEXT,
     "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
     CONSTRAINT "ledger_requestId_fkey" FOREIGN KEY ("requestId")
       REFERENCES "requests" ("id") ON DELETE SET NULL ON UPDATE CASCADE
   )`,
  `CREATE UNIQUE INDEX "balances_employeeId_locationId_key" ON "balances"("employeeId", "locationId")`,
];

function rmDbFiles(): void {
  for (const f of DB_SIDECARS) {
    if (fs.existsSync(f)) fs.rmSync(f);
  }
}

describe('Requests concurrency (optimistic locking)', () => {
  let prisma: PrismaService;
  let requests: RequestsService;

  beforeAll(async () => {
    rmDbFiles();
    // PrismaService reads DATABASE_URL at construction, so set it before compile.
    process.env.DATABASE_URL = `file:./${DB_NAME}`;

    const moduleRef = await Test.createTestingModule({
      providers: [
        RequestsService,
        BalancesService,
        PrismaService,
        // create() never calls HCM (it only reserves locally); stub it out.
        { provide: HcmService, useValue: { deduct: jest.fn() } },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    requests = moduleRef.get(RequestsService);
    await prisma.onModuleInit();

    // WAL + a busy timeout so any incidental lock waits rather than erroring.
    await prisma.$executeRawUnsafe('PRAGMA journal_mode=WAL');
    await prisma.$executeRawUnsafe('PRAGMA busy_timeout=5000');
    for (const stmt of DDL) {
      await prisma.$executeRawUnsafe(stmt);
    }
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    rmDbFiles();
  });

  async function seedBalance(employeeId: string, total: number): Promise<void> {
    await prisma.balance.create({
      data: {
        employeeId,
        locationId: 'LOC-T',
        totalBalance: total,
        reservedBalance: 0,
      },
    });
  }

  function req(employeeId: string, days: number): CreateRequestDto {
    return { employeeId, locationId: 'LOC-T', days } as CreateRequestDto;
  }

  it('rejects the over-allocating request: balance 10, A=7 + B=6 → exactly one wins', async () => {
    const employeeId = 'CC-OVER';
    await seedBalance(employeeId, 10);

    const results = await Promise.allSettled([
      requests.create(req(employeeId, 7)),
      requests.create(req(employeeId, 6)),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // The loser fails its balance check (now insufficient) → 422, not a crash.
    const reason = rejected[0].reason as unknown;
    expect(reason).toBeInstanceOf(UnprocessableEntityException);
    expect((reason as HttpException).getStatus()).toBe(422);

    const bal = await prisma.balance.findFirstOrThrow({ where: { employeeId } });
    const winnerDays = (fulfilled[0] as PromiseFulfilledResult<{ days: number }>)
      .value.days;
    expect(bal.reservedBalance).toBe(winnerDays);
    expect(bal.reservedBalance).toBeLessThanOrEqual(bal.totalBalance); // no over-allocation
    expect(bal.version).toBe(1); // exactly one guarded write landed

    const reservedRows = await prisma.request.count({
      where: { employeeId, status: 'RESERVED' },
    });
    expect(reservedRows).toBe(1);
  });

  it('allows two compatible requests: balance 10, A=4 + B=5 → both win (reserved 9)', async () => {
    const employeeId = 'CC-FIT';
    await seedBalance(employeeId, 10);

    const results = await Promise.allSettled([
      requests.create(req(employeeId, 4)),
      requests.create(req(employeeId, 5)),
    ]);

    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    const bal = await prisma.balance.findFirstOrThrow({ where: { employeeId } });
    expect(bal.reservedBalance).toBe(9);
    expect(bal.reservedBalance).toBeLessThanOrEqual(bal.totalBalance);
    expect(bal.version).toBe(2); // both guarded writes landed (one may have retried)
  });
});

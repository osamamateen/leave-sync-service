import { Test } from '@nestjs/testing';
import {
  ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { RequestsService } from './requests.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { BalancesService } from '../balances/balances.service';
import { PrismaService } from '../prisma/prisma.service';
import { HcmService } from '../hcm/hcm.service';

// Phase 7 — failure handling. Covers compensation (HCM failure at approve rolls
// the reservation back and marks FAILED_SYNC) and request-creation idempotency
// (same Idempotency-Key reserves once, even under a concurrent race). Isolated
// SQLite file, schema applied through the same connection — mirrors the earlier
// concurrency / reconciliation specs.

const DB_NAME = `test-failure-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
const DB_FILE = path.join(process.cwd(), DB_NAME);
const DB_SIDECARS = ['', '-journal', '-wal', '-shm'].map((s) => DB_FILE + s);

// Final-state schema (post all migrations), including the unique idempotencyKey
// index the race path relies on. Keep in sync with schema.prisma.
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
  `CREATE UNIQUE INDEX "balances_employeeId_locationId_key" ON "balances"("employeeId", "locationId")`,
  `CREATE UNIQUE INDEX "requests_idempotencyKey_key" ON "requests"("idempotencyKey")`,
];

function rmDbFiles(): void {
  for (const f of DB_SIDECARS) if (fs.existsSync(f)) fs.rmSync(f);
}

describe('Requests failure handling (compensation + idempotency)', () => {
  let prisma: PrismaService;
  let requests: RequestsService;
  const deduct = jest.fn();

  beforeAll(async () => {
    rmDbFiles();
    process.env.DATABASE_URL = `file:./${DB_NAME}`;

    const moduleRef = await Test.createTestingModule({
      providers: [
        RequestsService,
        BalancesService,
        PrismaService,
        { provide: HcmService, useValue: { deduct } },
      ],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    requests = moduleRef.get(RequestsService);
    await prisma.onModuleInit();
    await prisma.$executeRawUnsafe('PRAGMA journal_mode=WAL');
    for (const stmt of DDL) await prisma.$executeRawUnsafe(stmt);
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
    rmDbFiles();
  });

  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany();
    await prisma.request.deleteMany();
    await prisma.balance.deleteMany();
    deduct.mockReset();
  });

  async function seed(
    employeeId: string,
    total: number,
    locationId = 'LOC-A',
  ): Promise<void> {
    await prisma.balance.create({
      data: { employeeId, locationId, totalBalance: total, reservedBalance: 0 },
    });
  }

  function req(
    employeeId: string,
    days: number,
    locationId = 'LOC-A',
  ): CreateRequestDto {
    return { employeeId, locationId, days } as CreateRequestDto;
  }

  it('rolls the reservation back and marks FAILED_SYNC when HCM deduct fails at approve', async () => {
    await seed('EMP-1', 10);
    const created = await requests.create(req('EMP-1', 4));

    // Hold is in place.
    let bal = await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-1' } });
    expect(bal.reservedBalance).toBe(4);

    deduct.mockRejectedValueOnce(new ServiceUnavailableException('HCM down'));
    await expect(requests.approve(created.id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    // Compensation: hold released (available restored), request terminal.
    bal = await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-1' } });
    expect(bal.reservedBalance).toBe(0);
    expect(bal.totalBalance).toBe(10); // total untouched — never deducted
    const after = await prisma.request.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.status).toBe('FAILED_SYNC');

    // A RELEASE ledger row records the compensation.
    const release = await prisma.ledgerEntry.findMany({ where: { entryType: 'RELEASE' } });
    expect(release).toHaveLength(1);

    // Terminal request can't be approved again.
    await expect(requests.approve(created.id)).rejects.toMatchObject({ status: 409 });
  });

  it('surfaces a deterministic HCM 422 verbatim (not a 503) and rolls back', async () => {
    await seed('EMP-1b', 10);
    const created = await requests.create(req('EMP-1b', 4));

    // HCM deterministically rejects (e.g. its own balance is insufficient).
    deduct.mockRejectedValueOnce(
      new UnprocessableEntityException('HCM insufficient'),
    );
    await expect(requests.approve(created.id)).rejects.toMatchObject({ status: 422 });

    const bal = await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-1b' } });
    expect(bal.reservedBalance).toBe(0); // hold released
    expect(bal.totalBalance).toBe(10);
    const after = await prisma.request.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.status).toBe('FAILED_SYNC');
  });

  it('treats a 2xx with a non-numeric balance as a failed sync (rolls back, 503)', async () => {
    await seed('EMP-1c', 10);
    const created = await requests.create(req('EMP-1c', 4));

    // HCM replies 200 OK but with a garbage body — don't trust it.
    deduct.mockResolvedValueOnce({ employeeId: 'EMP-1c', locationId: 'LOC-A', balance: NaN });
    await expect(requests.approve(created.id)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );

    const bal = await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-1c' } });
    expect(bal.reservedBalance).toBe(0); // not committed
    expect(bal.totalBalance).toBe(10);
    const after = await prisma.request.findUniqueOrThrow({ where: { id: created.id } });
    expect(after.status).toBe('FAILED_SYNC');
  });

  it('approve still commits normally when HCM succeeds (no compensation)', async () => {
    await seed('EMP-2', 10);
    const created = await requests.create(req('EMP-2', 3));
    deduct.mockResolvedValueOnce({ employeeId: 'EMP-2', locationId: 'LOC-A', balance: 7 });

    const approved = await requests.approve(created.id);
    expect(approved.status).toBe('APPROVED');
    const bal = await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-2' } });
    expect(bal.totalBalance).toBe(7);
    expect(bal.reservedBalance).toBe(0);
    expect(deduct).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: created.id, days: 3 }),
    );
  });

  it('returns the original request on an idempotent replay (no second reservation)', async () => {
    await seed('EMP-3', 10);
    const first = await requests.create(req('EMP-3', 5), 'key-abc');
    const second = await requests.create(req('EMP-3', 5), 'key-abc');

    expect(second.id).toBe(first.id);
    const count = await prisma.request.count({ where: { employeeId: 'EMP-3' } });
    expect(count).toBe(1);
    const bal = await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-3' } });
    expect(bal.reservedBalance).toBe(5); // reserved once, not 10
  });

  it('reserves once under a concurrent race on the same Idempotency-Key', async () => {
    await seed('EMP-4', 10);
    const results = await Promise.allSettled([
      requests.create(req('EMP-4', 6), 'key-race'),
      requests.create(req('EMP-4', 6), 'key-race'),
    ]);

    // Both calls resolve (the loser of the unique race gets the winner back).
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    const ids = (results as PromiseFulfilledResult<{ id: string }>[]).map(
      (r) => r.value.id,
    );
    expect(ids[0]).toBe(ids[1]);

    const count = await prisma.request.count({ where: { employeeId: 'EMP-4' } });
    expect(count).toBe(1);
    const bal = await prisma.balance.findFirstOrThrow({ where: { employeeId: 'EMP-4' } });
    expect(bal.reservedBalance).toBe(6); // reserved exactly once
  });

  it('draws from the named location only — pools are per (employee, location)', async () => {
    // Same employee, two independent pools.
    await seed('EMP-5', 10, 'LOC-NYC');
    await seed('EMP-5', 4, 'LOC-SF');

    await requests.create(req('EMP-5', 8, 'LOC-NYC'));
    const nyc = await prisma.balance.findUniqueOrThrow({
      where: { employeeId_locationId: { employeeId: 'EMP-5', locationId: 'LOC-NYC' } },
    });
    const sf = await prisma.balance.findUniqueOrThrow({
      where: { employeeId_locationId: { employeeId: 'EMP-5', locationId: 'LOC-SF' } },
    });
    expect(nyc.reservedBalance).toBe(8); // NYC pool drawn
    expect(sf.reservedBalance).toBe(0); // SF pool untouched

    // SF has only 4 available — an 8-day SF request is rejected regardless of NYC.
    await expect(requests.create(req('EMP-5', 8, 'LOC-SF'))).rejects.toMatchObject({
      status: 422,
    });
    // A 3-day SF request fits its own pool.
    await requests.create(req('EMP-5', 3, 'LOC-SF'));
    expect(
      (
        await prisma.balance.findUniqueOrThrow({
          where: { employeeId_locationId: { employeeId: 'EMP-5', locationId: 'LOC-SF' } },
        })
      ).reservedBalance,
    ).toBe(3);

    // A location the employee has no pool at → 404.
    await expect(requests.create(req('EMP-5', 1, 'LOC-NONE'))).rejects.toMatchObject({
      status: 404,
    });
  });
});

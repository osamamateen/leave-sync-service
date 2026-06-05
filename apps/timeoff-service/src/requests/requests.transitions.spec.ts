import { ConflictException, NotFoundException } from '@nestjs/common';
import { RequestsService } from './requests.service';
import { PrismaService } from '../prisma/prisma.service';
import { BalancesService } from '../balances/balances.service';
import { HcmService } from '../hcm/hcm.service';

// Phase 8 unit — request state transitions. No database / HCM: a mocked
// findUnique drives the lifecycle guards (404 unknown, 409 only-RESERVED-can-be-
// approved/rejected). The balance and HCM collaborators are asserted untouched,
// proving the guard short-circuits before any side effect.
describe('RequestsService state transitions', () => {
  let findUnique: jest.Mock;
  let findMany: jest.Mock;
  let balances: { resolveBalance: jest.Mock };
  let hcm: { deduct: jest.Mock };
  let service: RequestsService;

  beforeEach(() => {
    findUnique = jest.fn();
    findMany = jest.fn();
    balances = { resolveBalance: jest.fn() };
    hcm = { deduct: jest.fn() };
    const prisma = {
      request: { findUnique, findMany, findFirst: jest.fn() },
      balance: { findFirst: jest.fn() },
    } as unknown as PrismaService;
    service = new RequestsService(
      prisma,
      balances as unknown as BalancesService,
      hcm as unknown as HcmService,
    );
  });

  it('list() forwards only the provided filters and maps rows to responses', async () => {
    findMany.mockResolvedValue([
      {
        id: 'r1', employeeId: 'EMP-1', locationId: 'LOC-A',
        days: 2, status: 'RESERVED', reason: null, createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);

    const out = await service.list({ status: 'RESERVED', employeeId: 'EMP-1' });

    expect(findMany).toHaveBeenCalledWith({
      where: { employeeId: 'EMP-1', status: 'RESERVED' }, // no locationId key when absent
      orderBy: { createdAt: 'desc' },
    });
    expect(out).toEqual([
      expect.objectContaining({ id: 'r1', locationId: 'LOC-A', status: 'RESERVED' }),
    ]);
  });

  it('list() with no filters queries with an empty where', async () => {
    findMany.mockResolvedValue([]);
    await service.list({});
    expect(findMany).toHaveBeenCalledWith({ where: {}, orderBy: { createdAt: 'desc' } });
  });

  it('404s on an unknown request for getById / approve / reject', async () => {
    findUnique.mockResolvedValue(null);
    await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.approve('nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.reject('nope')).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each(['APPROVED', 'REJECTED', 'FAILED_SYNC', 'PENDING'])(
    '409s when approving a %s request, with no HCM call',
    async (status) => {
      findUnique.mockResolvedValue({ id: 'r1', employeeId: 'EMP-1', status });
      await expect(service.approve('r1')).rejects.toBeInstanceOf(ConflictException);
      expect(hcm.deduct).not.toHaveBeenCalled();
    },
  );

  it('409s when rejecting a non-RESERVED request, with no balance write', async () => {
    findUnique.mockResolvedValue({ id: 'r1', employeeId: 'EMP-1', status: 'APPROVED' });
    await expect(service.reject('r1')).rejects.toBeInstanceOf(ConflictException);
    expect(balances.resolveBalance).not.toHaveBeenCalled();
  });
});

import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BalancesService } from './balances.service';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';

// Phase 8 unit — balance calculations. No database: a partial PrismaService mock
// feeds rows in, so this exercises the pure derivation (availableBalance =
// totalBalance - reservedBalance) and the insufficient-balance guard.
describe('BalancesService calculations', () => {
  let findMany: jest.Mock;
  let service: BalancesService;

  beforeEach(() => {
    findMany = jest.fn();
    const prisma = { balance: { findMany } } as unknown as PrismaService;
    service = new BalancesService(prisma);
  });

  it('derives available as total - reserved', () => {
    expect(service.available({ totalBalance: 30, reservedBalance: 12 } as never)).toBe(18);
    expect(service.available({ totalBalance: 5, reservedBalance: 5 } as never)).toBe(0);
  });

  it('projects each row with a derived availableBalance', async () => {
    findMany.mockResolvedValue([
      { employeeId: 'EMP-1', locationId: 'LOC-A', totalBalance: 30, reservedBalance: 7, version: 2 },
    ]);
    const [projection] = await service.getProjectedBalances('EMP-1');
    expect(projection).toEqual({
      employeeId: 'EMP-1',
      locationId: 'LOC-A',
      totalBalance: 30,
      reservedBalance: 7,
      availableBalance: 23,
      version: 2,
    });
  });

  it('404s when an employee has no local pools', async () => {
    findMany.mockResolvedValue([]);
    await expect(service.getProjectedBalances('NOBODY')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('refuses to reserve more than is available (422) without touching the row', async () => {
    const update = jest.fn();
    const tx = { balance: { updateMany: update } } as unknown as Prisma.TransactionClient;
    const balance = {
      id: 'b1', employeeId: 'EMP-1', locationId: 'LOC-A',
      totalBalance: 10, reservedBalance: 8, version: 0,
    };
    // available = 2, request 5 → reject, and never issue the update.
    await expect(
      service.reserveBalance(tx, balance, 5, 'req-1'),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(update).not.toHaveBeenCalled();
  });
});

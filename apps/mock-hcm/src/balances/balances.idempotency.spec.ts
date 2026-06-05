import { Test } from '@nestjs/testing';
import { BalancesService } from './balances.service';
import { BalanceStore } from './balance-store';
import { FailureSimulatorService } from '../common/failure-simulator.service';

// Phase 7 — the mock HCM honours an Idempotency-Key on deduct: a replayed deduct
// (same key) returns the original result without applying the deduction twice.
// Seed: EMP-001 @ LOC-NYC = 30.
describe('HCM deduct idempotency', () => {
  let balances: BalancesService;
  let store: BalanceStore;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [BalancesService, BalanceStore, FailureSimulatorService],
    }).compile();
    balances = moduleRef.get(BalancesService);
    store = moduleRef.get(BalanceStore);
    store.reset();
  });

  const deductDto = { employeeId: 'EMP-001', locationId: 'LOC-NYC', days: 5 };

  it('applies a keyed deduct once and returns the same result on replay', async () => {
    const first = await balances.deduct(deductDto, 'key-1');
    expect(first.balance).toBe(25);

    // Replay with the same key: no second deduction, original result returned.
    const replay = await balances.deduct(deductDto, 'key-1');
    expect(replay.balance).toBe(25);

    // Confirm the live store really only moved once.
    const live = store.find('EMP-001', 'LOC-NYC');
    expect(live?.balance).toBe(25);
  });

  it('applies every call when no key is supplied', async () => {
    const first = await balances.deduct(deductDto);
    expect(first.balance).toBe(25);
    const second = await balances.deduct(deductDto);
    expect(second.balance).toBe(20);
  });

  it('treats distinct keys as distinct operations', async () => {
    const a = await balances.deduct(deductDto, 'key-a');
    expect(a.balance).toBe(25);
    const b = await balances.deduct(deductDto, 'key-b');
    expect(b.balance).toBe(20);
  });

  it('does not remember a key when the deduct was rejected', async () => {
    // First, draw the pool down to 3 so a 5-day deduct can't fit.
    await balances.deduct({
      employeeId: 'EMP-001',
      locationId: 'LOC-NYC',
      days: 27,
    });
    const live = store.find('EMP-001', 'LOC-NYC');
    expect(live?.balance).toBe(3);

    // A rejected keyed deduct must not be cached as a successful result.
    await expect(balances.deduct(deductDto, 'key-x')).rejects.toMatchObject({
      status: 422,
    });
    expect(store.recallDeduct('key-x')).toBeUndefined();
  });
});

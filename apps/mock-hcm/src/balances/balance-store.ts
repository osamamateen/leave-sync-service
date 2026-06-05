import { Injectable } from '@nestjs/common';

// The HCM's authoritative view of an employee's pooled balance at a location.
// Balances are keyed by (employeeId, locationId), not by leave type — a single
// pool per location. `balance` is the remaining entitlement (HCM does not track
// reservations — that is the time-off service's local concern).
export interface HcmBalanceRecord {
  employeeId: string;
  locationId: string;
  balance: number;
}

// Seed data: the external system's starting state. One pooled row per
// (employeeId, locationId).
const SEED: HcmBalanceRecord[] = [
  { employeeId: 'EMP-001', locationId: 'LOC-NYC', balance: 30 },
  { employeeId: 'EMP-002', locationId: 'LOC-LON', balance: 23 },
  { employeeId: 'EMP-100', locationId: 'LOC-SF', balance: 37 },
];

// In-memory state store. The mock HCM is a separate system, so it deliberately
// does NOT share the time-off service's Prisma database.
@Injectable()
export class BalanceStore {
  private readonly records = new Map<string, HcmBalanceRecord>();
  // Idempotency-Key → the result snapshot from the first deduct that used it, so
  // a replayed deduct returns the original outcome instead of deducting again.
  private readonly deductResults = new Map<string, HcmBalanceRecord>();

  constructor() {
    this.reset();
  }

  private key(employeeId: string, locationId: string): string {
    return `${employeeId}::${locationId}`;
  }

  // Restore seed state (useful between tests).
  reset(): void {
    this.records.clear();
    this.deductResults.clear();
    for (const r of SEED) {
      this.records.set(this.key(r.employeeId, r.locationId), { ...r });
    }
  }

  // Idempotency for deduct: recall the result a key already produced (if any),
  // and remember a freshly-applied one. A copy is stored so later live mutations
  // to the same pool don't alter the remembered snapshot.
  recallDeduct(idempotencyKey: string): HcmBalanceRecord | undefined {
    return this.deductResults.get(idempotencyKey);
  }

  rememberDeduct(idempotencyKey: string, result: HcmBalanceRecord): void {
    this.deductResults.set(idempotencyKey, { ...result });
  }

  // Returns the live stored record (mutate in place to update), or undefined.
  find(employeeId: string, locationId: string): HcmBalanceRecord | undefined {
    return this.records.get(this.key(employeeId, locationId));
  }

  findByEmployee(employeeId: string): HcmBalanceRecord[] {
    return [...this.records.values()].filter(
      (r) => r.employeeId === employeeId,
    );
  }

  findAll(): HcmBalanceRecord[] {
    return [...this.records.values()];
  }
}

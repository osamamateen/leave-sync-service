// Shared domain types used across timeoff-service and mock-hcm.
// Mirror the Prisma models in apps/timeoff-service/prisma/schema.prisma.

export type RequestStatus =
  | 'PENDING'
  | 'RESERVED'
  | 'APPROVED'
  | 'REJECTED'
  | 'FAILED_SYNC';

// Append-only ledger movement kinds.
export type LedgerEntryType =
  | 'RESERVE'
  | 'RELEASE'
  | 'DEDUCT'
  | 'ADJUST'
  | 'RECONCILE';

export interface BalanceDto {
  employeeId: string;
  // Balances are pooled per location, not split by leave type.
  locationId: string;
  totalBalance: number;
  reservedBalance: number;
  // Derived: totalBalance - reservedBalance.
  availableBalance?: number;
  // Optimistic-locking token: every balance mutation guards on this value and
  // increments it, so concurrent reservations can't double-allocate the pool.
  version?: number;
}

// Body for POST /requests on the time-off service. Balances are pooled per
// (employeeId, locationId), so a request names the location it draws from.
// Duplicate-safety is opt-in via an `Idempotency-Key` HTTP header (not a body
// field): repeating a create with the same key returns the original request
// instead of reserving again.
export interface CreateRequestInput {
  employeeId: string;
  locationId: string;
  days: number;
  reason?: string;
}

export interface RequestDto {
  id: string;
  employeeId: string;
  locationId: string;
  days: number;
  status: RequestStatus;
  reason?: string | null;
  createdAt: string;
}

// One reconciliation_logs row: a single drift correction the reconciliation job
// applied against the HCM source of truth.
export interface ReconciliationLogDto {
  id: string;
  employeeId: string;
  previousBalance: number;
  correctedBalance: number;
  drift: number; // correctedBalance - previousBalance
  source: string; // e.g. 'FULL_SYNC'
  createdAt: string;
}

// Result of a reconciliation pass (POST /reconcile).
export interface ReconcileSummaryDto {
  checked: number; // HCM pools examined
  repaired: number; // pools whose total was corrected
  created: number; // local pools materialized from HCM
  drifts: Array<{
    employeeId: string;
    locationId: string;
    previous: number;
    corrected: number;
    drift: number;
  }>;
}

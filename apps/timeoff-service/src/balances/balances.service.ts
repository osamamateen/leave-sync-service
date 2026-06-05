import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '../../generated/prisma/client';

// Raised when a version-guarded balance update touches zero rows: the row was
// modified by a concurrent transaction since we read it (its `version` moved).
// Callers catch this to retry the read-modify-write on a fresh snapshot — see
// RequestsService.withOptimisticRetry.
export class OptimisticLockError extends Error {
  constructor(public readonly balanceId: string) {
    super(`Optimistic lock conflict on balance '${balanceId}'`);
    this.name = 'OptimisticLockError';
  }
}

// Local projection of a balance row, with availableBalance derived (it is NOT
// stored — see schema.prisma).
export interface BalanceProjection {
  employeeId: string;
  locationId: string;
  totalBalance: number;
  reservedBalance: number;
  availableBalance: number;
  version: number;
}

// Minimal shape the reservation primitives need from a balance row. `version`
// is the optimistic-locking token every mutator guards on.
interface BalanceRef {
  id: string;
  employeeId: string;
  locationId: string;
  totalBalance: number;
  reservedBalance: number;
  version: number;
}

@Injectable()
export class BalancesService {
  constructor(private readonly prisma: PrismaService) {}

  // GET /balances/:employeeId — local projected balances for one employee.
  async getProjectedBalances(employeeId: string): Promise<BalanceProjection[]> {
    const rows = await this.prisma.balance.findMany({ where: { employeeId } });
    if (rows.length === 0) {
      throw new NotFoundException(`No local balance for employee '${employeeId}'`);
    }
    return rows.map((b) => this.project(b));
  }

  // Resolve the pooled balance for one (employeeId, locationId) — the unique key
  // a request draws against.
  async resolveBalance(
    tx: Prisma.TransactionClient,
    employeeId: string,
    locationId: string,
  ): Promise<BalanceRef> {
    const balance = await tx.balance.findUnique({
      where: { employeeId_locationId: { employeeId, locationId } },
    });
    if (!balance) {
      throw new NotFoundException(
        `No local balance for employee '${employeeId}' at location '${locationId}'`,
      );
    }
    return balance;
  }

  available(balance: BalanceRef): number {
    return balance.totalBalance - balance.reservedBalance;
  }

  // Hold `days` against the pool: available must cover it; reservedBalance rises
  // while totalBalance is untouched. Writes a RESERVE ledger entry.
  //
  // Concurrency: the available check runs against the snapshot the caller read,
  // and the write is guarded on that snapshot's `version`. If another tx changed
  // the row in between, the guarded update touches zero rows and we raise
  // OptimisticLockError so the caller retries on fresh data — preventing two
  // requests from both reserving the same available days (double allocation).
  async reserveBalance(
    tx: Prisma.TransactionClient,
    balance: BalanceRef,
    days: number,
    requestId: string,
  ): Promise<void> {
    if (this.available(balance) < days) {
      throw new UnprocessableEntityException(
        `Insufficient balance for '${balance.employeeId}' at '${balance.locationId}': ` +
          `available ${this.available(balance)}, requested ${days}`,
      );
    }
    await this.guardedUpdate(tx, balance, {
      reservedBalance: { increment: days },
    });
    await this.writeLedger(tx, {
      employeeId: balance.employeeId,
      entryType: 'RESERVE',
      amount: days,
      balanceAfter: balance.totalBalance, // reserve does not move the total
      requestId,
      note: `reserved ${days} day(s)`,
    });
  }

  // Drop a hold without spending it (request rejected): reservedBalance falls,
  // totalBalance untouched. Writes a RELEASE ledger entry.
  async releaseReservation(
    tx: Prisma.TransactionClient,
    balance: BalanceRef,
    days: number,
    requestId: string,
  ): Promise<void> {
    await this.guardedUpdate(tx, balance, {
      reservedBalance: { decrement: days },
    });
    await this.writeLedger(tx, {
      employeeId: balance.employeeId,
      entryType: 'RELEASE',
      amount: days,
      balanceAfter: balance.totalBalance, // release does not move the total
      requestId,
      note: `released ${days} day(s)`,
    });
  }

  // Spend a hold (request approved + HCM deducted): both totalBalance and
  // reservedBalance fall by `days`, leaving availableBalance unchanged. Writes
  // a DEDUCT ledger entry snapshotting the new total.
  async commitDeduction(
    tx: Prisma.TransactionClient,
    balance: BalanceRef,
    days: number,
    requestId: string,
  ): Promise<void> {
    await this.guardedUpdate(tx, balance, {
      totalBalance: { decrement: days },
      reservedBalance: { decrement: days },
    });
    await this.writeLedger(tx, {
      employeeId: balance.employeeId,
      entryType: 'DEDUCT',
      amount: -days,
      balanceAfter: balance.totalBalance - days,
      requestId,
      note: `deducted ${days} day(s)`,
    });
  }

  // Repair a pool's totalBalance to the authoritative HCM value (Phase 6
  // reconciliation). `reservedBalance` is local-only state and is left untouched
  // — only the entitlement total is reconciled. Records the signed correction as
  // an immutable RECONCILE ledger row and bumps `version` like every mutation.
  // (If HCM has dropped below what is currently reserved, availableBalance may go
  // negative — that is a faithful reflection of the external truth, not clamped.)
  async reconcileTotal(
    tx: Prisma.TransactionClient,
    balance: BalanceRef,
    hcmTotal: number,
    note: string,
  ): Promise<void> {
    const drift = hcmTotal - balance.totalBalance;
    await this.guardedUpdate(tx, balance, { totalBalance: hcmTotal });
    await this.writeLedger(tx, {
      employeeId: balance.employeeId,
      entryType: 'RECONCILE',
      amount: drift,
      balanceAfter: hcmTotal,
      note,
    });
  }

  // Apply a balance mutation under optimistic locking: the update only matches
  // when the row still carries the `version` we read, and it bumps that version
  // so a stale concurrent writer's own guarded update will miss. `updateMany`
  // (not `update`) is required because Prisma's unique-only `update` where can't
  // carry the non-unique `version` predicate. Zero rows affected == conflict.
  private async guardedUpdate(
    tx: Prisma.TransactionClient,
    balance: BalanceRef,
    data: Prisma.BalanceUpdateManyMutationInput,
  ): Promise<void> {
    const { count } = await tx.balance.updateMany({
      where: { id: balance.id, version: balance.version },
      data: { ...data, version: { increment: 1 } },
    });
    if (count === 0) {
      throw new OptimisticLockError(balance.id);
    }
  }

  private project(b: BalanceRef): BalanceProjection {
    return {
      employeeId: b.employeeId,
      locationId: b.locationId,
      totalBalance: b.totalBalance,
      reservedBalance: b.reservedBalance,
      availableBalance: this.available(b),
      version: b.version,
    };
  }

  private writeLedger(
    tx: Prisma.TransactionClient,
    data: {
      employeeId: string;
      entryType: string;
      amount: number;
      balanceAfter: number;
      requestId?: string; // reconciliation entries are not tied to a request
      note: string;
    },
  ): Promise<unknown> {
    return tx.ledgerEntry.create({ data });
  }
}

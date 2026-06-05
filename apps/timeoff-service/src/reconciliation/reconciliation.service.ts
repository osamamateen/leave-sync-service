import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { HcmService, HcmBalance } from '../hcm/hcm.service';
import {
  BalancesService,
  OptimisticLockError,
} from '../balances/balances.service';
import { MetricsService } from '../observability/metrics.service';

// Floats compared with a small tolerance so half-day values never register as
// phantom drift from REAL round-tripping.
const EPSILON = 1e-6;

// One repaired pool.
export interface ReconcileDrift {
  employeeId: string;
  locationId: string;
  previous: number;
  corrected: number;
  drift: number;
}

// Outcome of a reconciliation pass.
export interface ReconcileSummary {
  checked: number; // HCM pools examined
  repaired: number; // pools whose total was corrected
  created: number; // local pools materialized from HCM
  drifts: ReconcileDrift[];
}

// Phase 6 — reconciliation. Periodically pulls the HCM's authoritative balances
// and repairs local drift. HCM is the source of truth for the entitlement
// `totalBalance`; local `reservedBalance` (pending holds) is never touched.
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger('Reconciliation');
  // Guards against a slow run overlapping the next cron tick.
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly hcm: HcmService,
    private readonly balances: BalancesService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // Scheduled sweep. Disable in tests / HCM-less dev with RECONCILE_DISABLED=true.
  // A failed HCM full-sync is logged and swallowed so the scheduler keeps ticking.
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'reconcile' })
  async scheduled(): Promise<void> {
    if (process.env.RECONCILE_DISABLED === 'true') {
      return;
    }
    try {
      const summary = await this.reconcile();
      this.logger.log(
        `scheduled reconcile: checked ${summary.checked}, repaired ${summary.repaired}, created ${summary.created}`,
      );
    } catch (err) {
      this.logger.error(`scheduled reconcile failed: ${String(err)}`);
    }
  }

  // Compare every HCM pool (whole corpus / batch) against its local projection
  // and repair drift. Safe to invoke on demand (POST /reconcile) as well as from
  // the cron; the `running` guard keeps overlapping whole-corpus sweeps out.
  async reconcile(): Promise<ReconcileSummary> {
    if (this.running) {
      this.logger.warn('reconcile already in progress; skipping this run');
      return { checked: 0, repaired: 0, created: 0, drifts: [] };
    }
    this.running = true;
    try {
      return await this.applyRows(await this.hcm.fullSync());
    } finally {
      this.running = false;
    }
  }

  // On-demand realtime refresh of a single employee (POST /reconcile/:employeeId)
  // using the HCM's per-employee realtime read — gives the Employee an accurate
  // balance now instead of waiting for the next whole-corpus sweep (e.g. right
  // after a work-anniversary bonus). An unknown employee surfaces HCM's 404.
  async reconcileEmployee(employeeId: string): Promise<ReconcileSummary> {
    const hcmRows = await this.hcm.getByEmployee(employeeId);
    return this.applyRows(hcmRows);
  }

  // Repair each HCM pool against its local projection: create a missing pool,
  // fix a drifted total, or skip an in-sync one (cheap pre-check avoids opening a
  // tx — no phantom version bump). Shared by the whole-corpus and per-employee paths.
  private async applyRows(hcmRows: HcmBalance[]): Promise<ReconcileSummary> {
    const drifts: ReconcileDrift[] = [];
    let created = 0;

    for (const hcm of hcmRows) {
      const local = await this.prisma.balance.findUnique({
        where: {
          employeeId_locationId: {
            employeeId: hcm.employeeId,
            locationId: hcm.locationId,
          },
        },
      });

      if (!local) {
        // HCM knows a pool we don't — materialize it from the source of truth.
        await this.prisma.balance.create({
          data: {
            employeeId: hcm.employeeId,
            locationId: hcm.locationId,
            totalBalance: hcm.balance,
            reservedBalance: 0,
          },
        });
        created++;
        this.logger.warn(
          `created missing local pool ${hcm.employeeId}/${hcm.locationId} = ${hcm.balance}`,
        );
        continue;
      }

      // Cheap pre-check before opening a transaction.
      if (Math.abs(hcm.balance - local.totalBalance) <= EPSILON) {
        continue;
      }

      const repaired = await this.repair(local.id, hcm.balance);
      if (repaired) {
        drifts.push(repaired);
        this.logger.log(
          `repaired ${repaired.employeeId}/${repaired.locationId}: ` +
            `${repaired.previous} → ${repaired.corrected} (drift ${repaired.drift})`,
        );
      }
    }

    const summary = {
      checked: hcmRows.length,
      repaired: drifts.length,
      created,
      drifts,
    };
    this.metrics?.observeReconciliation(summary);
    return summary;
  }

  // Most recent reconciliation log rows (newest first) for inspection.
  async recentLogs(take = 50): Promise<ReconciliationLogResponse[]> {
    const rows = await this.prisma.reconciliationLog.findMany({
      orderBy: { createdAt: 'desc' },
      take,
    });
    return rows.map((r) => ({
      id: r.id,
      employeeId: r.employeeId,
      previousBalance: r.previousBalance,
      correctedBalance: r.correctedBalance,
      drift: r.drift,
      source: r.source,
      createdAt: r.createdAt.toISOString(),
    }));
  }

  // Repair one pool inside a single transaction: re-read fresh for the version
  // guard, recompute drift (another writer may have closed it already), update
  // the total + ledger via BalancesService, and append a reconciliation_logs row.
  // A concurrent write mid-repair surfaces as OptimisticLockError — skip and let
  // the next run settle it (eventual consistency), rather than fighting the user.
  private async repair(
    localId: string,
    hcmTotal: number,
  ): Promise<ReconcileDrift | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const fresh = await tx.balance.findUniqueOrThrow({
          where: { id: localId },
        });
        const drift = hcmTotal - fresh.totalBalance;
        if (Math.abs(drift) <= EPSILON) {
          return null;
        }
        await this.balances.reconcileTotal(
          tx,
          fresh,
          hcmTotal,
          `reconcile: local ${fresh.totalBalance} → HCM ${hcmTotal}`,
        );
        await tx.reconciliationLog.create({
          data: {
            employeeId: fresh.employeeId,
            previousBalance: fresh.totalBalance,
            correctedBalance: hcmTotal,
            drift,
            source: 'FULL_SYNC',
          },
        });
        return {
          employeeId: fresh.employeeId,
          locationId: fresh.locationId,
          previous: fresh.totalBalance,
          corrected: hcmTotal,
          drift,
        };
      });
    } catch (err) {
      if (err instanceof OptimisticLockError) {
        this.logger.warn(
          `skipped ${localId}: concurrent change during reconcile; will retry next run`,
        );
        return null;
      }
      throw err;
    }
  }
}

// Public reconciliation_logs row (createdAt serialized to ISO).
export interface ReconciliationLogResponse {
  id: string;
  employeeId: string;
  previousBalance: number;
  correctedBalance: number;
  drift: number;
  source: string;
  createdAt: string;
}

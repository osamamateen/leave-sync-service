import {
  ConflictException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  BalancesService,
  OptimisticLockError,
} from '../balances/balances.service';
import { HcmService, HcmBalance } from '../hcm/hcm.service';
import { CreateRequestDto } from './dto/create-request.dto';
import { ListRequestsDto } from './dto/list-requests.dto';
import { MetricsService } from '../observability/metrics.service';
import { Prisma } from '../../generated/prisma/client';

// How many times a balance read-modify-write is retried on an optimistic-lock
// conflict before giving up with a 409. Conflicts only arise under genuine
// concurrent writes to the same pool, so a small bound clears them quickly.
const MAX_LOCK_RETRIES = 5;

// Public request shape (createdAt serialized to ISO).
export interface RequestResponse {
  id: string;
  employeeId: string;
  locationId: string;
  days: number;
  status: string;
  reason: string | null;
  createdAt: string;
}

interface RequestRow {
  id: string;
  employeeId: string;
  locationId: string;
  days: number;
  status: string;
  reason: string | null;
  createdAt: Date;
}

@Injectable()
export class RequestsService {
  private readonly logger = new Logger('RequestsService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly balances: BalancesService,
    private readonly hcm: HcmService,
    @Optional() private readonly metrics?: MetricsService,
  ) {}

  // POST /requests — validate balance, reserve it, and create the request in one
  // transaction. Either the hold lands and a RESERVED request is returned, or
  // nothing is persisted (insufficient balance / unknown employee both roll back).
  async create(
    dto: CreateRequestDto,
    idempotencyKey?: string,
  ): Promise<RequestResponse> {
    // Idempotent replay: a client retrying with the same Idempotency-Key gets the
    // original request back, with no second reservation.
    if (idempotencyKey) {
      const existing = await this.prisma.request.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        this.logger.log(
          `idempotent replay for key '${idempotencyKey}' → request ${existing.id}`,
        );
        return this.toResponse(existing);
      }
    }

    try {
      // Whole tx is retried on an optimistic-lock conflict: each attempt re-reads
      // the balance fresh (so the version guard sees current data) and the rolled-
      // back attempt leaves no orphan request row behind.
      const request = await this.withOptimisticRetry(() =>
        this.prisma.$transaction(async (tx) => {
          const balance = await this.balances.resolveBalance(
            tx,
            dto.employeeId,
            dto.locationId,
          );
          const created = await tx.request.create({
            data: {
              employeeId: dto.employeeId,
              locationId: dto.locationId,
              days: dto.days,
              reason: dto.reason ?? null,
              status: 'RESERVED',
              idempotencyKey: idempotencyKey ?? null,
            },
          });
          await this.balances.reserveBalance(tx, balance, dto.days, created.id);
          return created;
        }),
      );
      this.logger.log(
        `created request ${request.id} (${dto.employeeId}@${dto.locationId}, ${dto.days}d) RESERVED`,
      );
      this.metrics?.inc('created');
      return this.toResponse(request);
    } catch (err) {
      // Lost a race on the unique idempotencyKey: a concurrent create with the
      // same key committed first. Return the winner rather than the raw P2002.
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.request.findUnique({
          where: { idempotencyKey },
        });
        if (existing) {
          this.logger.log(
            `idempotent race for key '${idempotencyKey}' → returning request ${existing.id}`,
          );
          return this.toResponse(existing);
        }
      }
      throw err;
    }
  }

  // GET /requests/:id
  async getById(id: string): Promise<RequestResponse> {
    return this.toResponse(await this.getEntity(id));
  }

  // GET /requests — filtered list (newest first). Powers the manager's approval
  // queue (?status=RESERVED) and an employee's history (?employeeId=...).
  async list(filter: ListRequestsDto): Promise<RequestResponse[]> {
    const rows = await this.prisma.request.findMany({
      where: {
        ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
        ...(filter.locationId ? { locationId: filter.locationId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toResponse(r));
  }

  // POST /requests/:id/approve — confirm the hold with the external HCM, then
  // spend it locally. On HCM failure a compensating tx rolls the hold back and
  // marks the request FAILED_SYNC.
  async approve(id: string): Promise<RequestResponse> {
    const request = await this.getEntity(id);
    this.assertReserved(request, 'approve');

    try {
      const result = await this.hcm.deduct({
        employeeId: request.employeeId,
        locationId: request.locationId,
        days: request.days,
        idempotencyKey: request.id,
      });
      // Don't trust a 2xx blindly: HCM may not always reject what it should, so
      // verify the response is sane before committing locally.
      this.assertSaneHcmBalance(result, request.id);
    } catch (err) {
      // Compensating transaction: the HCM deduction could not be confirmed, so
      // release the local hold (return the days to the pool) and mark the request
      // FAILED_SYNC. The deduct carried `request.id` as its Idempotency-Key, so if
      // HCM had in fact applied it, a future retry won't double-deduct and
      // reconciliation will pull the authoritative total back down.
      await this.withOptimisticRetry(() =>
        this.prisma.$transaction(async (tx) => {
          const fresh = await tx.balance.findUnique({
            where: {
              employeeId_locationId: {
                employeeId: request.employeeId,
                locationId: request.locationId,
              },
            },
          });
          if (fresh) {
            await this.balances.releaseReservation(
              tx,
              fresh,
              request.days,
              request.id,
            );
          }
          await tx.request.update({
            where: { id },
            data: { status: 'FAILED_SYNC' },
          });
        }),
      );
      this.logger.error(
        `request ${id} approval failed at HCM (${String(err)}); reservation rolled back, marked FAILED_SYNC`,
      );
      this.metrics?.inc('failed_sync');
      // A deterministic HCM business rejection (e.g. 422 insufficient, 404
      // invalid combination) is surfaced verbatim — retrying won't help. Only
      // transient failures (network / timeout / 5xx, retries exhausted) collapse
      // to a 503.
      if (err instanceof HttpException && err.getStatus() < 500) {
        throw err;
      }
      throw new ServiceUnavailableException(
        `HCM deduction failed; request ${id} reservation rolled back and marked FAILED_SYNC`,
      );
    }

    const updated = await this.withOptimisticRetry(() =>
      this.prisma.$transaction(async (tx) => {
        // Re-read inside the retried tx so the version guard sees current data.
        const fresh = await this.balances.resolveBalance(
          tx,
          request.employeeId,
          request.locationId,
        );
        await this.balances.commitDeduction(tx, fresh, request.days, request.id);
        return tx.request.update({
          where: { id },
          data: { status: 'APPROVED' },
        });
      }),
    );
    this.logger.log(`request ${id} APPROVED (HCM deducted ${request.days}d)`);
    this.metrics?.inc('approved');
    return this.toResponse(updated);
  }

  // POST /requests/:id/reject — release the hold locally; no HCM call needed.
  async reject(id: string): Promise<RequestResponse> {
    const request = await this.getEntity(id);
    this.assertReserved(request, 'reject');

    const updated = await this.withOptimisticRetry(() =>
      this.prisma.$transaction(async (tx) => {
        // Re-read inside the retried tx so the version guard sees current data.
        const balance = await tx.balance.findUnique({
          where: {
            employeeId_locationId: {
              employeeId: request.employeeId,
              locationId: request.locationId,
            },
          },
        });
        if (balance) {
          await this.balances.releaseReservation(
            tx,
            balance,
            request.days,
            request.id,
          );
        }
        return tx.request.update({
          where: { id },
          data: { status: 'REJECTED' },
        });
      }),
    );
    this.logger.log(`request ${id} REJECTED (released ${request.days}d)`);
    this.metrics?.inc('rejected');
    return this.toResponse(updated);
  }

  private async getEntity(id: string): Promise<RequestRow> {
    const request = await this.prisma.request.findUnique({ where: { id } });
    if (!request) {
      throw new NotFoundException(`Unknown request '${id}'`);
    }
    return request;
  }

  // Defensive check on HCM's deduct response: we can't count on HCM to always
  // reject what it should, so we validate its 2xx reply rather than trust it.
  private assertSaneHcmBalance(result: HcmBalance, requestId: string): void {
    if (typeof result?.balance !== 'number' || !Number.isFinite(result.balance)) {
      // 2xx with a non-numeric/garbage body — we can't confirm the deduction
      // landed correctly, so treat it as a failed sync (compensate + retryable).
      throw new ServiceUnavailableException(
        `HCM returned a non-numeric balance for request ${requestId}`,
      );
    }
    if (result.balance < 0) {
      // HCM accepted a deduction that drove its own balance negative — it should
      // have rejected. We can't un-apply it, so flag loudly and let
      // reconciliation reflect the authoritative (negative) total.
      this.logger.warn(
        `HCM balance went negative (${result.balance}) after deducting for request ${requestId}`,
      );
    }
  }

  // Only a held (RESERVED) request can be approved or rejected.
  private assertReserved(request: RequestRow, action: string): void {
    if (request.status !== 'RESERVED') {
      throw new ConflictException(
        `Cannot ${action} request ${request.id}: status is ${request.status}`,
      );
    }
  }

  private toResponse(r: RequestRow): RequestResponse {
    return {
      id: r.id,
      employeeId: r.employeeId,
      locationId: r.locationId,
      days: r.days,
      status: r.status,
      reason: r.reason,
      createdAt: r.createdAt.toISOString(),
    };
  }

  // Run a balance read-modify-write, retrying when a concurrent writer wins the
  // version race (OptimisticLockError). The whole transaction re-runs — re-
  // reading fresh balance state — so the loser either succeeds on a later pass
  // or fails its own business check (e.g. now-insufficient → 422). Exhausting
  // the bound is surfaced as a 409 rather than silently dropping the write.
  private async withOptimisticRetry<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work();
      } catch (err) {
        if (!(err instanceof OptimisticLockError)) {
          throw err;
        }
        if (attempt >= MAX_LOCK_RETRIES) {
          this.logger.warn(
            `optimistic lock conflict on balance ${err.balanceId} unresolved after ${attempt} attempts`,
          );
          throw new ConflictException(
            'Balance is being updated concurrently; please retry',
          );
        }
        this.logger.debug(
          `optimistic lock conflict on balance ${err.balanceId}; retry ${attempt}/${MAX_LOCK_RETRIES}`,
        );
      }
    }
  }
}

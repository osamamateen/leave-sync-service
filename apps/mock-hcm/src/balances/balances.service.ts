import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { FailureSimulatorService } from '../common/failure-simulator.service';
import { BalanceStore, HcmBalanceRecord } from './balance-store';
import { DeductBalanceDto } from './dto/deduct-balance.dto';
import { AdjustBalanceDto } from './dto/adjust-balance.dto';

// Public response shape (a defensive copy of the stored record).
export interface HcmBalanceDto {
  employeeId: string;
  locationId: string;
  balance: number;
}

function toDto(record: HcmBalanceRecord): HcmBalanceDto {
  return {
    employeeId: record.employeeId,
    locationId: record.locationId,
    balance: record.balance,
  };
}

@Injectable()
export class BalancesService {
  constructor(
    private readonly store: BalanceStore,
    private readonly failures: FailureSimulatorService,
  ) {}

  // GET /balances/:employeeId — all per-location balances for one employee.
  async getByEmployee(employeeId: string): Promise<HcmBalanceDto[]> {
    await this.failures.maybeFail(`GET /balances/${employeeId}`);
    const rows = this.store.findByEmployee(employeeId);
    if (rows.length === 0) {
      throw new NotFoundException(`Unknown employee '${employeeId}'`);
    }
    return rows.map(toDto);
  }

  // GET /balances/full-sync — the entire dataset for reconciliation.
  async fullSync(): Promise<HcmBalanceDto[]> {
    await this.failures.maybeFail('GET /balances/full-sync');
    return this.store.findAll().map(toDto);
  }

  // POST /balances/deduct — reduce balance if sufficient, else reject. An
  // optional Idempotency-Key makes a retried deduct safe: once a key has been
  // applied, replays return the original result without deducting again. (The
  // failure simulator still runs first, so a replay can still surface a transient
  // fault — idempotency guarantees apply-once, not failure-free.)
  async deduct(
    dto: DeductBalanceDto,
    idempotencyKey?: string,
  ): Promise<HcmBalanceDto> {
    await this.failures.maybeFail('POST /balances/deduct');
    if (idempotencyKey) {
      const prior = this.store.recallDeduct(idempotencyKey);
      if (prior) {
        return toDto(prior);
      }
    }
    const record = this.requireRecord(dto.employeeId, dto.locationId);
    if (record.balance < dto.days) {
      throw new UnprocessableEntityException(
        `Insufficient balance for '${dto.employeeId}' at '${dto.locationId}': ` +
          `have ${record.balance}, requested ${dto.days}`,
      );
    }
    record.balance -= dto.days;
    if (idempotencyKey) {
      this.store.rememberDeduct(idempotencyKey, record);
    }
    return toDto(record);
  }

  // POST /balances/adjust — apply a signed correction (bonus or HR fix).
  async adjust(dto: AdjustBalanceDto): Promise<HcmBalanceDto> {
    await this.failures.maybeFail('POST /balances/adjust');
    const record = this.requireRecord(dto.employeeId, dto.locationId);
    const next = record.balance + dto.amount;
    if (next < 0) {
      throw new UnprocessableEntityException(
        `Adjustment of ${dto.amount} would drive the balance for ` +
          `'${dto.employeeId}' at '${dto.locationId}' below zero ` +
          `(current ${record.balance})`,
      );
    }
    record.balance = next;
    return toDto(record);
  }

  private requireRecord(
    employeeId: string,
    locationId: string,
  ): HcmBalanceRecord {
    const record = this.store.find(employeeId, locationId);
    if (!record) {
      throw new NotFoundException(
        `No balance for employee '${employeeId}' at location '${locationId}'`,
      );
    }
    return record;
  }
}

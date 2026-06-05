import {
  HttpException,
  Injectable,
  Logger,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios, { AxiosError, AxiosInstance, AxiosRequestConfig } from 'axios';
import { MetricsService } from '../observability/metrics.service';
import { CORRELATION_HEADER, getCorrelationId } from '../observability/correlation';

// Balance shape returned by the mock HCM (apps/mock-hcm HcmBalanceDto).
export interface HcmBalance {
  employeeId: string;
  locationId: string;
  balance: number;
}

export interface HcmDeductInput {
  employeeId: string;
  locationId: string;
  days: number;
  // Forwarded as an Idempotency-Key header so a retried deduct is safe to
  // replay once the HCM honours it (full duplicate-safety lands in Phase 7).
  idempotencyKey?: string;
}

// Thin Axios wrapper around the external HCM. Adds a request timeout and a
// bounded retry with exponential backoff for transient faults (network errors,
// timeouts, 5xx). Deterministic 4xx business rejections are surfaced as-is and
// never retried.
@Injectable()
export class HcmService {
  private readonly logger = new Logger('HcmClient');
  private readonly http: AxiosInstance;
  private readonly maxRetries: number;

  // MetricsService is @Optional so the client can still be `new HcmService()`d in
  // unit tests and resolved in test modules that don't wire observability.
  constructor(@Optional() private readonly metrics?: MetricsService) {
    const baseURL = process.env.HCM_BASE_URL ?? 'http://localhost:3100';
    const timeout = Number(process.env.HCM_CLIENT_TIMEOUT_MS ?? 3000);
    this.maxRetries = Number(process.env.HCM_CLIENT_RETRIES ?? 2);
    this.http = axios.create({ baseURL, timeout });
  }

  async deduct(input: HcmDeductInput): Promise<HcmBalance> {
    const headers = input.idempotencyKey
      ? { 'Idempotency-Key': input.idempotencyKey }
      : undefined;
    return this.send<HcmBalance>(
      {
        method: 'post',
        url: '/balances/deduct',
        data: {
          employeeId: input.employeeId,
          locationId: input.locationId,
          days: input.days,
        },
        headers,
      },
      'deduct',
    );
  }

  async getByEmployee(employeeId: string): Promise<HcmBalance[]> {
    return this.send<HcmBalance[]>(
      { method: 'get', url: `/balances/${employeeId}` },
      'getByEmployee',
    );
  }

  async fullSync(): Promise<HcmBalance[]> {
    return this.send<HcmBalance[]>(
      { method: 'get', url: '/balances/full-sync' },
      'fullSync',
    );
  }

  // Times the whole round-trip (across retries) and records it: `failed` marks a
  // transient fault that exhausted retries (a deterministic 4xx is a successful
  // round-trip with a business answer, not an HCM failure).
  private async send<T>(config: AxiosRequestConfig, op: string): Promise<T> {
    const start = Date.now();
    try {
      const result = await this.sendInner<T>(config, op);
      this.metrics?.observeHcmCall(Date.now() - start, false);
      return result;
    } catch (err) {
      const transient = err instanceof ServiceUnavailableException;
      this.metrics?.observeHcmCall(Date.now() - start, transient);
      throw err;
    }
  }

  private async sendInner<T>(config: AxiosRequestConfig, op: string): Promise<T> {
    // Propagate the current correlation id so the HCM logs the same trace id.
    const correlationId = getCorrelationId();
    const reqConfig: AxiosRequestConfig = correlationId
      ? {
          ...config,
          headers: { ...config.headers, [CORRELATION_HEADER]: correlationId },
        }
      : config;

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await this.http.request<T>(reqConfig);
        return res.data;
      } catch (err) {
        const ax = err as AxiosError;
        const status = ax.response?.status;

        // A deterministic client-side rejection (e.g. 422 insufficient,
        // 404 unknown employee). Retrying will not change the outcome, so
        // surface it verbatim to the caller. 408/429 are treated as transient.
        if (
          status &&
          status >= 400 &&
          status < 500 &&
          status !== 408 &&
          status !== 429
        ) {
          throw new HttpException(
            (ax.response?.data as object) ?? ax.message,
            status,
          );
        }

        lastError = err;
        if (attempt < this.maxRetries) {
          const backoff = 100 * 2 ** attempt;
          this.logger.warn(
            `[${op}] attempt ${attempt + 1} failed (${status ?? ax.code ?? 'network'}); ` +
              `retrying in ${backoff}ms`,
          );
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }

    this.logger.error(
      `[${op}] exhausted ${this.maxRetries + 1} attempts: ${String(lastError)}`,
    );
    throw new ServiceUnavailableException(`HCM call failed: ${op}`);
  }
}

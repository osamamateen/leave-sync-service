import {
  GatewayTimeoutException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { sleep } from './sleep';

// Tunable knobs that make the mock HCM behave like a flaky external dependency.
export interface FailureConfig {
  // Probability [0..1] a call hangs past `timeoutMs` and then fails with 504.
  timeoutRate: number;
  // Probability [0..1] a call fails fast with a 503.
  errorRate: number;
  // Base artificial latency applied to every call, in ms.
  latencyMs: number;
  // How long a simulated timeout stalls before throwing, in ms.
  timeoutMs: number;
}

// Parse a 0..1 rate from env, falling back when missing/invalid.
function parseRate(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : fallback;
}

// Parse a non-negative integer (ms) from env, falling back when missing/invalid.
function parseMs(value: string | undefined, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

@Injectable()
export class FailureSimulatorService {
  private readonly logger = new Logger('HcmFailureSimulator');
  private config: FailureConfig;

  constructor() {
    // Defaults are deterministic (no failures) so tests are stable unless
    // explicitly configured via env or the admin endpoint.
    this.config = {
      timeoutRate: parseRate(process.env.HCM_TIMEOUT_RATE, 0),
      errorRate: parseRate(process.env.HCM_ERROR_RATE, 0),
      latencyMs: parseMs(process.env.HCM_LATENCY_MS, 0),
      timeoutMs: parseMs(process.env.HCM_TIMEOUT_MS, 2000),
    };
    this.logger.log(`initial failure config: ${JSON.stringify(this.config)}`);
  }

  getConfig(): FailureConfig {
    return { ...this.config };
  }

  setConfig(patch: Partial<FailureConfig>): FailureConfig {
    // Merge only defined keys: a transformed DTO carries every optional field
    // as an `undefined` own-property, and a blind spread would clobber the
    // current config with those undefineds.
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        this.config[key as keyof FailureConfig] = value as number;
      }
    }
    this.logger.log(`failure config updated: ${JSON.stringify(this.config)}`);
    return this.getConfig();
  }

  // Invoke at the start of every HCM operation. Applies latency, then rolls
  // for a slow timeout failure, then for a fast error failure.
  async maybeFail(operation: string): Promise<void> {
    const { latencyMs, timeoutRate, timeoutMs, errorRate } = this.config;

    if (latencyMs > 0) {
      await sleep(latencyMs);
    }

    if (Math.random() < timeoutRate) {
      this.logger.warn(`[${operation}] simulating timeout (stalling ${timeoutMs}ms)`);
      await sleep(timeoutMs);
      throw new GatewayTimeoutException('HCM request timed out');
    }

    if (Math.random() < errorRate) {
      this.logger.warn(`[${operation}] simulating upstream error`);
      throw new ServiceUnavailableException('HCM temporarily unavailable');
    }
  }
}

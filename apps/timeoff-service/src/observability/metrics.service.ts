import { Injectable } from '@nestjs/common';

export interface ReconcileLike {
  repaired: number;
  created: number;
  drifts: { drift: number }[];
}

export interface MetricsSnapshot {
  requests: Record<string, number>;
  hcm: { calls: number; failures: number; latencyMsAvg: number; latencyMsMax: number };
  reconciliation: {
    runs: number;
    repaired: number;
    created: number;
    driftAbsSum: number;
  };
}

// In-memory operational metrics for the time-off service: request-lifecycle
// counters, HCM call health (count / failures / latency), and reconciliation
// drift. Exposed at GET /metrics. Process-lifetime cumulative — fine for this
// single-instance service; a real deployment would scrape Prometheus.
@Injectable()
export class MetricsService {
  private readonly requests = new Map<string, number>();
  private readonly hcm = { calls: 0, failures: 0, latencyMsSum: 0, latencyMsMax: 0 };
  private readonly reconciliation = { runs: 0, repaired: 0, created: 0, driftAbsSum: 0 };

  // Request-lifecycle counter (created / approved / rejected / failed_sync).
  inc(name: string, by = 1): void {
    this.requests.set(name, (this.requests.get(name) ?? 0) + by);
  }

  // One HCM round-trip: its wall-clock latency and whether it ended in a
  // transient failure (retries exhausted → 503).
  observeHcmCall(latencyMs: number, failed: boolean): void {
    this.hcm.calls++;
    if (failed) this.hcm.failures++;
    this.hcm.latencyMsSum += latencyMs;
    this.hcm.latencyMsMax = Math.max(this.hcm.latencyMsMax, latencyMs);
  }

  // One reconciliation pass (whole-corpus or per-employee).
  observeReconciliation(summary: ReconcileLike): void {
    this.reconciliation.runs++;
    this.reconciliation.repaired += summary.repaired;
    this.reconciliation.created += summary.created;
    for (const d of summary.drifts) {
      this.reconciliation.driftAbsSum += Math.abs(d.drift);
    }
  }

  snapshot(): MetricsSnapshot {
    const avg = this.hcm.calls ? this.hcm.latencyMsSum / this.hcm.calls : 0;
    return {
      requests: Object.fromEntries(this.requests),
      hcm: {
        calls: this.hcm.calls,
        failures: this.hcm.failures,
        latencyMsAvg: Math.round(avg),
        latencyMsMax: this.hcm.latencyMsMax,
      },
      reconciliation: { ...this.reconciliation },
    };
  }
}

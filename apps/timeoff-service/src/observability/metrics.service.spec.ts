import { MetricsService } from './metrics.service';

// Phase 9 unit — the in-memory metrics registry: lifecycle counters, HCM call
// health (count / failures / avg+max latency), and reconciliation drift.
describe('MetricsService', () => {
  let metrics: MetricsService;

  beforeEach(() => {
    metrics = new MetricsService();
  });

  it('accumulates lifecycle counters', () => {
    metrics.inc('created');
    metrics.inc('created');
    metrics.inc('approved');
    expect(metrics.snapshot().requests).toEqual({ created: 2, approved: 1 });
  });

  it('tracks HCM calls, failures, and latency (avg + max)', () => {
    metrics.observeHcmCall(100, false);
    metrics.observeHcmCall(300, true);
    const { hcm } = metrics.snapshot();
    expect(hcm).toEqual({
      calls: 2,
      failures: 1,
      latencyMsAvg: 200, // (100 + 300) / 2
      latencyMsMax: 300,
    });
  });

  it('aggregates reconciliation passes and absolute drift', () => {
    metrics.observeReconciliation({
      repaired: 1,
      created: 0,
      drifts: [{ drift: 6 }],
    });
    metrics.observeReconciliation({
      repaired: 1,
      created: 2,
      drifts: [{ drift: -4 }],
    });
    expect(metrics.snapshot().reconciliation).toEqual({
      runs: 2,
      repaired: 2,
      created: 2,
      driftAbsSum: 10, // |6| + |-4|
    });
  });

  it('reports zero latency before any HCM call', () => {
    expect(metrics.snapshot().hcm).toEqual({
      calls: 0,
      failures: 0,
      latencyMsAvg: 0,
      latencyMsMax: 0,
    });
  });
});

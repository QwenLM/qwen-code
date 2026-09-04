/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type {
  Meter,
  ObservableGauge,
  ObservableResult,
} from '@opentelemetry/api';

const gaugeCallbacks: Array<(result: ObservableResult) => void> = [];
const mockObservableGaugeAddCallback = vi.fn(
  (cb: (result: ObservableResult) => void) => {
    gaugeCallbacks.push(cb);
  },
);
const mockCreateObservableGaugeFn: Mock<
  (name: string, options?: unknown) => ObservableGauge
> = vi.fn().mockReturnValue({
  addCallback: mockObservableGaugeAddCallback,
});

const mockMeterInstance: Meter = {
  createObservableGauge: mockCreateObservableGaugeFn,
} as Partial<Meter> as Meter;

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: vi.fn().mockReturnValue(mockMeterInstance),
  },
  ValueType: {
    DOUBLE: 2,
  },
  diag: {
    setLogger: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

describe('event loop lag metrics', () => {
  let registerDaemonEventLoopLagGauge: typeof import('./event-loop-lag-metrics.js').registerDaemonEventLoopLagGauge;
  let registerAcpEventLoopLagGauge: typeof import('./event-loop-lag-metrics.js').registerAcpEventLoopLagGauge;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    gaugeCallbacks.length = 0;
    const mod = await import('./event-loop-lag-metrics.js');
    registerDaemonEventLoopLagGauge = mod.registerDaemonEventLoopLagGauge;
    registerAcpEventLoopLagGauge = mod.registerAcpEventLoopLagGauge;
  });

  it('registers daemon and ACP event loop lag gauges', () => {
    registerDaemonEventLoopLagGauge(() => ({
      meanMs: 1,
      p50Ms: 2,
      p99Ms: 3,
      maxMs: 4,
    }));
    registerAcpEventLoopLagGauge(() => ({
      meanMs: 5,
      p50Ms: 6,
      p99Ms: 7,
      maxMs: 8,
    }));

    expect(mockCreateObservableGaugeFn).toHaveBeenCalledWith(
      'qwen-code.daemon.event_loop.lag',
      expect.objectContaining({ unit: 'ms' }),
    );
    expect(mockCreateObservableGaugeFn).toHaveBeenCalledWith(
      'qwen-code.acp.event_loop.lag',
      expect.objectContaining({ unit: 'ms' }),
    );
  });

  it('observes all four stats with stat attributes', () => {
    registerDaemonEventLoopLagGauge(() => ({
      meanMs: 1,
      p50Ms: 2,
      p99Ms: 3,
      maxMs: 4,
    }));
    const result = { observe: vi.fn() };

    gaugeCallbacks[0]!(result as unknown as ObservableResult);

    expect(result.observe).toHaveBeenCalledWith(1, { stat: 'mean' });
    expect(result.observe).toHaveBeenCalledWith(2, { stat: 'p50' });
    expect(result.observe).toHaveBeenCalledWith(3, { stat: 'p99' });
    expect(result.observe).toHaveBeenCalledWith(4, { stat: 'max' });
  });

  it('does not re-register the same process role twice', () => {
    registerAcpEventLoopLagGauge(() => ({
      meanMs: 1,
      p50Ms: 1,
      p99Ms: 1,
      maxMs: 1,
    }));
    registerAcpEventLoopLagGauge(() => ({
      meanMs: 2,
      p50Ms: 2,
      p99Ms: 2,
      maxMs: 2,
    }));

    expect(mockCreateObservableGaugeFn).toHaveBeenCalledTimes(1);
  });

  it('swallows snapshot errors from observable callbacks', () => {
    registerDaemonEventLoopLagGauge(() => {
      throw new Error('snapshot failed');
    });

    expect(() =>
      gaugeCallbacks[0]!({ observe: vi.fn() } as unknown as ObservableResult),
    ).not.toThrow();
  });
});

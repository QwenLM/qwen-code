/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type {
  Counter,
  Meter,
  Attributes,
  Context,
  Histogram,
  ObservableGauge,
  ObservableResult,
} from '@opentelemetry/api';

const mockCounterAddFn: Mock<
  (value: number, attributes?: Attributes, context?: Context) => void
> = vi.fn();
const mockHistogramRecordFn: Mock<
  (value: number, attributes?: Attributes, context?: Context) => void
> = vi.fn();

const mockCreateCounterFn: Mock<(name: string, options?: unknown) => Counter> =
  vi.fn();
const mockCreateHistogramFn: Mock<
  (name: string, options?: unknown) => Histogram
> = vi.fn();

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

const mockCounterInstance: Counter = {
  add: mockCounterAddFn,
} as Partial<Counter> as Counter;

const mockHistogramInstance: Histogram = {
  record: mockHistogramRecordFn,
} as Partial<Histogram> as Histogram;

const mockMeterInstance: Meter = {
  createCounter: mockCreateCounterFn.mockReturnValue(mockCounterInstance),
  createHistogram: mockCreateHistogramFn.mockReturnValue(mockHistogramInstance),
  createObservableGauge: mockCreateObservableGaugeFn,
} as Partial<Meter> as Meter;

vi.mock('@opentelemetry/api', () => ({
  metrics: {
    getMeter: vi.fn().mockReturnValue(mockMeterInstance),
  },
  ValueType: {
    INT: 1,
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

describe('Daemon Metrics', () => {
  let initializeDaemonMetrics: typeof import('./daemon-metrics.js').initializeDaemonMetrics;
  let registerDaemonGaugeCallbacks: typeof import('./daemon-metrics.js').registerDaemonGaugeCallbacks;
  let recordDaemonHttpRequest: typeof import('./daemon-metrics.js').recordDaemonHttpRequest;
  let recordDaemonSessionLifecycle: typeof import('./daemon-metrics.js').recordDaemonSessionLifecycle;
  let recordDaemonChannelLifecycle: typeof import('./daemon-metrics.js').recordDaemonChannelLifecycle;
  let recordDaemonPromptQueueWait: typeof import('./daemon-metrics.js').recordDaemonPromptQueueWait;
  let recordDaemonPromptDuration: typeof import('./daemon-metrics.js').recordDaemonPromptDuration;
  let recordDaemonBridgeError: typeof import('./daemon-metrics.js').recordDaemonBridgeError;
  let recordDaemonCancel: typeof import('./daemon-metrics.js').recordDaemonCancel;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    gaugeCallbacks.length = 0;

    mockCreateCounterFn.mockReturnValue(mockCounterInstance);
    mockCreateHistogramFn.mockReturnValue(mockHistogramInstance);

    const mod = await import('./daemon-metrics.js');
    initializeDaemonMetrics = mod.initializeDaemonMetrics;
    registerDaemonGaugeCallbacks = mod.registerDaemonGaugeCallbacks;
    recordDaemonHttpRequest = mod.recordDaemonHttpRequest;
    recordDaemonSessionLifecycle = mod.recordDaemonSessionLifecycle;
    recordDaemonChannelLifecycle = mod.recordDaemonChannelLifecycle;
    recordDaemonPromptQueueWait = mod.recordDaemonPromptQueueWait;
    recordDaemonPromptDuration = mod.recordDaemonPromptDuration;
    recordDaemonBridgeError = mod.recordDaemonBridgeError;
    recordDaemonCancel = mod.recordDaemonCancel;
  });

  describe('initializeDaemonMetrics', () => {
    it('creates counters and histograms', () => {
      initializeDaemonMetrics();

      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.daemon.http.request.count',
        expect.objectContaining({ description: expect.any(String) }),
      );
      expect(mockCreateHistogramFn).toHaveBeenCalledWith(
        'qwen-code.daemon.http.request.duration',
        expect.objectContaining({ unit: 'ms' }),
      );
      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.daemon.session.lifecycle',
        expect.any(Object),
      );
      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.daemon.channel.lifecycle',
        expect.any(Object),
      );
      expect(mockCreateHistogramFn).toHaveBeenCalledWith(
        'qwen-code.daemon.prompt.queue_wait',
        expect.objectContaining({ unit: 'ms' }),
      );
      expect(mockCreateHistogramFn).toHaveBeenCalledWith(
        'qwen-code.daemon.prompt.duration',
        expect.objectContaining({ unit: 'ms' }),
      );
      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.daemon.bridge.error.count',
        expect.any(Object),
      );
      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.daemon.cancel.count',
        expect.any(Object),
      );
    });

    it('does not re-initialize on second call', () => {
      initializeDaemonMetrics();
      const callCount = mockCreateCounterFn.mock.calls.length;
      initializeDaemonMetrics();
      expect(mockCreateCounterFn.mock.calls.length).toBe(callCount);
    });
  });

  describe('recording functions before initialization', () => {
    it('are no-ops before init', () => {
      recordDaemonHttpRequest(100, 'POST /session/:id/prompt', 200);
      recordDaemonSessionLifecycle('spawn');
      recordDaemonCancel();
      expect(mockCounterAddFn).not.toHaveBeenCalled();
      expect(mockHistogramRecordFn).not.toHaveBeenCalled();
    });
  });

  describe('recordDaemonHttpRequest', () => {
    it('records counter with status_class and histogram with route', () => {
      initializeDaemonMetrics();
      recordDaemonHttpRequest(42, 'POST /session/:id/prompt', 201);

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        route: 'POST /session/:id/prompt',
        status_class: '2xx',
      });
      expect(mockHistogramRecordFn).toHaveBeenCalledWith(42, {
        route: 'POST /session/:id/prompt',
      });
    });

    it('computes status_class correctly for 4xx and 5xx', () => {
      initializeDaemonMetrics();
      mockCounterAddFn.mockClear();

      recordDaemonHttpRequest(10, 'DELETE /session/:id', 404);
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        route: 'DELETE /session/:id',
        status_class: '4xx',
      });

      mockCounterAddFn.mockClear();
      recordDaemonHttpRequest(5, 'POST /session', 500);
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        route: 'POST /session',
        status_class: '5xx',
      });
    });
  });

  describe('recordDaemonSessionLifecycle', () => {
    it('records with action attribute', () => {
      initializeDaemonMetrics();
      mockCounterAddFn.mockClear();
      recordDaemonSessionLifecycle('spawn');
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, { action: 'spawn' });
    });
  });

  describe('recordDaemonChannelLifecycle', () => {
    it('records with action and expected attributes', () => {
      initializeDaemonMetrics();
      mockCounterAddFn.mockClear();
      recordDaemonChannelLifecycle('exit', false);
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        action: 'exit',
        expected: false,
      });
    });

    it('omits expected when undefined', () => {
      initializeDaemonMetrics();
      mockCounterAddFn.mockClear();
      recordDaemonChannelLifecycle('spawn');
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, { action: 'spawn' });
    });
  });

  describe('recordDaemonPromptQueueWait', () => {
    it('records histogram value', () => {
      initializeDaemonMetrics();
      mockHistogramRecordFn.mockClear();
      recordDaemonPromptQueueWait(150);
      expect(mockHistogramRecordFn).toHaveBeenCalledWith(150);
    });
  });

  describe('recordDaemonPromptDuration', () => {
    it('records histogram value', () => {
      initializeDaemonMetrics();
      mockHistogramRecordFn.mockClear();
      recordDaemonPromptDuration(5000);
      expect(mockHistogramRecordFn).toHaveBeenCalledWith(5000);
    });
  });

  describe('recordDaemonBridgeError', () => {
    it('normalizes known error types', () => {
      initializeDaemonMetrics();
      mockCounterAddFn.mockClear();
      const err = new Error('not found');
      err.name = 'SessionNotFoundError';
      recordDaemonBridgeError(err);
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        error_type: 'SessionNotFoundError',
      });
    });

    it('normalizes unknown error types to "unknown"', () => {
      initializeDaemonMetrics();
      mockCounterAddFn.mockClear();
      const err = new Error('something');
      err.name = 'RandomCustomError';
      recordDaemonBridgeError(err);
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        error_type: 'unknown',
      });
    });

    it('handles non-Error throws', () => {
      initializeDaemonMetrics();
      mockCounterAddFn.mockClear();
      recordDaemonBridgeError('string error');
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        error_type: 'unknown',
      });
    });
  });

  describe('recordDaemonCancel', () => {
    it('increments counter', () => {
      initializeDaemonMetrics();
      mockCounterAddFn.mockClear();
      recordDaemonCancel();
      expect(mockCounterAddFn).toHaveBeenCalledWith(1);
    });
  });

  describe('registerDaemonGaugeCallbacks', () => {
    it('creates 3 observable gauges', () => {
      registerDaemonGaugeCallbacks({
        sessionCount: () => 5,
        sseCount: () => 3,
        heapUsed: () => 100_000_000,
      });

      expect(mockCreateObservableGaugeFn).toHaveBeenCalledTimes(3);
      expect(mockCreateObservableGaugeFn).toHaveBeenCalledWith(
        'qwen-code.daemon.session.active',
        expect.any(Object),
      );
      expect(mockCreateObservableGaugeFn).toHaveBeenCalledWith(
        'qwen-code.daemon.sse.active',
        expect.any(Object),
      );
      expect(mockCreateObservableGaugeFn).toHaveBeenCalledWith(
        'qwen-code.daemon.process.heap_used',
        expect.objectContaining({ unit: 'bytes' }),
      );
    });

    it('gauge callbacks invoke the provided getters', () => {
      const sessionCount = vi.fn().mockReturnValue(7);
      const sseCount = vi.fn().mockReturnValue(2);
      const heapUsed = vi.fn().mockReturnValue(50_000_000);

      registerDaemonGaugeCallbacks({ sessionCount, sseCount, heapUsed });

      const mockResult = { observe: vi.fn() };
      for (const cb of gaugeCallbacks) {
        cb(mockResult as unknown as ObservableResult);
      }

      expect(sessionCount).toHaveBeenCalled();
      expect(sseCount).toHaveBeenCalled();
      expect(heapUsed).toHaveBeenCalled();
      expect(mockResult.observe).toHaveBeenCalledWith(7);
      expect(mockResult.observe).toHaveBeenCalledWith(2);
      expect(mockResult.observe).toHaveBeenCalledWith(50_000_000);
    });

    it('gauge callbacks swallow exceptions', () => {
      registerDaemonGaugeCallbacks({
        sessionCount: () => {
          throw new Error('boom');
        },
        sseCount: () => 0,
        heapUsed: () => 0,
      });

      const mockResult = { observe: vi.fn() };
      expect(() => {
        for (const cb of gaugeCallbacks) {
          cb(mockResult as unknown as ObservableResult);
        }
      }).not.toThrow();
    });
  });
});

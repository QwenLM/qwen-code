/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type {
  Counter,
  Meter,
  Attributes,
  Context,
  Histogram,
} from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import { MemoryMetricType } from './metrics.js';
import { makeFakeConfig } from '../test-utils/config.js';

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

const mockCounterInstance: Counter = {
  add: mockCounterAddFn,
} as Partial<Counter> as Counter;

const mockHistogramInstance: Histogram = {
  record: mockHistogramRecordFn,
} as Partial<Histogram> as Histogram;

const mockMeterInstance: Meter = {
  createCounter: mockCreateCounterFn.mockReturnValue(mockCounterInstance),
  createHistogram: mockCreateHistogramFn.mockReturnValue(mockHistogramInstance),
} as Partial<Meter> as Meter;

function originalOtelMockFactory() {
  return {
    metrics: {
      getMeter: vi.fn(),
    },
    ValueType: {
      INT: 1,
      DOUBLE: 2,
    },
    diag: {
      setLogger: vi.fn(),
      warn: vi.fn(),
    },
  } as const;
}

vi.mock('@opentelemetry/api');

describe('Telemetry Metrics', () => {
  let initializeMetricsModule: typeof import('./metrics.js').initializeMetrics;
  let recordChatCompressionMetricsModule: typeof import('./metrics.js').recordChatCompressionMetrics;
  let recordStartupPerformanceModule: typeof import('./metrics.js').recordStartupPerformance;
  let recordMemoryUsageModule: typeof import('./metrics.js').recordMemoryUsage;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@opentelemetry/api', () => {
      const actualApi = originalOtelMockFactory();
      (actualApi.metrics.getMeter as Mock).mockReturnValue(mockMeterInstance);
      return actualApi;
    });

    const metricsJsModule = await import('./metrics.js');
    initializeMetricsModule = metricsJsModule.initializeMetrics;
    recordChatCompressionMetricsModule =
      metricsJsModule.recordChatCompressionMetrics;
    recordStartupPerformanceModule = metricsJsModule.recordStartupPerformance;
    recordMemoryUsageModule = metricsJsModule.recordMemoryUsage;

    const otelApiModule = await import('@opentelemetry/api');

    mockCounterAddFn.mockClear();
    mockCreateCounterFn.mockClear();
    mockCreateHistogramFn.mockClear();
    mockHistogramRecordFn.mockClear();
    (otelApiModule.metrics.getMeter as Mock).mockClear();

    (otelApiModule.metrics.getMeter as Mock).mockReturnValue(mockMeterInstance);
    mockCreateCounterFn.mockReturnValue(mockCounterInstance);
    mockCreateHistogramFn.mockReturnValue(mockHistogramInstance);
  });

  describe('recordChatCompressionMetrics', () => {
    it('records token compression with the correct attributes (assuming manually initialized)', () => {
      const config = makeFakeConfig({});
      initializeMetricsModule(config);

      recordChatCompressionMetricsModule(config, {
        tokens_after: 100,
        tokens_before: 200,
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        'session.id': 'test-session-id',
        tokens_after: 100,
        tokens_before: 200,
      });
    });
  });

  describe('Performance Monitoring Metrics', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTelemetryEnabled: () => false, // Performance monitoring is disabled
    } as unknown as Config;

    describe('recordStartupPerformance', () => {
      it('should NOT record metrics because performance monitoring is forced disabled', () => {
        initializeMetricsModule(mockConfig);
        mockHistogramRecordFn.mockClear();

        recordStartupPerformanceModule(mockConfig, 150, {
          phase: 'settings_loading',
          details: {
            auth_type: 'gemini',
          },
        });

        expect(mockHistogramRecordFn).not.toHaveBeenCalled();
      });
    });

    describe('recordMemoryUsage', () => {
      it('should NOT record memory usage', () => {
        initializeMetricsModule(mockConfig);
        mockHistogramRecordFn.mockClear();

        recordMemoryUsageModule(mockConfig, 15728640, {
          memory_type: MemoryMetricType.HEAP_USED,
          component: 'startup',
        });

        expect(mockHistogramRecordFn).not.toHaveBeenCalled();
      });
    });

    // ... other performance metrics tests would also not be called
  });
});

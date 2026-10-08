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
import {
  FileOperation,
  MemoryMetricType,
  ToolExecutionPhase,
  ApiRequestPhase,
} from './metrics.js';
import { makeFakeConfig } from '../test-utils/config.js';
import type { GoalStateEvent } from './types.js';

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
    ValueType: { INT: 1, DOUBLE: 2 },
    diag: { setLogger: vi.fn(), warn: vi.fn() },
  } as const;
}

vi.mock('@opentelemetry/api');

const mockConfig = {
  getSessionId: () => 'test-session-id',
  getTelemetryEnabled: () => true,
  getTelemetryMetricsIncludeSessionId: () => false,
} as unknown as Config;

/** Expects exactly `calls`, in order, as [value, attributes] pairs. */
const expectCalls = (mock: Mock, calls: Array<[number, Attributes]>) => {
  expect(mock).toHaveBeenCalledTimes(calls.length);
  calls.forEach(([value, attrs], i) =>
    expect(mock).toHaveBeenNthCalledWith(i + 1, value, attrs),
  );
};

describe('Telemetry Metrics', () => {
  // Fresh module per case (vi.resetModules), so its instruments start unset.
  let m: typeof import('./metrics.js');

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@opentelemetry/api', () => {
      const actualApi = originalOtelMockFactory();
      (actualApi.metrics.getMeter as Mock).mockReturnValue(mockMeterInstance);
      return actualApi;
    });

    m = await import('./metrics.js');

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

  /** Initializes metrics, then forgets the instrument calls that made. */
  const init = <C extends Config>(config: C = mockConfig as C): C => {
    m.initializeMetrics(config);
    mockCounterAddFn.mockClear();
    mockHistogramRecordFn.mockClear();
    return config;
  };

  /** On fresh metrics, `record(mockConfig, value, attrs)` records `expected`. */
  const expectHistogram = <A>(
    record: (config: Config, value: number, attrs: A) => void,
    value: number,
    attrs: NoInfer<A>,
    expected: Attributes = attrs as Attributes,
  ) => {
    init();
    record(mockConfig, value, attrs);
    expect(mockHistogramRecordFn).toHaveBeenCalledWith(value, expected);
  };

  describe('recordToolCallMetrics', () => {
    const config = makeFakeConfig({ sessionId: 'test-session-id' });

    it('records an explicit terminal status only on the counter', () => {
      m.initializeMetrics(config);
      const attrs = {
        function_name: 'read_file',
        success: false,
        status: 'cancelled',
        tool_type: 'native',
      } as const;

      m.recordToolCallMetrics(config, 25, attrs);

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, attrs);
      expect(mockHistogramRecordFn).toHaveBeenCalledWith(25, {
        function_name: 'read_file',
      });
    });

    it('derives status from success for legacy callers', () => {
      m.initializeMetrics(config);

      m.recordToolCallMetrics(config, 10, {
        function_name: 'legacy_tool',
        success: false,
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        function_name: 'legacy_tool',
        success: false,
        status: 'error',
      });
    });
  });

  describe('recordChatCompressionMetrics', () => {
    const tokens = { tokens_after: 100, tokens_before: 200 };

    it('does not record metrics if not initialized', () => {
      m.recordChatCompressionMetrics(makeFakeConfig({}), tokens);

      expect(mockCounterAddFn).not.toHaveBeenCalled();
    });

    it('records token compression with the correct attributes', () => {
      const config = makeFakeConfig({ sessionId: 'test-session-id' });
      m.initializeMetrics(config);

      m.recordChatCompressionMetrics(config, tokens);

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, tokens);
    });
  });

  describe('recordMemoryRecallMetrics', () => {
    it('omits the selector_skipped dimension unless the caller sets it', () => {
      init();

      m.recordMemoryRecallMetrics(mockConfig, 42, {
        strategy: 'heuristic',
        docs_selected: 1,
      });
      m.recordMemoryRecallMetrics(mockConfig, 7, {
        strategy: 'heuristic',
        docs_selected: 0,
        selector_skipped: true,
      });

      // An existing series must not gain the dimension — not even as a
      // constant `false` — or every deployment with the experiment off
      // splits the time series. Exact-attribute assertions, since a spy on
      // this public API is what replaces it for logger-level tests.
      expectCalls(mockCounterAddFn, [
        [1, { strategy: 'heuristic' }],
        [1, { strategy: 'heuristic', selector_skipped: true }],
      ]);
      expectCalls(mockHistogramRecordFn, [
        [42, { strategy: 'heuristic' }],
        [7, { strategy: 'heuristic', selector_skipped: true }],
      ]);
    });

    it('keeps an explicit selector_skipped: false as the control series', () => {
      // The ablation's control arm: with the experiment on, a recall whose
      // selector ran must carry the dimension set to false — a truthiness
      // check would drop it and mix the control series into the
      // no-dimension (experiment-off) one.
      init();

      m.recordMemoryRecallMetrics(mockConfig, 9, {
        strategy: 'heuristic',
        docs_selected: 1,
        selector_skipped: false,
      });

      expectCalls(mockCounterAddFn, [
        [1, { strategy: 'heuristic', selector_skipped: false }],
      ]);
      expectCalls(mockHistogramRecordFn, [
        [9, { strategy: 'heuristic', selector_skipped: false }],
      ]);
    });
  });

  describe('recordGoalStateMetrics', () => {
    const histogramSpies = new Map<string, Mock>();
    beforeEach(() => {
      histogramSpies.clear();
      mockCreateHistogramFn.mockImplementation((name: string) => {
        const record = vi.fn((...args: Parameters<Histogram['record']>) =>
          mockHistogramRecordFn(...args),
        );
        histogramSpies.set(name, record);
        return { record } as Histogram;
      });
    });

    const goalEvent = (fields: Partial<GoalStateEvent>): GoalStateEvent => ({
      'event.name': 'goal_state',
      'event.timestamp': '2025-01-01T00:00:00.000Z',
      cause: 'create',
      goal_id: 'g-1',
      revision: 1,
      ...fields,
    });
    const tokensHistogram = () =>
      histogramSpies.get('qwen-code.goal.tokens_used');
    const turnsHistogram = () =>
      histogramSpies.get('qwen-code.goal.turn_count');

    it('records nothing before metrics are initialized', () => {
      m.recordGoalStateMetrics(
        makeFakeConfig({}),
        goalEvent({ cause: 'complete', tokens_used: 10, turn_count: 1 }),
      );

      expect(mockCounterAddFn).not.toHaveBeenCalled();
      expect(mockHistogramRecordFn).not.toHaveBeenCalled();
    });

    it('registers the Goal counter and histograms', () => {
      m.initializeMetrics(makeFakeConfig({}));

      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.goal.transition.count',
        expect.anything(),
      );
      expect(mockCreateHistogramFn).toHaveBeenCalledWith(
        'qwen-code.goal.tokens_used',
        expect.objectContaining({
          unit: '{token}',
          advice: {
            explicitBucketBoundaries: [
              1_000, 10_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000,
              30_000_000, 100_000_000, 300_000_000, 600_000_000,
            ],
          },
        }),
      );
      expect(mockCreateHistogramFn).toHaveBeenCalledWith(
        'qwen-code.goal.turn_count',
        expect.objectContaining({
          unit: '{turn}',
          advice: {
            explicitBucketBoundaries: [
              1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 10_000, 25_000,
              50_000,
            ],
          },
        }),
      );
    });

    it('counts a transition by its bounded attributes only', () => {
      // Goal id and revision are per-Goal; on a metric each Goal would open a
      // new time series.
      const config = init(makeFakeConfig({ sessionId: 'test-session-id' }));

      m.recordGoalStateMetrics(
        config,
        goalEvent({
          cause: 'pause',
          status: 'paused',
          turn_count: 3,
          tokens_used: 500,
        }),
      );

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        cause: 'pause',
        status: 'paused',
      });
      // A pause is not an outcome, so nothing is recorded as spend.
      expect(mockHistogramRecordFn).not.toHaveBeenCalled();
    });

    it.each(['complete', 'blocked', 'usage_limited'] as const)(
      'records spend and turns on %s',
      (cause) => {
        const config = init(makeFakeConfig({ sessionId: 'test-session-id' }));
        const limitAttributes =
          cause === 'usage_limited'
            ? { limit_kind: 'time_budget' as const }
            : {};

        m.recordGoalStateMetrics(
          config,
          goalEvent({
            cause,
            status: cause,
            ...limitAttributes,
            turn_count: 12,
            tokens_used: 45_000,
          }),
        );

        const attrs = { cause, ...limitAttributes };
        expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
          ...attrs,
          status: cause,
        });
        expect(tokensHistogram()).toHaveBeenCalledWith(45_000, attrs);
        expect(turnsHistogram()).toHaveBeenCalledWith(12, attrs);
      },
    );

    it.each([
      'create',
      'replace',
      'edit',
      'pause',
      'resume',
      'clear',
      'verifier_reject',
    ] as const)('records no outcome figure on %s', (cause) => {
      const config = init(makeFakeConfig({}));
      m.recordGoalStateMetrics(
        config,
        goalEvent({ cause, tokens_used: 45_000, turn_count: 12 }),
      );
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, { cause });
      expect(mockHistogramRecordFn).not.toHaveBeenCalled();
    });

    it('records cumulative observations on each stop of a resumed Goal', () => {
      const config = makeFakeConfig({});
      m.initializeMetrics(config);
      for (const [tokens_used, turn_count] of [
        [30_000_000, 2],
        [60_000_000, 4],
      ]) {
        m.recordGoalStateMetrics(
          config,
          goalEvent({
            cause: 'usage_limited',
            limit_kind: 'token_budget',
            tokens_used,
            turn_count,
          }),
        );
      }
      const attributes = { cause: 'usage_limited', limit_kind: 'token_budget' };
      expect(tokensHistogram()?.mock.calls).toEqual([
        [30_000_000, attributes],
        [60_000_000, attributes],
      ]);
      expect(turnsHistogram()?.mock.calls).toEqual([
        [2, attributes],
        [4, attributes],
      ]);
    });

    it('records zero spend and turns on an outcome', () => {
      const config = makeFakeConfig({});
      m.initializeMetrics(config);

      m.recordGoalStateMetrics(
        config,
        goalEvent({
          cause: 'complete',
          status: 'complete',
          tokens_used: 0,
          turn_count: 0,
        }),
      );

      expectCalls(mockHistogramRecordFn, [
        [0, { cause: 'complete' }],
        [0, { cause: 'complete' }],
      ]);
    });
  });

  describe('recordTokenUsageMetrics', () => {
    const input = { model: 'gemini-pro', type: 'input' } as const;

    it('should not record metrics if not initialized', () => {
      m.recordTokenUsageMetrics(mockConfig, 100, input);
      expect(mockCounterAddFn).not.toHaveBeenCalled();
    });

    it('should record token usage with the correct attributes', () => {
      m.initializeMetrics(mockConfig);
      m.recordTokenUsageMetrics(mockConfig, 100, input);
      expectCalls(mockCounterAddFn, [
        [1, {}],
        [100, { model: 'gemini-pro', type: 'input' }],
      ]);
    });

    const expectTokens = (
      tokens: number,
      model: string,
      type: 'input' | 'output' | 'thought' | 'cache',
    ) => {
      m.recordTokenUsageMetrics(mockConfig, tokens, { model, type });
      expect(mockCounterAddFn).toHaveBeenCalledWith(tokens, { model, type });
    };

    it('should record token usage for different types', () => {
      init();
      expectTokens(50, 'gemini-pro', 'output');
      expectTokens(25, 'gemini-pro', 'thought');
      expectTokens(75, 'gemini-pro', 'cache');
    });

    it('should handle different models', () => {
      init();
      expectTokens(200, 'gemini-ultra', 'input');
    });
  });

  describe('recordToolExecutionMetrics', () => {
    it('does not record before metrics are initialized', () => {
      m.recordToolExecutionMetrics(mockConfig, {
        execution_status: 'unknown',
        tool_type: 'native',
      });

      expect(mockCounterAddFn).not.toHaveBeenCalled();
    });

    it('uses a dedicated low-cardinality counter', () => {
      init();
      const attrs = { execution_status: 'error', tool_type: 'mcp' } as const;

      m.recordToolExecutionMetrics(mockConfig, attrs);

      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.tool.execution.count',
        expect.any(Object),
      );
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, attrs);
    });

    it('merges common attributes when session id is opted in', () => {
      const configWithSession = init({
        ...mockConfig,
        getTelemetryMetricsIncludeSessionId: () => true,
      } as unknown as Config);

      m.recordToolExecutionMetrics(configWithSession, {
        execution_status: 'success',
        tool_type: 'native',
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        'session.id': 'test-session-id',
        execution_status: 'success',
        tool_type: 'native',
      });
    });
  });

  describe('recordRepeatedToolFailureGuardMetrics', () => {
    it('records only low-cardinality transition attributes', () => {
      init(makeFakeConfig({ sessionId: 'test-session-id' }));
      const attrs = {
        route: 'acp_foreground',
        mode: 'enforce',
        phase_before: 'warned',
        phase_after: 'latched',
        decision: 'stopped',
        failure_count_bucket: '8+',
        batch_count_bucket: '3+',
        terminal_status: 'error',
        execution_status: 'error',
        tool_type: 'mcp',
      } as const;

      m.recordRepeatedToolFailureGuardMetrics(attrs);

      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.repeated_tool_failure_guard.count',
        expect.any(Object),
      );
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, attrs);
    });
  });

  describe('recordFileOperationMetric', () => {
    const created = {
      operation: FileOperation.CREATE,
      lines: 10,
      mimetype: 'text/plain',
      extension: 'txt',
    };

    it('should not record metrics if not initialized', () => {
      m.recordFileOperationMetric(mockConfig, created);
      expect(mockCounterAddFn).not.toHaveBeenCalled();
    });

    it('should record file creation with all attributes', () => {
      m.initializeMetrics(mockConfig);
      m.recordFileOperationMetric(mockConfig, created);

      expectCalls(mockCounterAddFn, [
        [1, {}],
        [1, { ...created }],
      ]);
    });

    // 'should record file operation without diffStat' was an exact duplicate
    // of the diffStat row below.
    it.each([
      [
        'should record file read with minimal attributes',
        { operation: FileOperation.READ },
      ],
      [
        'should record file update with some attributes',
        { operation: FileOperation.UPDATE, mimetype: 'application/javascript' },
      ],
      [
        'should record minimal file operation when optional parameters are undefined',
        { ...created, operation: FileOperation.UPDATE },
      ],
      [
        'should not include diffStat attributes when diffStat is not provided',
        { operation: FileOperation.UPDATE },
      ],
    ])('%s', (_title, attrs) => {
      init();
      m.recordFileOperationMetric(mockConfig, attrs);
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, { ...attrs });
    });
  });

  describe('Performance Monitoring Metrics', () => {
    describe('recordStartupPerformance', () => {
      it('should not record metrics when performance monitoring is disabled', () => {
        // Telemetry off disables performance monitoring.
        const mockConfigDisabled = init({
          ...mockConfig,
          getTelemetryEnabled: () => false,
        } as unknown as Config);

        m.recordStartupPerformance(mockConfigDisabled, 100, {
          phase: 'settings_loading',
          details: { auth_type: 'gemini' },
        });

        expect(mockHistogramRecordFn).not.toHaveBeenCalled();
      });

      it('should record startup performance with phase and details', () => {
        const details = {
          auth_type: 'gemini',
          telemetry_enabled: true,
          settings_sources: 2,
        };
        expectHistogram(
          m.recordStartupPerformance,
          150,
          { phase: 'settings_loading', details },
          { phase: 'settings_loading', ...details },
        );
      });

      it('should record startup performance without details', () => {
        expectHistogram(m.recordStartupPerformance, 50, { phase: 'cleanup' });
      });

      it('should handle floating-point duration values from performance.now()', () => {
        // A realistic performance.now() value.
        expectHistogram(
          m.recordStartupPerformance,
          123.45678,
          {
            phase: 'total_startup',
            details: { is_tty: true, has_question: false },
          },
          { phase: 'total_startup', is_tty: true, has_question: false },
        );
      });
    });

    describe('recordMemoryUsage', () => {
      it('should record memory usage for different memory types', () => {
        expectHistogram(
          m.recordMemoryUsage,
          15728640,
          { memory_type: MemoryMetricType.HEAP_USED, component: 'startup' },
          { memory_type: 'heap_used', component: 'startup' },
        );
      });

      it('should record memory usage for all memory metric types', () => {
        init();
        const rows = [
          [31457280, MemoryMetricType.HEAP_TOTAL, 'api_call'],
          [2097152, MemoryMetricType.EXTERNAL, 'tool_execution'],
          [41943040, MemoryMetricType.RSS, 'memory_monitor'],
        ] as const;
        for (const [bytes, memory_type, component] of rows) {
          m.recordMemoryUsage(mockConfig, bytes, { memory_type, component });
        }

        expectCalls(mockHistogramRecordFn, [
          [31457280, { memory_type: 'heap_total', component: 'api_call' }],
          [2097152, { memory_type: 'external', component: 'tool_execution' }],
          [41943040, { memory_type: 'rss', component: 'memory_monitor' }],
        ]);
      });

      it('should record memory usage without component', () => {
        expectHistogram(
          m.recordMemoryUsage,
          15728640,
          { memory_type: MemoryMetricType.HEAP_USED },
          { memory_type: 'heap_used' },
        );
      });
    });

    describe('recordCpuUsage', () => {
      it('should record CPU usage percentage', () => {
        expectHistogram(m.recordCpuUsage, 85.5, {
          component: 'tool_execution',
        });
      });

      it('should record CPU usage without component', () => {
        expectHistogram(m.recordCpuUsage, 42.3, {});
      });
    });

    describe('recordToolQueueDepth', () => {
      it('should record tool queue depth', () => {
        init();
        m.recordToolQueueDepth(mockConfig, 3);
        expect(mockHistogramRecordFn).toHaveBeenCalledWith(3, {});
      });

      it('should record zero queue depth', () => {
        init();
        m.recordToolQueueDepth(mockConfig, 0);
        expect(mockHistogramRecordFn).toHaveBeenCalledWith(0, {});
      });
    });

    describe('recordToolExecutionBreakdown', () => {
      it('should record tool execution breakdown for all phases', () => {
        expectHistogram(
          m.recordToolExecutionBreakdown,
          25,
          { function_name: 'Read', phase: ToolExecutionPhase.VALIDATION },
          { function_name: 'Read', phase: 'validation' },
        );
      });

      it('should record execution breakdown for different phases', () => {
        init();
        for (const [ms, phase] of [
          [50, ToolExecutionPhase.PREPARATION],
          [1500, ToolExecutionPhase.EXECUTION],
          [75, ToolExecutionPhase.RESULT_PROCESSING],
        ] as const) {
          m.recordToolExecutionBreakdown(mockConfig, ms, {
            function_name: 'Bash',
            phase,
          });
        }

        expectCalls(mockHistogramRecordFn, [
          [50, { function_name: 'Bash', phase: 'preparation' }],
          [1500, { function_name: 'Bash', phase: 'execution' }],
          [75, { function_name: 'Bash', phase: 'result_processing' }],
        ]);
      });
    });

    describe('recordTokenEfficiency', () => {
      it('should record token efficiency metrics', () => {
        expectHistogram(m.recordTokenEfficiency, 0.85, {
          model: 'gemini-pro',
          metric: 'cache_hit_rate',
          context: 'api_request',
        });
      });

      it('should record token efficiency without context', () => {
        expectHistogram(m.recordTokenEfficiency, 125.5, {
          model: 'gemini-pro',
          metric: 'tokens_per_operation',
        });
      });
    });

    describe('recordApiRequestBreakdown', () => {
      it('should record API request breakdown for all phases', () => {
        expectHistogram(
          m.recordApiRequestBreakdown,
          15,
          { model: 'gemini-pro', phase: ApiRequestPhase.REQUEST_PREPARATION },
          { model: 'gemini-pro', phase: 'request_preparation' },
        );
      });

      it('should record API request breakdown for different phases', () => {
        init();
        for (const [ms, phase] of [
          [250, ApiRequestPhase.NETWORK_LATENCY],
          [100, ApiRequestPhase.RESPONSE_PROCESSING],
          [50, ApiRequestPhase.TOKEN_PROCESSING],
        ] as const) {
          m.recordApiRequestBreakdown(mockConfig, ms, {
            model: 'gemini-pro',
            phase,
          });
        }

        expectCalls(mockHistogramRecordFn, [
          [250, { model: 'gemini-pro', phase: 'network_latency' }],
          [100, { model: 'gemini-pro', phase: 'response_processing' }],
          [50, { model: 'gemini-pro', phase: 'token_processing' }],
        ]);
      });
    });

    describe('recordPerformanceScore', () => {
      it('should record performance score with category and baseline', () => {
        expectHistogram(m.recordPerformanceScore, 85.5, {
          category: 'memory_efficiency',
          baseline: 80.0,
        });
      });

      it('should record performance score without baseline', () => {
        expectHistogram(m.recordPerformanceScore, 92.3, {
          category: 'overall_performance',
        });
      });
    });

    describe('recordPerformanceRegression', () => {
      const regression = (
        metric: string,
        current_value: number,
        baseline_value: number,
        severity: 'low' | 'medium' | 'high',
      ) => ({ metric, current_value, baseline_value, severity });

      it('should record performance regression with baseline comparison', () => {
        init();
        const attrs = regression('startup_time', 1200, 1000, 'medium');

        m.recordPerformanceRegression(mockConfig, attrs);

        expect(mockCounterAddFn).toHaveBeenCalledWith(1, { ...attrs });
        // Baseline comparison histogram: a 20% increase.
        expect(mockHistogramRecordFn).toHaveBeenCalledWith(20, { ...attrs });
      });

      it('should handle zero baseline value gracefully', () => {
        init();
        const attrs = regression('memory_usage', 100, 0, 'high');

        m.recordPerformanceRegression(mockConfig, attrs);

        // The counter still records; a zero baseline skips the comparison.
        expect(mockCounterAddFn).toHaveBeenCalledWith(1, { ...attrs });
        expect(mockHistogramRecordFn).not.toHaveBeenCalled();
      });

      it('should record different severity levels', () => {
        init();
        const low = regression('api_latency', 500, 400, 'low');
        const high = regression('cpu_usage', 90, 70, 'high');

        m.recordPerformanceRegression(mockConfig, low);
        m.recordPerformanceRegression(mockConfig, high);

        expect(mockCounterAddFn).toHaveBeenNthCalledWith(1, 1, { ...low });
        expect(mockCounterAddFn).toHaveBeenNthCalledWith(2, 1, { ...high });
      });
    });

    describe('recordBaselineComparison', () => {
      /** `value` is the recorded percentage change, (current - base) / base. */
      const expectComparison = (
        value: number,
        attrs: Parameters<typeof m.recordBaselineComparison>[1],
      ) => {
        init();
        m.recordBaselineComparison(mockConfig, attrs);
        expect(mockHistogramRecordFn).toHaveBeenCalledWith(value, { ...attrs });
      };

      it('should record baseline comparison with percentage change', () => {
        // (120 - 100) / 100 * 100 = 20%
        expectComparison(20, {
          metric: 'memory_usage',
          current_value: 120,
          baseline_value: 100,
          category: 'performance_tracking',
        });
      });

      it('should handle negative percentage change (improvement)', () => {
        // (800 - 1000) / 1000 * 100 = -20%
        expectComparison(-20, {
          metric: 'startup_time',
          current_value: 800,
          baseline_value: 1000,
          category: 'optimization',
        });
      });

      it('should skip recording when baseline is zero', async () => {
        const mockedModule = (await vi.importMock('@opentelemetry/api')) as {
          diag: { warn: ReturnType<typeof vi.fn> };
        };
        const diagSpy = vi.spyOn(mockedModule.diag, 'warn');
        init();

        m.recordBaselineComparison(mockConfig, {
          metric: 'new_metric',
          current_value: 50,
          baseline_value: 0,
          category: 'testing',
        });

        expect(diagSpy).toHaveBeenCalledWith(
          'Baseline value is zero, skipping comparison.',
        );
        expect(mockHistogramRecordFn).not.toHaveBeenCalled();
      });
    });
  });

  describe('metric attribute cardinality controls', () => {
    it('records memory recall delivery with low-cardinality attributes', () => {
      const config = init(makeFakeConfig({ sessionId: 'cardinality-test' }));
      const expectedAttrs = {
        phase: 'refined',
        delivery_point: 'discarded',
        discard_reason: 'reset',
        strategy: 'model',
      } as const;

      m.recordMemoryRecallDeliveryMetrics(config, 42, { ...expectedAttrs });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, expectedAttrs);
      expect(mockHistogramRecordFn).toHaveBeenCalledWith(42, expectedAttrs);
    });

    /** Records one compression on `config`; returns the counter attributes. */
    const compressionAttrs = (config: Config): Attributes => {
      init(config);
      m.recordChatCompressionMetrics(config, {
        tokens_after: 1,
        tokens_before: 2,
      });
      return mockCounterAddFn.mock.calls[0]?.[1] ?? {};
    };

    it('omits session.id from metric attributes by default', () => {
      const attrs = compressionAttrs(
        makeFakeConfig({ sessionId: 'cardinality-test' }),
      );
      expect(attrs).not.toHaveProperty('session.id');
    });

    it('includes session.id when telemetry.metrics.includeSessionId is true', () => {
      const attrs = compressionAttrs(
        makeFakeConfig({
          sessionId: 'cardinality-test',
          telemetry: { metrics: { includeSessionId: true } },
        }),
      );
      expect(attrs['session.id']).toBe('cardinality-test');
    });
  });

  describe('recordChannelMemoryRecallMetrics', () => {
    it('does not record before metrics are initialized', () => {
      m.recordChannelMemoryRecallMetrics({
        durationMs: 12,
        cache: 'hit',
        result: 'selected',
        selectedCount: 2,
      });

      expect(mockCounterAddFn).not.toHaveBeenCalled();
      expect(mockHistogramRecordFn).not.toHaveBeenCalled();
    });

    it('records only bounded recall outcome attributes', () => {
      init(makeFakeConfig({ sessionId: 'secret-session' }));

      m.recordChannelMemoryRecallMetrics({
        durationMs: 12.5,
        cache: 'miss',
        result: 'revision_unstable',
        selectedCount: 1,
      });

      const attributes = { cache: 'miss', result: 'revision_unstable' };
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, attributes);
      expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(
        1,
        12.5,
        attributes,
      );
      expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(2, 1, attributes);
      expect(Object.keys(mockCounterAddFn.mock.calls[0]![1]!).sort()).toEqual([
        'cache',
        'result',
      ]);
    });

    it('initializes dedicated channel memory recall instruments', () => {
      m.initializeMetrics(makeFakeConfig({}));

      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.channel.memory.recall.count',
        expect.any(Object),
      );
      expect(mockCreateHistogramFn).toHaveBeenCalledWith(
        'qwen-code.channel.memory.recall.duration',
        expect.objectContaining({ unit: 'ms' }),
      );
      expect(mockCreateHistogramFn).toHaveBeenCalledWith(
        'qwen-code.channel.memory.recall.selected_count',
        expect.any(Object),
      );
    });
  });
});

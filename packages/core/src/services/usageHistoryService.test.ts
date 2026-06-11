/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { metricsToUsageRecord, aggregateUsage } from './usageHistoryService.js';
import { ToolCallDecision } from '../telemetry/tool-call-decision.js';
import type { SessionMetrics } from '../telemetry/uiTelemetry.js';
import type { UsageSummaryRecord } from './usageHistoryService.js';

function makeMetrics(overrides?: Partial<SessionMetrics>): SessionMetrics {
  return {
    models: {
      'qwen-max': {
        api: {
          totalRequests: 5,
          totalErrors: 0,
          totalLatencyMs: 3200,
        },
        tokens: {
          prompt: 1000,
          candidates: 500,
          total: 1500,
          cached: 200,
          thoughts: 100,
        },
        bySource: {},
      },
    },
    tools: {
      totalCalls: 10,
      totalSuccess: 8,
      totalFail: 2,
      totalDurationMs: 5000,
      totalDecisions: {
        [ToolCallDecision.ACCEPT]: 5,
        [ToolCallDecision.REJECT]: 1,
        [ToolCallDecision.MODIFY]: 0,
        [ToolCallDecision.AUTO_ACCEPT]: 4,
      },
      byName: {
        edit: {
          count: 6,
          success: 5,
          fail: 1,
          durationMs: 3000,
          decisions: {
            [ToolCallDecision.ACCEPT]: 3,
            [ToolCallDecision.REJECT]: 1,
            [ToolCallDecision.MODIFY]: 0,
            [ToolCallDecision.AUTO_ACCEPT]: 2,
          },
        },
        bash: {
          count: 4,
          success: 3,
          fail: 1,
          durationMs: 2000,
          decisions: {
            [ToolCallDecision.ACCEPT]: 2,
            [ToolCallDecision.REJECT]: 0,
            [ToolCallDecision.MODIFY]: 0,
            [ToolCallDecision.AUTO_ACCEPT]: 2,
          },
        },
      },
    },
    files: {
      totalLinesAdded: 50,
      totalLinesRemoved: 10,
    },
    ...overrides,
  };
}

describe('metricsToUsageRecord', () => {
  it('populates totalLatencyMs from sum of model api.totalLatencyMs', () => {
    const metrics = makeMetrics({
      models: {
        'qwen-max': {
          api: { totalRequests: 3, totalErrors: 0, totalLatencyMs: 2000 },
          tokens: {
            prompt: 500,
            candidates: 200,
            total: 700,
            cached: 0,
            thoughts: 0,
          },
          bySource: {},
        },
        'qwen-turbo': {
          api: { totalRequests: 2, totalErrors: 1, totalLatencyMs: 1500 },
          tokens: {
            prompt: 300,
            candidates: 100,
            total: 400,
            cached: 50,
            thoughts: 0,
          },
          bySource: {},
        },
      },
    });

    const record = metricsToUsageRecord(
      'session-1',
      '/project',
      1000,
      5000,
      metrics,
    );

    expect(record.totalLatencyMs).toBe(3500); // 2000 + 1500
  });

  it('populates totalDurationMs for each tool in byName', () => {
    const metrics = makeMetrics();

    const record = metricsToUsageRecord(
      'session-2',
      '/project',
      1000,
      6000,
      metrics,
    );

    expect(record.tools.byName['edit']).toEqual({
      count: 6,
      success: 5,
      fail: 1,
      totalDurationMs: 3000,
    });
    expect(record.tools.byName['bash']).toEqual({
      count: 4,
      success: 3,
      fail: 1,
      totalDurationMs: 2000,
    });
  });

  it('sets totalLatencyMs to 0 when no models present', () => {
    const metrics = makeMetrics({ models: {} });

    const record = metricsToUsageRecord(
      'session-3',
      '/project',
      0,
      1000,
      metrics,
    );

    expect(record.totalLatencyMs).toBe(0);
  });

  it('preserves existing fields correctly alongside new fields', () => {
    const metrics = makeMetrics();

    const record = metricsToUsageRecord(
      'session-4',
      '/my/project',
      1000,
      4000,
      metrics,
    );

    expect(record.version).toBe(1);
    expect(record.sessionId).toBe('session-4');
    expect(record.project).toBe('/my/project');
    expect(record.durationMs).toBe(3000);
    expect(record.totalLatencyMs).toBe(3200);
    expect(record.tools.totalCalls).toBe(10);
    expect(record.tools.totalSuccess).toBe(8);
    expect(record.tools.totalFail).toBe(2);
    expect(record.files.linesAdded).toBe(50);
    expect(record.files.linesRemoved).toBe(10);
  });
});

function makeRecord(
  overrides?: Partial<UsageSummaryRecord>,
): UsageSummaryRecord {
  return {
    version: 1,
    sessionId: 'sess-1',
    timestamp: Date.now(),
    startTime: Date.now() - 60000,
    project: '/my/project',
    durationMs: 60000,
    totalLatencyMs: 2000,
    models: {
      'qwen-max': {
        requests: 3,
        inputTokens: 1000,
        outputTokens: 500,
        cachedTokens: 100,
        thoughtsTokens: 50,
        totalTokens: 1550,
      },
    },
    tools: {
      totalCalls: 5,
      totalSuccess: 4,
      totalFail: 1,
      byName: {
        edit: { count: 3, success: 2, fail: 1, totalDurationMs: 1500 },
        bash: { count: 2, success: 2, fail: 0, totalDurationMs: 800 },
      },
    },
    files: {
      linesAdded: 20,
      linesRemoved: 5,
    },
    ...overrides,
  };
}

describe('aggregateUsage', () => {
  it('accumulates totalLatencyMs from records', () => {
    const records = [
      makeRecord({ totalLatencyMs: 2000 }),
      makeRecord({ totalLatencyMs: 3000 }),
    ];

    const report = aggregateUsage(records, 'all');

    expect(report.totalLatencyMs).toBe(5000);
  });

  it('handles records without totalLatencyMs (backward compat)', () => {
    const r1 = makeRecord({ totalLatencyMs: 1500 });
    const r2 = makeRecord({ totalLatencyMs: undefined });

    const report = aggregateUsage([r1, r2], 'all');

    expect(report.totalLatencyMs).toBe(1500);
  });

  it('accumulates totalRequests by summing model requests', () => {
    const records = [
      makeRecord({
        models: {
          'qwen-max': {
            requests: 3,
            inputTokens: 100,
            outputTokens: 50,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 150,
          },
          'qwen-turbo': {
            requests: 2,
            inputTokens: 80,
            outputTokens: 40,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 120,
          },
        },
      }),
      makeRecord({
        models: {
          'qwen-max': {
            requests: 4,
            inputTokens: 200,
            outputTokens: 100,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 300,
          },
        },
      }),
    ];

    const report = aggregateUsage(records, 'all');

    // 3 + 2 + 4 = 9
    expect(report.totalRequests).toBe(9);
  });

  it('includes totalDurationMs in topTools', () => {
    const records = [
      makeRecord({
        tools: {
          totalCalls: 5,
          totalSuccess: 4,
          totalFail: 1,
          byName: {
            edit: { count: 3, success: 2, fail: 1, totalDurationMs: 1500 },
            bash: { count: 2, success: 2, fail: 0, totalDurationMs: 800 },
          },
        },
      }),
      makeRecord({
        tools: {
          totalCalls: 3,
          totalSuccess: 3,
          totalFail: 0,
          byName: {
            edit: { count: 2, success: 2, fail: 0, totalDurationMs: 1000 },
            grep: { count: 1, success: 1, fail: 0, totalDurationMs: 200 },
          },
        },
      }),
    ];

    const report = aggregateUsage(records, 'all');

    const editTool = report.tools.topTools.find((t) => t.name === 'edit');
    expect(editTool).toBeDefined();
    expect(editTool!.totalDurationMs).toBe(2500); // 1500 + 1000

    const bashTool = report.tools.topTools.find((t) => t.name === 'bash');
    expect(bashTool).toBeDefined();
    expect(bashTool!.totalDurationMs).toBe(800);

    const grepTool = report.tools.topTools.find((t) => t.name === 'grep');
    expect(grepTool).toBeDefined();
    expect(grepTool!.totalDurationMs).toBe(200);
  });

  it('handles tools without totalDurationMs (backward compat)', () => {
    const records = [
      makeRecord({
        tools: {
          totalCalls: 2,
          totalSuccess: 2,
          totalFail: 0,
          byName: {
            edit: { count: 2, success: 2, fail: 0 },
          },
        },
      }),
    ];

    const report = aggregateUsage(records, 'all');

    const editTool = report.tools.topTools.find((t) => t.name === 'edit');
    expect(editTool).toBeDefined();
    expect(editTool!.totalDurationMs).toBe(0);
  });

  it('returns zero for all new fields when no records match', () => {
    const report = aggregateUsage([], 'all');

    expect(report.totalLatencyMs).toBe(0);
    expect(report.totalRequests).toBe(0);
    expect(report.tools.topTools).toEqual([]);
  });
});

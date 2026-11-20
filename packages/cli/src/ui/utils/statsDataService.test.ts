/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  UsageSummaryRecord,
  AggregatedReport,
} from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    loadUsageHistory: vi.fn(),
    // Default: no ledger coverage, so records drive every field. Without this
    // the real loader would read the developer's own ~/.qwen/usage.
    loadLedgerOrEmpty: vi.fn(async () => new Map()),
  };
});

import { loadUsageHistory, loadLedgerOrEmpty } from '@qwen-code/qwen-code-core';
import {
  loadStatsData,
  getPreviousRangeBounds,
  computeDelta,
  _resetStatsLedgerCacheForTest,
} from './statsDataService.js';

const mockedLoadUsageHistory = vi.mocked(loadUsageHistory);

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
        cachedTokens: 200,
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

describe('getPreviousRangeBounds', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-05T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns null for "all" range', () => {
    expect(getPreviousRangeBounds('all')).toBeNull();
  });

  it('returns yesterday 00:00 to today 00:00 for "today"', () => {
    const result = getPreviousRangeBounds('today');
    expect(result).not.toBeNull();

    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);

    expect(result!.start.getTime()).toBe(yesterdayStart.getTime());
    expect(result!.end.getTime()).toBe(todayStart.getTime());
  });

  it('returns 14 days ago to 7 days ago for "week"', () => {
    const result = getPreviousRangeBounds('week');
    expect(result).not.toBeNull();

    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

    expect(result!.start.getTime()).toBe(fourteenDaysAgo.getTime());
    expect(result!.end.getTime()).toBe(sevenDaysAgo.getTime());
  });

  it('returns 60 days ago to 30 days ago for "month"', () => {
    const result = getPreviousRangeBounds('month');
    expect(result).not.toBeNull();

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);

    expect(result!.start.getTime()).toBe(sixtyDaysAgo.getTime());
    expect(result!.end.getTime()).toBe(thirtyDaysAgo.getTime());
  });
});

describe('computeDelta', () => {
  function makeReport(overrides?: Partial<AggregatedReport>): AggregatedReport {
    return {
      timeRange: 'all',
      periodStart: new Date(0),
      periodEnd: new Date(),
      sessionCount: 10,
      totalDurationMs: 600000,
      totalLatencyMs: 5000,
      totalRequests: 20,
      models: {
        'qwen-max': {
          requests: 20,
          inputTokens: 10000,
          outputTokens: 5000,
          cachedTokens: 2000,
          thoughtsTokens: 500,
          totalTokens: 15500,
          totalLatencyMs: 5000,
        },
      },
      tools: {
        totalCalls: 50,
        totalSuccess: 45,
        totalFail: 5,
        topTools: [],
      },
      files: { linesAdded: 100, linesRemoved: 30 },
      skills: { totalCalls: 0, topSkills: [] },
      projects: [],
      ...overrides,
    };
  }

  it('computes percentage change for sessions', () => {
    const current = makeReport({ sessionCount: 12 });
    const previous = makeReport({ sessionCount: 10 });

    const delta = computeDelta(current, previous);

    // (12-10)/10 * 100 = 20%
    expect(delta.sessions).toBeCloseTo(20);
  });

  it('computes percentage change for duration', () => {
    const current = makeReport({ totalDurationMs: 120000 });
    const previous = makeReport({ totalDurationMs: 100000 });

    const delta = computeDelta(current, previous);

    // (120000-100000)/100000 * 100 = 20%
    expect(delta.duration).toBeCloseTo(20);
  });

  it('computes percentage change for tokens', () => {
    const current = makeReport({
      models: {
        'qwen-max': {
          requests: 10,
          inputTokens: 5000,
          outputTokens: 2500,
          cachedTokens: 1000,
          thoughtsTokens: 0,
          totalTokens: 7500,
          totalLatencyMs: 2000,
        },
      },
    });
    const previous = makeReport({
      models: {
        'qwen-max': {
          requests: 10,
          inputTokens: 4000,
          outputTokens: 2000,
          cachedTokens: 800,
          thoughtsTokens: 0,
          totalTokens: 6000,
          totalLatencyMs: 1500,
        },
      },
    });

    const delta = computeDelta(current, previous);

    // current totalTokens: 7500, previous: 6000, (7500-6000)/6000*100 = 25%
    expect(delta.tokens).toBeCloseTo(25);
  });

  it('computes absolute diff for cacheRate', () => {
    // current: cachedTokens=3000, inputTokens=10000 -> 30%
    // previous: cachedTokens=2000, inputTokens=10000 -> 20%
    // diff: 30 - 20 = 10
    const current = makeReport({
      models: {
        m: {
          requests: 5,
          inputTokens: 10000,
          outputTokens: 3000,
          cachedTokens: 3000,
          thoughtsTokens: 0,
          totalTokens: 13000,
          totalLatencyMs: 4000,
        },
      },
    });
    const previous = makeReport({
      models: {
        m: {
          requests: 5,
          inputTokens: 10000,
          outputTokens: 3000,
          cachedTokens: 2000,
          thoughtsTokens: 0,
          totalTokens: 12000,
          totalLatencyMs: 3500,
        },
      },
    });

    const delta = computeDelta(current, previous);

    expect(delta.cacheRate).toBeCloseTo(10);
  });

  it('computes absolute diff for toolSuccess', () => {
    const current = makeReport({
      tools: { totalCalls: 100, totalSuccess: 90, totalFail: 10, topTools: [] },
    });
    const previous = makeReport({
      tools: { totalCalls: 80, totalSuccess: 64, totalFail: 16, topTools: [] },
    });

    const delta = computeDelta(current, previous);

    // current: 90/100*100=90%, previous: 64/80*100=80%, diff=10
    expect(delta.toolSuccess).toBeCloseTo(10);
  });

  it('computes absolute diff for avgLatency', () => {
    const current = makeReport({ totalLatencyMs: 5000, totalRequests: 10 });
    const previous = makeReport({ totalLatencyMs: 4000, totalRequests: 10 });

    const delta = computeDelta(current, previous);

    // current avg: 500, previous avg: 400, diff: 100
    expect(delta.avgLatency).toBeCloseTo(100);
  });

  it('returns null values when previous has zero denominators', () => {
    const current = makeReport({ sessionCount: 5 });
    const previous = makeReport({
      sessionCount: 0,
      totalDurationMs: 0,
      totalLatencyMs: 0,
      totalRequests: 0,
      models: {},
      tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, topTools: [] },
    });

    const delta = computeDelta(current, previous);

    expect(delta.sessions).toBeNull();
    expect(delta.duration).toBeNull();
    expect(delta.tokens).toBeNull();
    expect(delta.cacheRate).toBeNull();
    expect(delta.toolSuccess).toBeNull();
    expect(delta.avgLatency).toBeNull();
  });
});

describe('loadStatsData - new fields', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetStatsLedgerCacheForTest();
  });

  it('returns delta as null for range "all"', async () => {
    const now = Date.now();
    const records = [makeRecord({ timestamp: now - 1000 })];
    mockedLoadUsageHistory.mockResolvedValue(records);

    const result = await loadStatsData('all');

    expect(result.delta).toBeNull();
  });

  it('returns computed delta for range "today"', async () => {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const todayTimestamp = Math.max(todayStart.getTime(), now.getTime() - 1000);
    const yesterdayMid = todayStart.getTime() - 12 * 60 * 60 * 1000; // yesterday noon

    const todayRecord = makeRecord({
      sessionId: 'today-1',
      timestamp: todayTimestamp,
      startTime: todayTimestamp - 60000,
      durationMs: 60000,
      totalLatencyMs: 1000,
      models: {
        'qwen-max': {
          requests: 2,
          inputTokens: 500,
          outputTokens: 200,
          cachedTokens: 100,
          thoughtsTokens: 0,
          totalTokens: 700,
        },
      },
      tools: { totalCalls: 10, totalSuccess: 8, totalFail: 2, byName: {} },
    });

    const yesterdayRecord = makeRecord({
      sessionId: 'yesterday-1',
      timestamp: yesterdayMid,
      startTime: yesterdayMid - 60000,
      durationMs: 30000,
      totalLatencyMs: 800,
      models: {
        'qwen-max': {
          requests: 2,
          inputTokens: 400,
          outputTokens: 150,
          cachedTokens: 50,
          thoughtsTokens: 0,
          totalTokens: 550,
        },
      },
      tools: { totalCalls: 5, totalSuccess: 4, totalFail: 1, byName: {} },
    });

    mockedLoadUsageHistory.mockResolvedValue([yesterdayRecord, todayRecord]);

    const result = await loadStatsData('today');

    expect(result.delta).not.toBeNull();
    // sessions: 1 today vs 1 yesterday => 0%
    expect(result.delta!.sessions).toBeCloseTo(0);
    // duration: 60000 vs 30000 => 100%
    expect(result.delta!.duration).toBeCloseTo(100);
  });

  it('computes efficiency fields correctly', async () => {
    const now = Date.now();
    const records = [
      makeRecord({
        timestamp: now - 1000,
        totalLatencyMs: 3000,
        models: {
          'qwen-max': {
            requests: 10,
            inputTokens: 2000,
            outputTokens: 1000,
            cachedTokens: 500,
            thoughtsTokens: 0,
            totalTokens: 3000,
            // metricsToUsageRecord always writes the per-model latency; the
            // accounting table reads it there, not from the record total.
            totalLatencyMs: 3000,
          },
        },
        tools: {
          totalCalls: 20,
          totalSuccess: 18,
          totalFail: 2,
          byName: {},
        },
      }),
    ];
    mockedLoadUsageHistory.mockResolvedValue(records);

    const result = await loadStatsData('all');

    // cacheHitRate = 500/2000*100 = 25
    expect(result.efficiency.cacheHitRate).toBeCloseTo(25);
    // toolSuccessRate = 18/20*100 = 90
    expect(result.efficiency.toolSuccessRate).toBeCloseTo(90);
    // avgLatencyMs = 3000/10 = 300
    expect(result.efficiency.avgLatencyMs).toBeCloseTo(300);
  });

  it('handles zero inputTokens for cacheHitRate', async () => {
    const now = Date.now();
    const records = [
      makeRecord({
        timestamp: now - 1000,
        models: {},
        tools: { totalCalls: 0, totalSuccess: 0, totalFail: 0, byName: {} },
      }),
    ];
    mockedLoadUsageHistory.mockResolvedValue(records);

    const result = await loadStatsData('all');

    expect(result.efficiency.cacheHitRate).toBe(0);
    expect(result.efficiency.toolSuccessRate).toBe(0);
    expect(result.efficiency.avgLatencyMs).toBeNull();
  });

  it('computes toolLeaderboard from topTools', async () => {
    const now = Date.now();
    const records = [
      makeRecord({
        timestamp: now - 1000,
        tools: {
          totalCalls: 15,
          totalSuccess: 13,
          totalFail: 2,
          byName: {
            edit: { count: 8, success: 7, fail: 1, totalDurationMs: 3000 },
            bash: { count: 5, success: 4, fail: 1, totalDurationMs: 2000 },
            grep: { count: 2, success: 2, fail: 0, totalDurationMs: 400 },
          },
        },
      }),
    ];
    mockedLoadUsageHistory.mockResolvedValue(records);

    const result = await loadStatsData('all');

    expect(result.toolLeaderboard.length).toBeLessThanOrEqual(8);
    expect(result.toolLeaderboard[0]).toEqual({
      name: 'edit',
      count: 8,
      totalDurationMs: 3000,
      successRate: (7 / 8) * 100,
    });
    expect(result.toolLeaderboard[1]).toEqual({
      name: 'bash',
      count: 5,
      totalDurationMs: 2000,
      successRate: (4 / 5) * 100,
    });
    expect(result.toolLeaderboard[2]).toEqual({
      name: 'grep',
      count: 2,
      totalDurationMs: 400,
      successRate: 100,
    });
  });

  it('limits toolLeaderboard to 8 entries', async () => {
    const now = Date.now();
    const byName: Record<
      string,
      { count: number; success: number; fail: number; totalDurationMs: number }
    > = {};
    for (let i = 0; i < 12; i++) {
      byName[`tool-${i}`] = {
        count: 12 - i,
        success: 12 - i,
        fail: 0,
        totalDurationMs: 100,
      };
    }
    const records = [
      makeRecord({
        timestamp: now - 1000,
        tools: { totalCalls: 78, totalSuccess: 78, totalFail: 0, byName },
      }),
    ];
    mockedLoadUsageHistory.mockResolvedValue(records);

    const result = await loadStatsData('all');

    expect(result.toolLeaderboard.length).toBe(8);
  });
});

describe('loadStatsData — per-request ledger accounting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetStatsLedgerCacheForTest();
  });

  const dayKey = (ms: number) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const DAY = 24 * 60 * 60 * 1000;
  const ledgerDay = (o: {
    requests: number;
    inputTokens: number;
    outputTokens?: number;
    cachedTokens?: number;
    apiDurationMs?: number;
  }) =>
    new Map([
      [
        'qwen-max',
        {
          requests: o.requests,
          inputTokens: o.inputTokens,
          outputTokens: o.outputTokens ?? 0,
          cachedTokens: o.cachedTokens ?? 0,
          thoughtsTokens: 0,
          totalTokens: o.inputTokens + (o.outputTokens ?? 0),
          apiDurationMs: o.apiDurationMs ?? 0,
        },
      ],
    ]);
  const reportTokens = (r: AggregatedReport) =>
    Object.values(r.models).reduce((s, m) => s + m.totalTokens, 0);

  it('replaces a ledger-covered day instead of adding the record copy', async () => {
    const now = Date.now();
    mockedLoadUsageHistory.mockResolvedValue([makeRecord({ timestamp: now })]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(
      new Map([
        [
          dayKey(now),
          ledgerDay({
            requests: 2,
            inputTokens: 300,
            outputTokens: 30,
            apiDurationMs: 400,
          }),
        ],
      ]),
    );

    const result = await loadStatsData('today');

    // 330, not the record's 1550 and not 1880.
    expect(reportTokens(result.report)).toBe(330);
    expect(result.report.totalRequests).toBe(2);
    expect(result.report.totalLatencyMs).toBe(400);
    expect(result.efficiency.avgLatencyMs).toBe(200);
    // Session-granular fields the ledger cannot supply stay on the records.
    expect(result.report.sessionCount).toBe(1);
    expect(result.report.tools.totalCalls).toBe(5);
    expect(result.report.files.linesAdded).toBe(20);
    expect(result.report.projects[0]!.totalTokens).toBe(1550);
  });

  it('attributes tokens to the day each response happened', async () => {
    const now = Date.now();
    const yesterday = now - DAY;
    mockedLoadUsageHistory.mockResolvedValue([makeRecord({ timestamp: now })]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(
      new Map([
        [dayKey(yesterday), ledgerDay({ requests: 4, inputTokens: 1000 })],
        [dayKey(now), ledgerDay({ requests: 2, inputTokens: 330 })],
      ]),
    );

    const today = await loadStatsData('today');
    expect(reportTokens(today.report)).toBe(330);

    const week = await loadStatsData('week');
    expect(reportTokens(week.report)).toBe(1330);
    expect(week.heatmap[dayKey(yesterday)]).toBe(1000);
    expect(week.heatmap[dayKey(now)]).toBe(330);
    expect(
      week.tokensPerDay.find((p) => p.date === dayKey(yesterday))?.tokens,
    ).toBe(1000);
  });

  it('compares the delta against a ledger-backed previous window', async () => {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const todayTs = Math.max(todayStart, now.getTime() - 1000);
    const yesterdayTs = todayStart - 12 * 60 * 60 * 1000;
    mockedLoadUsageHistory.mockResolvedValue([
      makeRecord({ sessionId: 't', timestamp: todayTs }),
      makeRecord({ sessionId: 'y', timestamp: yesterdayTs }),
    ]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(
      new Map([
        [dayKey(yesterdayTs), ledgerDay({ requests: 4, inputTokens: 1000 })],
        [dayKey(todayTs), ledgerDay({ requests: 2, inputTokens: 330 })],
      ]),
    );

    const result = await loadStatsData('today');

    // (330 - 1000) / 1000, not against the records' 1550 for yesterday.
    expect(result.delta?.tokens).toBeCloseTo(-67);
  });

  it('keeps record tokens for days the ledger does not cover', async () => {
    const now = Date.now();
    const old = now - 40 * DAY;
    mockedLoadUsageHistory.mockResolvedValue([
      makeRecord({ sessionId: 'old', timestamp: old }),
    ]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(
      new Map([[dayKey(now), ledgerDay({ requests: 1, inputTokens: 70 })]]),
    );

    const result = await loadStatsData('all');

    // The uncovered day keeps its record-derived tokens in the heatmap.
    expect(result.heatmap[dayKey(old)]).toBe(1550);
    expect(result.heatmap[dayKey(now)]).toBe(70);
    expect(reportTokens(result.report)).toBe(1620);
  });

  it('streams the ledger once across repeated opens of the same window', async () => {
    mockedLoadUsageHistory.mockResolvedValue([
      makeRecord({ timestamp: Date.now() }),
    ]);

    await loadStatsData('all');
    await loadStatsData('all');

    expect(vi.mocked(loadLedgerOrEmpty)).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous window disjoint from the current one', async () => {
    const now = Date.now();
    const startDay = now - 7 * DAY;
    const dayBefore = startDay - DAY;
    mockedLoadUsageHistory.mockResolvedValue([makeRecord({ timestamp: now })]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(
      new Map([
        [dayKey(startDay), ledgerDay({ requests: 4, inputTokens: 1000 })],
        [dayKey(dayBefore), ledgerDay({ requests: 2, inputTokens: 500 })],
        [dayKey(now), ledgerDay({ requests: 2, inputTokens: 330 })],
      ]),
    );

    const result = await loadStatsData('week');

    // Current is 1330 (the day before the window start is outside it);
    // previous is 500. If the previous window also held the current start day
    // it would be 1500 and the delta would read about -11%.
    expect(reportTokens(result.report)).toBe(1330);
    expect(result.delta?.tokens).toBeCloseTo(166);
  });

  it('builds the delta when only the ledger covers the previous window', async () => {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const todayTs = Math.max(todayStart, now.getTime() - 1000);
    const yesterdayTs = todayStart - 12 * 60 * 60 * 1000;
    // A run killed before exit writes no record, so the previous window exists
    // only in the ledger.
    mockedLoadUsageHistory.mockResolvedValue([
      makeRecord({ sessionId: 't', timestamp: todayTs }),
    ]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(
      new Map([
        [dayKey(yesterdayTs), ledgerDay({ requests: 4, inputTokens: 1000 })],
        [dayKey(todayTs), ledgerDay({ requests: 2, inputTokens: 330 })],
      ]),
    );

    const result = await loadStatsData('today');

    expect(result.delta).not.toBeNull();
    expect(result.delta?.tokens).toBeCloseTo(-67);
  });
});

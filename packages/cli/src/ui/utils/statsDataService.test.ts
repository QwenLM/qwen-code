/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  UsageSummaryRecord,
  AggregatedReport,
  TokenUsageDailyByModel,
} from '@qwen-code/qwen-code-core';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    loadUsageHistory: vi.fn(),
    dedupBySessionId: vi.fn(actual.dedupBySessionId),
    // Default: no ledger coverage, so records drive every field. Without this
    // the real loader would read the developer's own ~/.qwen/usage.
    loadLedgerOrEmpty: vi.fn(async () => new Map()),
  };
});

import {
  dedupBySessionId,
  loadUsageHistory,
  loadLedgerOrEmpty,
} from '@qwen-code/qwen-code-core';
import {
  loadStatsData,
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

  it('does not compare a partial today with a completed yesterday', async () => {
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

    expect(result.delta).toBeNull();
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

  it('keeps only this run in a live current record and disjoint prior runs', async () => {
    const now = Date.now();
    const old = now - DAY;
    const prior = makeRecord({
      sessionId: 'session-same',
      timestamp: old,
      startTime: old - 60_000,
      durationMs: 60_000,
      runScoped: true,
      models: {
        'qwen-max': {
          requests: 1,
          inputTokens: 100_000,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 100_000,
        },
      },
      skills: {
        totalCalls: 3,
        totalSuccess: 3,
        totalFail: 0,
        byName: { review: { count: 3, success: 3, fail: 0 } },
      },
    });
    mockedLoadUsageHistory.mockResolvedValue([prior]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(new Map());
    const current = makeRecord({
      sessionId: 'session-same',
      timestamp: now,
      startTime: now - 1000,
      durationMs: 0,
      totalLatencyMs: 0,
      runScoped: true,
      models: {
        'qwen-max': {
          requests: 1,
          inputTokens: 1,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 1,
        },
      },
      tools: { totalCalls: 1, totalSuccess: 1, totalFail: 0, byName: {} },
      files: { linesAdded: 0, linesRemoved: 0 },
    });

    const today = await loadStatsData('today', current);
    expect(reportTokens(today.report)).toBe(1);
    expect(today.report.sessionCount).toBe(1);
    expect(today.report.skills.totalCalls).toBe(0);

    const week = await loadStatsData('week', current);
    expect(reportTokens(week.report)).toBe(100_001);
    expect(week.report.sessionCount).toBe(2);
    expect(week.report.skills.totalCalls).toBe(3);
    expect(week.heatmap[dayKey(old)]).toBe(100_000);
    expect(week.heatmap[dayKey(now)]).toBe(1);
  });

  it('merges only the current session group', async () => {
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(new Map());
    const now = Date.now();
    const old = makeRecord({
      sessionId: 'current',
      timestamp: now - DAY,
      runScoped: true,
      models: {
        'qwen-max': {
          requests: 1,
          inputTokens: 100,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 100,
        },
      },
    });
    const otherSessions = Array.from({ length: 20 }, (_, index) =>
      makeRecord({ sessionId: `other-${index}`, timestamp: now - DAY }),
    );
    mockedLoadUsageHistory.mockResolvedValue([old, ...otherSessions]);
    const live = makeRecord({
      sessionId: 'current',
      timestamp: now,
      runScoped: true,
      models: {
        'qwen-max': {
          requests: 1,
          inputTokens: 7,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          totalTokens: 7,
        },
      },
    });

    const result = await loadStatsData('all', live);

    expect(vi.mocked(dedupBySessionId).mock.calls).toHaveLength(1);
    expect(vi.mocked(dedupBySessionId).mock.calls[0]![0]).toHaveLength(2);
    expect(reportTokens(result.report)).toBe(31_107);
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
    const ledger: TokenUsageDailyByModel = new Map();
    for (let i = 0; i <= 14; i++) {
      const day = new Date();
      day.setDate(day.getDate() - i);
      ledger.set(
        dayKey(day.getTime()),
        ledgerDay({ requests: 2, inputTokens: 100 }),
      );
    }
    vi.mocked(loadLedgerOrEmpty).mockImplementation(
      async (since) => new Map([...ledger].filter(([day]) => day >= since)),
    );

    const result = await loadStatsData('week');

    // Both completed seven-day windows contain equal token totals;
    // today's partial amount belongs to the display, not the delta.
    expect(result.delta?.tokens).toBeCloseTo(0);
    expect(vi.mocked(loadLedgerOrEmpty)).toHaveBeenCalledWith(
      dayKey(new Date().setDate(new Date().getDate() - 14)),
      expect.any(Map),
    );
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

  it('coalesces concurrent reads but reloads on the next open', async () => {
    mockedLoadUsageHistory.mockResolvedValue([
      makeRecord({ timestamp: Date.now() }),
    ]);
    let release!: (table: TokenUsageDailyByModel) => void;
    const pending = new Promise<TokenUsageDailyByModel>((resolve) => {
      release = resolve;
    });
    vi.mocked(loadLedgerOrEmpty).mockReturnValue(pending);

    const first = loadStatsData('all');
    const second = loadStatsData('all');
    await vi.waitFor(() => {
      expect(vi.mocked(loadLedgerOrEmpty)).toHaveBeenCalledTimes(1);
    });
    release(new Map());
    await Promise.all([first, second]);

    await loadStatsData('all');
    expect(vi.mocked(loadLedgerOrEmpty)).toHaveBeenCalledTimes(2);
  });

  it('sees tokens added between opens without waiting for a TTL', async () => {
    const now = Date.now();
    const recordWithTokens = (tokens: number) =>
      makeRecord({
        timestamp: now,
        startTime: now - 1000,
        models: {
          'qwen-max': {
            requests: 1,
            inputTokens: tokens,
            outputTokens: 0,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: tokens,
          },
        },
      });
    mockedLoadUsageHistory.mockResolvedValue([]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValueOnce(
      new Map([[dayKey(now), ledgerDay({ requests: 1, inputTokens: 100 })]]),
    );
    expect(
      reportTokens(
        (await loadStatsData('today', recordWithTokens(100))).report,
      ),
    ).toBe(100);

    vi.mocked(loadLedgerOrEmpty).mockResolvedValueOnce(
      new Map([[dayKey(now), ledgerDay({ requests: 4, inputTokens: 400 })]]),
    );
    expect(
      reportTokens(
        (await loadStatsData('today', recordWithTokens(300))).report,
      ),
    ).toBe(400);
  });

  it.each([
    { range: 'week' as const, days: 20 },
    { range: 'month' as const, days: 70 },
  ])('compares equal-length windows for $range', async ({ range, days }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 20, 12, 0, 0));
    try {
      const daily: TokenUsageDailyByModel = new Map();
      for (let i = 0; i < days; i++) {
        const day = new Date();
        day.setDate(day.getDate() - i);
        daily.set(
          dayKey(day.getTime()),
          ledgerDay({ requests: 1, inputTokens: 100 }),
        );
      }
      mockedLoadUsageHistory.mockResolvedValue([]);
      vi.mocked(loadLedgerOrEmpty).mockImplementation(
        async (since) => new Map([...daily].filter(([day]) => day >= since)),
      );

      const result = await loadStatsData(range);

      expect(result.delta?.tokens).toBeCloseTo(0);
      const previousStart = new Date();
      previousStart.setDate(
        previousStart.getDate() - (range === 'week' ? 14 : 60),
      );
      expect(vi.mocked(loadLedgerOrEmpty)).toHaveBeenCalledWith(
        dayKey(previousStart.getTime()),
        expect.any(Map),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('excludes an unfinished day from both sides of the delta', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 20, 0, 30, 0));
    try {
      const daily: TokenUsageDailyByModel = new Map();
      for (let i = 0; i < 30; i++) {
        const day = new Date();
        day.setDate(day.getDate() - i);
        daily.set(
          dayKey(day.getTime()),
          ledgerDay({ requests: 1, inputTokens: 100 }),
        );
      }
      // A large partial day must not contaminate a stable completed-day delta.
      daily.set(
        dayKey(Date.now()),
        ledgerDay({ requests: 13, inputTokens: 10_000 }),
      );
      mockedLoadUsageHistory.mockResolvedValue([]);
      vi.mocked(loadLedgerOrEmpty).mockResolvedValue(daily);

      const result = await loadStatsData('week');

      expect(result.delta?.tokens).toBeCloseTo(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [2026, 2, 12, 0, 30],
    [2026, 10, 5, 23, 30],
  ] as const)(
    'keeps flat daily usage neutral across DST at %s-%s-%sT%s:%s',
    async (year, month, day, hour, minute) => {
      const originalTimezone = process.env['TZ'];
      process.env['TZ'] = 'America/New_York';
      vi.useFakeTimers();
      vi.setSystemTime(new Date(year, month, day, hour, minute));
      try {
        const daily: TokenUsageDailyByModel = new Map();
        for (let i = 0; i < 90; i++) {
          const date = new Date();
          date.setDate(date.getDate() - i);
          daily.set(
            dayKey(date.getTime()),
            ledgerDay({ requests: 1, inputTokens: 100 }),
          );
        }
        mockedLoadUsageHistory.mockResolvedValue([]);
        vi.mocked(loadLedgerOrEmpty).mockResolvedValue(daily);

        const result = await loadStatsData('week');

        expect(result.delta?.tokens).toBeCloseTo(0);
      } finally {
        vi.useRealTimers();
        if (originalTimezone === undefined) delete process.env['TZ'];
        else process.env['TZ'] = originalTimezone;
      }
    },
  );

  it('counts every session-granular field on the whole boundary day', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 20, 12, 0, 0));
    try {
      const boundary = new Date();
      boundary.setDate(boundary.getDate() - 7);
      boundary.setHours(0, 30, 0, 0);
      const record = makeRecord({
        timestamp: boundary.getTime(),
        startTime: boundary.getTime() - 60_000,
        durationMs: 60_000,
      });
      mockedLoadUsageHistory.mockResolvedValue([record]);
      vi.mocked(loadLedgerOrEmpty).mockResolvedValue(
        new Map([
          [
            dayKey(boundary.getTime()),
            ledgerDay({ requests: 1, inputTokens: 17_000_000 }),
          ],
        ]),
      );

      const result = await loadStatsData('week');

      expect(reportTokens(result.report)).toBe(17_000_000);
      expect(result.report.sessionCount).toBe(1);
      expect(result.report.totalDurationMs).toBe(60_000);
      expect(result.report.tools.totalCalls).toBe(5);
      expect(result.report.files.linesAdded).toBe(20);
    } finally {
      vi.useRealTimers();
    }
  });

  it('compares sessions and duration only over completed local days', async () => {
    const now = Date.now();
    mockedLoadUsageHistory.mockResolvedValue([
      makeRecord({
        sessionId: 'previous',
        timestamp: now - 14 * DAY,
        durationMs: 30_000,
      }),
      makeRecord({
        sessionId: 'completed',
        timestamp: now - DAY,
        durationMs: 60_000,
      }),
      makeRecord({
        sessionId: 'unfinished',
        timestamp: now,
        durationMs: 42_000,
      }),
    ]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(new Map());

    const result = await loadStatsData('week');

    expect(result.delta?.sessions).toBeCloseTo(0);
    expect(result.delta?.duration).toBeCloseTo(100);
    // Whole-week tiles include today's unfinished session, but the delta does not.
    expect(result.report.sessionCount).toBe(2);
    expect(result.report.totalDurationMs).toBe(102_000);
  });

  it('uses one record basis when a completed side lacks ledger coverage', async () => {
    const now = Date.now();
    mockedLoadUsageHistory.mockResolvedValue([
      makeRecord({
        sessionId: 'previous',
        timestamp: now - 14 * DAY,
        durationMs: 30_000,
        models: {
          'qwen-max': {
            requests: 1,
            inputTokens: 500,
            outputTokens: 0,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 500,
          },
        },
      }),
      makeRecord({ sessionId: 'today', timestamp: now }),
    ]);
    const currentDays: TokenUsageDailyByModel = new Map();
    for (let i = 0; i < 8; i++) {
      const day = new Date();
      day.setDate(day.getDate() - i);
      currentDays.set(
        dayKey(day.getTime()),
        ledgerDay({ requests: 1, inputTokens: 100 }),
      );
    }
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(currentDays);

    const result = await loadStatsData('week');

    // The ledger has 700 current tokens, but the records-only prior sum is
    // zero and its token total is 500. An unfair ledger-vs-record delta
    // would report growth instead of this same-basis -100%.
    expect(result.delta?.tokens).toBeCloseTo(-100);
    expect(result.delta?.sessions).toBeCloseTo(-100);
    expect(result.delta?.duration).toBeCloseTo(-100);
  });

  it('uses records on both delta sides when current coverage is incomplete', async () => {
    const now = Date.now();
    mockedLoadUsageHistory.mockResolvedValue([
      makeRecord({
        sessionId: 'previous',
        timestamp: now - 14 * DAY,
        durationMs: 30_000,
        models: {
          'qwen-max': {
            requests: 1,
            inputTokens: 500,
            outputTokens: 0,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 500,
          },
        },
      }),
      makeRecord({
        sessionId: 'yesterday',
        timestamp: now - DAY,
        durationMs: 30_000,
        models: {
          'qwen-max': {
            requests: 1,
            inputTokens: 300,
            outputTokens: 0,
            cachedTokens: 0,
            thoughtsTokens: 0,
            totalTokens: 300,
          },
        },
      }),
      makeRecord({ sessionId: 'today', timestamp: now }),
    ]);
    const ledger: TokenUsageDailyByModel = new Map();
    for (let i = 8; i <= 14; i++) {
      const day = new Date();
      day.setDate(day.getDate() - i);
      ledger.set(
        dayKey(day.getTime()),
        ledgerDay({ requests: 1, inputTokens: 500 }),
      );
    }
    const yesterday = new Date(now - DAY);
    ledger.set(
      dayKey(yesterday.getTime()),
      ledgerDay({ requests: 1, inputTokens: 1000 }),
    );
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(ledger);

    const result = await loadStatsData('week');

    // The current model-bearing record makes sparse coverage insufficient,
    // even though the previous ledger is complete. Compare 300 with 500 on
    // the record basis, not 1000 with 3500 on a mixed token basis.
    expect(result.delta?.tokens).toBeCloseTo(-40);
    expect(result.delta?.sessions).toBeCloseTo(0);
    expect(result.delta?.duration).toBeCloseTo(0);
  });

  it('computes a delta across sparse ledger-only completed windows', async () => {
    mockedLoadUsageHistory.mockResolvedValue([]);
    const now = Date.now();
    const ledger: TokenUsageDailyByModel = new Map([
      [dayKey(now - 2 * DAY), ledgerDay({ requests: 1, inputTokens: 200 })],
      [dayKey(now - 10 * DAY), ledgerDay({ requests: 1, inputTokens: 100 })],
    ]);
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(ledger);

    const result = await loadStatsData('week');

    expect(result.delta?.tokens).toBeCloseTo(100);
    expect(reportTokens(result.report)).toBe(200);
  });

  it('keeps skill activity without creating a token streak', async () => {
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(new Map());
    mockedLoadUsageHistory.mockResolvedValue([]);
    const current = makeRecord({
      sessionId: 'skills-only',
      timestamp: Date.now(),
      runScoped: true,
      models: {},
      skills: {
        totalCalls: 1,
        totalSuccess: 1,
        totalFail: 0,
        byName: { review: { count: 1, success: 1, fail: 0 } },
      },
    });

    const result = await loadStatsData('today', current);

    expect(result.report.skills?.totalCalls).toBe(1);
    expect(result.currentStreak).toBe(0);
    expect(result.longestStreak).toBe(0);
  });

  it('keeps the previous window disjoint from the current one', async () => {
    const now = Date.now();
    mockedLoadUsageHistory.mockResolvedValue([makeRecord({ timestamp: now })]);
    const ledger: TokenUsageDailyByModel = new Map();
    for (let i = 0; i < 8; i++) {
      const day = new Date();
      day.setDate(day.getDate() - i);
      ledger.set(
        dayKey(day.getTime()),
        ledgerDay({
          requests: i === 0 ? 2 : 4,
          inputTokens: i === 0 ? 330 : 1000,
        }),
      );
    }
    for (let i = 8; i <= 14; i++) {
      const day = new Date();
      day.setDate(day.getDate() - i);
      ledger.set(
        dayKey(day.getTime()),
        ledgerDay({ requests: 2, inputTokens: 500 }),
      );
    }
    vi.mocked(loadLedgerOrEmpty).mockResolvedValue(ledger);

    const result = await loadStatsData('week');

    // Displayed current tokens stay 7330 for seven completed days plus today.
    // The delta compares 7000 completed tokens against 3500 previously,
    // never including today's partial 330.
    expect(reportTokens(result.report)).toBe(7330);
    expect(result.delta?.tokens).toBeCloseTo(100);
  });

  it('builds the delta when only the ledger covers the previous window', async () => {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    ).getTime();
    const todayTs = Math.max(todayStart, now.getTime() - 1000);
    // A run killed before exit writes no record, so the previous window exists
    // only in the ledger.
    mockedLoadUsageHistory.mockResolvedValue([
      makeRecord({ sessionId: 't', timestamp: todayTs }),
    ]);
    const ledger: TokenUsageDailyByModel = new Map();
    for (let i = 0; i <= 14; i++) {
      const day = new Date();
      day.setDate(day.getDate() - i);
      ledger.set(
        dayKey(day.getTime()),
        ledgerDay({ requests: 2, inputTokens: 100 }),
      );
    }
    vi.mocked(loadLedgerOrEmpty).mockImplementation(
      async (since) => new Map([...ledger].filter(([day]) => day >= since)),
    );

    const result = await loadStatsData('week');

    expect(result.delta).not.toBeNull();
    expect(result.delta?.tokens).toBeCloseTo(0);
  });
});

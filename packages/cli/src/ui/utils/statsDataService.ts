/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  loadUsageHistory,
  aggregateUsage,
  getTimeRangeBounds,
  type AggregatedReport,
  type TimeRange,
  type UsageSummaryRecord,
} from '@qwen-code/qwen-code-core';

export interface StatsData {
  report: AggregatedReport;
  heatmap: Record<string, number>;
  currentStreak: number;
  longestStreak: number;
  tokensPerDay: Array<{ date: string; model: string; tokens: number }>;
  delta: {
    sessions: number | null;
    duration: number | null;
    tokens: number | null;
    cacheRate: number | null;
    toolSuccess: number | null;
    avgLatency: number | null;
  } | null;
  efficiency: {
    cacheHitRate: number;
    toolSuccessRate: number;
    avgLatencyMs: number | null;
  };
  toolLeaderboard: Array<{
    name: string;
    count: number;
    totalDurationMs: number;
    successRate: number;
  }>;
}

function calculateStreaks(dates: string[]): {
  currentStreak: number;
  longestStreak: number;
} {
  if (dates.length === 0) return { currentStreak: 0, longestStreak: 0 };

  const parsed = dates
    .map((d) => {
      const dt = new Date(d + 'T00:00:00');
      dt.setHours(0, 0, 0, 0);
      return dt;
    })
    .sort((a, b) => a.getTime() - b.getTime());

  let currentStreak = 1;
  let longestStreak = 1;

  for (let i = 1; i < parsed.length; i++) {
    const diff = Math.round(
      (parsed[i]!.getTime() - parsed[i - 1]!.getTime()) / (1000 * 60 * 60 * 24),
    );
    if (diff === 1) {
      currentStreak++;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    } else if (diff > 1) {
      currentStreak = 1;
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const lastDate = parsed[parsed.length - 1]!;
  const daysSinceLast = Math.round(
    (today.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24),
  );
  if (daysSinceLast > 1) currentStreak = 0;

  return { currentStreak, longestStreak };
}

function buildHeatmap(
  records: UsageSummaryRecord[],
  start: Date,
  end: Date,
): Record<string, number> {
  const heatmap: Record<string, number> = {};
  for (const r of records) {
    if (r.timestamp < start.getTime() || r.timestamp > end.getTime()) continue;
    if (!r.models) continue;
    const ts = new Date(r.timestamp);
    const key = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`;
    let totalTokens = 0;
    for (const m of Object.values(r.models)) {
      totalTokens +=
        m.totalTokens || m.inputTokens + m.outputTokens + m.thoughtsTokens;
    }
    heatmap[key] = (heatmap[key] || 0) + totalTokens;
  }
  return heatmap;
}

function buildTokensPerDay(
  records: UsageSummaryRecord[],
  start: Date,
  end: Date,
): Array<{ date: string; model: string; tokens: number }> {
  const dayModel = new Map<string, number>();
  for (const r of records) {
    const ts = new Date(r.timestamp);
    if (r.timestamp < start.getTime() || r.timestamp > end.getTime()) continue;
    if (!r.models) continue;
    const dateKey = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, '0')}-${String(ts.getDate()).padStart(2, '0')}`;
    for (const [model, m] of Object.entries(r.models)) {
      const key = `${dateKey}|${model}`;
      const tokens =
        m.totalTokens || m.inputTokens + m.outputTokens + m.thoughtsTokens;
      dayModel.set(key, (dayModel.get(key) || 0) + tokens);
    }
  }
  const result: Array<{ date: string; model: string; tokens: number }> = [];
  for (const [key, tokens] of dayModel) {
    const [date, model] = key.split('|') as [string, string];
    result.push({ date, model, tokens });
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

export function getPreviousRangeBounds(
  range: TimeRange,
): { start: Date; end: Date } | null {
  if (range === 'all') return null;

  const now = new Date();
  switch (range) {
    case 'today': {
      const todayStart = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate(),
      );
      const yesterdayStart = new Date(todayStart);
      yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      return { start: yesterdayStart, end: todayStart };
    }
    case 'week': {
      const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      const fourteenDaysAgo = new Date(
        now.getTime() - 14 * 24 * 60 * 60 * 1000,
      );
      return { start: fourteenDaysAgo, end: sevenDaysAgo };
    }
    case 'month': {
      const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
      return { start: sixtyDaysAgo, end: thirtyDaysAgo };
    }
    default:
      return null;
  }
}

export function computeDelta(
  current: AggregatedReport,
  previous: AggregatedReport,
): {
  sessions: number | null;
  duration: number | null;
  tokens: number | null;
  cacheRate: number | null;
  toolSuccess: number | null;
  avgLatency: number | null;
} {
  const pctChange = (cur: number, prev: number): number | null => {
    if (prev === 0) return null;
    return ((cur - prev) / prev) * 100;
  };

  let currentTotalTokens = 0;
  let currentInputTokens = 0;
  let currentCachedTokens = 0;
  for (const m of Object.values(current.models)) {
    currentTotalTokens += m.totalTokens;
    currentInputTokens += m.inputTokens;
    currentCachedTokens += m.cachedTokens;
  }

  let previousTotalTokens = 0;
  let previousInputTokens = 0;
  let previousCachedTokens = 0;
  for (const m of Object.values(previous.models)) {
    previousTotalTokens += m.totalTokens;
    previousInputTokens += m.inputTokens;
    previousCachedTokens += m.cachedTokens;
  }

  const currentCacheRate =
    currentInputTokens > 0
      ? (currentCachedTokens / currentInputTokens) * 100
      : null;
  const previousCacheRate =
    previousInputTokens > 0
      ? (previousCachedTokens / previousInputTokens) * 100
      : null;
  const cacheRateDelta =
    currentCacheRate !== null && previousCacheRate !== null
      ? currentCacheRate - previousCacheRate
      : null;

  const currentToolSuccess =
    current.tools.totalCalls > 0
      ? (current.tools.totalSuccess / current.tools.totalCalls) * 100
      : null;
  const previousToolSuccess =
    previous.tools.totalCalls > 0
      ? (previous.tools.totalSuccess / previous.tools.totalCalls) * 100
      : null;
  const toolSuccessDelta =
    currentToolSuccess !== null && previousToolSuccess !== null
      ? currentToolSuccess - previousToolSuccess
      : null;

  const currentAvgLatency =
    current.totalRequests > 0
      ? current.totalLatencyMs / current.totalRequests
      : null;
  const previousAvgLatency =
    previous.totalRequests > 0
      ? previous.totalLatencyMs / previous.totalRequests
      : null;
  const avgLatencyDelta =
    currentAvgLatency !== null && previousAvgLatency !== null
      ? currentAvgLatency - previousAvgLatency
      : null;

  return {
    sessions: pctChange(current.sessionCount, previous.sessionCount),
    duration: pctChange(current.totalDurationMs, previous.totalDurationMs),
    tokens: pctChange(currentTotalTokens, previousTotalTokens),
    cacheRate: cacheRateDelta,
    toolSuccess: toolSuccessDelta,
    avgLatency: avgLatencyDelta,
  };
}

export async function loadStatsData(
  range: TimeRange,
  currentSession?: UsageSummaryRecord,
): Promise<StatsData> {
  const persisted = await loadUsageHistory();
  let records = persisted;
  if (currentSession) {
    records = persisted.filter((r) => r.sessionId !== currentSession.sessionId);
    records.push(currentSession);
  }
  const report = aggregateUsage(records, range);
  const { start, end } = getTimeRangeBounds(range);

  const heatmap = buildHeatmap(records, start, end);
  const heatmapDates = Object.keys(heatmap);
  const { currentStreak, longestStreak } = calculateStreaks(heatmapDates);

  const tokensPerDay = buildTokensPerDay(records, start, end);

  let delta: StatsData['delta'] = null;
  const prevBounds = getPreviousRangeBounds(range);
  if (prevBounds) {
    const prevFiltered = records.filter(
      (r) =>
        r.timestamp >= prevBounds.start.getTime() &&
        r.timestamp < prevBounds.end.getTime(),
    );
    if (prevFiltered.length > 0) {
      const previousReport = aggregateUsage(prevFiltered, 'all');
      delta = computeDelta(report, previousReport);
    }
  }

  let totalInputTokens = 0;
  let totalCachedTokens = 0;
  for (const m of Object.values(report.models)) {
    totalInputTokens += m.inputTokens;
    totalCachedTokens += m.cachedTokens;
  }
  const cacheHitRate =
    totalInputTokens > 0 ? (totalCachedTokens / totalInputTokens) * 100 : 0;
  const toolSuccessRate =
    report.tools.totalCalls > 0
      ? (report.tools.totalSuccess / report.tools.totalCalls) * 100
      : 0;
  const avgLatencyMs =
    report.totalRequests > 0
      ? report.totalLatencyMs / report.totalRequests
      : null;

  const efficiency: StatsData['efficiency'] = {
    cacheHitRate,
    toolSuccessRate,
    avgLatencyMs,
  };

  const toolLeaderboard: StatsData['toolLeaderboard'] = report.tools.topTools
    .slice(0, 8)
    .map((t) => ({
      name: t.name,
      count: t.count,
      totalDurationMs: t.totalDurationMs,
      successRate: t.count > 0 ? (t.success / t.count) * 100 : 0,
    }));

  return {
    report,
    heatmap,
    currentStreak,
    longestStreak,
    tokensPerDay,
    delta,
    efficiency,
    toolLeaderboard,
  };
}

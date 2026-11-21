/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  loadUsageHistory,
  aggregateUsage,
  getTimeRangeBounds,
  buildUsageDayTable,
  filterUsageRecordsByLocalDay,
  sumUsageWindowByModel,
  loadLedgerOrEmpty,
  localDateKey,
  modelTokens,
  type AggregatedReport,
  type TimeRange,
  type TokenUsageDailyByModel,
  type UsageDayModelTable,
  type UsageSummaryRecord,
} from '@qwen-code/qwen-code-core';

/** Concurrent opens share reads; settled data is never reused across opens. */
const pendingLedgerLoads = new Map<string, Promise<TokenUsageDailyByModel>>();

/** Test-only: forget pending reads between cases. */
export function _resetStatsLedgerCacheForTest(): void {
  pendingLedgerLoads.clear();
}

function loadLedgerShared(
  sinceLocalDate: string,
): Promise<TokenUsageDailyByModel> {
  const pending = pendingLedgerLoads.get(sinceLocalDate);
  if (pending) return pending;
  const promise = loadLedgerOrEmpty(sinceLocalDate).finally(() => {
    if (pendingLedgerLoads.get(sinceLocalDate) === promise) {
      pendingLedgerLoads.delete(sinceLocalDate);
    }
  });
  pendingLedgerLoads.set(sinceLocalDate, promise);
  return promise;
}

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
  table: UsageDayModelTable,
  startKey: string,
  endKey: string,
): Record<string, number> {
  const heatmap: Record<string, number> = {};
  for (const [day, byModel] of table) {
    if (day < startKey || day > endKey) continue;
    let tokens = 0;
    for (const m of byModel.values()) tokens += modelTokens(m);
    heatmap[day] = tokens;
  }
  return heatmap;
}

function buildTokensPerDay(
  table: UsageDayModelTable,
  startKey: string,
  endKey: string,
): Array<{ date: string; model: string; tokens: number }> {
  const result: Array<{ date: string; model: string; tokens: number }> = [];
  for (const [day, byModel] of table) {
    if (day < startKey || day > endKey) continue;
    for (const [model, m] of byModel) {
      result.push({ date: day, model, tokens: modelTokens(m) });
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Replaces the report's token-bearing fields with the shared accounting table's
 * window slice. Session-granular fields (sessions, duration, tools, files,
 * skills, projects) stay on the session records: the per-request ledger carries
 * none of them, and it has no project dimension to attribute tokens to.
 */
function applyTokenWindow(
  report: AggregatedReport,
  table: UsageDayModelTable,
  startKey: string,
  endKey: string,
): void {
  const models = sumUsageWindowByModel(table, startKey, endKey);
  const next: AggregatedReport['models'] = {};
  let requests = 0;
  let latency = 0;
  for (const [model, m] of models) {
    requests += m.requests;
    latency += m.apiDurationMs;
    next[model] = {
      requests: m.requests,
      inputTokens: m.inputTokens,
      outputTokens: m.outputTokens,
      cachedTokens: m.cachedTokens,
      thoughtsTokens: m.thoughtsTokens,
      totalTokens: m.totalTokens,
      totalLatencyMs: m.apiDurationMs,
    };
  }
  report.models = next;
  report.totalRequests = requests;
  report.totalLatencyMs = latency;
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
  const persisted = await loadUsageHistory(currentSession?.sessionId);
  let records = persisted;
  if (currentSession) {
    records = persisted.filter((r) => r.sessionId !== currentSession.sessionId);
    records.push(currentSession);
  }
  const { start, end } = getTimeRangeBounds(range);
  const currentStartKey = localDateKey(start.getTime());
  const currentEndKey = localDateKey(end.getTime());
  const prevBounds = getPreviousRangeBounds(range);
  let prevStartKey: string | undefined;
  let prevEndKey: string | undefined;
  if (prevBounds) {
    const prevStart = new Date(prevBounds.start);
    const prevEnd = new Date(prevBounds.end.getTime() - 1);
    prevStartKey = localDateKey(prevStart.getTime());
    prevEndKey = localDateKey(prevEnd.getTime());
    if (prevEndKey === currentStartKey) {
      // Keep both sides disjoint and the same length. Move the start too;
      // shortening only the end made week compare 8 days against 7.
      prevStart.setDate(prevStart.getDate() - 1);
      prevEnd.setDate(prevEnd.getDate() - 1);
      prevStartKey = localDateKey(prevStart.getTime());
      prevEndKey = localDateKey(prevEnd.getTime());
    }
  }

  // One accounting table for this surface and the daemon usage dashboard. The
  // ledger window has to reach back far enough for the previous range too, or
  // the delta would compare a ledger-backed current against a record-backed past.
  const earliestKey =
    prevStartKey && prevStartKey < currentStartKey
      ? prevStartKey
      : currentStartKey;
  const ledgerDaily = await loadLedgerShared(earliestKey);
  const table = buildUsageDayTable(records, ledgerDaily);
  const report = aggregateUsage(
    filterUsageRecordsByLocalDay(records, currentStartKey, currentEndKey),
    'all',
  );

  applyTokenWindow(report, table, currentStartKey, currentEndKey);

  const heatmap = buildHeatmap(table, currentStartKey, currentEndKey);
  const heatmapDates = Object.keys(heatmap);
  const { currentStreak, longestStreak } = calculateStreaks(heatmapDates);

  const tokensPerDay = buildTokensPerDay(table, currentStartKey, currentEndKey);

  let delta: StatsData['delta'] = null;
  if (prevStartKey && prevEndKey) {
    const prevFiltered = filterUsageRecordsByLocalDay(
      records,
      prevStartKey,
      prevEndKey,
    );
    // A run killed before exit writes no record, so the ledger alone can cover
    // the previous window. Gate on either source, not on records only.
    const ledgerCoversPrev = [...ledgerDaily.keys()].some(
      (day) => day >= prevStartKey && day <= prevEndKey,
    );
    if (prevFiltered.length > 0 || ledgerCoversPrev) {
      const previousReport = aggregateUsage(prevFiltered, 'all');
      applyTokenWindow(previousReport, table, prevStartKey, prevEndKey);
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

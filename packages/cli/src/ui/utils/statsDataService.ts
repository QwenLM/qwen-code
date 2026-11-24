/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  loadUsageHistory,
  aggregateUsage,
  dedupBySessionId,
  getTranscriptScope,
  getTimeRangeBounds,
  buildUsageDayTable,
  filterUsageRecordsByLocalDay,
  sumUsageWindowByModel,
  loadLedgerOrEmpty,
  localDateKey,
  modelTokens,
  type AggregatedReport,
  type TimeRange,
  type TokenUsageCompletedMonthCache,
  type TokenUsageDailyByModel,
  type UsageDayModelTable,
  type UsageSummaryRecord,
} from '@qwen-code/qwen-code-core';
import {
  recordTouchesLedgerDays,
  setLedgerTranscriptScope,
} from '@qwen-code/qwen-code-core/services/usage-dashboard-service.js';
import { projectKeysFromRecords } from '@qwen-code/qwen-code-core/services/usageHistoryService.js';

/** Pending opens coalesce; only immutable completed months are retained. */
const pendingLedgerLoads = new Map<string, Promise<TokenUsageDailyByModel>>();
const completedMonthCache: TokenUsageCompletedMonthCache = new Map();

/** Test-only: forget pending reads and completed-month aggregates. */
export function _resetStatsLedgerCacheForTest(): void {
  pendingLedgerLoads.clear();
  completedMonthCache.clear();
}

function loadLedgerShared(
  sinceLocalDate: string,
): Promise<TokenUsageDailyByModel> {
  const pending = pendingLedgerLoads.get(sinceLocalDate);
  if (pending) return pending;
  const promise = loadLedgerOrEmpty(
    sinceLocalDate,
    completedMonthCache,
  ).finally(() => {
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
  // Provider model names are arbitrary keys, including "__proto__".
  const next = Object.create(null) as AggregatedReport['models'];
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

function addLocalDays(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  date.setDate(date.getDate() + days);
  return localDateKey(date.getTime());
}

function countLocalDays(startKey: string, endKey: string): number {
  let count = 0;
  for (let day = startKey; day <= endKey; day = addLocalDays(day, 1)) {
    count++;
  }
  return count;
}

function canUseLedgerDelta(
  records: readonly UsageSummaryRecord[],
  ledgerDaily: TokenUsageDailyByModel,
  sortedLedgerDays: readonly string[],
  currentSession?: UsageSummaryRecord,
): boolean {
  return !records.some(
    (record) =>
      Object.values(record.models).some(
        (model) =>
          model.requests > 0 ||
          model.inputTokens > 0 ||
          model.outputTokens > 0 ||
          model.cachedTokens > 0 ||
          model.thoughtsTokens > 0 ||
          model.totalTokens > 0 ||
          (model.totalLatencyMs ?? 0) > 0,
      ) &&
      !recordTouchesLedgerDays(
        record,
        ledgerDaily,
        sortedLedgerDays,
        undefined,
        currentSession,
      ),
  );
}

export async function loadStatsData(
  range: TimeRange,
  currentSession?: UsageSummaryRecord,
  currentSessionId?: string,
  projectRoot?: string,
): Promise<StatsData> {
  const sessionId = currentSession?.sessionId ?? currentSessionId;
  const persisted = await loadUsageHistory(sessionId, {
    projectRoot: projectRoot ?? currentSession?.project,
    beforeMsBySession: currentSession
      ? new Map([[currentSession.sessionId, currentSession.startTime]])
      : undefined,
  });
  let records = persisted;
  const persistedScope = getTranscriptScope(persisted);
  if (currentSession) {
    const first = persisted.findIndex(
      (r) => r.sessionId === currentSession.sessionId,
    );
    if (first < 0) {
      records = [...persisted, currentSession];
    } else {
      const last = persisted.findLastIndex(
        (r) => r.sessionId === currentSession.sessionId,
      );
      records = [
        ...persisted.slice(0, first),
        ...dedupBySessionId([
          ...persisted.slice(first, last + 1),
          currentSession,
        ]),
        ...persisted.slice(last + 1),
      ];
    }
  }
  const transcriptScope = persistedScope
    ? {
        ...persistedScope,
        projectKeysBySession: projectKeysFromRecords(
          records,
          persistedScope.projectKeysBySession,
        ),
      }
    : undefined;
  const { start, end } = getTimeRangeBounds(range);
  const currentStartKey = localDateKey(start.getTime());
  const currentEndKey = localDateKey(end.getTime());
  const currentCompletedEndKey = addLocalDays(currentEndKey, -1);
  const completedDays =
    range === 'all'
      ? 0
      : countLocalDays(currentStartKey, currentCompletedEndKey);
  const prevEndKey =
    completedDays > 0 ? addLocalDays(currentStartKey, -1) : undefined;
  const prevStartKey =
    completedDays > 0
      ? addLocalDays(prevEndKey!, -(completedDays - 1))
      : undefined;

  // One accounting table for both surfaces. The previous comparison needs its
  // own earlier days, and every record's spending day must be visible to the
  // replacement predicate independently of the selected display range.
  const comparisonStartKey =
    prevStartKey && prevStartKey < currentStartKey
      ? prevStartKey
      : currentStartKey;
  const firstRecordStart = records.reduce(
    (earliest, record) => Math.min(earliest, record.startTime),
    start.getTime(),
  );
  const firstRecordKey = localDateKey(firstRecordStart);
  const ledgerStartKey =
    firstRecordKey < comparisonStartKey ? firstRecordKey : comparisonStartKey;
  const ledgerDaily = await loadLedgerShared(ledgerStartKey);
  setLedgerTranscriptScope(ledgerDaily, transcriptScope);
  const sortedLedgerDays = [...ledgerDaily.keys()].sort();
  const table = buildUsageDayTable(
    records,
    ledgerDaily,
    sortedLedgerDays,
    undefined,
    currentSession,
  );
  const report = aggregateUsage(
    filterUsageRecordsByLocalDay(records, currentStartKey, currentEndKey),
    'all',
  );

  applyTokenWindow(report, table, currentStartKey, currentEndKey);

  const heatmap = buildHeatmap(table, currentStartKey, currentEndKey);
  const heatmapDates = Object.entries(heatmap)
    .filter(([, tokens]) => tokens > 0)
    .map(([date]) => date);
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
    const ledgerCoversPrev = sortedLedgerDays.some(
      (day) => day >= prevStartKey && day <= prevEndKey,
    );
    if (prevFiltered.length > 0 || ledgerCoversPrev) {
      // Compare only completed local days; never compare a partial today
      // against full days or invent intraday data by scaling them.
      const currentCompletedRecords = filterUsageRecordsByLocalDay(
        records,
        currentStartKey,
        currentCompletedEndKey,
      );
      const currentDeltaReport = aggregateUsage(currentCompletedRecords, 'all');
      const previousReport = aggregateUsage(prevFiltered, 'all');
      if (
        canUseLedgerDelta(
          currentCompletedRecords,
          ledgerDaily,
          sortedLedgerDays,
          currentSession,
        ) &&
        canUseLedgerDelta(
          prevFiltered,
          ledgerDaily,
          sortedLedgerDays,
          currentSession,
        )
      ) {
        applyTokenWindow(
          currentDeltaReport,
          table,
          currentStartKey,
          currentCompletedEndKey,
        );
        applyTokenWindow(previousReport, table, prevStartKey, prevEndKey);
      }
      // Model-bearing records need complete ledger coverage. Without them,
      // missing keys may be ordinary zero-request days, and there is no
      // replayed record basis to mix with the ledger.
      delta = computeDelta(currentDeltaReport, previousReport);
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

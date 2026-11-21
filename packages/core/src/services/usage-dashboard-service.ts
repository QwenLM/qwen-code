/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  aggregateUsage,
  getTimeRangeBounds,
  loadUsageHistoryWithLive,
  type TimeRange,
  type UsageSummaryRecord,
} from './usageHistoryService.js';
import {
  loadTokenUsageDailyByModel,
  type TokenUsageCompletedMonthCache,
  type TokenUsageDailyByModel,
  type TokenUsageDayModelTotals,
} from './tokenUsageService.js';
import { outputTokenCount } from '../telemetry/gen-ai-usage.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('USAGE_DASHBOARD');

/** Trailing window for the heatmap, ~6 months. */
const DEFAULT_HEATMAP_DAYS = 183;
/** Cap on the per-day series length (guards a wide `range` like `all`). */
const MAX_DAILY_DAYS = 92;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
/**
 * Trailing days of per-request ledger loaded for the dashboard. Matches the
 * route's `heatmapDays` clamp, so one load covers every window a caller can ask
 * for and the cached sources stay range-independent.
 */
const LEDGER_WINDOW_DAYS = 366;

/**
 * Flattened totals for the selected range, powering the usage-dashboard hero +
 * breakdown tiles. All token counts are summed across every model in the range.
 */
export interface UsageDashboardTotals {
  totalTokens: number;
  inputTokens: number;
  /** Output tokens with reasoning counted once, so input + output = total. */
  outputTokens: number;
  cachedTokens: number;
  /** Raw reasoning count; most providers already include it in outputTokens. */
  thoughtsTokens: number;
  requests: number;
  sessions: number;
  toolCalls: number;
  linesAdded: number;
  linesRemoved: number;
  /** cachedTokens / inputTokens as a 0..1 fraction (0 when there is no input). */
  cacheReadRate: number;
}

/** One model's share of the range's token spend, for the model-share list. */
export interface UsageModelShare {
  model: string;
  totalTokens: number;
  /** cachedTokens / inputTokens, 0..1. */
  cacheReadRate: number;
  /** totalTokens / range total, 0..1. */
  share: number;
}

/** One skill's invocation count over the range, for the skill-calls table. */
export interface UsageSkillCall {
  name: string;
  count: number;
}

/** One day's tokens plus the runs whose record ended on that day. */
export interface UsageDailyPoint {
  date: string;
  tokens: number;
  /** Runs ended on this day; a cross-midnight run can differ from token day. */
  sessions: number;
}

/** One heatmap cell: total tokens (drives intensity) + that day's cache rate. */
export interface UsageHeatmapDay {
  tokens: number;
  /** cachedTokens / inputTokens for that day, 0..1. */
  cacheReadRate: number;
}

export interface UsageDashboard {
  generatedAt: string;
  /** The range these totals cover; the heatmap below is always ~6 months. */
  range: TimeRange;
  summary: UsageDashboardTotals;
  /** Per-model token share for the range, sorted by tokens desc. */
  models: UsageModelShare[];
  /** Skill invocations for the range, sorted by count desc. */
  skills: UsageSkillCall[];
  /** Per-day tokens + sessions across the range window (continuous axis). */
  daily: UsageDailyPoint[];
  /** Per-day cells keyed by local `YYYY-MM-DD`, trailing `heatmapDays`. */
  heatmap: Record<string, UsageHeatmapDay>;
  heatmapDays: number;
}

export interface LoadUsageDashboardOptions {
  /** Aggregation window for the summary totals. Defaults to `today`. */
  range?: TimeRange;
  /** Trailing days covered by the heatmap. Defaults to ~6 months. */
  heatmapDays?: number;
}

/**
 * A model's token total: the reported total, or the component sum for records
 * that predate it. Shared so every usage surface applies the same fallback.
 */
export function modelTokens(m: {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}): number {
  return m.totalTokens || m.inputTokens + m.outputTokens + m.thoughtsTokens;
}

/** The local calendar day an epoch-ms instant falls on, as `YYYY-MM-DD`. */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function startOfLocalDay(ms: number): Date {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Local day -> model -> counters. Every token-bearing output derives from it. */
export type UsageDayModelTable = TokenUsageDailyByModel;

/**
 * The shared accounting table for every cross-session usage surface: session
 * records bucketed by the day the session ended, with each day the per-request
 * ledger covers **replaced** by the ledger's counters.
 *
 * Replacing rather than adding is what keeps one run from being counted twice —
 * the same requests exist in both sources. A record is dropped when its run's
 * day span touches ANY ledger-covered day, not just its end day: a run that
 * spends on D and exits after midnight on D+1 would otherwise leave a full-run
 * copy on D+1 while the ledger already counted those responses on D. Records
 * with no ledger overlap at all keep the session-record attribution, which
 * preserves history from before the ledger existed and the behavior of a user
 * with usage statistics disabled.
 */
export function buildUsageDayTable(
  records: UsageSummaryRecord[],
  ledgerDaily?: TokenUsageDailyByModel,
): UsageDayModelTable {
  const table: UsageDayModelTable = new Map();
  // Sorted once so each record's span check can stop at the first day past it.
  const ledgerDays = ledgerDaily ? [...ledgerDaily.keys()].sort() : [];
  const touchesLedger = (startDay: string, endDay: string): boolean => {
    for (const day of ledgerDays) {
      if (day > endDay) return false;
      if (day >= startDay) return true;
    }
    return false;
  };
  for (const r of records) {
    if (!r.models) continue;
    const day = localDateKey(r.timestamp);
    if (touchesLedger(localDateKey(r.startTime), day)) continue;
    let byModel = table.get(day);
    if (!byModel) {
      byModel = new Map();
      table.set(day, byModel);
    }
    for (const [model, m] of Object.entries(r.models)) {
      const totals = byModel.get(model) ?? emptyDayModelTotals();
      totals.requests += m.requests;
      totals.inputTokens += m.inputTokens;
      totals.outputTokens += m.outputTokens;
      totals.cachedTokens += m.cachedTokens;
      totals.thoughtsTokens += m.thoughtsTokens;
      totals.totalTokens += m.totalTokens;
      totals.apiDurationMs += m.totalLatencyMs ?? 0;
      byModel.set(model, totals);
    }
  }
  if (ledgerDaily) {
    for (const [day, byModel] of ledgerDaily) {
      table.set(day, new Map(byModel));
    }
  }
  return table;
}

function emptyDayModelTotals(): TokenUsageDayModelTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    thoughtsTokens: 0,
    totalTokens: 0,
    apiDurationMs: 0,
  };
}

/**
 * Per-model counters summed over the local days in `[startKey, endKey]`. Day
 * buckets cannot be split by hour, so a window selects whole local days.
 */
export function sumUsageWindowByModel(
  table: UsageDayModelTable,
  startKey: string,
  endKey: string,
): Map<string, TokenUsageDayModelTotals> {
  const models = new Map<string, TokenUsageDayModelTotals>();
  for (const [day, byModel] of table) {
    if (day < startKey || day > endKey) continue;
    for (const [model, m] of byModel) {
      const totals = models.get(model) ?? emptyDayModelTotals();
      totals.requests += m.requests;
      totals.inputTokens += m.inputTokens;
      totals.outputTokens += m.outputTokens;
      totals.cachedTokens += m.cachedTokens;
      totals.thoughtsTokens += m.thoughtsTokens;
      totals.totalTokens += m.totalTokens;
      totals.apiDurationMs += m.apiDurationMs;
      models.set(model, totals);
    }
  }
  return models;
}

function dayTokens(byModel: Map<string, TokenUsageDayModelTotals>): {
  tokens: number;
  input: number;
  cached: number;
} {
  let tokens = 0;
  let input = 0;
  let cached = 0;
  for (const m of byModel.values()) {
    tokens += modelTokens(m);
    input += m.inputTokens;
    cached += m.cachedTokens;
  }
  return { tokens, input, cached };
}

function buildHeatmap(
  table: UsageDayModelTable,
  startKey: string,
  endKey: string,
): Record<string, UsageHeatmapDay> {
  const heatmap: Record<string, UsageHeatmapDay> = {};
  for (const [day, byModel] of table) {
    if (day < startKey || day > endKey) continue;
    const { tokens, input, cached } = dayTokens(byModel);
    heatmap[day] = { tokens, cacheReadRate: input > 0 ? cached / input : 0 };
  }
  return heatmap;
}

/** Records whose end day falls in the inclusive local-day window. */
export function filterUsageRecordsByLocalDay(
  records: UsageSummaryRecord[],
  startKey: string,
  endKey: string,
): UsageSummaryRecord[] {
  return records.filter((r) => {
    const day = localDateKey(r.timestamp);
    return day >= startKey && day <= endKey;
  });
}

/**
 * Per-day tokens + ended-run counts on a continuous day axis (zero-filled).
 * The two sources can attribute a cross-midnight run to different days: tokens
 * follow each request, while sessions follow the run record's end timestamp.
 */
function buildDaily(
  table: UsageDayModelTable,
  records: UsageSummaryRecord[],
  startMs: number,
  endMs: number,
): UsageDailyPoint[] {
  const sessionByDay = new Map<string, number>();
  for (const r of records) {
    const key = localDateKey(r.timestamp);
    sessionByDay.set(key, (sessionByDay.get(key) ?? 0) + 1);
  }
  const out: UsageDailyPoint[] = [];
  const cursor = startOfLocalDay(startMs);
  const last = startOfLocalDay(endMs).getTime();
  // Advance by calendar day (DST-safe) rather than fixed ms steps.
  while (cursor.getTime() <= last) {
    const key = localDateKey(cursor.getTime());
    const byModel = table.get(key);
    out.push({
      date: key,
      tokens: byModel ? dayTokens(byModel).tokens : 0,
      sessions: sessionByDay.get(key) ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * Build the dashboard from already-loaded usage records (pure — no I/O). Split
 * out from {@link loadUsageDashboard} so a caller can load the history once and
 * cheaply re-aggregate across ranges (the Today/7D/30D toggle) rather than
 * re-reading the whole history per range.
 */
export function buildUsageDashboard(
  records: UsageSummaryRecord[],
  options: LoadUsageDashboardOptions = {},
  ledgerDaily?: TokenUsageDailyByModel,
): UsageDashboard {
  const range: TimeRange = options.range ?? 'today';
  const heatmapDays =
    options.heatmapDays && options.heatmapDays > 0
      ? Math.floor(options.heatmapDays)
      : DEFAULT_HEATMAP_DAYS;

  const now = Date.now();
  const todayKey = localDateKey(now);
  const rangeStartKey = localDateKey(getTimeRangeBounds(range).start.getTime());
  // These fields only exist on session records, but they use the same whole-day
  // window as the token table rather than a rolling millisecond cut-off.
  const report = aggregateUsage(
    filterUsageRecordsByLocalDay(records, rangeStartKey, todayKey),
    'all',
  );

  const table = buildUsageDayTable(records, ledgerDaily);
  const windowModels = sumUsageWindowByModel(table, rangeStartKey, todayKey);
  let requests = 0;
  for (const m of windowModels.values()) requests += m.requests;

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let thoughtsTokens = 0;
  let totalTokens = 0;
  for (const m of windowModels.values()) {
    inputTokens += m.inputTokens;
    // Providers disagree on whether the output count already carries reasoning,
    // and a usage record has no auth type to consult. The reported total settles
    // it: `outputTokenCount` accepts a total inside the band both conventions
    // allow, so adding thoughtsTokens here would bill reasoning twice.
    outputTokens += outputTokenCount(
      {
        input: m.inputTokens,
        output: m.outputTokens,
        thoughts: m.thoughtsTokens,
        total: m.totalTokens,
      },
      undefined,
    );
    cachedTokens += m.cachedTokens;
    thoughtsTokens += m.thoughtsTokens;
    totalTokens += modelTokens(m);
  }

  const summary: UsageDashboardTotals = {
    totalTokens,
    inputTokens,
    outputTokens,
    cachedTokens,
    thoughtsTokens,
    requests,
    sessions: report.sessionCount,
    toolCalls: report.tools.totalCalls,
    linesAdded: report.files.linesAdded,
    linesRemoved: report.files.linesRemoved,
    cacheReadRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
  };

  const models: UsageModelShare[] = [...windowModels]
    .map(([model, m]) => ({
      model,
      totalTokens: modelTokens(m),
      cacheReadRate: m.inputTokens > 0 ? m.cachedTokens / m.inputTokens : 0,
      share: totalTokens > 0 ? modelTokens(m) / totalTokens : 0,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const skills: UsageSkillCall[] = report.skills.topSkills.map((s) => ({
    name: s.name,
    count: s.count,
  }));

  const dailyStart = Math.max(
    getTimeRangeBounds(range).start.getTime(),
    now - MAX_DAILY_DAYS * MS_PER_DAY,
  );
  const daily = buildDaily(table, records, dailyStart, now);

  // The heatmap covers the trailing `heatmapDays` (~12 months in the UI),
  // independent of `range`.
  const heatmap = buildHeatmap(
    table,
    localDateKey(now - heatmapDays * MS_PER_DAY),
    todayKey,
  );

  debugLogger.debug(
    `built dashboard range=${range} records=${records.length} ledgerDays=${ledgerDaily?.size ?? 0} models=${models.length} skills=${skills.length} dailyPoints=${daily.length}`,
  );

  return {
    generatedAt: new Date(now).toISOString(),
    range,
    summary,
    models,
    skills,
    daily,
    heatmap,
    heatmapDays,
  };
}

/** The two sources the dashboard aggregates, loaded once and cached together. */
export interface UsageDashboardSources {
  records: UsageSummaryRecord[];
  ledgerDaily: TokenUsageDailyByModel;
}

/**
 * Loads the ledger for a window, degrading to an empty table when it cannot be
 * read. The loader itself rethrows every non-ENOENT error so a half-read month
 * can never pass as a complete one; the decision to keep the surface usable
 * belongs here, at the composition point. An unreadable ledger then leaves the
 * record-derived attribution in place — the pre-ledger behavior — instead of
 * blanking tiles whose own source loaded fine.
 */
export async function loadLedgerOrEmpty(
  sinceLocalDate: string,
  completedMonthCache?: TokenUsageCompletedMonthCache,
): Promise<TokenUsageDailyByModel> {
  try {
    return await loadTokenUsageDailyByModel(
      sinceLocalDate,
      completedMonthCache,
    );
  } catch (error) {
    debugLogger.warn(
      `usage ledger unreadable, falling back to session-record attribution: ${error}`,
    );
    return new Map();
  }
}

/**
 * Load both dashboard sources: the session history (for sessions, tool calls,
 * changed lines and skills) and the per-request ledger's per-day counters (for
 * everything token-bearing). Read-only. The session history can be I/O heavy on
 * large histories, so callers should cache the pair and re-run
 * {@link buildUsageDashboard} per range.
 */
export async function loadUsageDashboardSources(): Promise<UsageDashboardSources> {
  const [records, ledgerDaily] = await Promise.all([
    loadUsageHistoryWithLive(),
    loadLedgerOrEmpty(
      localDateKey(Date.now() - LEDGER_WINDOW_DAYS * MS_PER_DAY),
    ),
  ]);
  return { records, ledgerDaily };
}

/**
 * Read-only snapshot of local token usage for the daemon usage-dashboard API.
 * Loads the global cross-project history (`~/.qwen`) via
 * {@link loadUsageHistoryWithLive} — the persisted `usage_record.jsonl` unioned
 * with a replay of recent transcripts — so the session-granular tiles include
 * daemon / Web Shell and in-progress sessions that the persisted file never
 * captures, and the per-request ledger so token totals land on the day each
 * response actually happened.
 */
export async function loadUsageDashboard(
  options: LoadUsageDashboardOptions = {},
): Promise<UsageDashboard> {
  const { records, ledgerDaily } = await loadUsageDashboardSources();
  return buildUsageDashboard(records, options, ledgerDaily);
}

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
  getTokenUsageSessionIds,
  loadTokenUsageDailyByModel,
  mergeTokenUsageSessionIds,
  type TokenUsageCompletedMonthCache,
  type TokenUsageDailyByModel,
  type TokenUsageDayModelTotals,
} from './tokenUsageService.js';
import { outputTokenCount } from '../telemetry/gen-ai-usage.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { Storage } from '../config/storage.js';

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

function ledgerCoversModel(
  record: UsageSummaryRecord,
  model: string,
  ledgerDaily: TokenUsageDailyByModel | undefined,
  sortedLedgerDays?: readonly string[],
): boolean {
  if (!ledgerDaily) return false;
  const startDay = localDateKey(record.startTime);
  const endDay = localDateKey(record.timestamp);
  for (const day of sortedLedgerDays ?? [...ledgerDaily.keys()].sort()) {
    if (day > endDay) return false;
    if (day < startDay || !ledgerDaily.get(day)?.has(model)) continue;
    const sessionIds = getTokenUsageSessionIds(ledgerDaily, day, model);
    if (!sessionIds || sessionIds.has(record.sessionId)) return true;
  }
  return false;
}

/**
 * Whether every positive-count model in a record has ledger coverage in its
 * span. A full-window comparison must not treat a different model's ledger as
 * coverage for this record. Where session evidence is available, the match
 * must also refer to this session rather than another runtime's activity.
 * `sortedLedgerDays` lets callers processing many records share one sort.
 */
export function recordTouchesLedgerDays(
  record: UsageSummaryRecord,
  ledgerDaily: TokenUsageDailyByModel | undefined,
  sortedLedgerDays?: readonly string[],
): boolean {
  const models = Object.entries(record.models).filter(
    ([, model]) =>
      model.requests > 0 ||
      model.inputTokens > 0 ||
      model.outputTokens > 0 ||
      model.cachedTokens > 0 ||
      model.thoughtsTokens > 0 ||
      model.totalTokens > 0 ||
      (model.totalLatencyMs ?? 0) > 0,
  );
  return (
    models.length > 0 &&
    models.every(([model]) =>
      ledgerCoversModel(record, model, ledgerDaily, sortedLedgerDays),
    )
  );
}

/**
 * The shared accounting table for every cross-session usage surface: session
 * records bucketed by the day the session ended, with covered model/session
 * entries replaced by the ledger's counters rather than replacing entire days.
 *
 * A model from one run is omitted only where it is actually covered by the
 * ledger, so the shared request is not added twice. Uncovered models and
 * sessions remain, including when only part of a record has coverage. Ledger
 * days are then summed with the remaining record rows rather than replacing an
 * entire day and deleting those genuine unmatched costs.
 */
export function buildUsageDayTable(
  records: UsageSummaryRecord[],
  ledgerDaily?: TokenUsageDailyByModel,
  sortedLedgerDays?: readonly string[],
): UsageDayModelTable {
  const table: UsageDayModelTable = new Map();
  // The caller may share this sorted array with other record span checks.
  const ledgerDays =
    sortedLedgerDays ?? (ledgerDaily ? [...ledgerDaily.keys()].sort() : []);
  for (const r of records) {
    if (!r.models) continue;
    const day = localDateKey(r.timestamp);
    for (const [model, m] of Object.entries(r.models)) {
      if (ledgerCoversModel(r, model, ledgerDaily, ledgerDays)) continue;
      let byModel = table.get(day);
      if (!byModel) {
        byModel = new Map();
        table.set(day, byModel);
      }
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
      const targetModels = table.get(day) ?? new Map();
      table.set(day, targetModels);
      for (const [model, totals] of byModel) {
        const existing = targetModels.get(model);
        if (!existing) {
          targetModels.set(model, { ...totals });
          continue;
        }
        existing.requests += totals.requests;
        existing.inputTokens += totals.inputTokens;
        existing.outputTokens += totals.outputTokens;
        existing.cachedTokens += totals.cachedTokens;
        existing.thoughtsTokens += totals.thoughtsTokens;
        existing.totalTokens += totals.totalTokens;
        existing.apiDurationMs += totals.apiDurationMs;
      }
    }
  }
  for (const record of records) {
    if (!recordTouchesLedgerDays(record, ledgerDaily, ledgerDays)) continue;
    const day = localDateKey(record.timestamp);
    for (const [model, metrics] of Object.entries(record.models)) {
      if (
        !metrics.errors ||
        !ledgerCoversModel(record, model, ledgerDaily, ledgerDays)
      ) {
        continue;
      }
      let byModel = table.get(day);
      if (!byModel) {
        byModel = new Map();
        table.set(day, byModel);
      }
      const totals = byModel.get(model) ?? emptyDayModelTotals();
      totals.requests += metrics.errors;
      // Failure latency has session-record granularity, like duration.
      totals.apiDurationMs += metrics.errorLatencyMs ?? 0;
      byModel.set(model, totals);
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
    if (r.transcriptSupplement === true) continue;
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
 * {@link buildUsageDashboard} per range. With an explicit root list, only those
 * known roots are read; an empty list retains the independent global history
 * instead of mixing a coincidental ambient ledger into it. Without the list,
 * the current runtime root is used.
 */
export async function loadUsageDashboardSources(
  ledgerRuntimeBaseDirs?: readonly string[],
): Promise<UsageDashboardSources> {
  const sinceLocalDate = localDateKey(
    Date.now() - LEDGER_WINDOW_DAYS * MS_PER_DAY,
  );
  const runtimeRoots = ledgerRuntimeBaseDirs
    ? [...new Set(ledgerRuntimeBaseDirs)]
    : [undefined];
  const [records, ledgerTables] = await Promise.all([
    loadUsageHistoryWithLive(),
    Promise.all(
      runtimeRoots.map((runtimeRoot) =>
        runtimeRoot
          ? Storage.runWithResolvedRuntimeBaseDir(runtimeRoot, () =>
              loadLedgerOrEmpty(sinceLocalDate),
            )
          : loadLedgerOrEmpty(sinceLocalDate),
      ),
    ),
  ]);
  const ledgerDaily: TokenUsageDailyByModel = new Map();
  for (const table of ledgerTables) {
    mergeTokenUsageSessionIds(ledgerDaily, table);
    for (const [day, models] of table) {
      const targetModels = ledgerDaily.get(day) ?? new Map();
      ledgerDaily.set(day, targetModels);
      for (const [model, totals] of models) {
        const existing = targetModels.get(model);
        if (!existing) {
          targetModels.set(model, { ...totals });
          continue;
        }
        existing.requests += totals.requests;
        existing.inputTokens += totals.inputTokens;
        existing.outputTokens += totals.outputTokens;
        existing.cachedTokens += totals.cachedTokens;
        existing.thoughtsTokens += totals.thoughtsTokens;
        existing.totalTokens += totals.totalTokens;
        existing.apiDurationMs += totals.apiDurationMs;
      }
    }
  }
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

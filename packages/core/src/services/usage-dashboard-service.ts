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

/** One day's totals for the range's daily token/session charts. */
export interface UsageDailyPoint {
  date: string;
  tokens: number;
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

function modelTokens(m: {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
}): number {
  return m.totalTokens || m.inputTokens + m.outputTokens + m.thoughtsTokens;
}

function localDateKey(ts: number): string {
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
type DayModelTable = TokenUsageDailyByModel;

/**
 * Session-record tokens bucketed by the day the session ended. This is the
 * fallback attribution for days the per-request ledger does not cover; it cannot
 * split a session's spend across the days it actually ran.
 */
function tableFromRecords(records: UsageSummaryRecord[]): DayModelTable {
  const table: DayModelTable = new Map();
  for (const r of records) {
    if (!r.models) continue;
    const day = localDateKey(r.timestamp);
    let byModel = table.get(day);
    if (!byModel) {
      byModel = new Map();
      table.set(day, byModel);
    }
    for (const [model, m] of Object.entries(r.models)) {
      const totals = byModel.get(model) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 0,
      };
      totals.requests += m.requests;
      totals.inputTokens += m.inputTokens;
      totals.outputTokens += m.outputTokens;
      totals.cachedTokens += m.cachedTokens;
      totals.thoughtsTokens += m.thoughtsTokens;
      totals.totalTokens += m.totalTokens;
      byModel.set(model, totals);
    }
  }
  return table;
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
  table: DayModelTable,
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

/**
 * Per-day tokens + session counts over `[startMs, endMs]`, on a continuous day
 * axis (zero-filled) so the daily line/bar charts have no gaps. Tokens come from
 * the day table; session counts stay session-granular.
 */
function buildDaily(
  table: DayModelTable,
  records: UsageSummaryRecord[],
  startMs: number,
  endMs: number,
): UsageDailyPoint[] {
  const sessionByDay = new Map<string, number>();
  for (const r of records) {
    if (r.timestamp < startMs || r.timestamp > endMs) continue;
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

  // Sessions, tool calls, changed lines and skills only exist on session
  // records; the ledger deliberately carries none of them.
  const report = aggregateUsage(records, range);

  const now = Date.now();
  const todayKey = localDateKey(now);
  const rangeStartKey = localDateKey(getTimeRangeBounds(range).start.getTime());

  const table = tableFromRecords(records);
  // A day the ledger covers is authoritative and REPLACES the session-record
  // copy: the same requests appear in both, so adding them would double count.
  // Days it does not cover keep the session-record attribution, which is what
  // preserves heatmap history from before the ledger existed.
  if (ledgerDaily) {
    for (const [day, byModel] of ledgerDaily) {
      table.set(day, new Map(byModel));
    }
  }

  const windowModels = new Map<string, TokenUsageDayModelTotals>();
  let requests = 0;
  for (const [day, byModel] of table) {
    if (day < rangeStartKey || day > todayKey) continue;
    for (const [model, m] of byModel) {
      requests += m.requests;
      const totals = windowModels.get(model) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        thoughtsTokens: 0,
        totalTokens: 0,
      };
      totals.requests += m.requests;
      totals.inputTokens += m.inputTokens;
      totals.outputTokens += m.outputTokens;
      totals.cachedTokens += m.cachedTokens;
      totals.thoughtsTokens += m.thoughtsTokens;
      totals.totalTokens += m.totalTokens;
      windowModels.set(model, totals);
    }
  }

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
 * Load both dashboard sources: the session history (for sessions, tool calls,
 * changed lines and skills) and the per-request ledger's per-day counters (for
 * everything token-bearing). Read-only. The session history can be I/O heavy on
 * large histories, so callers should cache the pair and re-run
 * {@link buildUsageDashboard} per range.
 */
export async function loadUsageDashboardSources(): Promise<UsageDashboardSources> {
  const [records, ledgerDaily] = await Promise.all([
    loadUsageHistoryWithLive(),
    loadTokenUsageDailyByModel(
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

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  aggregateUsage,
  getTimeRangeBounds,
  loadUsageHistory,
  type TimeRange,
  type UsageSummaryRecord,
} from './usageHistoryService.js';

/** Trailing window for the heatmap, ~6 months. */
const DEFAULT_HEATMAP_DAYS = 183;
/** Cap on the per-day series length (guards a wide `range` like `all`). */
const MAX_DAILY_DAYS = 92;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Flattened totals for the selected range, powering the usage-dashboard hero +
 * breakdown tiles. All token counts are summed across every model in the range.
 */
export interface UsageDashboardTotals {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
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
  /** Consecutive days with activity ending today (0 if today has a gap). */
  currentStreak: number;
  longestStreak: number;
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

function buildHeatmap(
  records: UsageSummaryRecord[],
  startMs: number,
  endMs: number,
): Record<string, UsageHeatmapDay> {
  const tokensByDay = new Map<string, number>();
  const inputByDay = new Map<string, number>();
  const cachedByDay = new Map<string, number>();
  for (const r of records) {
    if (r.timestamp < startMs || r.timestamp > endMs) continue;
    if (!r.models) continue;
    const key = localDateKey(r.timestamp);
    let tokens = 0;
    let input = 0;
    let cached = 0;
    for (const m of Object.values(r.models)) {
      tokens += modelTokens(m);
      input += m.inputTokens;
      cached += m.cachedTokens;
    }
    tokensByDay.set(key, (tokensByDay.get(key) ?? 0) + tokens);
    inputByDay.set(key, (inputByDay.get(key) ?? 0) + input);
    cachedByDay.set(key, (cachedByDay.get(key) ?? 0) + cached);
  }
  const heatmap: Record<string, UsageHeatmapDay> = {};
  for (const [key, tokens] of tokensByDay) {
    const input = inputByDay.get(key) ?? 0;
    const cached = cachedByDay.get(key) ?? 0;
    heatmap[key] = { tokens, cacheReadRate: input > 0 ? cached / input : 0 };
  }
  return heatmap;
}

/**
 * Per-day tokens + session counts over `[startMs, endMs]`, on a continuous day
 * axis (zero-filled) so the daily line/bar charts have no gaps.
 */
function buildDaily(
  records: UsageSummaryRecord[],
  startMs: number,
  endMs: number,
): UsageDailyPoint[] {
  const tokenByDay = new Map<string, number>();
  const sessionByDay = new Map<string, number>();
  for (const r of records) {
    if (r.timestamp < startMs || r.timestamp > endMs) continue;
    const key = localDateKey(r.timestamp);
    let tokens = 0;
    if (r.models) {
      for (const m of Object.values(r.models)) tokens += modelTokens(m);
    }
    tokenByDay.set(key, (tokenByDay.get(key) ?? 0) + tokens);
    sessionByDay.set(key, (sessionByDay.get(key) ?? 0) + 1);
  }
  const out: UsageDailyPoint[] = [];
  const cursor = startOfLocalDay(startMs);
  const last = startOfLocalDay(endMs).getTime();
  // Advance by calendar day (DST-safe) rather than fixed ms steps.
  while (cursor.getTime() <= last) {
    const key = localDateKey(cursor.getTime());
    out.push({
      date: key,
      tokens: tokenByDay.get(key) ?? 0,
      sessions: sessionByDay.get(key) ?? 0,
    });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

function calculateStreaks(dateKeys: string[]): {
  currentStreak: number;
  longestStreak: number;
} {
  if (dateKeys.length === 0) return { currentStreak: 0, longestStreak: 0 };

  const days = dateKeys
    .map((d) => {
      const dt = new Date(`${d}T00:00:00`);
      dt.setHours(0, 0, 0, 0);
      return dt.getTime();
    })
    .sort((a, b) => a - b);

  let currentStreak = 1;
  let longestStreak = 1;
  for (let i = 1; i < days.length; i++) {
    const diff = Math.round((days[i]! - days[i - 1]!) / MS_PER_DAY);
    if (diff === 1) {
      currentStreak++;
      if (currentStreak > longestStreak) longestStreak = currentStreak;
    } else if (diff > 1) {
      currentStreak = 1;
    }
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const daysSinceLast = Math.round(
    (today.getTime() - days[days.length - 1]!) / MS_PER_DAY,
  );
  if (daysSinceLast > 1) currentStreak = 0;

  return { currentStreak, longestStreak };
}

/**
 * Read-only, workspace-agnostic snapshot of local token usage for the
 * daemon usage-dashboard API. Reuses {@link loadUsageHistory} (persisted
 * `usage_record.jsonl`, falling back to transcript replay) and
 * {@link aggregateUsage} so it stays consistent with the TUI `/stats` view.
 *
 * NOTE: history is global across all projects (`~/.qwen`), matching the
 * dashboard's cross-project intent. This can be I/O heavy on large histories
 * (transcript replay); callers should fetch on demand and cache.
 */
export async function loadUsageDashboard(
  options: LoadUsageDashboardOptions = {},
): Promise<UsageDashboard> {
  const range: TimeRange = options.range ?? 'today';
  const heatmapDays =
    options.heatmapDays && options.heatmapDays > 0
      ? Math.floor(options.heatmapDays)
      : DEFAULT_HEATMAP_DAYS;

  const records = await loadUsageHistory();
  const report = aggregateUsage(records, range);

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let thoughtsTokens = 0;
  let totalTokens = 0;
  for (const m of Object.values(report.models)) {
    inputTokens += m.inputTokens;
    outputTokens += m.outputTokens;
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
    requests: report.totalRequests,
    sessions: report.sessionCount,
    toolCalls: report.tools.totalCalls,
    linesAdded: report.files.linesAdded,
    linesRemoved: report.files.linesRemoved,
    cacheReadRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
  };

  const now = Date.now();

  const models: UsageModelShare[] = Object.entries(report.models)
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
  const daily = buildDaily(records, dailyStart, now);

  // The heatmap always covers the trailing ~6 months, independent of `range`.
  const heatmap = buildHeatmap(records, now - heatmapDays * MS_PER_DAY, now);
  const { currentStreak, longestStreak } = calculateStreaks(
    Object.keys(heatmap),
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
    currentStreak,
    longestStreak,
  };
}

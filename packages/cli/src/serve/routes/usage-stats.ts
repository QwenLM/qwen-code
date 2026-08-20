/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read-only usage-dashboard surface behind the Web Shell Daemon Status
 * "统计 / Usage" tab. Serves the selected range's (`today`/`week`/`month`)
 * flattened token totals plus a trailing per-day heatmap, computed by core's
 * `buildUsageDashboard` from the local usage history (global `~/.qwen`,
 * cross-project). Uses `loadUsageHistoryWithLive`, which unions the durable
 * `usage_record.jsonl` (written only by the TUI `/clear` path) with a replay of
 * recent transcripts — so daemon / Web Shell sessions and any in-progress
 * session are counted here, unlike the TUI `/stats` view. The load is
 * read-only (never writes `~/.qwen`).
 *
 * Open GET (no `mutate` gate), consistent with `GET /daemon/status` and
 * `GET /scheduled-tasks`: it exposes only aggregate local usage counts.
 *
 * The heavy step — `loadUsageHistoryWithLive` can replay recent transcripts —
 * is cached once (range-independent), so toggling Today/7D/30D re-aggregates
 * cheaply from a single disk read instead of re-loading per range, and
 * concurrent requests coalesce onto the in-flight load.
 */

import type { Application } from 'express';
import {
  buildUsageDashboard,
  loadUsageHistoryWithLive,
  type UsageSummaryRecord,
} from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../../utils/stdioHelpers.js';

const DEFAULT_HEATMAP_DAYS = 183;
const MIN_HEATMAP_DAYS = 1;
const MAX_HEATMAP_DAYS = 366;
const DEFAULT_CACHE_TTL_MS = 60_000;

// The summary window the UI toggle exposes (Today / 7D / 30D). A subset of
// core's `TimeRange`; core maps week→7 days and month→30 days.
const USAGE_RANGES = ['today', 'week', 'month'] as const;
type UsageRange = (typeof USAGE_RANGES)[number];

export interface RegisterUsageStatsRoutesDeps {
  /** Injectable for tests; defaults to core's disk-backed history loader. */
  loadHistory?: () => Promise<UsageSummaryRecord[]>;
  /** Coalescing/refresh window for the cached history. Defaults to 60s. */
  cacheTtlMs?: number;
}

/** Parse `?range=`; anything invalid falls back to `today` (matches core). */
function parseRange(raw: unknown): UsageRange {
  return typeof raw === 'string' &&
    (USAGE_RANGES as readonly string[]).includes(raw)
    ? (raw as UsageRange)
    : 'today';
}

/** Parse + clamp `?heatmapDays=`; anything invalid falls back to the default. */
function parseHeatmapDays(raw: unknown): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) {
    return DEFAULT_HEATMAP_DAYS;
  }
  const value = Number.parseInt(raw, 10);
  return Math.min(MAX_HEATMAP_DAYS, Math.max(MIN_HEATMAP_DAYS, value));
}

export function registerUsageStatsRoutes(
  app: Application,
  deps: RegisterUsageStatsRoutesDeps = {},
): void {
  const loadHistory = deps.loadHistory ?? (() => loadUsageHistoryWithLive());
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  // Closure-scoped, range-independent history cache (one daemon per process).
  // A pending load is always reused regardless of age, so concurrent requests
  // share one load even when it runs longer than the TTL (the slow transcript-
  // replay path). The TTL window only starts once the load settles; a rejected
  // load clears the cache so the next request retries (and is consumed here so
  // a failed load never surfaces as an unhandled rejection).
  interface HistoryCache {
    promise: Promise<UsageSummaryRecord[]>;
    settledAt: number | null;
  }
  let cache: HistoryCache | null = null;

  const getRecords = (): Promise<UsageSummaryRecord[]> => {
    const now = Date.now();
    const fresh =
      cache !== null &&
      (cache.settledAt === null || now - cache.settledAt < ttlMs);
    if (!fresh) {
      const entry: HistoryCache = { promise: loadHistory(), settledAt: null };
      cache = entry;
      entry.promise.then(
        () => {
          if (cache === entry) entry.settledAt = Date.now();
        },
        () => {
          if (cache === entry) cache = null;
        },
      );
    }
    return cache!.promise;
  };

  app.get('/usage/dashboard', async (req, res) => {
    const range = parseRange(req.query['range']);
    const heatmapDays = parseHeatmapDays(req.query['heatmapDays']);
    try {
      const records = await getRecords();
      const dashboard = buildUsageDashboard(records, { range, heatmapDays });
      res.status(200).json(dashboard);
    } catch (err) {
      writeStderrLine(
        `qwen serve: GET /usage/dashboard failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      res.status(500).json({
        error: 'Failed to load usage dashboard',
        code: 'usage_dashboard_failed',
      });
    }
  });
}

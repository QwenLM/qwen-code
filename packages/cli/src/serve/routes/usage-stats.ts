/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read-only usage-dashboard surface behind the Web Shell Daemon Status
 * "统计 / Usage" tab. Serves the selected range's (`today`/`week`/`month`)
 * flattened token totals plus a trailing per-day heatmap, computed by core's
 * `loadUsageDashboard` from the durable
 * local usage history (global `~/.qwen`, cross-project) — the same source the
 * TUI `/stats` command reads. No new instrumentation; nothing is written.
 *
 * Open GET (no `mutate` gate), consistent with `GET /daemon/status` and
 * `GET /scheduled-tasks`: it exposes only aggregate local usage counts.
 *
 * A short per-window TTL cache coalesces the heavy path — `loadUsageHistory`
 * can replay every project's transcripts — so rapid refreshes (and concurrent
 * requests) share a single load instead of stampeding the disk.
 */

import type { Application } from 'express';
import {
  loadUsageDashboard,
  type UsageDashboard,
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
  /** Injectable for tests; defaults to core's disk-backed loader. */
  loadDashboard?: (opts: {
    range: UsageRange;
    heatmapDays: number;
  }) => Promise<UsageDashboard>;
  /** Coalescing/refresh window. Defaults to 60s. */
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
  const value = typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(value)) return DEFAULT_HEATMAP_DAYS;
  return Math.min(MAX_HEATMAP_DAYS, Math.max(MIN_HEATMAP_DAYS, value));
}

export function registerUsageStatsRoutes(
  app: Application,
  deps: RegisterUsageStatsRoutesDeps = {},
): void {
  const load = deps.loadDashboard ?? ((opts) => loadUsageDashboard(opts));
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  // Closure-scoped cache: one per registration (one daemon per process), so
  // tests get a fresh cache per mount with no global reset. Keyed by the
  // clamped window; the in-flight promise is cached so concurrent requests
  // coalesce onto a single load.
  const cache = new Map<
    string,
    { at: number; promise: Promise<UsageDashboard> }
  >();

  app.get('/usage/dashboard', async (req, res) => {
    const range = parseRange(req.query['range']);
    const heatmapDays = parseHeatmapDays(req.query['heatmapDays']);
    const key = `${range}:${heatmapDays}`;
    try {
      const now = Date.now();
      let entry = cache.get(key);
      if (!entry || now - entry.at >= ttlMs) {
        const promise = load({ range, heatmapDays });
        entry = { at: now, promise };
        cache.set(key, entry);
        // Don't cache a rejection for the whole TTL window — drop the entry so
        // the next request retries. Also consumes the rejection so a failed
        // load never surfaces as an unhandled rejection.
        promise.catch(() => {
          if (cache.get(key) === entry) cache.delete(key);
        });
      }
      const dashboard = await entry.promise;
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

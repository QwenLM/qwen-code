/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read-only usage-dashboard surface behind the Web Shell Daemon Status
 * "统计 / Usage" tab. Serves the selected range's (`today`/`week`/`month`)
 * flattened token totals plus a trailing per-day heatmap, computed by core's
 * `buildUsageDashboard` from token ledgers in the registered workspaces' own
 * runtime roots and the global session history (`usage_record.jsonl` unioned with
 * a replay of recent transcripts) for sessions, tool calls, changed lines and
 * skills. A
 * day the ledger covers replaces that day's session-record tokens rather than
 * adding to them. The load is read-only (never writes `~/.qwen`).
 *
 * Open GET (no `mutate` gate), consistent with `GET /daemon/status` and
 * `GET /scheduled-tasks`: it exposes only aggregate local usage counts.
 *
 * The heavy step — the session history can replay recent transcripts — is
 * cached once (range-independent, and covering the widest heatmap window), so
 * toggling Today/7D/30D re-aggregates cheaply from a single disk read instead of
 * re-loading per range, and concurrent requests coalesce onto the in-flight load.
 */

import type { Application } from 'express';
import {
  buildUsageDashboard,
  loadUsageDashboardSources,
  type UsageDashboardSources,
} from '@qwen-code/qwen-code-core/services/usage-dashboard-service.js';
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
  /** Injectable for tests; defaults to core's disk-backed source loader. */
  loadSources?: () => Promise<UsageDashboardSources>;
  /** Coalescing/refresh window for the cached sources. Defaults to 60s. */
  cacheTtlMs?: number;
  /** Resolved ledger roots for the current daemon's registered workspaces. */
  getLedgerRuntimeBaseDirs?: () => readonly string[];
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
  const loadSources =
    deps.loadSources ??
    (() => loadUsageDashboardSources(deps.getLedgerRuntimeBaseDirs?.()));
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;

  // Closure-scoped, range-independent source cache (one daemon per process).
  // A pending load is always reused regardless of age, so concurrent requests
  // share one load even when it runs longer than the TTL (the slow transcript-
  // replay path). The TTL window only starts once the load settles; a rejected
  // load clears the cache so the next request retries (and is consumed here so
  // a failed load never surfaces as an unhandled rejection).
  interface SourcesCache {
    promise: Promise<UsageDashboardSources>;
    settledAt: number | null;
  }
  let cache: SourcesCache | null = null;

  const getSources = (): Promise<UsageDashboardSources> => {
    const now = Date.now();
    const fresh =
      cache !== null &&
      (cache.settledAt === null || now - cache.settledAt < ttlMs);
    if (!fresh) {
      const entry: SourcesCache = { promise: loadSources(), settledAt: null };
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
      const { records, ledgerDaily, runtimeScopes } = await getSources();
      const dashboard = buildUsageDashboard(
        records,
        { range, heatmapDays },
        ledgerDaily,
        runtimeScopes,
      );
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

/**
 * Aggregation queries for dashboard stats.
 * Reads from SQLite and returns structured data for the API.
 */

import { getDb } from './db.js';
import type {
  AggregatedStats,
  CostTimeSeriesPoint,
  DashboardStats,
  FolderStats,
  ModelPerformancePoint,
  ModelStats,
  ModelTimeSeriesPoint,
  RecentRequest,
  TimeRange,
  TimeSeriesPoint,
  ToolStatsSummary,
  ToolUsageEntry,
} from './shared-types.js';

interface OverviewRow {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  avgDuration: number | null;
  avgTtft: number | null;
  firstTimestamp: number | null;
  lastTimestamp: number | null;
}

interface ModelRow extends OverviewRow {
  model: string;
}

interface FolderRow extends OverviewRow {
  folder: string;
}

// ---------------------------------------------------------------------------
// Time range helpers
// ---------------------------------------------------------------------------


function getTimeRangeMs(range: TimeRange): number | null {
  switch (range) {
    case '1h':
      return 60 * 60 * 1000;
    case '6h':
      return 6 * 60 * 60 * 1000;
    case '24h':
      return 24 * 60 * 60 * 1000;
    case '7d':
      return 7 * 24 * 60 * 60 * 1000;
    case '30d':
      return 30 * 24 * 60 * 60 * 1000;
    case 'all':
      return null;
  }
}

function getWhereClause(range: TimeRange): { where: string; params: unknown[] } {
  const ms = getTimeRangeMs(range);
  if (ms === null) return { where: '', params: [] };
  const cutoff = Date.now() - ms;
  return { where: 'WHERE timestamp >= ?', params: [cutoff] };
}

// ---------------------------------------------------------------------------
// Overview stats
// ---------------------------------------------------------------------------

function getOverviewStats(range: TimeRange): AggregatedStats {
  const d = getDb();
  const { where, params } = getWhereClause(range);

  const row = d
    .prepare(
      `SELECT
        COUNT(*) as totalRequests,
        SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END) as successfulRequests,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as failedRequests,
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cached_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(thoughts_tokens), 0) as totalCacheWriteTokens,
        AVG(duration_ms) as avgDuration,
        AVG(ttft_ms) as avgTtft,
        MIN(timestamp) as firstTimestamp,
        MAX(timestamp) as lastTimestamp
      FROM api_requests ${where}`,
    )
    .get(...params) as OverviewRow;

  const total = row.totalRequests ?? 0;
  const failed = row.failedRequests ?? 0;
  const inputTokens = row.totalInputTokens ?? 0;
  const cachedTokens = row.totalCacheReadTokens ?? 0;
  const outputTokens = row.totalOutputTokens ?? 0;
  const avgDuration = row.avgDuration;
  const avgTps =
    avgDuration && avgDuration > 0 ? outputTokens / (total * avgDuration / 1000) : null;

  return {
    totalRequests: total,
    successfulRequests: row.successfulRequests ?? 0,
    failedRequests: failed,
    errorRate: total > 0 ? failed / total : 0,
    totalInputTokens: inputTokens,
    totalOutputTokens: outputTokens,
    totalCacheReadTokens: cachedTokens,
    totalCacheWriteTokens: row.totalCacheWriteTokens ?? 0,
    cacheRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
    totalCost: 0, // cost calculation requires model pricing table
    avgDuration: avgDuration ? Math.round(avgDuration) : null,
    avgTtft: row.avgTtft ? Math.round(row.avgTtft) : null,
    avgTokensPerSecond: avgTps ? Math.round(avgTps * 100) / 100 : null,
    firstTimestamp: row.firstTimestamp ?? 0,
    lastTimestamp: row.lastTimestamp ?? 0,
  };
}

// ---------------------------------------------------------------------------
// By-model breakdown
// ---------------------------------------------------------------------------

function getByModelStats(range: TimeRange): ModelStats[] {
  const d = getDb();
  const { where, params } = getWhereClause(range);

  const rows = d
    .prepare(
      `SELECT
        model,
        COUNT(*) as totalRequests,
        SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END) as successfulRequests,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as failedRequests,
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cached_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(thoughts_tokens), 0) as totalCacheWriteTokens,
        AVG(duration_ms) as avgDuration,
        AVG(ttft_ms) as avgTtft,
        MIN(timestamp) as firstTimestamp,
        MAX(timestamp) as lastTimestamp
      FROM api_requests ${where}
      GROUP BY model
      ORDER BY totalRequests DESC`,
    )
    .all(...params) as ModelRow[];

  return rows.map((row) => {
    const total = row.totalRequests ?? 0;
    const failed = row.failedRequests ?? 0;
    const inputTokens = row.totalInputTokens ?? 0;
    const cachedTokens = row.totalCacheReadTokens ?? 0;
    const outputTokens = row.totalOutputTokens ?? 0;
    const avgDuration = row.avgDuration;
    const avgTps =
      avgDuration && avgDuration > 0 ? outputTokens / (total * avgDuration / 1000) : null;

    return {
      model: row.model,
      totalRequests: total,
      successfulRequests: row.successfulRequests ?? 0,
      failedRequests: failed,
      errorRate: total > 0 ? failed / total : 0,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      totalCacheReadTokens: cachedTokens,
      totalCacheWriteTokens: row.totalCacheWriteTokens ?? 0,
      cacheRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
      totalCost: 0,
      avgDuration: avgDuration ? Math.round(avgDuration) : null,
      avgTtft: row.avgTtft ? Math.round(row.avgTtft) : null,
      avgTokensPerSecond: avgTps ? Math.round(avgTps * 100) / 100 : null,
      firstTimestamp: row.firstTimestamp ?? 0,
      lastTimestamp: row.lastTimestamp ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// By-folder breakdown
// ---------------------------------------------------------------------------

function getByFolderStats(range: TimeRange): FolderStats[] {
  const d = getDb();
  const { where, params } = getWhereClause(range);

  const rows = d
    .prepare(
      `SELECT
        folder,
        COUNT(*) as totalRequests,
        SUM(CASE WHEN is_error = 0 THEN 1 ELSE 0 END) as successfulRequests,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as failedRequests,
        COALESCE(SUM(input_tokens), 0) as totalInputTokens,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(cached_tokens), 0) as totalCacheReadTokens,
        COALESCE(SUM(thoughts_tokens), 0) as totalCacheWriteTokens,
        AVG(duration_ms) as avgDuration,
        AVG(ttft_ms) as avgTtft,
        MIN(timestamp) as firstTimestamp,
        MAX(timestamp) as lastTimestamp
      FROM api_requests ${where}
      GROUP BY folder
      ORDER BY totalRequests DESC
      LIMIT 50`,
    )
    .all(...params) as FolderRow[];

  return rows.map((row) => {
    const total = row.totalRequests ?? 0;
    const failed = row.failedRequests ?? 0;
    const inputTokens = row.totalInputTokens ?? 0;
    const cachedTokens = row.totalCacheReadTokens ?? 0;
    const outputTokens = row.totalOutputTokens ?? 0;
    const avgDuration = row.avgDuration;
    const avgTps =
      avgDuration && avgDuration > 0 ? outputTokens / (total * avgDuration / 1000) : null;

    return {
      folder: row.folder,
      totalRequests: total,
      successfulRequests: row.successfulRequests ?? 0,
      failedRequests: failed,
      errorRate: total > 0 ? failed / total : 0,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      totalCacheReadTokens: cachedTokens,
      totalCacheWriteTokens: row.totalCacheWriteTokens ?? 0,
      cacheRate: inputTokens > 0 ? cachedTokens / inputTokens : 0,
      totalCost: 0,
      avgDuration: avgDuration ? Math.round(avgDuration) : null,
      avgTtft: row.avgTtft ? Math.round(row.avgTtft) : null,
      avgTokensPerSecond: avgTps ? Math.round(avgTps * 100) / 100 : null,
      firstTimestamp: row.firstTimestamp ?? 0,
      lastTimestamp: row.lastTimestamp ?? 0,
    };
  });
}

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

function getTimeSeries(range: TimeRange): TimeSeriesPoint[] {
  const d = getDb();
  const { where, params } = getWhereClause(range);

  // Bucket size depends on range
  const ms = getTimeRangeMs(range);
  let bucketExpr: string;
  if (!ms || ms > 7 * 24 * 60 * 60 * 1000) {
    bucketExpr = "strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch')";
  } else if (ms > 24 * 60 * 60 * 1000) {
    bucketExpr = "strftime('%Y-%m-%d %H:00', timestamp / 1000, 'unixepoch')";
  } else {
    bucketExpr = "strftime('%Y-%m-%d %H:%M', timestamp / 1000, 'unixepoch')";
  }

  const rows = d
    .prepare(
      `SELECT
        ${bucketExpr} as bucket,
        MIN(timestamp) as timestamp,
        COUNT(*) as requests,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(cached_tokens), 0) as cachedTokens,
        SUM(CASE WHEN is_error = 1 THEN 1 ELSE 0 END) as errors,
        0 as cost
      FROM api_requests ${where}
      GROUP BY bucket
      ORDER BY bucket`,
    )
    .all(...params) as Array<{
    timestamp: number;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    errors: number;
    cost: number;
  }>;

  return rows;
}

function getModelTimeSeries(range: TimeRange): ModelTimeSeriesPoint[] {
  const d = getDb();
  const { where, params } = getWhereClause(range);

  const rows = d
    .prepare(
      `SELECT
        strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') as date,
        model,
        COUNT(*) as requests,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens,
        COALESCE(SUM(cached_tokens), 0) as cachedTokens,
        0 as cost
      FROM api_requests ${where}
      GROUP BY date, model
      ORDER BY date, model`,
    )
    .all(...params) as ModelTimeSeriesPoint[];

  return rows;
}

function getModelPerformance(range: TimeRange): ModelPerformancePoint[] {
  const d = getDb();
  const { where, params } = getWhereClause(range);

  const rows = d
    .prepare(
      `SELECT
        strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') as date,
        model,
        AVG(duration_ms) as avgDuration,
        AVG(ttft_ms) as avgTtft,
        COUNT(*) as requests,
        COALESCE(SUM(output_tokens), 0) as totalOutputTokens,
        COALESCE(SUM(duration_ms), 0) as totalDurationMs
      FROM api_requests ${where}
      GROUP BY date, model
      ORDER BY date, model`,
    )
    .all(...params) as Array<{
    date: string;
    model: string;
    avgDuration: number | null;
    avgTtft: number | null;
    requests: number;
    totalOutputTokens: number;
    totalDurationMs: number;
  }>;

  return rows.map((row) => ({
    date: row.date,
    model: row.model,
    avgDuration: row.avgDuration ? Math.round(row.avgDuration) : null,
    avgTtft: row.avgTtft ? Math.round(row.avgTtft) : null,
    avgTokensPerSecond:
      row.totalDurationMs > 0
        ? Math.round((row.totalOutputTokens / (row.totalDurationMs / 1000)) * 100) / 100
        : null,
    requests: row.requests,
  }));
}

function getCostTimeSeries(range: TimeRange): CostTimeSeriesPoint[] {
  const d = getDb();
  const { where, params } = getWhereClause(range);

  const rows = d
    .prepare(
      `SELECT
        strftime('%Y-%m-%d', timestamp / 1000, 'unixepoch') as date,
        0 as cost,
        COUNT(*) as requests,
        COALESCE(SUM(input_tokens), 0) as inputTokens,
        COALESCE(SUM(output_tokens), 0) as outputTokens
      FROM api_requests ${where}
      GROUP BY date
      ORDER BY date`,
    )
    .all(...params) as CostTimeSeriesPoint[];

  return rows;
}

// ---------------------------------------------------------------------------
// Recent requests
// ---------------------------------------------------------------------------

function getRecentRequests(range: TimeRange, limit = 50): RecentRequest[] {
  const d = getDb();
  const { where, params } = getWhereClause(range);

  const rows = d
    .prepare(
      `SELECT id, session_id, folder, model, provider, timestamp,
              duration_ms, ttft_ms, input_tokens, output_tokens,
              cached_tokens, total_tokens, is_error, error_type, error_status
       FROM api_requests ${where}
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(...params, limit) as Array<{
    id: string;
    session_id: string;
    folder: string;
    model: string;
    provider: string;
    timestamp: number;
    duration_ms: number | null;
    ttft_ms: number | null;
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    total_tokens: number;
    is_error: number;
    error_type: string | null;
    error_status: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    folder: r.folder,
    model: r.model,
    provider: r.provider,
    timestamp: r.timestamp,
    durationMs: r.duration_ms,
    ttftMs: r.ttft_ms,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    cachedTokens: r.cached_tokens,
    totalTokens: r.total_tokens,
    isError: r.is_error === 1,
    errorType: r.error_type,
    errorStatus: r.error_status,
  }));
}

// ---------------------------------------------------------------------------
// Tool stats
// ---------------------------------------------------------------------------

function getToolStats(range: TimeRange): ToolStatsSummary {
  const d = getDb();
  const { where, params } = getWhereClause(range);

  const totalRow = d
    .prepare(
      `SELECT
        COUNT(*) as totalCalls,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCalls
      FROM tool_calls ${where}`,
    )
    .get(...params) as { totalCalls: number; successCalls: number };

  const byToolRows = d
    .prepare(
      `SELECT
        tool_name,
        COUNT(*) as calls,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successCalls,
        AVG(duration_ms) as avgDurationMs
      FROM tool_calls ${where}
      GROUP BY tool_name
      ORDER BY calls DESC
      LIMIT 30`,
    )
    .all(...params) as Array<{
    tool_name: string;
    calls: number;
    successCalls: number;
    avgDurationMs: number | null;
  }>;

  const byTool: ToolUsageEntry[] = byToolRows.map((r) => ({
    toolName: r.tool_name,
    calls: r.calls,
    successRate: r.calls > 0 ? r.successCalls / r.calls : 0,
    avgDurationMs: r.avgDurationMs ? Math.round(r.avgDurationMs) : null,
  }));

  return {
    totalCalls: totalRow.totalCalls ?? 0,
    successRate:
      totalRow.totalCalls > 0 ? (totalRow.successCalls ?? 0) / totalRow.totalCalls : 0,
    byTool,
  };
}

// ---------------------------------------------------------------------------
// Main dashboard query
// ---------------------------------------------------------------------------

export function getDashboardStats(range: TimeRange = '24h'): DashboardStats {
  return {
    overview: getOverviewStats(range),
    byModel: getByModelStats(range),
    byFolder: getByFolderStats(range),
    timeSeries: getTimeSeries(range),
    modelTimeSeries: getModelTimeSeries(range),
    modelPerformance: getModelPerformance(range),
    costTimeSeries: getCostTimeSeries(range),
    recentRequests: getRecentRequests(range),
    toolStats: getToolStats(range),
  };
}

export { getOverviewStats, getByModelStats, getByFolderStats, getTimeSeries, getToolStats };
export type { TimeRange } from './shared-types.js';

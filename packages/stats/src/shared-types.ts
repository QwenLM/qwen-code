/**
 * Shared type definitions consumed by both the server-side stats code and the
 * standalone client bundle. Keep this file free of any imports from server-only
 * packages (e.g. @oh-my-pi/pi-ai, bun:sqlite) so the client can import it
 * without dragging server dependencies into its bundle.
 */

// ---------------------------------------------------------------------------
// Time range
// ---------------------------------------------------------------------------

export type TimeRange = '1h' | '6h' | '24h' | '7d' | '30d' | 'all';

// ---------------------------------------------------------------------------
// Aggregated stats interfaces
// ---------------------------------------------------------------------------

/** Aggregated stats for a model or folder. */
export interface AggregatedStats {
  /** Total number of requests */
  totalRequests: number;
  /** Number of successful requests */
  successfulRequests: number;
  /** Number of failed requests */
  failedRequests: number;
  /** Error rate (0-1) */
  errorRate: number;
  /** Total input tokens */
  totalInputTokens: number;
  /** Total output tokens */
  totalOutputTokens: number;
  /** Total cache read tokens */
  totalCacheReadTokens: number;
  /** Total cache write tokens */
  totalCacheWriteTokens: number;
  /** Cache hit rate (0-1) */
  cacheRate: number;
  /** Total cost */
  totalCost: number;
  /** Average duration in ms */
  avgDuration: number | null;
  /** Average TTFT in ms */
  avgTtft: number | null;
  /** Average tokens per second (output tokens / duration) */
  avgTokensPerSecond: number | null;
  /** Time range */
  firstTimestamp: number;
  lastTimestamp: number;
}

/** Stats grouped by model. */
export interface ModelStats extends AggregatedStats {
  model: string;
}

/** Stats grouped by folder. */
export interface FolderStats extends AggregatedStats {
  folder: string;
}

/** Time series data point. */
export interface TimeSeriesPoint {
  timestamp: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  errors: number;
  cost: number;
}

/** Model usage time series data point (daily buckets). */
export interface ModelTimeSeriesPoint {
  date: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  cost: number;
}

/** Model performance time series data point (daily buckets). */
export interface ModelPerformancePoint {
  date: string;
  model: string;
  avgDuration: number | null;
  avgTtft: number | null;
  avgTokensPerSecond: number | null;
  requests: number;
}

/** Cost time series data point (daily buckets). */
export interface CostTimeSeriesPoint {
  date: string;
  cost: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

/** Overall dashboard stats. */
export interface DashboardStats {
  overview: AggregatedStats;
  byModel: ModelStats[];
  byFolder: FolderStats[];
  timeSeries: TimeSeriesPoint[];
  modelTimeSeries: ModelTimeSeriesPoint[];
  modelPerformance: ModelPerformancePoint[];
  costTimeSeries: CostTimeSeriesPoint[];
  recentRequests: RecentRequest[];
  toolStats: ToolStatsSummary;
}

/** A recent API request for the detail list. */
export interface RecentRequest {
  id: string;
  sessionId: string;
  folder: string;
  model: string;
  provider: string;
  timestamp: number;
  durationMs: number | null;
  ttftMs: number | null;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  isError: boolean;
  errorType: string | null;
  errorStatus: number | null;
}

/** Tool usage summary. */
export interface ToolStatsSummary {
  totalCalls: number;
  successRate: number;
  byTool: ToolUsageEntry[];
}

/** Per-tool usage entry. */
export interface ToolUsageEntry {
  toolName: string;
  calls: number;
  successRate: number;
  avgDurationMs: number | null;
}

/** Sync status response. */
export interface SyncStatus {
  syncing: boolean;
  progress: {
    totalFiles: number;
    processedFiles: number;
    currentFile: string;
    totalApiRequests: number;
    totalToolCalls: number;
  } | null;
  lastSyncAt: number | null;
}

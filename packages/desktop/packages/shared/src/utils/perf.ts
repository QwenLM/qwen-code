/**
 * Performance Instrumentation
 *
 * Lightweight performance tracking for identifying bottlenecks.
 * Logs to stderr with aggregated statistics.
 *
 * IMPORTANT: Disabled by default. Only active when:
 * - CLI: --debug flag is passed (calls enableDebug())
 * - Electron: Running from source (!app.isPackaged)
 *
 * Usage:
 *   const end = perf.start('session.load')
 *   // ... do work ...
 *   end() // logs duration
 *
 *   // Or with async operations:
 *   const result = await perf.measure('mcp.connect', async () => {
 *     return connectToServer()
 *   })
 *
 *   // Nested spans for detailed breakdown:
 *   const span = perf.span('agent.init')
 *   span.mark('config.loaded')
 *   span.mark('mcp.connected')
 *   span.end() // logs total + breakdown
 */

import { isDebugEnabled } from './debug.ts';

// Performance metrics storage
interface PerfMetric {
  name: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  marks: Array<{ name: string; time: number; elapsed: number }>;
  metadata?: Record<string, unknown>;
}

interface PerfConfig {
  enabled: boolean;
  logToFile: boolean;
  logFilePath: string;
  minDurationMs: number; // Only log operations above this threshold
  onMetric?: (metric: PerfMetric) => void; // Custom handler (e.g., for IPC)
}

const config: PerfConfig = {
  enabled: false, // Disabled by default, use setPerfEnabled(true) or relies on isDebugEnabled()
  logToFile: false, // File logging disabled, use stderr instead
  logFilePath: '', // Not used
  minDurationMs: 0, // Log everything by default
};

// Store recent metrics for analysis
const recentMetrics: PerfMetric[] = [];
const MAX_RECENT_METRICS = 1000;

// Aggregated stats per operation name
const aggregatedStats = new Map<
  string,
  {
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    durations: number[];
  }
>();

/**
 * Configure performance tracking
 */
export function configurePerfTracking(options: Partial<PerfConfig>): void {
  Object.assign(config, options);
}

/**
 * Enable/disable perf tracking at runtime
 */
export function setPerfEnabled(enabled: boolean): void {
  config.enabled = enabled;
}

/**
 * Check if perf tracking is enabled.
 * Returns true if explicitly enabled OR if debug mode is active.
 */
export function isPerfEnabled(): boolean {
  return config.enabled || isDebugEnabled();
}

/**
 * Format a metric for logging
 */
function formatMetric(metric: PerfMetric): string {
  const timestamp = new Date().toISOString();
  const duration = metric.duration?.toFixed(2) ?? 'N/A';

  let line = `${timestamp} [PERF] ${metric.name}: ${duration}ms`;

  // Add marks breakdown if any
  if (metric.marks.length > 0) {
    const markStr = metric.marks
      .map((m) => `${m.name}:${m.elapsed.toFixed(1)}ms`)
      .join(' → ');
    line += ` (${markStr})`;
  }

  // Add metadata if any
  if (metric.metadata && Object.keys(metric.metadata).length > 0) {
    line += ` ${JSON.stringify(metric.metadata)}`;
  }

  return line;
}

/**
 * Log a completed metric
 */
function logMetric(metric: PerfMetric): void {
  if (!isPerfEnabled()) return;
  if (metric.duration !== undefined && metric.duration < config.minDurationMs)
    return;

  // Store in recent metrics
  recentMetrics.push(metric);
  if (recentMetrics.length > MAX_RECENT_METRICS) {
    recentMetrics.shift();
  }

  // Update aggregated stats
  updateAggregatedStats(metric);

  // Call custom handler if set
  if (config.onMetric) {
    config.onMetric(metric);
  }

  // Log to stderr (avoids interfering with stdout)
  if (metric.duration !== undefined) {
    const line = formatMetric(metric);
    process.stderr.write(line + '\n');
  }
}

/**
 * Update aggregated statistics for an operation
 */
function updateAggregatedStats(metric: PerfMetric): void {
  if (metric.duration === undefined) return;

  let stats = aggregatedStats.get(metric.name);
  if (!stats) {
    stats = {
      count: 0,
      totalMs: 0,
      minMs: Infinity,
      maxMs: 0,
      avgMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      durations: [],
    };
    aggregatedStats.set(metric.name, stats);
  }

  stats.count++;
  stats.totalMs += metric.duration;
  stats.minMs = Math.min(stats.minMs, metric.duration);
  stats.maxMs = Math.max(stats.maxMs, metric.duration);
  stats.avgMs = stats.totalMs / stats.count;

  // Keep durations for percentile calculation (limited to last 100)
  stats.durations.push(metric.duration);
  if (stats.durations.length > 100) {
    stats.durations.shift();
  }

  // Calculate percentiles
  const sorted = [...stats.durations].sort((a, b) => a - b);
  stats.p50Ms = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
  stats.p95Ms = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
}

/**
 * Start a simple timing operation
 * Returns a function to call when the operation completes
 */
export function start(
  name: string,
  metadata?: Record<string, unknown>
): () => number {
  const startTime = performance.now();

  return () => {
    const endTime = performance.now();
    const duration = endTime - startTime;

    const metric: PerfMetric = {
      name,
      startTime,
      endTime,
      duration,
      marks: [],
      metadata,
    };

    logMetric(metric);
    return duration;
  };
}

/**
 * Measure an async operation
 */
export async function measure<T>(
  name: string,
  fn: () => Promise<T>,
  metadata?: Record<string, unknown>
): Promise<T> {
  const end = start(name, metadata);
  try {
    return await fn();
  } finally {
    end();
  }
}

/**
 * Measure a sync operation
 */
export function measureSync<T>(
  name: string,
  fn: () => T,
  metadata?: Record<string, unknown>
): T {
  const end = start(name, metadata);
  try {
    return fn();
  } finally {
    end();
  }
}

/**
 * Create a span for measuring operations with intermediate marks
 */
export interface PerfSpan {
  /** Add a checkpoint mark */
  mark(name: string): void;
  /** Add metadata to the span */
  setMetadata(key: string, value: unknown): void;
  /** End the span and log results */
  end(): number;
  /** Get elapsed time without ending */
  elapsed(): number;
}

export function span(name: string, metadata?: Record<string, unknown>): PerfSpan {
  const startTime = performance.now();
  const marks: Array<{ name: string; time: number; elapsed: number }> = [];
  const spanMetadata: Record<string, unknown> = { ...metadata };

  return {
    mark(markName: string): void {
      const time = performance.now();
      const elapsed = time - startTime;
      marks.push({ name: markName, time, elapsed });
    },

    setMetadata(key: string, value: unknown): void {
      spanMetadata[key] = value;
    },

    elapsed(): number {
      return performance.now() - startTime;
    },

    end(): number {
      const endTime = performance.now();
      const duration = endTime - startTime;

      const metric: PerfMetric = {
        name,
        startTime,
        endTime,
        duration,
        marks,
        metadata:
          Object.keys(spanMetadata).length > 0 ? spanMetadata : undefined,
      };

      logMetric(metric);
      return duration;
    },
  };
}

/**
 * Get aggregated statistics for all operations
 */
export function getStats(): Map<
  string,
  {
    count: number;
    totalMs: number;
    minMs: number;
    maxMs: number;
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
  }
> {
  // Return copy without the durations array
  const result = new Map<
    string,
    {
      count: number;
      totalMs: number;
      minMs: number;
      maxMs: number;
      avgMs: number;
      p50Ms: number;
      p95Ms: number;
    }
  >();

  for (const [name, stats] of aggregatedStats) {
    result.set(name, {
      count: stats.count,
      totalMs: stats.totalMs,
      minMs: stats.minMs,
      maxMs: stats.maxMs,
      avgMs: stats.avgMs,
      p50Ms: stats.p50Ms,
      p95Ms: stats.p95Ms,
    });
  }

  return result;
}

/**
 * Get recent metrics (for debugging/analysis)
 */
export function getRecentMetrics(): PerfMetric[] {
  return [...recentMetrics];
}

/**
 * Clear all collected metrics and stats
 */
export function clearMetrics(): void {
  recentMetrics.length = 0;
  aggregatedStats.clear();
}

/**
 * Format stats as a summary table (for console output)
 */
export function formatStatsSummary(): string {
  const stats = getStats();
  if (stats.size === 0) {
    return 'No performance metrics collected';
  }

  const lines: string[] = [];
  lines.push('Performance Summary:');
  lines.push('─'.repeat(80));
  lines.push(
    'Operation'.padEnd(40) +
      'Count'.padStart(8) +
      'Avg'.padStart(10) +
      'P50'.padStart(10) +
      'P95'.padStart(10)
  );
  lines.push('─'.repeat(80));

  // Sort by total time descending
  const sorted = [...stats.entries()].sort(
    (a, b) => b[1].totalMs - a[1].totalMs
  );

  for (const [name, s] of sorted) {
    lines.push(
      name.padEnd(40) +
        s.count.toString().padStart(8) +
        `${s.avgMs.toFixed(1)}ms`.padStart(10) +
        `${s.p50Ms.toFixed(1)}ms`.padStart(10) +
        `${s.p95Ms.toFixed(1)}ms`.padStart(10)
    );
  }

  lines.push('─'.repeat(80));
  return lines.join('\n');
}

// Export a default object for convenient namespaced usage
export const perf = {
  start,
  measure,
  measureSync,
  span,
  getStats,
  getRecentMetrics,
  clearMetrics,
  formatStatsSummary,
  configure: configurePerfTracking,
  setEnabled: setPerfEnabled,
  isEnabled: isPerfEnabled,
};

export default perf;

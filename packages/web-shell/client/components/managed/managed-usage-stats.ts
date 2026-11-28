/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionUsageStatsSnapshot } from '../artifacts/tokenUsageTotals';
import type { ManagedDiagnosticStats } from './managed-agent-provider';

/**
 * Projects a Managed session's diagnostic statistics envelope onto the
 * backend-neutral snapshot consumed by {@link ComposerUsageStats}.
 *
 * Fails closed when statistics are unsupported, unrecorded, or carry no known
 * token counts. Uses `statistics.totals` so truncated or omitted per-model
 * breakdowns still report complete session totals, leaves `promptCount` at `0`
 * (Managed tracks LLM requests rather than user turns), and marks
 * `cacheHitUnknown` when no request reported cached token counts.
 */
export function managedDiagnosticStatsToUsageSnapshot(
  stats: ManagedDiagnosticStats,
): SessionUsageStatsSnapshot {
  const empty: SessionUsageStatsSnapshot = {
    sessionId: stats.sessionId,
    promptCount: 0,
    models: {},
  };
  if (
    stats.availability === 'unsupported' ||
    stats.availability === 'not_recorded' ||
    !stats.statistics
  ) {
    return empty;
  }
  const totals = stats.statistics.totals;
  const hasKnownTokens =
    totals.usageKnown.total > 0 ||
    totals.usageKnown.prompt > 0 ||
    totals.usageKnown.candidates > 0;
  if (totals.requests.total <= 0 || !hasKnownTokens) {
    return empty;
  }
  return {
    sessionId: stats.sessionId,
    promptCount: 0,
    cacheHitUnknown: totals.usageKnown.cached <= 0,
    models: {
      totals: {
        api: {
          totalRequests: totals.requests.total,
          totalErrors: totals.requests.error,
          totalLatencyMs: totals.latencyMs,
        },
        tokens: {
          prompt: totals.tokens.prompt,
          candidates: totals.tokens.candidates,
          total: totals.tokens.total,
          cached: totals.usageKnown.cached > 0 ? totals.tokens.cached : 0,
          thoughts: totals.tokens.thoughts,
        },
        // Managed exposes generation-window throughput timing rather than
        // full-request output-speed duration; omitting totalOutputSpeedDurationMs
        // selects the matching generation-window rate formula in outputSpeed.
        generation: {
          timedRequests: totals.timing.generationCount,
          totalTtftMs: totals.timing.totalTtftMs,
          totalGenerationDurationMs: totals.timing.totalGenerationMs,
          totalThroughputOutputTokens: totals.timing.throughputOutputTokens,
        },
      },
    },
  };
}

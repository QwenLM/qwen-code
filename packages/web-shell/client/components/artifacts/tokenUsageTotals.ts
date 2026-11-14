/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  DaemonSessionStatsModelMetrics,
  DaemonSessionStatsStatus,
} from '@qwen-code/web-shell/daemon-react-sdk';
import { isLegacySpeed, tokensPerSecond } from './TokenUsageTrend';

type ModelTokens = DaemonSessionStatsModelMetrics['tokens'];
type ModelGeneration = NonNullable<
  DaemonSessionStatsModelMetrics['generation']
>;

/** Prompt-side tokens; `prompt` already includes the cached part. */
export function inputTokens(tokens: ModelTokens): number {
  return tokens.prompt > 0 ? tokens.prompt : tokens.cached;
}

export function totalTokens(tokens: ModelTokens): number {
  const input = inputTokens(tokens);
  return tokens.total > 0
    ? Math.max(tokens.total, input + tokens.candidates)
    : input + tokens.candidates + tokens.thoughts;
}

export function outputTokens(tokens: ModelTokens): number {
  return Math.max(0, totalTokens(tokens) - inputTokens(tokens));
}

/** Compact token counts: 1,390,000 → "1.39M", 199,076 → "199.1K". */
export function formatCompact(n: number): string {
  if (n >= 999_995_000) return trimZeros((n / 1_000_000_000).toFixed(2)) + 'B';
  if (n >= 999_950) return trimZeros((n / 1_000_000).toFixed(2)) + 'M';
  if (n >= 1_000) return trimZeros((n / 1_000).toFixed(1)) + 'K';
  return String(n);
}

function trimZeros(value: string): string {
  return value.replace(/\.?0+$/, '');
}

/**
 * Token-weighted output tokens per second over the timed requests' time from
 * sending each request to its last visible output, TTFT included. Older
 * daemons do not send that time; their sums only support their own rate over
 * the generation window.
 */
export function outputSpeed(
  generation: DaemonSessionStatsModelMetrics['generation'],
  legacy: boolean,
): number | undefined {
  if (!generation) return undefined;
  return legacy
    ? tokensPerSecond(
        generation.totalThroughputOutputTokens,
        generation.totalGenerationDurationMs,
      )
    : tokensPerSecond(
        generation.totalOutputSpeedTokens ?? 0,
        generation.totalOutputSpeedDurationMs ?? 0,
      );
}

export interface SessionUsageTotals {
  prompt: number;
  cached: number;
  output: number;
  thoughts: number;
  total: number;
  requests: number;
  failed: number;
  generation: Required<ModelGeneration>;
  /** The daemon predates the full-request speed fields. */
  legacySpeed: boolean;
}

/** Session-wide sums over every model that served a request. */
export function summarizeSessionUsage(
  status: DaemonSessionStatsStatus,
): SessionUsageTotals {
  const totals: SessionUsageTotals = {
    prompt: 0,
    cached: 0,
    output: 0,
    thoughts: 0,
    total: 0,
    requests: 0,
    failed: 0,
    generation: {
      timedRequests: 0,
      totalTtftMs: 0,
      totalGenerationDurationMs: 0,
      totalThroughputOutputTokens: 0,
      totalTimedGenerationDurationMs: 0,
      totalOutputSpeedTokens: 0,
      totalOutputSpeedDurationMs: 0,
    },
    legacySpeed: false,
  };
  for (const metrics of Object.values(status.models)) {
    if (metrics.api.totalRequests <= 0) continue;
    totals.prompt += inputTokens(metrics.tokens);
    totals.cached += metrics.tokens.cached;
    totals.output += outputTokens(metrics.tokens);
    totals.thoughts += metrics.tokens.thoughts;
    totals.total += totalTokens(metrics.tokens);
    totals.requests += metrics.api.totalRequests;
    totals.failed += metrics.api.totalErrors;
    const g = metrics.generation;
    if (g) {
      // Every model comes from the same daemon, so one tells which rule applies.
      if (isLegacySpeed(g)) totals.legacySpeed = true;
      totals.generation.timedRequests += g.timedRequests;
      totals.generation.totalTtftMs += g.totalTtftMs;
      totals.generation.totalGenerationDurationMs +=
        g.totalGenerationDurationMs;
      totals.generation.totalThroughputOutputTokens +=
        g.totalThroughputOutputTokens;
      totals.generation.totalTimedGenerationDurationMs +=
        g.totalTimedGenerationDurationMs ?? 0;
      totals.generation.totalOutputSpeedTokens += g.totalOutputSpeedTokens ?? 0;
      totals.generation.totalOutputSpeedDurationMs +=
        g.totalOutputSpeedDurationMs ?? 0;
    }
  }
  return totals;
}

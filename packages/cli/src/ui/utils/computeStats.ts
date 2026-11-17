/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerationMetrics } from '@qwen-code/qwen-code-core';
import type {
  SessionMetrics,
  ComputedSessionStats,
  ModelMetricsCore,
} from '../contexts/SessionContext.js';

/**
 * Output tokens per second over `durationMs`; undefined without output tokens
 * (no usage reported) or time.
 */
export function outputTokensPerSecond(
  outputTokens: number,
  durationMs: number,
): number | undefined {
  return outputTokens > 0 && durationMs > 0
    ? outputTokens / (durationMs / 1000)
    : undefined;
}

/**
 * Latest-request TPS, average TTFT and session TPS for `/stats`. TPS covers
 * the time from sending a request to its last visible output, TTFT included;
 * session TPS is token-weighted.
 */
export function computeGenerationRates(
  generation: GenerationMetrics | undefined,
): {
  lastTps: number | undefined;
  averageTtft: number | undefined;
  sessionTps: number | undefined;
} {
  const last = generation?.last;
  return {
    lastTps: last
      ? outputTokensPerSecond(
          last.outputTokens,
          last.ttftMs + last.generationDurationMs,
        )
      : undefined,
    averageTtft:
      generation && generation.timedRequests > 0
        ? generation.totalTtftMs / generation.timedRequests
        : undefined,
    sessionTps: generation
      ? outputTokensPerSecond(
          generation.totalOutputSpeedTokens,
          generation.totalOutputSpeedDurationMs,
        )
      : undefined,
  };
}

export function calculateErrorRate(metrics: ModelMetricsCore): number {
  if (metrics.api.totalRequests === 0) {
    return 0;
  }
  return (metrics.api.totalErrors / metrics.api.totalRequests) * 100;
}

export function calculateAverageLatency(metrics: ModelMetricsCore): number {
  if (metrics.api.totalRequests === 0) {
    return 0;
  }
  return metrics.api.totalLatencyMs / metrics.api.totalRequests;
}

export function calculateCacheHitRate(metrics: ModelMetricsCore): number {
  if (metrics.tokens.prompt === 0) {
    return 0;
  }
  return (metrics.tokens.cached / metrics.tokens.prompt) * 100;
}

export const computeSessionStats = (
  metrics: SessionMetrics,
): ComputedSessionStats => {
  const { models, tools, files } = metrics;
  const totalApiTime = Object.values(models).reduce(
    (acc, model) => acc + model.api.totalLatencyMs,
    0,
  );
  const totalToolTime = tools.totalDurationMs;
  const agentActiveTime = totalApiTime + totalToolTime;
  const apiTimePercent =
    agentActiveTime > 0 ? (totalApiTime / agentActiveTime) * 100 : 0;
  const toolTimePercent =
    agentActiveTime > 0 ? (totalToolTime / agentActiveTime) * 100 : 0;

  const totalCachedTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.cached,
    0,
  );
  const totalPromptTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.prompt,
    0,
  );
  const cacheEfficiency =
    totalPromptTokens > 0 ? (totalCachedTokens / totalPromptTokens) * 100 : 0;

  const totalDecisions =
    tools.totalDecisions.accept +
    tools.totalDecisions.reject +
    tools.totalDecisions.modify;
  const successRate =
    tools.totalCalls > 0 ? (tools.totalSuccess / tools.totalCalls) * 100 : 0;
  const agreementRate =
    totalDecisions > 0
      ? (tools.totalDecisions.accept / totalDecisions) * 100
      : 0;

  return {
    totalApiTime,
    totalToolTime,
    agentActiveTime,
    apiTimePercent,
    toolTimePercent,
    cacheEfficiency,
    totalDecisions,
    successRate,
    agreementRate,
    totalCachedTokens,
    totalPromptTokens,
    totalLinesAdded: files.totalLinesAdded,
    totalLinesRemoved: files.totalLinesRemoved,
  };
};

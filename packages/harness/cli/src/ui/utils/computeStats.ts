/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  SessionStats,
  ComputedSessionStats,
  ModelStats,
} from '../contexts/SessionContext.js';

export function calculateErrorRate(stats: ModelStats): number {
  if (stats.api.totalRequests === 0) {
    return 0;
  }
  return (stats.api.totalErrors / stats.api.totalRequests) * 100;
}

export function calculateAverageLatency(stats: ModelStats): number {
  if (stats.api.totalRequests === 0) {
    return 0;
  }
  return stats.api.totalLatencyMs / stats.api.totalRequests;
}

export function calculateCacheHitRate(stats: ModelStats): number {
  if (stats.tokens.prompt === 0) {
    return 0;
  }
  return (stats.tokens.cached / stats.tokens.prompt) * 100;
}

export const computeSessionStats = (
  stats: SessionStats,
): ComputedSessionStats => {
  const { models, tools, files } = stats;
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
  const totalInputTokens = Object.values(models).reduce(
    (acc, model) => acc + model.tokens.input,
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
    tools.totalDecisions.modify +
    tools.totalDecisions.auto_accept;
  const successRate =
    tools.totalCalls > 0 ? (tools.totalSuccess / tools.totalCalls) * 100 : 0;
  const agreementRate =
    totalDecisions > 0
      ? ((tools.totalDecisions.accept + tools.totalDecisions.auto_accept) /
          totalDecisions) *
        100
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
    totalInputTokens,
    totalPromptTokens,
    totalLinesAdded: files.totalLinesAdded,
    totalLinesRemoved: files.totalLinesRemoved,
  };
};

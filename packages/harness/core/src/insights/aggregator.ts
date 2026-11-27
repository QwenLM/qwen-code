/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionMeta, SessionFacets, AggregatedData } from './types.js';

/**
 * Aggregates session metadata and facets into rollup statistics.
 * Pure synchronous function with no I/O.
 */
export function aggregateData(
  sessions: SessionMeta[],
  facets: SessionFacets[],
): AggregatedData {
  const topicCounts = new Map<string, number>();
  const languageCounts = new Map<string, number>();
  const intentCounts = new Map<string, number>();
  const hourlyDistribution = new Array<number>(24).fill(0);
  const dailyDistribution = new Map<string, number>();
  const complexityDistribution = { low: 0, medium: 0, high: 0 };

  let totalMessages = 0;
  let totalUserMessages = 0;
  let minTime = Infinity;
  let maxTime = -Infinity;

  // Aggregate from session metadata
  for (const session of sessions) {
    totalMessages += session.messageCount;
    totalUserMessages += session.userMessageCount;

    if (session.startTime < minTime) {
      minTime = session.startTime;
    }
    if (session.lastUpdated > maxTime) {
      maxTime = session.lastUpdated;
    }

    // Hourly distribution based on session start time
    const hour = new Date(session.startTime).getHours();
    hourlyDistribution[hour]++;

    // Daily distribution based on session start date
    const dateKey = new Date(session.startTime).toISOString().slice(0, 10);
    dailyDistribution.set(dateKey, (dailyDistribution.get(dateKey) ?? 0) + 1);
  }

  // Aggregate from facets
  for (const facet of facets) {
    for (const topic of facet.topics ?? []) {
      const normalized = topic.toLowerCase();
      topicCounts.set(normalized, (topicCounts.get(normalized) ?? 0) + 1);
    }

    for (const language of facet.languages ?? []) {
      const normalized = language.toLowerCase();
      languageCounts.set(normalized, (languageCounts.get(normalized) ?? 0) + 1);
    }

    for (const intent of facet.intents ?? []) {
      const normalized = intent.toLowerCase();
      intentCounts.set(normalized, (intentCounts.get(normalized) ?? 0) + 1);
    }

    complexityDistribution[facet.complexityEstimate]++;
  }

  return {
    totalSessions: sessions.length,
    totalMessages,
    totalUserMessages,
    dateRange: {
      start: minTime === Infinity ? Date.now() : minTime,
      end: maxTime === -Infinity ? Date.now() : maxTime,
    },
    topicCounts,
    languageCounts,
    intentCounts,
    hourlyDistribution,
    dailyDistribution,
    complexityDistribution,
  };
}

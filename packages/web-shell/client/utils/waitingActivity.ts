/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Summaries for the waiting card: the task's Q&A timeline and token usage.

export const WAITING_ACTIVITY_BUCKETS = 44;

export interface WaitingActivityBucket {
  count: number;
  /** Inclusive start of the bucket, in epoch milliseconds. */
  startAt?: number;
  /** Exclusive end of the bucket, in epoch milliseconds. */
  endAt?: number;
}

export interface WaitingActivityMessage {
  role?: string;
  timestamp?: number;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    cachedTokens?: number;
  };
}

export interface WaitingTokenUsage {
  input: number;
  output: number;
  cached: number;
  context?: number;
  contextLimit?: number;
}

export interface WaitingTokenUsageFallback {
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/** Buckets user and assistant messages across the task's own timeline. */
export function buildWaitingActivity(
  messages: readonly WaitingActivityMessage[],
  bucketCount = WAITING_ACTIVITY_BUCKETS,
): WaitingActivityBucket[] {
  const count = Math.max(1, Math.floor(bucketCount));
  const points = messages
    .filter(
      (message) =>
        (message.role === 'user' || message.role === 'assistant') &&
        isTimestamp(message.timestamp),
    )
    .map((message) => message.timestamp as number);
  if (points.length === 0) {
    return Array.from({ length: count }, () => ({ count: 0 }));
  }

  const start = Math.min(...points);
  let end = Math.max(...points);
  if (end <= start) end = start + 60_000;
  const span = end - start;
  const buckets: WaitingActivityBucket[] = Array.from(
    { length: count },
    (_, index) => ({
      count: 0,
      startAt: start + (span * index) / count,
      endAt: start + (span * (index + 1)) / count,
    }),
  );
  for (const timestamp of points) {
    const index = Math.min(
      count - 1,
      Math.max(0, Math.floor(((timestamp - start) / span) * count)),
    );
    buckets[index]!.count += 1;
  }
  return buckets;
}

/** Sums assistant usage across the task; falls back to the latest usage event. */
export function buildWaitingTokenUsage(
  messages: readonly WaitingActivityMessage[],
  fallback: WaitingTokenUsageFallback = {},
  context?: number,
  contextLimit?: number,
): WaitingTokenUsage {
  let input = 0;
  let output = 0;
  let cached = 0;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.usage) continue;
    input += Math.max(0, message.usage.inputTokens ?? 0);
    output += Math.max(0, message.usage.outputTokens ?? 0);
    cached += Math.max(0, message.usage.cachedTokens ?? 0);
  }
  if (input === 0 && output === 0) {
    input = Math.max(0, fallback.inputTokens ?? 0);
    output = Math.max(0, fallback.outputTokens ?? 0);
    cached = Math.max(0, fallback.cachedTokens ?? 0);
  }
  return {
    input,
    output,
    cached,
    ...(context !== undefined ? { context: Math.max(0, context) } : {}),
    ...(contextLimit !== undefined
      ? { contextLimit: Math.max(0, contextLimit) }
      : {}),
  };
}

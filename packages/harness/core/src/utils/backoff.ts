/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { collectErrorObjects } from './errors.js';

export interface ExponentialBackoffOptions {
  attempt: number;
  baseDelayMs: number;
  maxBaseDelayMs: number;
  minJitterFactor: number;
  maxJitterFactor: number;
  random?: () => number;
}

/** Calculate capped exponential backoff, then apply the caller's jitter policy. */
export function calculateExponentialBackoffMs(
  options: ExponentialBackoffOptions,
): number {
  const baseDelayMs = Math.min(
    options.baseDelayMs * 2 ** Math.max(0, options.attempt - 1),
    options.maxBaseDelayMs,
  );
  const random = options.random ?? Math.random;
  const jitterFactor =
    options.minJitterFactor +
    random() * (options.maxJitterFactor - options.minJitterFactor);
  return baseDelayMs * jitterFactor;
}

export function nextRetryDelay(
  error: unknown,
  attempt: number,
): number | undefined {
  for (const record of collectErrorObjects(error)) {
    const value = record as {
      retryAfterMs?: unknown;
      retry_after_ms?: unknown;
      retryAfterSeconds?: unknown;
    };
    const raw = value.retryAfterMs ?? value.retry_after_ms;
    if (raw === undefined && value.retryAfterSeconds === undefined) continue;
    const ms =
      raw !== undefined ? Number(raw) : Number(value.retryAfterSeconds) * 1000;
    return Number.isFinite(ms) &&
      ms >= 0 &&
      Number.isSafeInteger(Math.round(ms))
      ? Math.round(ms)
      : undefined;
  }
  return calculateExponentialBackoffMs({
    attempt,
    baseDelayMs: 500,
    maxBaseDelayMs: 32_000,
    minJitterFactor: 1,
    maxJitterFactor: 1.25,
  });
}

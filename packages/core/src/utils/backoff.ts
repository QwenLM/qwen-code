/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

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

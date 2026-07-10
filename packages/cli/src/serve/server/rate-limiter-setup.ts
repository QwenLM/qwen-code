/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application } from 'express';
import type { DaemonLogger } from '../daemon-logger.js';
import { createRateLimiter, type RateLimiterInstance } from '../rate-limit.js';
import type { ServeOptions } from '../types.js';

export function installRateLimiter(
  app: Application,
  opts: ServeOptions,
  daemonLog: DaemonLogger | undefined,
  options: { mount?: boolean } = {},
): RateLimiterInstance | undefined {
  if (!opts.rateLimit) return undefined;

  const windowMs = opts.rateLimitWindowMs ?? 60_000;
  const rateLimiter = createRateLimiter({
    tiers: {
      prompt: { windowMs, max: opts.rateLimitPrompt ?? 10 },
      mutation: { windowMs, max: opts.rateLimitMutation ?? 30 },
      read: { windowMs, max: opts.rateLimitRead ?? 120 },
    },
    hostname: opts.hostname,
    onLimitReached: daemonLog
      ? (tier, key, suppressed) => {
          daemonLog.warn(
            `rate limit hit${suppressed > 0 ? ` (${suppressed} suppressed)` : ''}`,
            { tier, key: key.slice(0, 64) },
          );
        }
      : undefined,
    onError: daemonLog
      ? (err, path) => {
          daemonLog.warn(
            `rate limiter error (fail-open): ${err instanceof Error ? err.message : String(err)}`,
            { path },
          );
        }
      : undefined,
  });
  if (options.mount !== false) {
    app.use(rateLimiter.middleware);
  }
  return rateLimiter;
}

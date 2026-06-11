/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { isLoopbackBind } from './loopbackBinds.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RateLimitTier = 'prompt' | 'mutation' | 'read';

export interface RateLimitTierConfig {
  windowMs: number;
  max: number;
}

export interface RateLimitConfig {
  tiers: Record<RateLimitTier, RateLimitTierConfig>;
  hostname: string;
  onLimitReached?: (
    tier: RateLimitTier,
    key: string,
    suppressed: number,
  ) => void;
  onError?: (err: unknown, path: string) => void;
}

export interface RateLimiterInstance {
  middleware: RequestHandler;
  /** Check rate limit without Express req/res. Returns true if allowed. */
  checkRate(key: string, tier: RateLimitTier): boolean;
  reset(): void;
  setDraining(v: boolean): void;
  dispose(): void;
  getHitCounts(): Record<RateLimitTier, number>;
}

// ---------------------------------------------------------------------------
// Token Bucket
// ---------------------------------------------------------------------------

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

const MAX_BUCKETS = 10_000;
const GC_REQUEST_INTERVAL = 1000;
const GC_TIMER_INTERVAL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tier Resolution
// ---------------------------------------------------------------------------

function resolveTier(method: string, path: string): RateLimitTier | null {
  // Strip trailing slash for consistent matching
  const p = path.endsWith('/') && path.length > 1 ? path.slice(0, -1) : path;

  // Exempt: OPTIONS, health, demo, heartbeat, SSE events, ACP transport
  if (method === 'OPTIONS') return null;
  if (
    (method === 'GET' || method === 'HEAD') &&
    (p === '/health' || p === '/demo')
  )
    return null;
  if (
    method === 'POST' &&
    p.startsWith('/session/') &&
    p.endsWith('/heartbeat')
  )
    return null;
  if (method === 'GET' && p.startsWith('/session/') && p.endsWith('/events'))
    return null;
  if (p === '/acp' || p.startsWith('/acp/')) return null;

  // Prompt tier
  if (method === 'POST' && p.startsWith('/session/') && p.endsWith('/prompt'))
    return 'prompt';

  // Mutation tier: all remaining non-GET/HEAD
  if (method !== 'GET' && method !== 'HEAD') return 'mutation';

  // Read tier: all remaining GET/HEAD
  return 'read';
}

// ---------------------------------------------------------------------------
// Key Extraction
// ---------------------------------------------------------------------------

// Keep in sync with server.ts CLIENT_ID_RE / MAX_CLIENT_ID_LENGTH.
const MAX_CLIENT_ID_LENGTH = 128;
const CLIENT_ID_RE = /^[A-Za-z0-9._:-]+$/;

function normalizeIp(raw: string): string {
  // Normalize IPv6-mapped IPv4 (::ffff:127.0.0.1 -> 127.0.0.1)
  if (raw.startsWith('::ffff:')) {
    return raw.slice(7);
  }
  return raw;
}

export function createKeyExtractor(hostname: string): (req: Request) => string {
  const loopback = isLoopbackBind(hostname);
  return (req: Request): string => {
    const raw = req.get('x-qwen-client-id');
    const clientId =
      raw && raw.length <= MAX_CLIENT_ID_LENGTH && CLIENT_ID_RE.test(raw)
        ? raw
        : undefined;

    if (loopback) {
      return clientId ? `cid:${clientId}` : 'anonymous';
    }

    const ip = normalizeIp(req.socket?.remoteAddress ?? 'unknown');
    return clientId ? `${ip}:${clientId}` : ip;
  };
}

// ---------------------------------------------------------------------------
// Sampled Logger
// ---------------------------------------------------------------------------

interface SampledLogState {
  count: number;
  suppressed: number;
}

const LOG_SAMPLE_INTERVAL = 100;

interface SampledLogger {
  log(tier: RateLimitTier, key: string): void;
  clear(): void;
}

function createSampledLogger(
  onLog: (tier: RateLimitTier, key: string, suppressed: number) => void,
): SampledLogger {
  const state = new Map<string, SampledLogState>();

  return {
    log(tier: RateLimitTier, key: string) {
      const logKey = `${tier}:${key}`;
      let entry = state.get(logKey);
      if (!entry) {
        entry = { count: 0, suppressed: 0 };
        state.set(logKey, entry);
      }
      entry.count++;

      if (entry.count === 1 || entry.count % LOG_SAMPLE_INTERVAL === 0) {
        onLog(tier, key, entry.suppressed);
        entry.suppressed = 0;
      } else {
        entry.suppressed++;
      }
    },
    clear() {
      state.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRateLimiter(
  config: RateLimitConfig,
): RateLimiterInstance {
  // Defense-in-depth: reject invalid config even if CLI validation ran first.
  for (const [tier, cfg] of Object.entries(config.tiers) as Array<
    [RateLimitTier, RateLimitTierConfig]
  >) {
    if (!Number.isFinite(cfg.max) || cfg.max <= 0) {
      throw new Error(
        `rate limit: ${tier}.max must be a positive number, got ${cfg.max}`,
      );
    }
    if (!Number.isFinite(cfg.windowMs) || cfg.windowMs <= 0) {
      throw new Error(
        `rate limit: ${tier}.windowMs must be a positive number, got ${cfg.windowMs}`,
      );
    }
  }

  const buckets = new Map<string, Map<RateLimitTier, TokenBucket>>();
  const keyExtractor = createKeyExtractor(config.hostname);
  const hitCounts: Record<RateLimitTier, number> = {
    prompt: 0,
    mutation: 0,
    read: 0,
  };
  const rates: Record<RateLimitTier, number> = {
    prompt: config.tiers.prompt.max / config.tiers.prompt.windowMs,
    mutation: config.tiers.mutation.max / config.tiers.mutation.windowMs,
    read: config.tiers.read.max / config.tiers.read.windowMs,
  };

  let draining = false;
  let requestCount = 0;

  const sampledLog = config.onLimitReached
    ? createSampledLogger(config.onLimitReached)
    : undefined;

  // GC: sweep stale buckets
  function sweep(): void {
    const now = Date.now();
    for (const [key, tierMap] of buckets) {
      let allStale = true;
      for (const [tier, bucket] of tierMap) {
        if (now - bucket.lastRefill < config.tiers[tier].windowMs * 2) {
          allStale = false;
          break;
        }
      }
      if (allStale) {
        buckets.delete(key);
      }
    }
  }

  const gcTimer = setInterval(sweep, GC_TIMER_INTERVAL_MS);
  gcTimer.unref();

  // Middleware — delegates to tryConsume for the shared bucket logic.
  const middleware: RequestHandler = (
    req: Request,
    res: Response,
    next: NextFunction,
  ): void => {
    try {
      if (draining) {
        next();
        return;
      }

      const tier = resolveTier(req.method, req.path);
      if (tier === null) {
        next();
        return;
      }

      // GC sweep on request count
      requestCount++;
      if (requestCount % GC_REQUEST_INTERVAL === 0) {
        sweep();
      }

      const key = keyExtractor(req);
      if (tryConsume(key, tier)) {
        next();
      } else {
        const tierConfig = config.tiers[tier];
        const rate = rates[tier];
        const bucket = buckets.get(key)?.get(tier);
        const retryAfterMs = Math.ceil((1 - (bucket?.tokens ?? 0)) / rate);
        const retryAfterSec = Math.ceil(retryAfterMs / 1000);

        res.setHeader('Retry-After', String(retryAfterSec));
        res.setHeader('X-RateLimit-Limit', String(tierConfig.max));
        res.setHeader('X-RateLimit-Remaining', '0');
        res.setHeader(
          'X-RateLimit-Reset',
          String(Math.ceil((Date.now() + retryAfterMs) / 1000)),
        );
        res.status(429).json({
          error: 'Rate limit exceeded',
          code: 'rate_limit_exceeded',
          tier,
          retryAfterMs,
        });
      }
    } catch (err) {
      config.onError?.(err, req.path);
      next();
    }
  };

  function tryConsume(key: string, tier: RateLimitTier): boolean {
    if (draining) return true;
    const tierConfig = config.tiers[tier];
    const rate = rates[tier];
    const now = Date.now();
    let tierMap = buckets.get(key);
    if (!tierMap) {
      if (buckets.size >= MAX_BUCKETS) {
        config.onError?.(
          new Error(`rate limit bucket overflow: ${buckets.size} keys`),
          `tryConsume:${tier}`,
        );
        return true;
      }
      tierMap = new Map();
      buckets.set(key, tierMap);
    }
    let bucket = tierMap.get(tier);
    if (!bucket) {
      bucket = { tokens: tierConfig.max, lastRefill: now };
      tierMap.set(tier, bucket);
    }
    const elapsed = Math.max(0, now - bucket.lastRefill);
    bucket.tokens = Math.min(tierConfig.max, bucket.tokens + elapsed * rate);
    bucket.lastRefill = now;
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    hitCounts[tier]++;
    if (sampledLog) sampledLog.log(tier, key);
    return false;
  }

  return {
    middleware,
    checkRate: tryConsume,
    reset() {
      buckets.clear();
      hitCounts.prompt = 0;
      hitCounts.mutation = 0;
      hitCounts.read = 0;
      requestCount = 0;
      sampledLog?.clear();
    },
    setDraining(v: boolean) {
      draining = v;
    },
    dispose() {
      clearInterval(gcTimer);
      buckets.clear();
      sampledLog?.clear();
    },
    getHitCounts() {
      return { ...hitCounts };
    },
  };
}

const RATE_LIMITER_KEY = '_rateLimiter';

export function setRateLimiter(
  app: { locals: Record<string, unknown> },
  limiter: RateLimiterInstance,
): void {
  app.locals[RATE_LIMITER_KEY] = limiter;
}

export function getRateLimiter(app: {
  locals: Record<string, unknown>;
}): RateLimiterInstance | undefined {
  return app.locals[RATE_LIMITER_KEY] as RateLimiterInstance | undefined;
}

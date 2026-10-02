/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The rate-limit position providers report on every response.
 *
 * The pipeline already holds the HTTP response on the streaming path -- it
 * reads `content-type` off it to detect a gateway block page -- and drops the
 * rest, so the one place that knows how much of the window is left forgets it
 * immediately. Issue #2800 asks how to view the quota; this is where the answer
 * arrives.
 *
 * Retry behaviour is unchanged. `getRetryAfterDelayMs` already handles waiting;
 * this only remembers what was said, so it can be shown before a run walks into
 * the wall rather than after.
 */

/** One reading, as the provider spelled it. */
export interface RateLimitSnapshot {
  /** Rate-limit headers from the response, lower-cased. */
  headers: Record<string, string>;
  /** When the response carrying them arrived. */
  observedAt: number;
}

/**
 * Whether a header name is about a rate limit.
 *
 * Matched by meaning rather than by a list of names: OpenAI-compatible
 * providers send `x-ratelimit-remaining-requests`, Anthropic's subscription
 * windows send `anthropic-ratelimit-unified-5h-utilization`, DashScope and
 * Z.AI send their own. Naming today's headers would silently drop tomorrow's.
 */
export function isRateLimitHeader(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    lowered.includes('ratelimit') ||
    lowered.includes('rate-limit') ||
    lowered === 'retry-after' ||
    lowered === 'retry-after-ms'
  );
}

/**
 * Extracts the rate-limit headers from a response.
 *
 * Returns null rather than an empty object when the provider said nothing. A
 * caller drawing a meter from an empty reading would show a full account, and
 * "nobody asked" is not the same answer as "nothing left".
 */
export function extractRateLimitHeaders(
  headers: Headers | undefined | null,
): Record<string, string> | null {
  if (!headers || typeof headers.forEach !== 'function') return null;

  const found: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (isRateLimitHeader(name) && value) {
      found[name.toLowerCase()] = value;
    }
  });
  return Object.keys(found).length > 0 ? found : null;
}

const lastByProvider = new Map<string, RateLimitSnapshot>();

/**
 * Records what a provider last reported. Keyed by provider so two configured
 * endpoints in one session do not overwrite each other's reading.
 */
export function recordRateLimitHeaders(
  providerId: string,
  headers: Headers | undefined | null,
  now: number = Date.now(),
): void {
  const extracted = extractRateLimitHeaders(headers);
  if (!extracted) return;
  lastByProvider.set(providerId, { headers: extracted, observedAt: now });
}

/** The most recent reading for a provider, or undefined when it never said. */
export function getLastRateLimit(
  providerId: string,
): RateLimitSnapshot | undefined {
  return lastByProvider.get(providerId);
}

/** Every reading this session has seen, newest value per provider. */
export function getAllRateLimits(): ReadonlyMap<string, RateLimitSnapshot> {
  return lastByProvider;
}

/** Drops every reading. For tests. */
export function resetRateLimits(): void {
  lastByProvider.clear();
}

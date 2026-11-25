/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NonNullableUsage } from '../schemas/common.js';

/**
 * Zero-initialized usage object with all fields set to their default values.
 * Used as the base for `cloneUsage()` so every emitted usage is fully populated.
 */
export const EMPTY_USAGE: Readonly<NonNullableUsage> = {
  input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: 'standard',
  cache_creation: {
    ephemeral_1h_input_tokens: 0,
    ephemeral_5m_input_tokens: 0,
  },
  inference_geo: '',
  iterations: [],
  speed: 'standard',
};

const CACHE_READ_USAGE_AVAILABLE_PROPERTY = 'cache_read_usage_available';
const CACHE_WRITE_USAGE_AVAILABLE_PROPERTY = 'cache_write_usage_available';

function markCacheUsageAvailability<T extends object>(
  usage: T,
  property: string,
  available: boolean,
): T {
  Object.defineProperty(usage, property, {
    value: available,
    enumerable: false,
    writable: true,
    configurable: true,
  });
  return usage;
}

export function markCacheReadUsageAvailable<T extends object>(
  usage: T,
  available: boolean,
): T {
  return markCacheUsageAvailability(
    usage,
    CACHE_READ_USAGE_AVAILABLE_PROPERTY,
    available,
  );
}

export function markCacheWriteUsageAvailable<T extends object>(
  usage: T,
  available: boolean,
): T {
  return markCacheUsageAvailability(
    usage,
    CACHE_WRITE_USAGE_AVAILABLE_PROPERTY,
    available,
  );
}

function isCacheUsageFieldAvailable(
  usage: unknown,
  marker: string,
  valueField: string,
): boolean {
  if (!usage || typeof usage !== 'object') return false;
  const record = usage as Record<string, unknown>;
  const marked = record[marker];
  if (typeof marked === 'boolean') return marked;
  return Object.hasOwn(record, valueField);
}

export function isCacheReadUsageAvailable(usage: unknown): boolean {
  return isCacheUsageFieldAvailable(
    usage,
    CACHE_READ_USAGE_AVAILABLE_PROPERTY,
    'cache_read_input_tokens',
  );
}

export function isCacheWriteUsageAvailable(usage: unknown): boolean {
  return isCacheUsageFieldAvailable(
    usage,
    CACHE_WRITE_USAGE_AVAILABLE_PROPERTY,
    'cache_creation_input_tokens',
  );
}

/**
 * Create a mutable deep clone of `EMPTY_USAGE`.
 * Nested objects are shallow-copied so mutations don't leak to the constant.
 */
export function cloneUsage(): NonNullableUsage {
  const usage = {
    ...EMPTY_USAGE,
    server_tool_use: { ...EMPTY_USAGE.server_tool_use },
    cache_creation: { ...EMPTY_USAGE.cache_creation },
    iterations: [...EMPTY_USAGE.iterations],
  };
  markCacheReadUsageAvailable(usage, false);
  markCacheWriteUsageAvailable(usage, false);
  return usage;
}

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import crypto from 'node:crypto';

const crawlCache = new Map<string, string[]>();
const cacheTimers = new Map<string, NodeJS.Timeout>();

// Limits to prevent heap exhaustion when many projects are crawled concurrently
export const MAX_CACHE_ENTRIES = 256; // max distinct project roots cached
export const MAX_TOTAL_PATHS = 50_000; // max total paths across all entries

/**
 * Generates a unique cache key based on the project directory and the content
 * of ignore files. This ensures that the cache is invalidated if the project
 * or ignore rules change.
 */
export const getCacheKey = (
  directory: string,
  ignoreContent: string,
  maxDepth?: number,
  maxFiles?: number,
  useGitignore: boolean = true,
): string => {
  const hash = crypto.createHash('sha256');
  hash.update(directory);
  hash.update(ignoreContent);
  hash.update(useGitignore ? 'gitignore' : 'no-gitignore');
  if (maxDepth !== undefined) {
    hash.update(String(maxDepth));
  }
  if (maxFiles !== undefined) {
    hash.update(`maxFiles:${maxFiles}`);
  }
  return hash.digest('hex');
};

/**
 * Reads cached data from the in-memory cache.
 * Bumps the entry to the end of the FIFO queue on hit so that
 * frequently-read crawl results survive eviction by auxiliary crawls.
 * Returns undefined if the key is not found.
 */
export const read = (key: string): string[] | undefined => {
  const result = crawlCache.get(key);
  if (result !== undefined) {
    crawlCache.delete(key);
    crawlCache.set(key, result);
  }
  return result;
};

/**
 * Writes data to the in-memory cache and sets a timer to evict it after the TTL.
 * Enforces MAX_CACHE_ENTRIES (LRU by insertion order) and MAX_TOTAL_PATHS to
 * prevent heap exhaustion when many large projects are crawled.
 */
export const write = (key: string, results: string[], ttlMs: number): void => {
  // Clear any existing timer for this key to prevent premature deletion
  if (cacheTimers.has(key)) {
    clearTimeout(cacheTimers.get(key)!);
  }

  // Evict oldest entries when cache exceeds entry limit (FIFO / insertion-order).
  // Guard: updating an existing key doesn't increase entry count, so skip eviction.
  while (crawlCache.size >= MAX_CACHE_ENTRIES && !crawlCache.has(key)) {
    const oldestKey = crawlCache.keys().next().value;
    if (oldestKey) {
      crawlCache.delete(oldestKey);
      if (cacheTimers.has(oldestKey)) {
        clearTimeout(cacheTimers.get(oldestKey)!);
        cacheTimers.delete(oldestKey);
      }
    }
  }

  // Evict largest entries when total path count exceeds limit.
  // Calculate totalPaths excluding the key being updated to avoid counting old value.
  let totalPaths = 0;
  for (const [k, entry] of crawlCache) {
    if (k !== key) {
      totalPaths += entry.length;
    }
  }
  while (totalPaths + results.length > MAX_TOTAL_PATHS && crawlCache.size > 0) {
    // Find and remove the entry with the most paths (never evict the current key)
    let largestKey: string | undefined;
    let largestSize = 0;
    for (const [k, v] of crawlCache) {
      if (k === key) continue;
      if (v.length > largestSize) {
        largestSize = v.length;
        largestKey = k;
      }
    }
    if (largestKey) {
      totalPaths -= crawlCache.get(largestKey)!.length;
      crawlCache.delete(largestKey);
      if (cacheTimers.has(largestKey)) {
        clearTimeout(cacheTimers.get(largestKey)!);
        cacheTimers.delete(largestKey);
      }
    } else {
      break;
    }
  }

  // Bump existing key to end of FIFO queue (mirror fileReadCache.upsert behavior)
  if (crawlCache.has(key)) {
    crawlCache.delete(key);
  }

  // Store the new data
  crawlCache.set(key, results);

  // Set a timer to automatically delete the cache entry after the TTL
  const timerId = setTimeout(() => {
    crawlCache.delete(key);
    cacheTimers.delete(key);
  }, ttlMs);

  // Store the timer handle so we can clear it if the entry is updated
  cacheTimers.set(key, timerId);
};

/**
 * Clears the entire cache and all active timers.
 * Primarily used for testing.
 */
export const clear = (): void => {
  for (const timerId of cacheTimers.values()) {
    clearTimeout(timerId);
  }
  crawlCache.clear();
  cacheTimers.clear();
};

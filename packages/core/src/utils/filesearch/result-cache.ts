/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

interface CacheEntry {
  value: string[];
  timestamp: number;
  accessCount: number;
}

/**
 * Implements an in-memory LRU cache for file search results with TTL expiration.
 * This cache optimizes subsequent searches by leveraging previously computed results.
 */
export class ResultCache {
  private readonly cache: Map<string, CacheEntry>;
  private hits = 0;
  private misses = 0;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(
    private readonly allFiles: string[],
    options: { maxEntries?: number; ttlMs?: number } = {},
  ) {
    this.cache = new Map();
    this.maxEntries = options.maxEntries ?? 100; // Default to 100 entries
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000; // Default to 5 minutes TTL
  }

  /**
   * Removes expired entries from the cache.
   */
  private removeExpiredEntries(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Evicts the least recently used entries if the cache exceeds the maximum size.
   */
  private evictIfNecessary(): void {
    if (this.cache.size <= this.maxEntries) {
      return;
    }

    // Sort entries by access count and timestamp (LRU: least recently used)
    const entries = Array.from(this.cache.entries())
      .map(([key, entry]) => ({ key, entry }))
      .sort((a, b) => {
        // First sort by access count (ascending: less frequently accessed first)
        // If equal, sort by timestamp (ascending: older first)
        if (a.entry.accessCount !== b.entry.accessCount) {
          return a.entry.accessCount - b.entry.accessCount;
        }
        return a.entry.timestamp - b.entry.timestamp;
      });

    // Remove excess entries starting from the least recently used
    const excessCount = this.cache.size - this.maxEntries;
    for (let i = 0; i < excessCount; i++) {
      this.cache.delete(entries[i].key);
    }
  }

  /**
   * Retrieves cached search results for a given query, or provides a base set
   * of files to search from.
   * @param query The search query pattern.
   * @returns An object containing the files to search and a boolean indicating
   *          if the result is an exact cache hit.
   */
  async get(
    query: string,
  ): Promise<{ files: string[]; isExactMatch: boolean }> {
    // Clean up expired entries periodically (only when cache size is significant)
    if (this.cache.size > 10) {
      this.removeExpiredEntries();
    }

    const entry = this.cache.get(query);

    if (entry) {
      // Update access count and timestamp
      entry.accessCount++;
      entry.timestamp = Date.now();
      this.hits++;
      return { files: entry.value, isExactMatch: true };
    }

    this.misses++;

    // This is the core optimization of the memory cache.
    // If a user first searches for "foo", and then for "foobar",
    // we don't need to search through all files again. We can start
    // from the results of the "foo" search.
    // This finds the most specific, already-cached query that is a prefix
    // of the current query.
    let bestBaseQuery = '';
    for (const [key, _entry] of this.cache.entries()) {
      if (query.startsWith(key) && key.length > bestBaseQuery.length) {
        bestBaseQuery = key;
      }
    }

    const filesToSearch = bestBaseQuery
      ? this.cache.get(bestBaseQuery)!.value
      : this.allFiles;

    return { files: filesToSearch, isExactMatch: false };
  }

  /**
   * Stores search results in the cache.
   * @param query The search query pattern.
   * @param results The matching file paths to cache.
   */
  set(query: string, results: string[]): void {
    // Clean up expired entries before adding new ones
    if (this.cache.size > 10) {
      this.removeExpiredEntries();
    }

    this.cache.set(query, {
      value: results,
      timestamp: Date.now(),
      accessCount: 1,
    });

    // Evict if necessary to maintain size limits
    this.evictIfNecessary();
  }
}

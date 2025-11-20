/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Implements an in-memory cache for file search results.
 * This cache optimizes subsequent searches by leveraging previously computed results.
 */
export class ResultCache {
  private readonly cache: Map<string, string[]>;
  private hits = 0;
  private misses = 0;

  constructor(private readonly allFiles: string[]) {
    this.cache = new Map();
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
    const isCacheHit = this.cache.has(query);

    if (isCacheHit) {
      this.hits++;
      return { files: this.cache.get(query)!, isExactMatch: true };
    }

    this.misses++;

    // This is the core optimization of the memory cache.
    // If a user first searches for "foo", and then for "foobar",
    // we don't need to search through all files again. We can start
    // from the results of the "foo" search.
    // This finds the most specific, already-cached query that is a prefix
    // of the current query.
    // We use an optimized approach by checking the longest matching prefix only
    let bestBaseQuery = '';
    const cacheKeys = Array.from(this.cache.keys());

    // Sort keys by length in descending order to find the longest match first
    cacheKeys.sort((a, b) => b.length - a.length);

    for (const key of cacheKeys) {
      if (query.startsWith(key)) {
        bestBaseQuery = key;
        break; // Since we sorted by length, the first match is the best
      }
    }

    const filesToSearch = bestBaseQuery
      ? this.cache.get(bestBaseQuery)!
      : this.allFiles;

    return { files: filesToSearch, isExactMatch: false };
  }

  /**
   * Stores search results in the cache.
   * @param query The search query pattern.
   * @param results The matching file paths to cache.
   */
  set(query: string, results: string[]): void {
    this.cache.set(query, results);
  }
}

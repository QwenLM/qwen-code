/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import picomatch from 'picomatch';
import type { Ignore } from './ignore.js';
import { loadIgnoreRules } from './ignore.js';
import { ResultCache } from './result-cache.js';
import { crawl } from './crawler.js';
import type { FzfResultItem } from 'fzf';
import { AsyncFzf } from 'fzf';
import { unescapePath } from '../paths.js';

export interface FileSearchOptions {
  projectRoot: string;
  ignoreDirs: string[];
  useGitignore: boolean;
  useQwenignore: boolean;
  cache: boolean;
  cacheTtl: number;
  enableRecursiveFileSearch: boolean;
  disableFuzzySearch: boolean;
  maxDepth?: number;
}

export class AbortError extends Error {
  constructor(message = 'Search aborted') {
    super(message);
    this.name = 'AbortError';
  }
}

/**
 * Filters a list of paths based on a given pattern.
 * @param allPaths The list of all paths to filter.
 * @param pattern The picomatch pattern to filter by.
 * @param signal An AbortSignal to cancel the operation.
 * @returns A promise that resolves to the filtered and sorted list of paths.
 */
export async function filter(
  allPaths: string[],
  pattern: string,
  signal: AbortSignal | undefined,
): Promise<string[]> {
  const patternFilter = picomatch(pattern, {
    dot: true,
    contains: true,
    nocase: true,
  });

  const results: string[] = [];
  const batchSize = 1000;

  for (let i = 0; i < allPaths.length; i += batchSize) {
    // Process a batch of items before yielding to event loop
    const batchEnd = Math.min(i + batchSize, allPaths.length);
    for (let j = i; j < batchEnd; j++) {
      const p = allPaths[j];
      if (patternFilter(p)) {
        results.push(p);
      }
    }

    // Yield control to the event loop after processing each batch
    await new Promise((resolve) => setImmediate(resolve));
    if (signal?.aborted) {
      throw new AbortError();
    }
  }

  // Optimized sorting algorithm that prioritizes directories and uses efficient string comparison
  results.sort((a, b) => {
    const aIsDir = a.endsWith('/');
    const bIsDir = b.endsWith('/');

    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;

    // Use localeCompare with numeric option for better performance with filenames containing numbers
    // This is more efficient than manual character-by-character comparison
    return a.localeCompare(b, undefined, {
      numeric: true,
      sensitivity: 'base',
    });
  });

  return results;
}

export interface SearchOptions {
  signal?: AbortSignal;
  maxResults?: number;
}

export interface FileSearch {
  initialize(): Promise<void>;
  search(pattern: string, options?: SearchOptions): Promise<string[]>;
}

class RecursiveFileSearch implements FileSearch {
  private ignore: Ignore | undefined;
  private resultCache: ResultCache | undefined;
  private allFiles: string[] = [];
  private fzf: AsyncFzf<string[]> | undefined;

  constructor(private readonly options: FileSearchOptions) {}

  async initialize(): Promise<void> {
    this.ignore = loadIgnoreRules(this.options);
    this.allFiles = await crawl({
      crawlDirectory: this.options.projectRoot,
      cwd: this.options.projectRoot,
      ignore: this.ignore,
      cache: this.options.cache,
      cacheTtl: this.options.cacheTtl,
      maxDepth: this.options.maxDepth,
    });
    this.buildResultCache();
  }

  async search(
    pattern: string,
    options: SearchOptions = {},
  ): Promise<string[]> {
    if (
      !this.resultCache ||
      (!this.fzf && !this.options.disableFuzzySearch) ||
      !this.ignore
    ) {
      throw new Error('Engine not initialized. Call initialize() first.');
    }

    pattern = unescapePath(pattern) || '*';

    let filteredCandidates;
    const { files: candidates, isExactMatch } =
      await this.resultCache!.get(pattern);

    if (isExactMatch) {
      // Use the cached result.
      filteredCandidates = candidates;
    } else {
      let shouldCache = true;
      if (pattern.includes('*') || !this.fzf) {
        filteredCandidates = await filter(candidates, pattern, options.signal);
      } else {
        filteredCandidates = await this.fzf
          .find(pattern)
          .then((results: Array<FzfResultItem<string>>) =>
            results.map((entry: FzfResultItem<string>) => entry.item),
          )
          .catch(() => {
            shouldCache = false;
            return [];
          });
      }

      if (shouldCache) {
        this.resultCache!.set(pattern, filteredCandidates);
      }
    }

    const fileFilter = this.ignore.getFileFilter();
    const maxResults = options.maxResults ?? Infinity;
    const results: string[] = [];

    // Process in batches to reduce the number of async operations
    const batchSize = 1000;
    for (let i = 0; i < filteredCandidates.length; i += batchSize) {
      // Process a batch of items
      const batchEnd = Math.min(i + batchSize, filteredCandidates.length);
      for (let j = i; j < batchEnd; j++) {
        const candidate = filteredCandidates[j];

        if (results.length >= maxResults) {
          break;
        }
        if (candidate === '.') {
          continue;
        }
        // Only include files that are NOT ignored by the filter
        if (!fileFilter(candidate)) {
          results.push(candidate);
        }
      }

      // Only yield control to the event loop after processing each batch
      await new Promise((resolve) => setImmediate(resolve));
      if (options.signal?.aborted) {
        throw new AbortError();
      }

      // Break early if we've reached max results
      if (results.length >= maxResults) {
        break;
      }
    }
    return results;
  }

  private buildResultCache(): void {
    this.resultCache = new ResultCache(this.allFiles);
    if (!this.options.disableFuzzySearch) {
      // The v1 algorithm is much faster since it only looks at the first
      // occurence of the pattern. We use it for search spaces that have >20k
      // files, because the v2 algorithm is just too slow in those cases.
      this.fzf = new AsyncFzf(this.allFiles, {
        fuzzy: this.allFiles.length > 20000 ? 'v1' : 'v2',
      });
    }
  }
}

class DirectoryFileSearch implements FileSearch {
  private ignore: Ignore | undefined;

  constructor(private readonly options: FileSearchOptions) {}

  async initialize(): Promise<void> {
    this.ignore = loadIgnoreRules(this.options);
  }

  async search(
    pattern: string,
    options: SearchOptions = {},
  ): Promise<string[]> {
    if (!this.ignore) {
      throw new Error('Engine not initialized. Call initialize() first.');
    }
    pattern = pattern || '*';

    const dir = pattern.endsWith('/') ? pattern : path.dirname(pattern);
    const results = await crawl({
      crawlDirectory: path.join(this.options.projectRoot, dir),
      cwd: this.options.projectRoot,
      maxDepth: 0,
      ignore: this.ignore,
      cache: this.options.cache,
      cacheTtl: this.options.cacheTtl,
    });

    const filteredResults = await filter(results, pattern, options.signal);

    const fileFilter = this.ignore.getFileFilter();
    const maxResults = options.maxResults ?? Infinity;
    const finalResults: string[] = [];

    // Process in batches to reduce the number of async operations
    const batchSize = 1000;
    for (let i = 0; i < filteredResults.length; i += batchSize) {
      const batchEnd = Math.min(i + batchSize, filteredResults.length);
      for (let j = i; j < batchEnd; j++) {
        const candidate = filteredResults[j];

        if (finalResults.length >= maxResults) {
          break;
        }
        if (candidate === '.') {
          continue;
        }
        // Only include files that are NOT ignored by the filter
        if (!fileFilter(candidate)) {
          finalResults.push(candidate);
        }
      }

      // Only yield control to the event loop after processing each batch
      await new Promise((resolve) => setImmediate(resolve));
      if (options.signal?.aborted) {
        throw new AbortError();
      }

      // Break early if we've reached max results
      if (finalResults.length >= maxResults) {
        break;
      }
    }
    return finalResults;
  }
}

export class FileSearchFactory {
  static create(options: FileSearchOptions): FileSearch {
    if (options.enableRecursiveFileSearch) {
      return new RecursiveFileSearch(options);
    }
    return new DirectoryFileSearch(options);
  }
}

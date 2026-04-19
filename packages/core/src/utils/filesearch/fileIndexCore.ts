/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FzfResultItem } from 'fzf';
import { AsyncFzf } from 'fzf';
import { crawl } from './crawler.js';
import type { Ignore } from './ignore.js';
import { loadIgnoreRules } from './ignore.js';
import { ResultCache } from './result-cache.js';
import type { FileSearchOptions, SearchOptions } from './fileSearch.js';
import { AbortError, filter } from './fileSearch.js';
import { unescapePath } from '../paths.js';

/**
 * Safety cap on the number of file entries the recursive crawler will
 * materialise in memory. Kept in sync with the previous constant in
 * fileSearch.ts so behaviour is unchanged.
 */
export const MAX_CRAWL_FILES = 100_000;

/**
 * Pure, worker-safe core of the recursive file search engine. It owns the
 * crawled file list, the fzf index, and the prefix-aware result cache. The
 * main-thread `FileIndexService` drives this class indirectly through the
 * worker; unit tests can instantiate it directly.
 *
 * Lifecycle:
 *   1. `startCrawl(onChunk)` — kicks off the filesystem crawl. During the
 *      crawl the `allFiles` array grows and `onChunk` is invoked with batches
 *      of discovered paths. `search()` may be called concurrently; it will
 *      operate against the current snapshot with picomatch-based filtering.
 *   2. `buildFzfIndex()` — invoked once after `startCrawl` resolves. Enables
 *      the fuzzy-matching fast path for subsequent `search()` calls.
 *   3. `search(pattern, opts)` — can be called any time after the constructor.
 *      Before step 2 it falls back to substring/glob matching via `filter()`;
 *      after step 2 it uses fzf for non-glob patterns.
 */
export class FileIndexCore {
  private readonly ignore: Ignore;
  private allFiles: string[] = [];
  private fzf: AsyncFzf<string[]> | undefined;
  private resultCache: ResultCache | undefined;
  private crawlDone = false;

  constructor(private readonly options: FileSearchOptions) {
    this.ignore = loadIgnoreRules(options);
  }

  /**
   * Runs the recursive crawl. Resolves once fdir finishes collecting all
   * files. Before resolution, `onChunk` is invoked multiple times with slices
   * of paths as they are discovered.
   */
  async startCrawl(onChunk?: (chunk: string[]) => void): Promise<void> {
    const chunks: string[][] = [];
    await crawl({
      crawlDirectory: this.options.projectRoot,
      cwd: this.options.projectRoot,
      ignore: this.ignore,
      cache: this.options.cache,
      cacheTtl: this.options.cacheTtl,
      maxDepth: this.options.maxDepth,
      maxFiles: MAX_CRAWL_FILES,
      onProgress: (chunk) => {
        // Append to the live snapshot first so concurrent `search()` calls
        // see the growing list immediately.
        for (const p of chunk) this.allFiles.push(p);
        chunks.push(chunk);
        try {
          onChunk?.(chunk);
        } catch {
          // best-effort; don't break the crawl
        }
      },
    });
    // If onProgress never fired (e.g. tiny tree or cache hit), the crawl
    // result comes through the fulfilled promise only. In that case we need
    // to reconcile: the above push loop may have populated allFiles from
    // streaming chunks, or it may still be empty. crawl() itself returns the
    // full list on cache hits — handle that by falling back to it if the
    // stream produced nothing.
    if (this.allFiles.length === 0 && chunks.length === 0) {
      // Cache hit path: re-run the crawl without streaming to collect the
      // cached results. Since cache read is in-memory this is cheap.
      const cached = await crawl({
        crawlDirectory: this.options.projectRoot,
        cwd: this.options.projectRoot,
        ignore: this.ignore,
        cache: this.options.cache,
        cacheTtl: this.options.cacheTtl,
        maxDepth: this.options.maxDepth,
        maxFiles: MAX_CRAWL_FILES,
      });
      this.allFiles = cached;
    }
    this.crawlDone = true;
  }

  /**
   * Builds the fzf fuzzy index over the current `allFiles`. Also freezes the
   * ResultCache to `allFiles` so subsequent queries benefit from prefix
   * chaining. Called exactly once, after `startCrawl` resolves.
   */
  buildFzfIndex(): void {
    this.resultCache = new ResultCache(this.allFiles);
    if (this.options.enableFuzzySearch !== false) {
      // v1 is much faster than v2 on large search spaces; stick to the same
      // >20k threshold that the previous implementation used.
      this.fzf = new AsyncFzf(this.allFiles, {
        fuzzy: this.allFiles.length > 20000 ? 'v1' : 'v2',
      });
    }
  }

  /**
   * Runs a search against the current snapshot. When `buildFzfIndex()` has
   * not yet been called, falls back to picomatch-based substring/glob
   * filtering so partial results can stream to the UI while the index is
   * still warming up.
   */
  async search(
    pattern: string,
    options: SearchOptions = {},
  ): Promise<string[]> {
    const query = unescapePath(pattern) || '*';
    const fileFilter = this.ignore.getFileFilter();

    let filteredCandidates: string[];
    if (!this.resultCache) {
      // Snapshot / pre-index phase: no result cache yet (either crawl is
      // still running or buildFzfIndex has not been invoked). picomatch-
      // filter the live snapshot directly; skip caching so we never stash
      // results that predate additional files.
      filteredCandidates = await filter(this.allFiles, query, options.signal);
    } else {
      const { files: candidates, isExactMatch } =
        await this.resultCache!.get(query);
      if (isExactMatch) {
        filteredCandidates = candidates;
      } else {
        let shouldCache = true;
        if (query.includes('*') || !this.fzf) {
          filteredCandidates = await filter(candidates, query, options.signal);
        } else {
          filteredCandidates = await this.fzf
            .find(query)
            .then((results: Array<FzfResultItem<string>>) =>
              results.map((entry: FzfResultItem<string>) => entry.item),
            )
            .catch((e: unknown) => {
              if (e instanceof Error && e.name === 'AbortError') throw e;
              shouldCache = false;
              return [];
            });
        }
        if (shouldCache) {
          this.resultCache!.set(query, filteredCandidates);
        }
      }
    }

    const results: string[] = [];
    for (const [i, candidate] of filteredCandidates.entries()) {
      if (i % 1000 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (options.signal?.aborted) {
          throw new AbortError();
        }
      }
      if (results.length >= (options.maxResults ?? Infinity)) {
        break;
      }
      if (candidate === '.') {
        continue;
      }
      if (!fileFilter(candidate)) {
        results.push(candidate);
      }
    }
    return results;
  }

  get snapshotSize(): number {
    return this.allFiles.length;
  }

  get isReady(): boolean {
    return this.crawlDone;
  }
}

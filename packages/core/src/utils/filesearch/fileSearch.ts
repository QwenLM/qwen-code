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
import { unescapePath } from '../paths.js';

/**
 * Safety cap on the number of file entries the recursive crawler will
 * materialise in memory. Without this, workspaces with millions of files
 * (e.g. missing .gitignore, huge node_modules trees) can push Node.js past
 * its heap limit and crash with an OOM.  100 000 entries is generous enough
 * for virtually all real projects while keeping peak memory well under 100 MB.
 */
const MAX_CRAWL_FILES = 100_000;

const RustFileSearch: {
  FileSearch: new (config: {
    projectRoot: string;
    useGitignore: boolean;
    useQwenignore: boolean;
    ignoreDirs: string[];
    enableFuzzySearch: boolean;
    maxDepth?: number;
  }) => {
    initialize(): Promise<void>;
    getAllFiles(): string[];
    search(
      pattern: string,
      maxResults?: number,
    ): Promise<Array<{ path: string }>>;
  };
} | null = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-restricted-syntax, import/no-internal-modules
    return require('../../../../file-search-rs/index.js') as {
      FileSearch: new (config: {
        projectRoot: string;
        useGitignore: boolean;
        useQwenignore: boolean;
        ignoreDirs: string[];
        enableFuzzySearch: boolean;
        maxDepth?: number;
      }) => {
        initialize(): Promise<void>;
        getAllFiles(): string[];
        search(
          pattern: string,
          maxResults?: number,
        ): Promise<Array<{ path: string }>>;
      };
    };
  } catch {
    return null;
  }
})();

export interface FileSearchOptions {
  projectRoot: string;
  ignoreDirs: string[];
  useGitignore: boolean;
  useQwenignore: boolean;
  cache: boolean;
  cacheTtl: number;
  enableRecursiveFileSearch: boolean;
  enableFuzzySearch: boolean;
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
  for (const [i, p] of allPaths.entries()) {
    // Yield control to the event loop periodically to prevent blocking.
    if (i % 1000 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
      if (signal?.aborted) {
        throw new AbortError();
      }
    }

    if (patternFilter(p)) {
      results.push(p);
    }
  }

  results.sort((a, b) => {
    const aIsDir = a.endsWith('/');
    const bIsDir = b.endsWith('/');

    if (aIsDir && !bIsDir) return -1;
    if (!aIsDir && bIsDir) return 1;

    // This is 40% faster than localeCompare and the only thing we would really
    // gain from localeCompare is case-sensitive sort
    return a < b ? -1 : a > b ? 1 : 0;
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

/**
 * Rust-accelerated file search implementation
 * Uses native Rust code for directory crawling, gitignore filtering, and fuzzy search
 */
class RustAcceleratedFileSearch implements FileSearch {
  private nativeSearch: {
    initialize(): Promise<void>;
    getAllFiles(): string[];
    search(
      pattern: string,
      maxResults?: number,
    ): Promise<Array<{ path: string }>>;
  } | null = null;
  private resultCache: ResultCache | undefined;
  private allFiles: string[] = [];

  constructor(private readonly options: FileSearchOptions) {}

  async initialize(): Promise<void> {
    // Try to use Rust implementation
    if (RustFileSearch) {
      try {
        this.nativeSearch = new RustFileSearch.FileSearch({
          projectRoot: this.options.projectRoot,
          useGitignore: this.options.useGitignore,
          useQwenignore: this.options.useQwenignore,
          ignoreDirs: this.options.ignoreDirs,
          enableFuzzySearch: this.options.enableFuzzySearch !== false,
          maxDepth: this.options.maxDepth,
        });

        await this.nativeSearch.initialize();
        this.allFiles = this.nativeSearch.getAllFiles();
        this.resultCache = new ResultCache(this.allFiles);
        return;
      } catch (err) {
        // If Rust implementation fails, fall back to JS
        // eslint-disable-next-line no-console
        console.warn(
          'Rust file search initialization failed, falling back to JavaScript:',
          err,
        );
        this.nativeSearch = null;
      }
    }

    // Fall back to JavaScript implementation
    const ignore = loadIgnoreRules(this.options);
    this.allFiles = await crawl({
      crawlDirectory: this.options.projectRoot,
      cwd: this.options.projectRoot,
      ignore,
      cache: this.options.cache,
      cacheTtl: this.options.cacheTtl,
      maxDepth: this.options.maxDepth,
      maxFiles: MAX_CRAWL_FILES,
    });
    this.resultCache = new ResultCache(this.allFiles);
  }

  async search(
    pattern: string,
    options: SearchOptions = {},
  ): Promise<string[]> {
    if (!this.resultCache) {
      throw new Error('Engine not initialized. Call initialize() first.');
    }

    // Check if aborted before starting
    if (options.signal?.aborted) {
      throw new AbortError();
    }

    pattern = unescapePath(pattern) || '*';

    let filteredCandidates;
    const { files: candidates, isExactMatch } =
      await this.resultCache!.get(pattern);

    if (isExactMatch) {
      filteredCandidates = candidates;
    } else {
      // Use Rust search if available and no AbortSignal
      // (Rust can't be cancelled mid-operation)
      if (this.nativeSearch && !options.signal) {
        try {
          const rustResults = await this.nativeSearch.search(
            pattern,
            options.maxResults,
          );
          filteredCandidates = rustResults.map((r) => r.path);
          if (options.maxResults) {
            filteredCandidates = filteredCandidates.slice(
              0,
              options.maxResults,
            );
          }
          this.resultCache!.set(pattern, filteredCandidates);
          return filteredCandidates;
        } catch (err) {
          // Re-throw AbortError
          if (err instanceof AbortError) {
            throw err;
          }
          // eslint-disable-next-line no-console
          console.warn('Rust search failed, falling back to JS:', err);
        }
      }

      // Fall back to JavaScript
      let shouldCache = true;
      if (pattern.includes('*') || !this.options.enableFuzzySearch) {
        filteredCandidates = await filter(candidates, pattern, options.signal);
      } else {
        // Fuzzy search fallback
        const AsyncFzf = (await import('fzf')).AsyncFzf;
        const fzf = new AsyncFzf(candidates, {
          fuzzy: candidates.length > 20000 ? 'v1' : 'v2',
        });

        try {
          const results = await fzf.find(pattern);
          filteredCandidates = results.map(
            (entry: FzfResultItem<string>) => entry.item,
          );
        } catch {
          shouldCache = false;
          filteredCandidates = [];
        }
      }

      if (shouldCache) {
        this.resultCache!.set(pattern, filteredCandidates);
      }
    }

    // Apply final filtering
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
      results.push(candidate);
    }

    return results;
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
    const finalResults: string[] = [];
    for (const candidate of filteredResults) {
      if (finalResults.length >= (options.maxResults ?? Infinity)) {
        break;
      }
      if (candidate === '.') {
        continue;
      }
      if (!fileFilter(candidate)) {
        finalResults.push(candidate);
      }
    }
    return finalResults;
  }
}

export class FileSearchFactory {
  static create(options: FileSearchOptions): FileSearch {
    if (options.enableRecursiveFileSearch) {
      // Use Rust-accelerated search when available
      return new RustAcceleratedFileSearch(options);
    }
    return new DirectoryFileSearch(options);
  }
}

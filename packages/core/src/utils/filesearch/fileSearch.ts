/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import picomatch from 'picomatch';
import type { Ignore } from './ignore.js';
import { loadIgnoreRules } from './ignore.js';
import { crawl } from './crawler.js';
import { FileIndexService } from './fileIndexService.js';

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
  /**
   * Release any resources held by this instance. For the recursive (worker-
   * backed) implementation this tears down the shared FileIndexService so the
   * next `FileSearchFactory.create(...)` call gets a fresh worker — callers
   * should invoke this when filesystem events (e.g. a watcher reporting file
   * create/delete) would otherwise leave the indexed snapshot stale.
   * Optional to implement for backward compatibility; callers that didn't
   * previously call dispose() don't need to start.
   */
  dispose?(): Promise<void>;
}

/**
 * Thin proxy over a shared {@link FileIndexService}. Prior to P1 this class
 * owned the crawl, the fzf index, and the result cache on the main thread,
 * which could block the Ink render loop for hundreds of milliseconds on
 * large monorepos. Those responsibilities now live in a worker thread
 * managed by FileIndexService; the proxy is kept so existing callers and
 * the public `FileSearch` interface are unchanged.
 */
class RecursiveFileSearch implements FileSearch {
  private service: FileIndexService | undefined;

  constructor(private readonly options: FileSearchOptions) {}

  async initialize(): Promise<void> {
    // Grab-or-create the shared service. The crawl starts eagerly inside
    // the worker. We wait for `whenReady()` here so the public contract
    // ("after initialize, search results are complete") is preserved for
    // existing callers like vscode-ide-companion. This no longer blocks
    // the main thread because the heavy work happens inside the worker;
    // Ink can render "loading" state while the promise is pending.
    // Streaming-aware callers (e.g. useAtCompletion) go straight to
    // `FileIndexService.for(...)` to bypass this wait.
    this.service = FileIndexService.for(this.options);
    await this.service.whenReady();
  }

  async search(
    pattern: string,
    options: SearchOptions = {},
  ): Promise<string[]> {
    if (!this.service) {
      throw new Error('Engine not initialized. Call initialize() first.');
    }
    return this.service.search(pattern, options);
  }

  async dispose(): Promise<void> {
    const svc = this.service;
    this.service = undefined;
    await svc?.dispose();
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
      return new RecursiveFileSearch(options);
    }
    return new DirectoryFileSearch(options);
  }
}

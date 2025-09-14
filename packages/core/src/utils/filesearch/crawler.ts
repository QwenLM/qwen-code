/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fdir } from 'fdir';
import { Ignore } from './ignore.js';
import * as cache from './crawlCache.js';

/**
 * Defines the options for the `crawl` function.
 */
export interface CrawlOptions {
  /**
   * The directory to start the crawl from.
   */
  crawlDirectory: string;
  /**
   * The project's root directory, used for making the returned paths relative.
   */
  cwd: string;
  /**
   * The maximum depth to crawl, passed to the underlying `fdir` library.
   */
  maxDepth?: number;
  /**
   * A pre-configured `Ignore` instance to filter out files and directories.
   */
  ignore: Ignore;
  /**
   * Caching options.
   */
  cache: boolean;
  /**
   * The time-to-live for cache entries, in seconds.
   */
  cacheTtl: number;
}

/**
 * Converts a path to a POSIX-style path (using `/` as a separator).
 * @param p The path to convert.
 * @returns The POSIX-style path.
 */
function toPosixPath(p: string) {
  return p.split(path.sep).join(path.posix.sep);
}

/**
 * Crawls a directory and returns a list of all files and directories, respecting ignore rules.
 * This function uses the `fdir` library for efficient directory traversal and can cache results
 * to speed up subsequent calls.
 *
 * @param options The options for the crawl operation.
 * @returns A promise that resolves to an array of POSIX-style paths, relative to the `cwd` option.
 */
export async function crawl(options: CrawlOptions): Promise<string[]> {
  if (options.cache) {
    const cacheKey = cache.getCacheKey(
      options.crawlDirectory,
      options.ignore.getFingerprint(),
      options.maxDepth,
    );
    const cachedResults = cache.read(cacheKey);

    if (cachedResults) {
      return cachedResults;
    }
  }

  const posixCwd = toPosixPath(options.cwd);
  const posixCrawlDirectory = toPosixPath(options.crawlDirectory);

  let results: string[];
  try {
    const dirFilter = options.ignore.getDirectoryFilter();
    const api = new fdir()
      .withRelativePaths()
      .withDirs()
      .withPathSeparator('/') // Always use unix style paths
      .exclude((_, dirPath) => {
        const relativePath = path.posix.relative(posixCrawlDirectory, dirPath);
        return dirFilter(`${relativePath}/`);
      });

    if (options.maxDepth !== undefined) {
      api.withMaxDepth(options.maxDepth);
    }

    results = await api.crawl(options.crawlDirectory).withPromise();
  } catch (_e) {
    // The directory probably doesn't exist.
    return [];
  }

  const relativeToCrawlDir = path.posix.relative(posixCwd, posixCrawlDirectory);

  const relativeToCwdResults = results.map((p) =>
    path.posix.join(relativeToCrawlDir, p),
  );

  if (options.cache) {
    const cacheKey = cache.getCacheKey(
      options.crawlDirectory,
      options.ignore.getFingerprint(),
      options.maxDepth,
    );
    cache.write(cacheKey, relativeToCwdResults, options.cacheTtl * 1000);
  }

  return relativeToCwdResults;
}

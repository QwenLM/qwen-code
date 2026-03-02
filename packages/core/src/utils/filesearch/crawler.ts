/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fdir } from 'fdir';
import type { Ignore } from './ignore.js';
import * as cache from './crawlCache.js';
import { createDebugLogger } from '../debugLogger.js';

const debugLogger = createDebugLogger('CRAWLER');

export interface CrawlOptions {
  // The directory to start the crawl from.
  crawlDirectory: string;
  // The project's root directory, for path relativity.
  cwd: string;
  // The fdir maxDepth option.
  maxDepth?: number;
  // A pre-configured Ignore instance.
  ignore: Ignore;
  // Caching options.
  cache: boolean;
  cacheTtl: number;
  // Maximum number of files to crawl to prevent OOM (default: 100000)
  maxFiles?: number;
}

function toPosixPath(p: string) {
  return p.split(path.sep).join(path.posix.sep);
}

export async function crawl(options: CrawlOptions): Promise<string[]> {
  const maxFiles = options.maxFiles ?? 100000;

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

    // Limit the number of files to prevent OOM in large projects
    if (results.length > maxFiles) {
      debugLogger.warn(
        `Project contains ${results.length} files, limiting to ${maxFiles} to prevent memory issues. ` +
          `Consider using .qwenignore to exclude unnecessary directories.`,
      );
      results = results.slice(0, maxFiles);
    }
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

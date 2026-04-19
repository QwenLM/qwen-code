/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fdir } from 'fdir';
import type { Ignore } from './ignore.js';
import * as cache from './crawlCache.js';

export interface CrawlOptions {
  // The directory to start the crawl from.
  crawlDirectory: string;
  // The project's root directory, for path relativity.
  cwd: string;
  // The fdir maxDepth option.
  maxDepth?: number;
  // Maximum number of file entries to return. Prevents OOM on very large trees.
  maxFiles?: number;
  // A pre-configured Ignore instance.
  ignore: Ignore;
  // Caching options.
  cache: boolean;
  cacheTtl: number;
  // Optional streaming callback. If provided, is invoked with batches of
  // cwd-relative paths as fdir discovers them. A final batch containing any
  // remainder is flushed just before the crawl resolves. Errors thrown by the
  // callback are caught and ignored.
  onProgress?: (chunk: string[]) => void;
  // Buffer flushing thresholds for onProgress. Flush when either hits first.
  progressChunkSize?: number; // default 2000
  progressFlushMs?: number; // default 50
}

function toPosixPath(p: string) {
  return p.split(path.sep).join(path.posix.sep);
}

export async function crawl(options: CrawlOptions): Promise<string[]> {
  if (options.cache) {
    const cacheKey = cache.getCacheKey(
      options.crawlDirectory,
      options.ignore.getFingerprint(),
      options.maxDepth,
      options.maxFiles,
    );
    const cachedResults = cache.read(cacheKey);

    if (cachedResults) {
      return cachedResults;
    }
  }

  const posixCwd = toPosixPath(options.cwd);
  const posixCrawlDirectory = toPosixPath(options.crawlDirectory);
  const relativeToCrawlDir = path.posix.relative(posixCwd, posixCrawlDirectory);

  // Streaming state for onProgress callback.
  const onProgress = options.onProgress;
  const chunkSize = options.progressChunkSize ?? 2000;
  const flushMs = options.progressFlushMs ?? 50;
  let progressBuffer: string[] = [];
  let lastFlushAt = Date.now();
  const flushProgress = () => {
    if (!onProgress || progressBuffer.length === 0) return;
    const toSend = progressBuffer;
    progressBuffer = [];
    lastFlushAt = Date.now();
    try {
      onProgress(toSend);
    } catch {
      // swallow; the caller is best-effort
    }
  };

  let results: string[];
  try {
    const dirFilter = options.ignore.getDirectoryFilter();
    const fileFilter = options.ignore.getFileFilter();
    const api = new fdir()
      .withRelativePaths()
      .withDirs()
      .withPathSeparator('/') // Always use unix style paths
      .exclude((_, dirPath) => {
        const relativePath = path.posix.relative(posixCrawlDirectory, dirPath);
        return dirFilter(`${relativePath}/`);
      })
      .filter((filePath, isDirectory) => {
        // Apply file-level ignore patterns (e.g. *.log, *.map) during the
        // crawl so they don't consume the maxFiles budget. Directories are
        // already handled by the exclude() callback above, but we still buffer
        // them for the onProgress stream so partial snapshots include
        // directory entries in their natural position.
        const cwdRelative = path.posix.join(relativeToCrawlDir, filePath);
        const keep = isDirectory ? true : !fileFilter(cwdRelative);
        if (keep && onProgress) {
          progressBuffer.push(cwdRelative);
          if (
            progressBuffer.length >= chunkSize ||
            Date.now() - lastFlushAt >= flushMs
          ) {
            flushProgress();
          }
        }
        return keep;
      });

    if (options.maxDepth !== undefined) {
      api.withMaxDepth(options.maxDepth);
    }

    if (options.maxFiles !== undefined) {
      api.withMaxFiles(options.maxFiles);
    }

    results = await api.crawl(options.crawlDirectory).withPromise();
  } catch (_e) {
    // The directory probably doesn't exist.
    flushProgress();
    return [];
  }

  // Flush any remaining buffered progress before returning the final batch.
  flushProgress();

  const relativeToCwdResults = results.map((p) =>
    path.posix.join(relativeToCrawlDir, p),
  );

  if (options.cache) {
    const cacheKey = cache.getCacheKey(
      options.crawlDirectory,
      options.ignore.getFingerprint(),
      options.maxDepth,
      options.maxFiles,
    );
    cache.write(cacheKey, relativeToCwdResults, options.cacheTtl * 1000);
  }

  return relativeToCwdResults;
}

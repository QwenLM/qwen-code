/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { fdir } from 'fdir';
import type { Ignore } from './ignore.js';
import * as cache from './crawlCache.js';
import { buildRipgrepFileFilter, ripgrepCrawl } from './ripgrepCrawler.js';

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
  // cwd-relative paths as the underlying walker discovers them. A final
  // batch containing any remainder is flushed just before the crawl
  // resolves. Errors thrown by the callback are caught and ignored.
  onProgress?: (chunk: string[]) => void;
  // Buffer flushing thresholds for onProgress. Flush when either hits first.
  progressChunkSize?: number; // default 2000
  progressFlushMs?: number; // default 50
  // Abort signal threaded through to ripgrep so a search change can kill
  // an in-flight crawl early.
  signal?: AbortSignal;
  // Escape hatch: force the fdir backend even when ripgrep would be
  // eligible. Mostly for tests; in production callers always default to
  // the faster ripgrep path.
  preferFdir?: boolean;
}

function toPosixPath(p: string) {
  return p.split(path.sep).join(path.posix.sep);
}

/**
 * Once-per-process flag that disables the ripgrep fast path after a runtime
 * failure (binary missing, unexpected exit). We retry fdir for subsequent
 * crawls without paying the spawn-and-fail cost every time.
 */
let ripgrepDisabled = false;

/** For tests: let a suite re-enable the ripgrep fast path after forcing failures. */
export function __resetRipgrepDisabledForTests(): void {
  ripgrepDisabled = false;
}

async function fdirCrawl(options: CrawlOptions): Promise<string[]> {
  const posixCwd = toPosixPath(options.cwd);
  const posixCrawlDirectory = toPosixPath(options.crawlDirectory);
  const relativeToCrawlDir = path.posix.relative(posixCwd, posixCrawlDirectory);

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

  flushProgress();

  return results.map((p) => path.posix.join(relativeToCrawlDir, p));
}

/**
 * Extracts the directory portion of the ignore fingerprint-relevant info.
 * Currently we just pass the patterns straight through; the ripgrep walker
 * already consults `.gitignore` / `.ignore` from disk via its own parser,
 * so our `extraExcludeDirs` set is limited to directory-style patterns that
 * rg wouldn't otherwise know about (e.g. user-supplied ignoreDirs, or
 * `.qwenignore` directory rules). This is a superset; the post-filter
 * below enforces the exact semantics.
 */
function collectRipgrepExcludeDirs(_options: CrawlOptions): string[] {
  // We rely on the Ignore object's directory filter for correctness; the
  // rg --glob hints are only a speed optimisation so rg's walker can prune
  // without actually listing matching files. The post-filter drops
  // anything that slips through. Left as a hook for a later perf pass
  // (see the TODO below); currently we let rg enumerate and filter
  // ourselves, which is still fast enough in practice.
  return [];
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

  // Benchmark findings (measured against fdir on the same tree):
  //
  //   qwen-code repo (~2700 files)     fdir ~25ms   rg ~140ms   fdir wins
  //   project/node_modules (~48k)      fdir ~640ms  rg ~1800ms  fdir wins
  //   ~/ home dir (100k-file cap)      fdir ~9s     rg ~2.5s    rg 3-4× wins
  //
  // On small repos Node's `spawn`+stdout IPC overhead (~50-100ms baseline)
  // beats rg's native parallel walker. Past roughly 50k files the picture
  // flips: fdir's single-threaded JS walk plus per-entry `.gitignore`
  // callbacks into the `ignore` package balloon, while rg's Rust walker
  // stays saturated across cores and keeps output flowing. Since the slow
  // case is the painful one (a user typing @ at $HOME shouldn't wait 9s)
  // and the fast case is already well under the 200 ms loading threshold
  // regardless of backend, we default to rg and let callers force fdir
  // via `QWEN_FILESEARCH_USE_RG=0` if needed.
  const rgEnvVar = process.env['QWEN_FILESEARCH_USE_RG'];
  const ripgrepEnabled = rgEnvVar === undefined ? true : rgEnvVar !== '0';
  const canUseRipgrep =
    ripgrepEnabled &&
    !options.preferFdir &&
    !ripgrepDisabled &&
    options.maxDepth === undefined;

  let results: string[] | undefined;
  if (canUseRipgrep) {
    try {
      const ripResult = await ripgrepCrawl({
        crawlDirectory: options.crawlDirectory,
        cwd: options.cwd,
        maxFiles: options.maxFiles,
        extraExcludeDirs: collectRipgrepExcludeDirs(options),
        fileFilter: buildRipgrepFileFilter(options.ignore),
        onProgress: options.onProgress,
        progressChunkSize: options.progressChunkSize,
        progressFlushMs: options.progressFlushMs,
        signal: options.signal,
      });
      results = ripResult.files;
    } catch (_e) {
      ripgrepDisabled = true;
      results = undefined;
    }
  }

  if (results === undefined) {
    results = await fdirCrawl(options);
  }

  if (options.cache) {
    const cacheKey = cache.getCacheKey(
      options.crawlDirectory,
      options.ignore.getFingerprint(),
      options.maxDepth,
      options.maxFiles,
    );
    cache.write(cacheKey, results, options.cacheTtl * 1000);
  }

  return results;
}

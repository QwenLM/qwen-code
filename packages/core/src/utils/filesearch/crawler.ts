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
 * Timestamp (ms) at which the ripgrep fast path was last disabled, or `0`
 * if rg is currently eligible. A single spawn failure (missing binary,
 * sandbox race, transient resource exhaustion) shouldn't downgrade the
 * process forever — long-lived hosts like the VSCode extension would pay
 * the fdir penalty for the rest of the session. We cool down for
 * `RIPGREP_DISABLED_COOLDOWN_MS` and then re-try on the next crawl.
 */
const RIPGREP_DISABLED_COOLDOWN_MS = 5 * 60 * 1000;
let ripgrepDisabledAt = 0;

function isRipgrepDisabled(): boolean {
  if (ripgrepDisabledAt === 0) return false;
  if (Date.now() - ripgrepDisabledAt >= RIPGREP_DISABLED_COOLDOWN_MS) {
    ripgrepDisabledAt = 0;
    return false;
  }
  return true;
}

/** For tests: let a suite re-enable the ripgrep fast path after forcing failures. */
export function __resetRipgrepDisabledForTests(): void {
  ripgrepDisabledAt = 0;
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
 * Directory-only hints we hand to rg as `--glob '!dir'` args so its walker
 * can skip the subtree entirely instead of streaming every path under it
 * for the Node post-filter to reject. rg already understands `.gitignore`
 * / `.ignore` natively, so those rules don't need forwarding; the
 * additions here are:
 *
 *   - user-supplied `ignoreDirs` (from the `FileSearchOptions` contract),
 *   - directory-style patterns from `.qwenignore` (which rg doesn't read),
 *     extracted from the shared Ignore's fingerprint.
 *
 * The post-filter in `ripgrepCrawler` is still the source of truth — this
 * is a speed optimisation only. Patterns that contain glob metacharacters
 * (`*`, `?`, `[`, `!`, `/`) or newlines are skipped: rg would interpret
 * them, and getting the semantics wrong risks silently hiding files.
 * Plain directory names pass through unchanged.
 */
function collectRipgrepExcludeDirs(options: CrawlOptions): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const p = raw.replace(/^\/+|\/+$/g, '');
    if (!p || /[*?[\]]/.test(p) || p.includes('/') || p.includes('\n')) {
      return;
    }
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };
  // Pull plain directory patterns (e.g. `build/`, `dist/`, `.git/`, or
  // anything the caller passed as `ignoreDirs` which `loadIgnoreRules`
  // normalised into a trailing-slash pattern) out of the ignore
  // fingerprint. gitignore-family syntax is line-oriented; we only accept
  // patterns that are unambiguously a bare directory name so we don't
  // confuse rg with `foo/**` or `!foo/`. The post-filter in ripgrepCrawler
  // is still the source of truth — this is a speed optimisation only so rg
  // can prune whole subtrees at its walker rather than streaming every
  // path under them for the Node filter to discard.
  const fingerprint = options.ignore.getFingerprint?.() ?? '';
  for (const line of fingerprint.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!'))
      continue;
    if (!trimmed.endsWith('/')) continue;
    push(trimmed);
  }
  return out;
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
    !isRipgrepDisabled() &&
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
      ripgrepDisabledAt = Date.now();
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

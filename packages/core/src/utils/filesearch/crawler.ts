/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
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
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

// ---------------------------------------------------------------------------
// Throttling: rebuild index at most once per 5 seconds
// ---------------------------------------------------------------------------

const THROTTLE_MS = 5_000;
const lastRebuildTime = new Map<string, number>();

function isThrottled(crawlDirectory: string): boolean {
  const last = lastRebuildTime.get(crawlDirectory);
  if (last === undefined) return false;
  return Date.now() - last < THROTTLE_MS;
}

function recordRebuild(crawlDirectory: string): void {
  lastRebuildTime.set(crawlDirectory, Date.now());
}

// ---------------------------------------------------------------------------
// Mtime-based change detection
// ---------------------------------------------------------------------------

interface ChangeState {
  gitRootMtimeMs: number | null;
  fileList: string[];
}

const changeStateMap = new Map<string, ChangeState>();

function getGitRootMtime(crawlDirectory: string): number | null {
  try {
    // Walk up from crawlDirectory to find .git
    let current = crawlDirectory;
    while (current) {
      const gitDir = path.join(current, '.git');
      const stat = fs.statSync(gitDir);
      if (stat.isDirectory()) {
        // Found .git, now get its index file mtime
        const indexPath = path.join(gitDir, 'index');
        const indexStat = fs.statSync(indexPath);
        return indexStat.mtimeMs;
      }
      const parent = path.dirname(current);
      if (parent === current) break; // Reached root
      current = parent;
    }
  } catch {
    // Not a git repo or can't stat
  }
  return null;
}

function hasFileListChanged(crawlDirectory: string): boolean {
  const currentMtime = getGitRootMtime(crawlDirectory);
  const state = changeStateMap.get(crawlDirectory);

  if (!state) return true;

  // If mtime changed since last crawl, files may have changed
  if (currentMtime !== null && state.gitRootMtimeMs !== null) {
    return currentMtime > state.gitRootMtimeMs;
  }

  // If we can't determine mtime, always re-crawl
  return true;
}

function updateChangeState(crawlDirectory: string, fileList: string[]): void {
  const mtime = getGitRootMtime(crawlDirectory);
  changeStateMap.set(crawlDirectory, { gitRootMtimeMs: mtime, fileList });
}

// ---------------------------------------------------------------------------
// Process helpers: run a command with timeout and return stdout lines
// ---------------------------------------------------------------------------

interface CommandResult {
  success: boolean;
  lines: string[];
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = 20_000,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = execFile(
      command,
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 20_000_000, windowsHide: true },
      (error, stdout = '') => {
        if (error) {
          resolve({ success: false, lines: [] });
          return;
        }
        const lines = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0);
        resolve({ success: true, lines });
      },
    );
    child.on('error', () => resolve({ success: false, lines: [] }));
  });
}

// ---------------------------------------------------------------------------
// Normalize paths: convert Windows separators to POSIX
// ---------------------------------------------------------------------------

function normalizePath(p: string): string {
  return toPosixPath(p);
}

// ---------------------------------------------------------------------------
// Yield to event loop periodically for async chunked indexing (200k+ files)
// ---------------------------------------------------------------------------

const YIELD_INTERVAL = 1000;

async function maybeYield(index: number): Promise<void> {
  if (index % YIELD_INTERVAL === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// ---------------------------------------------------------------------------
// Primary: git ls-files
// ---------------------------------------------------------------------------

/**
 * Finds the git root for a given directory.
 * Returns the git root path, or null if not in a git repo.
 */
async function findGitRoot(dir: string): Promise<string | null> {
  const result = await runCommand(
    'git',
    ['rev-parse', '--show-toplevel'],
    dir,
    5_000,
  );
  if (!result.success || result.lines.length === 0) return null;
  return normalizePath(result.lines[0]);
}

/**
 * Crawls using git ls-files. Returns tracked + untracked files.
 * The paths in the returned list are relative to `crawlDirectory`.
 */
async function crawlWithGitLsFiles(
  crawlDirectory: string,
  cwd: string,
  options: CrawlOptions,
): Promise<{ success: boolean; files: string[]; isGitRepo: boolean }> {
  const gitRoot = await findGitRoot(crawlDirectory);
  if (!gitRoot) {
    return { success: false, files: [], isGitRepo: false };
  }

  const posixCrawlDir = normalizePath(crawlDirectory);

  // Get relative path from git root to crawl directory
  const relativeToGitRoot = path.posix.relative(gitRoot, posixCrawlDir);

  // Get tracked files (git ls-files outputs paths relative to git root)
  // Use `--` separator to ensure crawlDirectory is treated as a path argument
  // Pass crawlDirectory as path argument to scope results
  const trackedArgs = [
    'ls-files',
    '--cached',
    '--',
    relativeToGitRoot === '.' || relativeToGitRoot === ''
      ? posixCrawlDir
      : relativeToGitRoot,
  ];
  const trackedResult = await runCommand('git', trackedArgs, gitRoot, 20_000);
  if (!trackedResult.success) {
    return { success: false, files: [], isGitRepo: true };
  }

  // Get untracked files (excluding standard git ignored files)
  const untrackedArgs = [
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    relativeToGitRoot === '.' || relativeToGitRoot === ''
      ? posixCrawlDir
      : relativeToGitRoot,
  ];
  const untrackedResult = await runCommand(
    'git',
    untrackedArgs,
    gitRoot,
    10_000,
  );

  // Combine tracked + untracked files
  const fileSet = new Set<string>();
  let count = 0;

  for (const file of trackedResult.lines) {
    await maybeYield(count++);
    const normalizedFile = normalizePath(file);
    // Convert from gitRoot-relative to crawlDirectory-relative
    const fullPath = path.posix.relative(
      posixCrawlDir,
      path.posix.join(gitRoot, normalizedFile),
    );
    fileSet.add(fullPath);
  }

  if (untrackedResult.success) {
    for (const file of untrackedResult.lines) {
      await maybeYield(count++);
      const normalizedFile = normalizePath(file);
      // Convert from gitRoot-relative to crawlDirectory-relative
      const fullPath = path.posix.relative(
        posixCrawlDir,
        path.posix.join(gitRoot, normalizedFile),
      );
      if (!fileSet.has(fullPath)) {
        fileSet.add(fullPath);
      }
    }
  }

  // Build results with directories
  const results = buildResultsFromFileSet(fileSet);

  // Apply custom ignore rules
  const dirFilter = options.ignore.getDirectoryFilter();
  const fileFilter = options.ignore.getFileFilter();

  const filteredResults = results.filter((p) => {
    if (p === '.') return true;
    if (p.endsWith('/')) return !dirFilter(p);
    return !fileFilter(p);
  });

  // Update change detection state
  updateChangeState(crawlDirectory, filteredResults);
  recordRebuild(crawlDirectory);

  return { success: true, files: filteredResults, isGitRepo: true };
}

/**
 * Given a set of file paths, produces a list that includes:
 * - The root marker '.'
 * - All unique parent directories (with trailing '/')
 * - All files
 */
function buildResultsFromFileSet(files: Set<string>): string[] {
  const dirSet = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    let current = '';
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? current + '/' + parts[i] : parts[i];
      dirSet.add(current + '/');
    }
  }
  return ['.', ...Array.from(dirSet), ...Array.from(files)];
}

// ---------------------------------------------------------------------------
// Fallback 1: ripgrep --files
// ---------------------------------------------------------------------------

async function crawlWithRipgrep(
  crawlDirectory: string,
  cwd: string,
  options: CrawlOptions,
): Promise<{ success: boolean; files: string[] }> {
  const rgResult = await runCommand(
    'rg',
    ['--files', '--no-require-git'],
    crawlDirectory,
    20_000,
  );

  if (!rgResult.success) {
    return { success: false, files: [] };
  }

  // ripgrep --files with crawlDirectory as cwd returns paths relative to crawlDirectory
  // No need to adjust paths - they're already relative to crawlDirectory
  const fileSet = new Set<string>();
  let count = 0;
  for (const file of rgResult.lines) {
    await maybeYield(count++);
    const normalizedFile = normalizePath(file);
    fileSet.add(normalizedFile);
  }

  const results = buildResultsFromFileSet(fileSet);

  // Apply custom ignore rules
  const dirFilter = options.ignore.getDirectoryFilter();
  const fileFilter = options.ignore.getFileFilter();

  const filteredResults = results.filter((p) => {
    if (p === '.') return true;
    if (p.endsWith('/')) return !dirFilter(p);
    return !fileFilter(p);
  });

  recordRebuild(crawlDirectory);
  return { success: true, files: filteredResults };
}

// ---------------------------------------------------------------------------
// Fallback 2: original fdir-based crawl
// ---------------------------------------------------------------------------

async function crawlWithFdir(options: CrawlOptions): Promise<string[]> {
  const posixCwd = toPosixPath(options.cwd);
  const posixCrawlDirectory = toPosixPath(options.crawlDirectory);
  const relativeToCrawlDir = path.posix.relative(posixCwd, posixCrawlDirectory);

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
        // Directories are already handled by the exclude() callback above.
        if (isDirectory) return true;
        // Apply file-level ignore patterns (e.g. *.log, *.map) during the
        // crawl so they don't consume the maxFiles budget.
        const cwdRelative = path.posix.join(relativeToCrawlDir, filePath);
        return !fileFilter(cwdRelative);
      });

    if (options.maxDepth !== undefined) {
      api.withMaxDepth(options.maxDepth);
    }

    if (options.maxFiles !== undefined) {
      api.withMaxFiles(options.maxFiles);
    }

    results = await api.crawl(options.crawlDirectory).withPromise();
  } catch {
    // The directory probably doesn't exist.
    return [];
  }

  return results.map((p) => path.posix.join(relativeToCrawlDir, p));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function crawl(options: CrawlOptions): Promise<string[]> {
  // Check in-memory cache first
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

  // Check throttling: don't rebuild more than once per 5 seconds
  if (isThrottled(options.crawlDirectory)) {
    // Return cached result from changeStateMap if available
    const state = changeStateMap.get(options.crawlDirectory);
    if (state) {
      return applyMaxFilesLimit(state.fileList, options.maxFiles);
    }
    // Fall through to crawl if no state available
  }

  // Check if files have changed (mtime-based change detection)
  const needReCrawl = hasFileListChanged(options.crawlDirectory);

  // If no re-crawl needed and we have cached state, return it
  if (!needReCrawl) {
    const state = changeStateMap.get(options.crawlDirectory);
    if (state) {
      return applyMaxFilesLimit(state.fileList, options.maxFiles);
    }
  }

  // Try git ls-files first (primary path)
  const gitResult = await crawlWithGitLsFiles(
    options.crawlDirectory,
    options.cwd,
    options,
  );
  if (gitResult.success) {
    const results = applyMaxFilesLimit(gitResult.files, options.maxFiles);

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

  // Not a git repo — try ripgrep fallback
  if (!gitResult.isGitRepo) {
    const rgResult = await crawlWithRipgrep(
      options.crawlDirectory,
      options.cwd,
      options,
    );
    if (rgResult.success) {
      const results = applyMaxFilesLimit(rgResult.files, options.maxFiles);

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
  }

  // Ripgrep not available or failed — fall back to original fdir behavior
  const fdirResults = await crawlWithFdir(options);
  const limitedResults = applyMaxFilesLimit(fdirResults, options.maxFiles);

  if (options.cache) {
    const cacheKey = cache.getCacheKey(
      options.crawlDirectory,
      options.ignore.getFingerprint(),
      options.maxDepth,
      options.maxFiles,
    );
    cache.write(cacheKey, limitedResults, options.cacheTtl * 1000);
  }

  return limitedResults;
}

function applyMaxFilesLimit(results: string[], maxFiles?: number): string[] {
  if (maxFiles !== undefined && results.length > maxFiles) {
    return results.slice(0, maxFiles);
  }
  return results;
}

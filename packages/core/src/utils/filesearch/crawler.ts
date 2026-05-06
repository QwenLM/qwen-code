/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
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
  // Whether gitignore filtering should be respected by git/rg paths.
  useGitignore?: boolean;
  // Caching options.
  cache: boolean;
  cacheTtl: number;
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join(path.posix.sep);
}

const THROTTLE_MS = 5_000;
const PATH_CACHE_TTL_MS = 30_000;
const MAX_PATH_CACHE_ENTRIES = 200;
const MAX_CHANGE_STATE_ENTRIES = 50;
const STDERR_LOG_MAX_CHARS = 4_096;

const lastRebuildTime = new Map<string, number>();

interface Timestamped<T> {
  value: T;
  cachedAt: number;
}

function trimPathCache<T>(map: Map<string, Timestamped<T>>): void {
  while (map.size > MAX_PATH_CACHE_ENTRIES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    map.delete(oldest);
  }
}

function pathCacheGet<T>(
  map: Map<string, Timestamped<T>>,
  key: string,
): T | undefined {
  const entry = map.get(key);
  if (!entry) {
    return undefined;
  }
  if (Date.now() - entry.cachedAt > PATH_CACHE_TTL_MS) {
    map.delete(key);
    return undefined;
  }
  return entry.value;
}

function pathCacheSet<T>(
  map: Map<string, Timestamped<T>>,
  key: string,
  value: T,
): void {
  map.set(key, { value, cachedAt: Date.now() });
  trimPathCache(map);
}

function truncateStderrSnippet(stderr: string): string {
  const t = stderr.trim();
  if (t.length <= STDERR_LOG_MAX_CHARS) {
    return t;
  }
  return `${t.slice(0, STDERR_LOG_MAX_CHARS)}…`;
}

function logCommandProblem(
  kind: string,
  command: string,
  args: string[],
  detail: { code?: number | null; stderr?: string },
): void {
  const parts = [`[crawler] ${kind}:`, command, args.join(' ')];
  if (detail.code !== undefined && detail.code !== null) {
    parts.push(`exit=${String(detail.code)}`);
  }
  if (detail.stderr && detail.stderr.length > 0) {
    parts.push(truncateStderrSnippet(detail.stderr));
  }
  // eslint-disable-next-line no-console -- intentional diagnostics for git/rg failures
  console.warn(parts.join(' '));
}

function getStateKey(options: CrawlOptions): string {
  return [
    normalizePath(options.crawlDirectory),
    normalizePath(options.cwd),
    options.ignore.getFingerprint(),
    options.useGitignore === false ? 'no-gitignore' : 'gitignore',
    options.maxDepth === undefined ? 'undefined' : String(options.maxDepth),
    options.maxFiles === undefined ? 'undefined' : String(options.maxFiles),
  ].join('|');
}

function isThrottled(stateKey: string): boolean {
  const last = lastRebuildTime.get(stateKey);
  if (last === undefined) return false;
  return Date.now() - last < THROTTLE_MS;
}

function recordRebuild(stateKey: string): void {
  lastRebuildTime.set(stateKey, Date.now());
}

interface ChangeState {
  gitRootMtimeMs: number | null;
  untrackedFingerprint: string | null;
  deletedFingerprint: string | null;
  fileList: string[];
}

const changeStateMap = new Map<string, ChangeState>();

const resolveGitDirCache = new Map<string, Timestamped<string | null>>();

function evictChangeStateIfNeeded(): void {
  while (changeStateMap.size >= MAX_CHANGE_STATE_ENTRIES) {
    const oldest = changeStateMap.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    changeStateMap.delete(oldest);
    lastRebuildTime.delete(oldest);
  }
}

function resolveGitDir(crawlDirectory: string): string | null {
  const cacheKey = normalizePath(path.resolve(crawlDirectory));
  const cached = pathCacheGet(resolveGitDirCache, cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let current = crawlDirectory;

  while (current) {
    const gitPath = path.join(current, '.git');

    try {
      const stat = fs.statSync(gitPath);

      if (stat.isDirectory()) {
        pathCacheSet(resolveGitDirCache, cacheKey, gitPath);
        return gitPath;
      }

      if (stat.isFile()) {
        const contents = fs.readFileSync(gitPath, 'utf8').trim();
        const match = contents.match(/^gitdir:\s*(.+)$/i);
        if (!match) {
          pathCacheSet(resolveGitDirCache, cacheKey, null);
          return null;
        }

        const resolvedGitDir = match[1].trim();
        const resolved = path.isAbsolute(resolvedGitDir)
          ? resolvedGitDir
          : path.resolve(current, resolvedGitDir);
        pathCacheSet(resolveGitDirCache, cacheKey, resolved);
        return resolved;
      }
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      if (errno.code !== 'ENOENT') {
        return null;
      }
    }

    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  pathCacheSet(resolveGitDirCache, cacheKey, null);
  return null;
}

function getGitRootMtime(crawlDirectory: string): number | null {
  try {
    const gitDir = resolveGitDir(crawlDirectory);
    if (!gitDir) {
      return null;
    }

    const indexPath = path.join(gitDir, 'index');
    const indexStat = fs.statSync(indexPath);
    return indexStat.mtimeMs;
  } catch {
    // Ignore errors when .git metadata or index file doesn't exist.
  }
  return null;
}

function hasFileListChanged(stateKey: string, crawlDirectory: string): boolean {
  const currentMtime = getGitRootMtime(crawlDirectory);
  const state = changeStateMap.get(stateKey);

  if (!state) return true;

  if (currentMtime !== null && state.gitRootMtimeMs !== null) {
    return currentMtime > state.gitRootMtimeMs || !isThrottled(stateKey);
  }

  // For non-git paths, we can only rely on time-based throttling.
  if (currentMtime === null && state.gitRootMtimeMs === null) {
    return !isThrottled(stateKey);
  }

  return true;
}

function updateChangeState(
  stateKey: string,
  crawlDirectory: string,
  fileList: string[],
  untrackedFiles?: string[],
  deletedFiles?: string[],
): void {
  evictChangeStateIfNeeded();
  const mtime = getGitRootMtime(crawlDirectory);
  changeStateMap.set(stateKey, {
    gitRootMtimeMs: mtime,
    untrackedFingerprint:
      untrackedFiles === undefined
        ? null
        : computeLinesFingerprint(untrackedFiles),
    deletedFingerprint:
      deletedFiles === undefined ? null : computeLinesFingerprint(deletedFiles),
    fileList,
  });
}

function computeLinesFingerprint(lines: string[]): string {
  let hash = 5381;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      hash = ((hash << 5) + hash + line.charCodeAt(i)) >>> 0;
    }
    hash = ((hash << 5) + hash + 10) >>> 0;
  }
  return `${lines.length}:${hash}`;
}

interface CommandResult {
  success: boolean;
  lines: string[];
}

interface RunCommandOptions {
  maxLines?: number;
  collectLines?: boolean;
  onLine?: (line: string) => boolean;
  silentOnFailure?: boolean;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number = 20_000,
  options?: RunCommandOptions,
): Promise<CommandResult> {
  const maxLines = options?.maxLines;
  const collectLines = options?.collectLines !== false;

  if (maxLines !== undefined && maxLines <= 0) {
    return Promise.resolve({ success: true, lines: [] });
  }

  return new Promise((resolve) => {
    const lines: string[] = [];
    let settled = false;
    let timedOut = false;
    let killedByLimit = false;
    let streamBuffer = '';

    const finalize = (success: boolean, resultLines: string[]): void => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ success, lines: resultLines });
    };

    let stderrBuf = '';
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      logCommandProblem('command spawn threw', command, args, {
        stderr: err instanceof Error ? err.message : String(err),
      });
      finalize(false, []);
      return;
    }

    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        if (stderrBuf.length < STDERR_LOG_MAX_CHARS) {
          stderrBuf += chunk;
          if (stderrBuf.length > STDERR_LOG_MAX_CHARS) {
            stderrBuf = stderrBuf.slice(0, STDERR_LOG_MAX_CHARS);
          }
        }
      });
    }

    const stopProcess = (): void => {
      if (child.killed) {
        return;
      }
      try {
        child.kill();
      } catch {
        // Ignore kill failures.
      }
    };

    const processLine = (line: string): boolean => {
      const normalized = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (normalized.length === 0) {
        return true;
      }

      if (collectLines) {
        lines.push(normalized);
      }

      if (options?.onLine && !options.onLine(normalized)) {
        killedByLimit = true;
        stopProcess();
        return false;
      }

      if (maxLines !== undefined && lines.length >= maxLines) {
        killedByLimit = true;
        stopProcess();
        return false;
      }

      return true;
    };

    const processChunk = (chunk: string): void => {
      streamBuffer += chunk;

      while (true) {
        const newlineIndex = streamBuffer.indexOf('\n');
        if (newlineIndex === -1) {
          break;
        }

        const line = streamBuffer.slice(0, newlineIndex);
        streamBuffer = streamBuffer.slice(newlineIndex + 1);
        if (!processLine(line)) {
          break;
        }
      }
    };

    const flushRemainder = (): void => {
      if (streamBuffer.length === 0) {
        return;
      }
      processLine(streamBuffer);
      streamBuffer = '';
    };

    let timeout: NodeJS.Timeout | undefined;
    if (timeoutMs > 0) {
      timeout = setTimeout(() => {
        timedOut = true;
        stopProcess();
      }, timeoutMs);
    }

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      processChunk(chunk);
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      logCommandProblem('command spawn failed', command, args, {
        stderr: `${String(err.code ?? '')} ${String(err)}`.trim(),
      });
      finalize(false, []);
    });

    child.on('close', (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }

      if (timedOut) {
        if (!options?.silentOnFailure) {
          logCommandProblem('command timed out', command, args, {
            code,
            stderr: stderrBuf,
          });
        }
        finalize(false, []);
        return;
      }

      if (killedByLimit) {
        finalize(true, lines);
        return;
      }

      flushRemainder();

      const ok = code === 0;
      if (!ok && !options?.silentOnFailure) {
        logCommandProblem('command failed', command, args, {
          code,
          stderr: stderrBuf,
        });
      }
      finalize(ok, ok ? lines : []);
    });
  });
}

type CommandRunner = typeof runCommand;
let commandRunner: CommandRunner = runCommand;

export function __setCommandRunnerForTests(runner?: CommandRunner): void {
  commandRunner = runner ?? runCommand;
}

export function __resetCrawlerStateForTests(): void {
  lastRebuildTime.clear();
  changeStateMap.clear();
  resolveGitDirCache.clear();
}

function normalizePath(p: string): string {
  return toPosixPath(p);
}

function getPosixRelative(from: string, to: string): string {
  const fromAbs = path.resolve(from);
  const toAbs = path.resolve(to);
  const relative = path.relative(fromAbs, toAbs);
  const posixRel = toPosixPath(relative);
  return posixRel === '' ? '.' : posixRel;
}

function isValidIgnorePath(relativePath: string): boolean {
  if (!relativePath || relativePath === '.') {
    return false;
  }

  if (path.posix.isAbsolute(relativePath)) {
    return false;
  }

  return (
    relativePath !== '..' &&
    !relativePath.startsWith('../') &&
    !relativePath.includes('/../')
  );
}

/** Relative path from crawl root for ignore checks; avoids symlink canonicalization (fdir hot path). */
function toFdirExcludeRelativePath(
  crawlDirectory: string,
  dirPath: string,
): string | null {
  const base = path.resolve(crawlDirectory);
  const absoluteCandidate = path.isAbsolute(dirPath)
    ? dirPath
    : path.join(base, dirPath);
  let rel = path.relative(base, absoluteCandidate);
  rel = toPosixPath(rel);
  if (!rel || rel.startsWith('..') || path.posix.isAbsolute(rel)) {
    return null;
  }
  return isValidIgnorePath(rel) ? rel : null;
}

function getEntryDepth(entry: string): number {
  if (entry === '.') {
    return -1;
  }

  const withoutTrailingSlash = entry.endsWith('/') ? entry.slice(0, -1) : entry;
  if (withoutTrailingSlash.length === 0) {
    return -1;
  }

  return withoutTrailingSlash.split('/').length - 1;
}

function stripCrawlDirectoryPrefix(
  entry: string,
  relativeToCrawlDir: string,
): string {
  if (
    entry === '.' ||
    relativeToCrawlDir === '' ||
    relativeToCrawlDir === '.'
  ) {
    return entry;
  }

  const prefix = relativeToCrawlDir.endsWith('/')
    ? relativeToCrawlDir
    : `${relativeToCrawlDir}/`;

  if (entry === relativeToCrawlDir) {
    return '.';
  }

  if (entry.startsWith(prefix)) {
    return entry.slice(prefix.length) || '.';
  }

  return entry;
}

/** Depth limits apply here; git/rg streaming may still count maxFiles against paths later dropped by depth. */
function applyMaxDepthLimit(
  results: string[],
  maxDepth?: number,
  relativeToCrawlDir?: string,
): string[] {
  if (maxDepth === undefined) {
    return results;
  }

  return results.filter((entry) => {
    if (entry === '.') {
      return true;
    }

    const crawlRootRelativeEntry = relativeToCrawlDir
      ? stripCrawlDirectoryPrefix(entry, relativeToCrawlDir)
      : entry;

    return getEntryDepth(crawlRootRelativeEntry) <= maxDepth;
  });
}

function isUnderIgnoredDirectory(
  filePath: string,
  dirFilter: (dirPath: string) => boolean,
): boolean {
  const parts = filePath.split('/');
  let current = '';

  for (let i = 0; i < parts.length - 1; i++) {
    current = current ? `${current}/${parts[i]}` : parts[i];
    if (dirFilter(`${current}/`)) {
      return true;
    }
  }

  return false;
}

function applyFilters(
  results: string[],
  options: CrawlOptions,
  relativeToCrawlDir?: string,
  prevalidatedFiles?: Set<string>,
): string[] {
  const depthFiltered = applyMaxDepthLimit(
    results,
    options.maxDepth,
    relativeToCrawlDir,
  );
  const dirFilter = options.ignore.getDirectoryFilter();
  const fileFilter = options.ignore.getFileFilter();

  return depthFiltered.filter((p) => {
    if (p === '.') return true;

    if (p.endsWith('/')) {
      if (!isValidIgnorePath(p.slice(0, -1))) {
        return false;
      }
      return !dirFilter(p);
    }

    if (prevalidatedFiles?.has(p)) {
      return true;
    }

    if (!isValidIgnorePath(p)) {
      return false;
    }

    if (isUnderIgnoredDirectory(p, dirFilter)) {
      return false;
    }

    return !fileFilter(p);
  });
}

const YIELD_INTERVAL = 1000;

async function maybeYield(index: number): Promise<void> {
  if (index > 0 && index % YIELD_INTERVAL === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function findGitRoot(dir: string): Promise<string | null> {
  const result = await commandRunner(
    'git',
    ['rev-parse', '--show-toplevel'],
    dir,
    5_000,
    { silentOnFailure: true },
  );
  if (!result.success || result.lines.length === 0) return null;
  return normalizePath(result.lines[0]);
}

function shouldIncludeFile(
  filePath: string,
  dirFilter: (dirPath: string) => boolean,
  fileFilter: (filePath: string) => boolean,
): boolean {
  if (!isValidIgnorePath(filePath)) {
    return false;
  }

  if (isUnderIgnoredDirectory(filePath, dirFilter)) {
    return false;
  }

  if (fileFilter(filePath)) {
    return false;
  }

  return true;
}

function hasReachedFileBudget(fileCount: number, maxFiles?: number): boolean {
  return maxFiles !== undefined && fileCount >= maxFiles;
}

function shouldCountTowardBudget(
  fullPath: string,
  relativeToCrawlDir: string,
  maxDepth?: number,
): boolean {
  if (maxDepth === undefined) {
    return true;
  }
  const crawlRootRelativeEntry = stripCrawlDirectoryPrefix(
    fullPath,
    relativeToCrawlDir,
  );
  return getEntryDepth(crawlRootRelativeEntry) <= maxDepth;
}

async function listUntrackedFiles(
  gitRoot: string,
  relativeToGitRoot: string,
  useGitignore: boolean,
): Promise<string[] | null> {
  // Global `--literal-pathspecs` (before `ls-files`) matches Git CLI expectations on Windows;
  // pathspec characters are then treated literally for optional trailing paths.
  const untrackedArgs = ['--literal-pathspecs', 'ls-files', '--others'];
  if (useGitignore) {
    untrackedArgs.push('--exclude-standard');
  }
  if (relativeToGitRoot && relativeToGitRoot !== '.') {
    untrackedArgs.push(relativeToGitRoot);
  }

  const untrackedResult = await commandRunner(
    'git',
    untrackedArgs,
    gitRoot,
    10_000,
  );
  if (!untrackedResult.success) {
    return null;
  }

  return untrackedResult.lines.map((file) => normalizePath(file));
}

async function listDeletedTrackedFiles(
  gitRoot: string,
  relativeToGitRoot: string,
): Promise<string[] | null> {
  const deletedArgs = ['--literal-pathspecs', 'ls-files', '--deleted'];
  if (relativeToGitRoot && relativeToGitRoot !== '.') {
    deletedArgs.push(relativeToGitRoot);
  }

  const deletedResult = await commandRunner(
    'git',
    deletedArgs,
    gitRoot,
    10_000,
  );
  if (!deletedResult.success) {
    return null;
  }

  return deletedResult.lines.map((file) => normalizePath(file));
}

interface GitWorkingTreePrefetch {
  gitRoot: string;
  untrackedFiles: string[];
  deletedFiles: string[];
}

interface WorkingTreeChangeScan {
  changed: boolean;
  /** Lists from this scan; pass into `crawlWithGitLsFiles` to avoid duplicate git calls. */
  prefetch?: GitWorkingTreePrefetch;
}

async function scanWorkingTreeForChange(
  state: ChangeState,
  crawlDirectory: string,
  useGitignore: boolean,
): Promise<WorkingTreeChangeScan> {
  const gitRoot = await findGitRoot(crawlDirectory);

  if (
    state.untrackedFingerprint === null &&
    state.deletedFingerprint === null
  ) {
    return gitRoot ? { changed: true } : { changed: false };
  }

  if (!gitRoot) {
    return { changed: true };
  }

  const relativeToGitRoot = getPosixRelative(gitRoot, crawlDirectory);
  const [untrackedFiles, deletedFiles] = await Promise.all([
    listUntrackedFiles(gitRoot, relativeToGitRoot, useGitignore),
    listDeletedTrackedFiles(gitRoot, relativeToGitRoot),
  ]);
  if (untrackedFiles === null || deletedFiles === null) {
    return { changed: true };
  }

  const changed =
    computeLinesFingerprint(untrackedFiles) !== state.untrackedFingerprint ||
    computeLinesFingerprint(deletedFiles) !== state.deletedFingerprint;

  if (!changed) {
    return { changed: false };
  }

  return {
    changed: true,
    prefetch: { gitRoot, untrackedFiles, deletedFiles },
  };
}

async function crawlWithGitLsFiles(
  stateKey: string,
  crawlDirectory: string,
  cwd: string,
  options: CrawlOptions,
  workingTreePrefetch?: GitWorkingTreePrefetch,
): Promise<{ success: boolean; files: string[]; isGitRepo: boolean }> {
  let gitRoot: string | null;
  let untrackedFiles: string[] | null;
  let deletedFiles: string[] | null;

  if (workingTreePrefetch) {
    gitRoot = workingTreePrefetch.gitRoot;
    untrackedFiles = workingTreePrefetch.untrackedFiles;
    deletedFiles = workingTreePrefetch.deletedFiles;
  } else {
    gitRoot = await findGitRoot(crawlDirectory);
    if (!gitRoot) {
      return { success: false, files: [], isGitRepo: false };
    }

    const relativeToGitRootForLists = getPosixRelative(gitRoot, crawlDirectory);
    const lists = await Promise.all([
      listUntrackedFiles(
        gitRoot,
        relativeToGitRootForLists,
        options.useGitignore !== false,
      ),
      listDeletedTrackedFiles(gitRoot, relativeToGitRootForLists),
    ]);
    untrackedFiles = lists[0];
    deletedFiles = lists[1];
  }

  if (!gitRoot) {
    return { success: false, files: [], isGitRepo: false };
  }

  const relativeToCrawlDir = getPosixRelative(cwd, crawlDirectory);
  const relativeToGitRoot = getPosixRelative(gitRoot, crawlDirectory);
  const dirFilter = options.ignore.getDirectoryFilter();
  const fileFilter = options.ignore.getFileFilter();

  const trackedArgs = ['--literal-pathspecs', 'ls-files', '--cached'];
  if (relativeToGitRoot && relativeToGitRoot !== '.') {
    trackedArgs.push(relativeToGitRoot);
  }

  if (untrackedFiles === null || deletedFiles === null) {
    return { success: false, files: [], isGitRepo: true };
  }

  const deletedSet = new Set(deletedFiles);

  const fileSet = new Set<string>();
  let budgetedFileCount = 0;
  const processTrackedFile = (file: string): boolean => {
    if (hasReachedFileBudget(budgetedFileCount, options.maxFiles)) {
      return false;
    }

    const normalizedFile = normalizePath(file);
    if (deletedSet.has(normalizedFile)) {
      return true;
    }

    if (
      relativeToGitRoot &&
      relativeToGitRoot !== '.' &&
      normalizedFile === relativeToGitRoot
    ) {
      return true;
    }

    const fullPath =
      relativeToGitRoot && relativeToGitRoot !== '.'
        ? path.posix.join(
            relativeToCrawlDir,
            normalizedFile.slice(relativeToGitRoot.length + 1),
          )
        : path.posix.join(relativeToCrawlDir, normalizedFile);

    if (!shouldIncludeFile(fullPath, dirFilter, fileFilter)) {
      return true;
    }

    const before = fileSet.size;
    fileSet.add(fullPath);
    if (
      fileSet.size > before &&
      shouldCountTowardBudget(fullPath, relativeToCrawlDir, options.maxDepth)
    ) {
      budgetedFileCount++;
    }
    return !hasReachedFileBudget(budgetedFileCount, options.maxFiles);
  };

  const trackedResult = await commandRunner(
    'git',
    trackedArgs,
    gitRoot,
    20_000,
    {
      collectLines: false,
      onLine: processTrackedFile,
    },
  );
  if (!trackedResult.success) {
    return { success: false, files: [], isGitRepo: true };
  }

  // Test doubles may return `lines` without streaming `onLine`; drain any leftovers.
  for (const file of trackedResult.lines) {
    if (!processTrackedFile(file)) {
      break;
    }
  }

  let count = 0;

  if (untrackedFiles !== null) {
    for (const normalizedFile of untrackedFiles) {
      if (hasReachedFileBudget(budgetedFileCount, options.maxFiles)) {
        break;
      }

      await maybeYield(count++);
      const fullPath =
        relativeToGitRoot && relativeToGitRoot !== '.'
          ? path.posix.join(
              relativeToCrawlDir,
              normalizedFile.slice(relativeToGitRoot.length + 1),
            )
          : path.posix.join(relativeToCrawlDir, normalizedFile);

      if (!shouldIncludeFile(fullPath, dirFilter, fileFilter)) {
        continue;
      }

      if (!fileSet.has(fullPath)) {
        fileSet.add(fullPath);
        if (
          shouldCountTowardBudget(
            fullPath,
            relativeToCrawlDir,
            options.maxDepth,
          )
        ) {
          budgetedFileCount++;
        }
      }
    }
  }

  const results = buildResultsFromFileSet(fileSet);
  const filteredResults = applyFilters(
    results,
    options,
    relativeToCrawlDir,
    fileSet,
  );
  const limitedResults = applyMaxFilesLimit(filteredResults, options.maxFiles);

  updateChangeState(
    stateKey,
    crawlDirectory,
    limitedResults,
    untrackedFiles,
    deletedFiles,
  );
  recordRebuild(stateKey);

  return { success: true, files: limitedResults, isGitRepo: true };
}

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

async function crawlWithRipgrep(
  stateKey: string,
  crawlDirectory: string,
  cwd: string,
  options: CrawlOptions,
): Promise<{ success: boolean; files: string[] }> {
  const rgArgs = ['--files', '--no-require-git', '--hidden'];
  if (options.useGitignore === false) {
    rgArgs.push('--no-ignore');
  }

  const relativeToCrawlDir = getPosixRelative(cwd, crawlDirectory);
  const dirFilter = options.ignore.getDirectoryFilter();
  const fileFilter = options.ignore.getFileFilter();

  const fileSet = new Set<string>();
  let budgetedFileCount = 0;
  const processRgFile = (file: string): boolean => {
    if (hasReachedFileBudget(budgetedFileCount, options.maxFiles)) {
      return false;
    }

    const normalizedFile = normalizePath(file);
    const fullPath = path.posix.join(relativeToCrawlDir, normalizedFile);
    if (!shouldIncludeFile(fullPath, dirFilter, fileFilter)) {
      return true;
    }

    const before = fileSet.size;
    fileSet.add(fullPath);
    if (
      fileSet.size > before &&
      shouldCountTowardBudget(fullPath, relativeToCrawlDir, options.maxDepth)
    ) {
      budgetedFileCount++;
    }
    return !hasReachedFileBudget(budgetedFileCount, options.maxFiles);
  };

  const rgResult = await commandRunner('rg', rgArgs, crawlDirectory, 20_000, {
    collectLines: false,
    onLine: processRgFile,
  });

  if (!rgResult.success) {
    return { success: false, files: [] };
  }

  for (const file of rgResult.lines) {
    if (!processRgFile(file)) {
      break;
    }
  }

  const results = buildResultsFromFileSet(fileSet);
  const filteredResults = applyFilters(
    results,
    options,
    relativeToCrawlDir,
    fileSet,
  );
  const limitedResults = applyMaxFilesLimit(filteredResults, options.maxFiles);

  updateChangeState(stateKey, crawlDirectory, limitedResults);
  recordRebuild(stateKey);
  return { success: true, files: limitedResults };
}

async function crawlWithFdir(options: CrawlOptions): Promise<string[]> {
  const relativeToCrawlDir = getPosixRelative(
    options.cwd,
    options.crawlDirectory,
  );

  let results: string[];
  try {
    const dirFilter = options.ignore.getDirectoryFilter();
    const fileFilter = options.ignore.getFileFilter();
    const api = new fdir()
      .withRelativePaths()
      .withDirs()
      .withPathSeparator('/')
      .exclude((_, dirPath) => {
        const relativePath = toFdirExcludeRelativePath(
          options.crawlDirectory,
          dirPath,
        );
        if (!relativePath) {
          return false;
        }
        return dirFilter(`${relativePath}/`);
      })
      .filter((filePath, isDirectory) => {
        if (isDirectory) return true;
        const cwdRelative = path.posix.join(relativeToCrawlDir, filePath);
        if (!isValidIgnorePath(cwdRelative)) {
          return false;
        }
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
    return [];
  }

  return results.map((p) => path.posix.join(relativeToCrawlDir, p));
}

export async function crawl(options: CrawlOptions): Promise<string[]> {
  const stateKey = getStateKey(options);

  const cacheKey = options.cache
    ? cache.getCacheKey(
        options.crawlDirectory,
        options.ignore.getFingerprint(),
        options.maxDepth,
        options.maxFiles,
        options.useGitignore !== false,
      )
    : undefined;

  if (options.cache) {
    const cachedResults = cache.read(cacheKey!);
    if (cachedResults) {
      return cachedResults;
    }
  }

  let workingTreePrefetch: GitWorkingTreePrefetch | undefined;

  if (!options.cache) {
    const needReCrawl = hasFileListChanged(stateKey, options.crawlDirectory);

    if (!needReCrawl) {
      const state = changeStateMap.get(stateKey);
      if (state) {
        const scan = await scanWorkingTreeForChange(
          state,
          options.crawlDirectory,
          options.useGitignore !== false,
        );
        if (!scan.changed) {
          return state.fileList;
        }
        workingTreePrefetch = scan.prefetch;
      }
    }
  }

  const gitResult = await crawlWithGitLsFiles(
    stateKey,
    options.crawlDirectory,
    options.cwd,
    options,
    workingTreePrefetch,
  );
  if (gitResult.success) {
    const results = gitResult.files;

    if (options.cache) {
      cache.write(cacheKey!, results, options.cacheTtl * 1000);
    }

    return results;
  }

  const rgResult = await crawlWithRipgrep(
    stateKey,
    options.crawlDirectory,
    options.cwd,
    options,
  );
  if (rgResult.success) {
    const results = rgResult.files;

    if (options.cache) {
      cache.write(cacheKey!, results, options.cacheTtl * 1000);
    }

    return results;
  }

  const fdirResults = await crawlWithFdir(options);
  const limitedResults = applyMaxFilesLimit(fdirResults, options.maxFiles);
  updateChangeState(stateKey, options.crawlDirectory, limitedResults);
  recordRebuild(stateKey);

  if (options.cache) {
    cache.write(cacheKey!, limitedResults, options.cacheTtl * 1000);
  }

  return limitedResults;
}

/**
 * Caps the number of listed entries. When the caller passes a small `maxFiles`,
 * the naive prefix slice can contain only `.` and synthetic directory rows
 * before the first file path; in that case we extend through the first file row
 * so the crawl does not return an empty-looking tree (see crawler tests).
 */
function applyMaxFilesLimit(results: string[], maxFiles?: number): string[] {
  if (maxFiles === undefined || results.length <= maxFiles) {
    return results;
  }

  const clipped = results.slice(0, maxFiles);
  const rowIsFile = (e: string): boolean => e !== '.' && !e.endsWith('/');
  if (clipped.some(rowIsFile)) {
    return clipped;
  }

  const firstFileIdx = results.findIndex(rowIsFile);
  if (firstFileIdx === -1) {
    return clipped;
  }

  return results.slice(0, firstFileIdx + 1);
}

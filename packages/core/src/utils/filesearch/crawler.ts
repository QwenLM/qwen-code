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

const THROTTLE_MS = 5_000;
const lastRebuildTime = new Map<string, number>();

function getStateKey(options: CrawlOptions): string {
  return [
    normalizePath(options.crawlDirectory),
    normalizePath(options.cwd),
    options.ignore.getFingerprint(),
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
  fileList: string[];
}

const changeStateMap = new Map<string, ChangeState>();

function resolveGitDir(crawlDirectory: string): string | null {
  let current = crawlDirectory;
  while (current) {
    const gitPath = path.join(current, '.git');

    try {
      const stat = fs.statSync(gitPath);

      if (stat.isDirectory()) {
        return gitPath;
      }

      if (stat.isFile()) {
        const contents = fs.readFileSync(gitPath, 'utf8').trim();
        const match = contents.match(/^gitdir:\s*(.+)$/i);
        if (!match) {
          return null;
        }

        const resolvedGitDir = match[1].trim();
        return path.isAbsolute(resolvedGitDir)
          ? resolvedGitDir
          : path.resolve(current, resolvedGitDir);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return null;
      }
      // Keep walking ancestors when .git is simply missing here.
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

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
): void {
  const mtime = getGitRootMtime(crawlDirectory);
  changeStateMap.set(stateKey, {
    gitRootMtimeMs: mtime,
    untrackedFingerprint:
      untrackedFiles === undefined
        ? null
        : computeLinesFingerprint(untrackedFiles),
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
          .map((l) => l)
          .filter((l) => l.length > 0);
        resolve({ success: true, lines });
      },
    );
    child.on('error', () => resolve({ success: false, lines: [] }));
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
}

function normalizePath(p: string): string {
  return toPosixPath(p);
}

function normalizeForComparison(p: string): string {
  const normalized = normalizePath(p);
  if (/^[A-Z]:/.test(normalized)) {
    return `${normalized[0].toLowerCase()}${normalized.slice(1)}`;
  }
  return normalized;
}

function canonicalizePath(p: string): string {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

function getPosixRelative(from: string, to: string): string {
  const canonicalFrom = normalizeForComparison(canonicalizePath(from));
  const canonicalTo = normalizeForComparison(canonicalizePath(to));
  const relative = path.posix.relative(canonicalFrom, canonicalTo);
  return relative === '' ? '.' : relative;
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

function toIgnoreRelativePath(
  baseDir: string,
  candidatePath: string,
): string | null {
  const absoluteCandidate = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.join(baseDir, candidatePath);
  const relativePath = getPosixRelative(baseDir, absoluteCandidate);
  return isValidIgnorePath(relativePath) ? relativePath : null;
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
  if (index % YIELD_INTERVAL === 0) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function findGitRoot(dir: string): Promise<string | null> {
  const result = await commandRunner(
    'git',
    ['rev-parse', '--show-toplevel'],
    dir,
    5_000,
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

function hasReachedFileBudget(
  fileSet: Set<string>,
  maxFiles?: number,
): boolean {
  return maxFiles !== undefined && fileSet.size >= maxFiles;
}

function existingTrackedPath(gitRoot: string, normalizedFile: string): boolean {
  try {
    fs.lstatSync(path.join(gitRoot, normalizedFile));
    return true;
  } catch {
    return false;
  }
}

async function listUntrackedFiles(
  gitRoot: string,
  relativeToGitRoot: string,
): Promise<string[] | null> {
  const untrackedArgs = ['ls-files', '--others', '--exclude-standard'];
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

async function hasUntrackedFilesChanged(
  state: ChangeState,
  crawlDirectory: string,
): Promise<boolean> {
  if (state.untrackedFingerprint === null) {
    return false;
  }

  const gitRoot = await findGitRoot(crawlDirectory);
  if (!gitRoot) {
    return true;
  }

  const relativeToGitRoot = getPosixRelative(gitRoot, crawlDirectory);
  const untrackedFiles = await listUntrackedFiles(gitRoot, relativeToGitRoot);
  if (untrackedFiles === null) {
    return true;
  }

  return computeLinesFingerprint(untrackedFiles) !== state.untrackedFingerprint;
}

async function crawlWithGitLsFiles(
  stateKey: string,
  crawlDirectory: string,
  cwd: string,
  options: CrawlOptions,
): Promise<{ success: boolean; files: string[]; isGitRepo: boolean }> {
  const gitRoot = await findGitRoot(crawlDirectory);
  if (!gitRoot) {
    return { success: false, files: [], isGitRepo: false };
  }

  const relativeToCrawlDir = getPosixRelative(cwd, crawlDirectory);
  const relativeToGitRoot = getPosixRelative(gitRoot, crawlDirectory);
  const dirFilter = options.ignore.getDirectoryFilter();
  const fileFilter = options.ignore.getFileFilter();

  const trackedArgs = ['ls-files', '--cached'];
  if (relativeToGitRoot && relativeToGitRoot !== '.') {
    trackedArgs.push(relativeToGitRoot);
  }
  const trackedResult = await commandRunner(
    'git',
    trackedArgs,
    gitRoot,
    20_000,
  );
  if (!trackedResult.success) {
    return { success: false, files: [], isGitRepo: true };
  }

  const untrackedFiles = await listUntrackedFiles(gitRoot, relativeToGitRoot);

  const fileSet = new Set<string>();
  let count = 0;

  for (const file of trackedResult.lines) {
    if (hasReachedFileBudget(fileSet, options.maxFiles)) {
      break;
    }

    await maybeYield(count++);
    const normalizedFile = normalizePath(file);
    if (!existingTrackedPath(gitRoot, normalizedFile)) {
      continue;
    }

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

    fileSet.add(fullPath);
  }

  if (untrackedFiles !== null) {
    for (const normalizedFile of untrackedFiles) {
      if (hasReachedFileBudget(fileSet, options.maxFiles)) {
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
      }
    }
  }

  const results = buildResultsFromFileSet(fileSet);
  const filteredResults = applyFilters(results, options, relativeToCrawlDir);

  // Avoid caching a partial git snapshot when untracked listing fails.
  // A missing untracked snapshot can hide files during the throttle window.
  if (untrackedFiles !== null) {
    updateChangeState(
      stateKey,
      crawlDirectory,
      filteredResults,
      untrackedFiles,
    );
    recordRebuild(stateKey);
  }

  return { success: true, files: filteredResults, isGitRepo: true };
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
  const rgResult = await commandRunner(
    'rg',
    ['--files', '--no-require-git', '--hidden'],
    crawlDirectory,
    20_000,
  );

  if (!rgResult.success) {
    return { success: false, files: [] };
  }

  const relativeToCrawlDir = getPosixRelative(cwd, crawlDirectory);
  const dirFilter = options.ignore.getDirectoryFilter();
  const fileFilter = options.ignore.getFileFilter();

  const fileSet = new Set<string>();
  let count = 0;
  for (const file of rgResult.lines) {
    if (hasReachedFileBudget(fileSet, options.maxFiles)) {
      break;
    }

    await maybeYield(count++);
    const normalizedFile = normalizePath(file);

    const fullPath = path.posix.join(relativeToCrawlDir, normalizedFile);
    if (!shouldIncludeFile(fullPath, dirFilter, fileFilter)) {
      continue;
    }

    fileSet.add(fullPath);
  }

  const results = buildResultsFromFileSet(fileSet);
  const filteredResults = applyFilters(results, options, relativeToCrawlDir);

  updateChangeState(stateKey, crawlDirectory, filteredResults);
  recordRebuild(stateKey);
  return { success: true, files: filteredResults };
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
        const relativePath = toIgnoreRelativePath(
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

  if (!options.cache) {
    const needReCrawl = hasFileListChanged(stateKey, options.crawlDirectory);

    if (!needReCrawl) {
      const state = changeStateMap.get(stateKey);
      if (state) {
        if (isThrottled(stateKey)) {
          return applyMaxFilesLimit(state.fileList, options.maxFiles);
        }

        const untrackedChanged = await hasUntrackedFilesChanged(
          state,
          options.crawlDirectory,
        );
        if (!untrackedChanged) {
          return applyMaxFilesLimit(state.fileList, options.maxFiles);
        }
      }
    }
  }

  const gitResult = await crawlWithGitLsFiles(
    stateKey,
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

  if (!gitResult.isGitRepo) {
    const rgResult = await crawlWithRipgrep(
      stateKey,
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

  const fdirResults = await crawlWithFdir(options);
  updateChangeState(stateKey, options.crawlDirectory, fdirResults);
  recordRebuild(stateKey);
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

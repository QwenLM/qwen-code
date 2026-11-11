/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import picomatch from 'picomatch';
import { loadIgnoreRules, type Ignore } from './ignore.js';
import { ResultCache } from './result-cache.js';
import { crawl } from './crawler.js';
import { AsyncFzf, type FzfResultItem } from 'fzf';
import { unescapePath } from '../paths.js';
import type { FileDiscoveryService } from '../../services/fileDiscoveryService.js';
import { findGitRoot } from '../gitUtils.js';
import { ripGrepStream } from '../ripgrep.js';
import { runLogger } from '../runLogger.js';
import { getGitIndexMtime, listGitFiles } from './gitFileList.js';
import { GitIgnoreParser } from '../gitIgnoreParser.js';

const GIT_TRACKED_TIMEOUT_MS = 5000;
const FILE_ENUMERATION_TIMEOUT_MS = 10000;
const REFRESH_INTERVAL_MS = 5000;
const ASYNC_YIELD_INTERVAL = 256;
const ASYNC_YIELD_AFTER_MS = 4;

const RIPGREP_FILE_ARGS = [
  '--files',
  '--follow',
  '--hidden',
  '--glob',
  '!.git/',
  '--glob',
  '!.svn/',
  '--glob',
  '!.hg/',
  '--glob',
  '!.bzr/',
  '--glob',
  '!.jj/',
  '--glob',
  '!.sl/',
];

// Tiebreaker: Prefers shorter paths.
const byLengthAsc = (a: { item: string }, b: { item: string }) =>
  a.item.length - b.item.length;

// Tiebreaker: Prefers matches at the start of the filename (basename prefix).
const byBasenamePrefix = (
  a: { item: string; positions: Set<number> },
  b: { item: string; positions: Set<number> },
) => {
  const getBasenameStart = (p: string) => {
    const trimmed = p.endsWith('/') ? p.slice(0, -1) : p;
    return Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1;
  };
  const aDiff = Math.min(...a.positions) - getBasenameStart(a.item);
  const bDiff = Math.min(...b.positions) - getBasenameStart(b.item);

  const aIsFilenameMatch = aDiff >= 0;
  const bIsFilenameMatch = bDiff >= 0;

  if (aIsFilenameMatch && !bIsFilenameMatch) return -1;
  if (!aIsFilenameMatch && bIsFilenameMatch) return 1;
  if (aIsFilenameMatch && bIsFilenameMatch) return aDiff - bDiff;

  return 0; // Both are directory matches, let subsequent tiebreakers decide.
};

// Tiebreaker: Prefers matches closer to the end of the path.
const byMatchPosFromEnd = (
  a: { item: string; positions: Set<number> },
  b: { item: string; positions: Set<number> },
) => {
  const maxPosA = Math.max(-1, ...a.positions);
  const maxPosB = Math.max(-1, ...b.positions);
  const distA = a.item.length - maxPosA;
  const distB = b.item.length - maxPosB;
  return distA - distB;
};

export interface FileSearchOptions {
  projectRoot: string;
  ignoreDirs: string[];
  fileDiscoveryService: FileDiscoveryService;
  cache: boolean;
  cacheTtl: number;
  enableRecursiveFileSearch: boolean;
  enableFuzzySearch: boolean;
  maxDepth?: number;
  /** @deprecated Recursive @ completion no longer limits its candidate set. */
  maxFiles?: number;
  respectGitIgnore?: boolean;
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
  smartCase = false,
): Promise<string[]> {
  const caseSensitive = smartCase && pattern !== pattern.toLowerCase();
  const patternFilter = picomatch(pattern, {
    dot: true,
    contains: true,
    nocase: !caseSensitive,
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

class RecursiveFileSearch implements FileSearch {
  private ignore: Ignore | undefined;
  private fallbackIgnore: Ignore | undefined;
  private resultCache: ResultCache | undefined;
  private allFiles: string[] = [];
  private fzf: AsyncFzf<string[]> | undefined;
  private trackedFiles: string[] = [];
  private untrackedFiles: string[] = [];
  private topLevelDirectories: string[] = [];
  private gitRoot: string | null = null;
  private gitDirectoryIgnore: GitIgnoreParser | null = null;
  private usingGit = false;
  private refreshPromise: Promise<void> | null = null;
  private untrackedFetchPromise: Promise<void> | null = null;
  private lastRefreshMs = 0;
  private lastGitIndexMtime: number | null = null;
  private indexBuildGeneration = 0;

  constructor(private readonly options: FileSearchOptions) {}

  async initialize(): Promise<void> {
    this.gitRoot = findGitRoot(this.options.projectRoot);
    this.gitDirectoryIgnore =
      this.gitRoot && this.respectGitIgnore
        ? new GitIgnoreParser(this.gitRoot)
        : null;
    const standardIgnoreRoots = [
      ...new Set(
        [this.gitRoot, path.resolve(this.options.projectRoot)].filter(
          (root): root is string => root !== null,
        ),
      ),
    ];

    this.ignore = loadIgnoreRules(
      this.options.fileDiscoveryService,
      this.options.ignoreDirs,
      {
        includeGitIgnore: false,
        standardIgnoreRoots,
        candidateRoot: this.options.projectRoot,
      },
    );
    this.fallbackIgnore = loadIgnoreRules(
      this.options.fileDiscoveryService,
      this.options.ignoreDirs,
      {
        includeGitIgnore: this.respectGitIgnore,
        standardIgnoreRoots,
        candidateRoot: this.options.projectRoot,
      },
    );

    const startedAt = Date.now();
    await this.refreshProjectFiles();
    this.lastRefreshMs = Date.now();
    this.lastGitIndexMtime = getGitIndexMtime(this.gitRoot);
    runLogger.debug(
      `[FileSearch] initialized ${this.options.projectRoot} from ${this.usingGit ? 'git' : 'ripgrep'} with ${this.trackedFiles.length} files in ${Date.now() - startedAt}ms`,
    );
  }

  async search(
    pattern: string,
    options: SearchOptions = {},
  ): Promise<string[]> {
    if (
      !this.resultCache ||
      (!this.fzf && this.options.enableFuzzySearch) ||
      !this.ignore
    ) {
      throw new Error('Engine not initialized. Call initialize() first.');
    }

    this.refreshIfNeeded();

    pattern = unescapePath(pattern) || '*';
    const caseSensitive = pattern !== pattern.toLowerCase();

    let filteredCandidates;
    const { files: candidates, isExactMatch } =
      await this.resultCache.get(pattern);

    if (isExactMatch) {
      // Use the cached result.
      filteredCandidates = candidates;
    } else {
      let shouldCache = true;
      if (pattern.includes('*') || !this.fzf) {
        filteredCandidates = await filter(
          candidates,
          pattern,
          options.signal,
          true,
        );
      } else {
        filteredCandidates = await this.fzf
          .find(pattern)
          .then((results: Array<FzfResultItem<string>>) =>
            // eslint-disable-next-line @typescript-eslint/no-unsafe-return
            results.map((entry: FzfResultItem<string>) => entry.item),
          )
          .catch(() => {
            shouldCache = false;
            return [];
          });

        if (caseSensitive) {
          filteredCandidates = await this.filterCaseSensitiveSubsequence(
            filteredCandidates,
            pattern,
            options.signal,
          );
        }
      }

      if (shouldCache) {
        this.resultCache.set(pattern, filteredCandidates);
      }
    }

    const pathFilter = this.ignore.getPathFilter();
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
      if (!pathFilter(candidate)) {
        results.push(candidate);
      }
    }
    return results;
  }

  private get respectGitIgnore(): boolean {
    return this.options.respectGitIgnore ?? true;
  }

  private async refreshProjectFiles(): Promise<void> {
    if (!this.ignore || !this.fallbackIgnore) {
      throw new Error(
        'Ignore rules must be initialized before file discovery.',
      );
    }

    this.topLevelDirectories = await this.readTopLevelDirectories();

    if (this.gitRoot) {
      const startedAt = Date.now();
      try {
        const tracked = await listGitFiles({
          cwd: this.options.projectRoot,
          args: ['--recurse-submodules'],
          timeoutMs: GIT_TRACKED_TIMEOUT_MS,
        });
        this.trackedFiles = await this.prepareFiles(tracked, this.ignore);
        this.usingGit = true;
        await this.rebuildIndex();
        runLogger.debug(
          `[FileSearch] git tracked list returned ${this.trackedFiles.length} files in ${Date.now() - startedAt}ms`,
        );
        this.startBackgroundUntrackedFetch();
        return;
      } catch (error) {
        runLogger.debug(
          `[FileSearch] git tracked listing failed, using ripgrep: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const startedAt = Date.now();
    const discovered = await this.listFilesWithRipgrep();
    this.trackedFiles = await this.prepareFiles(
      discovered,
      this.fallbackIgnore,
    );
    this.untrackedFiles = [];
    this.usingGit = false;
    await this.rebuildIndex();
    runLogger.debug(
      `[FileSearch] ripgrep returned ${this.trackedFiles.length} files in ${Date.now() - startedAt}ms`,
    );
  }

  private startBackgroundUntrackedFetch(): void {
    if (!this.gitRoot || this.untrackedFetchPromise) return;

    const args = this.respectGitIgnore
      ? ['--others', '--exclude-standard']
      : ['--others'];
    const startedAt = Date.now();

    this.untrackedFetchPromise = listGitFiles({
      cwd: this.options.projectRoot,
      args,
      timeoutMs: FILE_ENUMERATION_TIMEOUT_MS,
    })
      .then(async (untracked) => {
        if (!this.usingGit || !this.ignore) return;
        this.untrackedFiles = await this.prepareFiles(untracked, this.ignore);
        await this.rebuildIndex();
        runLogger.debug(
          `[FileSearch] git untracked list returned ${this.untrackedFiles.length} files in ${Date.now() - startedAt}ms`,
        );
      })
      .catch((error) => {
        runLogger.debug(
          `[FileSearch] background untracked listing failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.untrackedFetchPromise = null;
      });
  }

  /**
   * Starts a background refresh without delaying the current search. The
   * current search keeps using the existing index; subsequent searches see
   * the refreshed candidates after the refresh completes.
   */
  private refreshIfNeeded(): void {
    const now = Date.now();
    const currentIndexMtime = getGitIndexMtime(this.gitRoot);
    const indexChanged =
      currentIndexMtime !== null &&
      currentIndexMtime !== this.lastGitIndexMtime;

    if (
      this.refreshPromise ||
      (!indexChanged && now - this.lastRefreshMs < REFRESH_INTERVAL_MS)
    ) {
      return;
    }

    const startedAt = now;
    this.refreshPromise = this.refreshProjectFiles()
      .then(() => {
        this.lastRefreshMs = Date.now();
        this.lastGitIndexMtime = getGitIndexMtime(this.gitRoot);
        runLogger.debug(
          `[FileSearch] refreshed ${this.options.projectRoot} in ${Date.now() - startedAt}ms`,
        );
      })
      .catch((error) => {
        this.lastRefreshMs = Date.now();
        runLogger.debug(
          `[FileSearch] refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        this.refreshPromise = null;
      });
  }

  private async listFilesWithRipgrep(): Promise<string[]> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      FILE_ENUMERATION_TIMEOUT_MS,
    );
    timeout.unref?.();

    const args = [...RIPGREP_FILE_ARGS];
    if (!this.respectGitIgnore) {
      args.push('--no-ignore-vcs');
    }

    const files: string[] = [];
    try {
      await ripGrepStream(
        args,
        path.resolve(this.options.projectRoot),
        controller.signal,
        (lines) => {
          for (const line of lines) {
            const absolutePath = path.isAbsolute(line)
              ? line
              : path.resolve(line);
            const relativePath = path.relative(
              this.options.projectRoot,
              absolutePath,
            );
            const normalized = normalizeRelativePath(relativePath);
            if (normalized) files.push(normalized);
          }
        },
      );
      return files;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async prepareFiles(
    rawFiles: string[],
    ignoreRules: Ignore,
  ): Promise<string[]> {
    const seen = new Set<string>();
    const pathFilter = ignoreRules.getPathFilter();
    let lastYieldAt = performance.now();

    for (const [index, rawFile] of rawFiles.entries()) {
      const normalized = normalizeRelativePath(rawFile);
      if (
        normalized &&
        this.isWithinMaxDepth(normalized) &&
        !pathFilter(normalized)
      ) {
        seen.add(normalized);
      }

      if (
        (index & (ASYNC_YIELD_INTERVAL - 1)) === ASYNC_YIELD_INTERVAL - 1 &&
        performance.now() - lastYieldAt > ASYNC_YIELD_AFTER_MS
      ) {
        await new Promise((resolve) => setImmediate(resolve));
        lastYieldAt = performance.now();
      }
    }

    return [...seen].sort(comparePaths);
  }

  private isWithinMaxDepth(filePath: string): boolean {
    if (this.options.maxDepth === undefined) return true;
    return filePath.split('/').length - 1 <= this.options.maxDepth;
  }

  private async rebuildIndex(): Promise<void> {
    const generation = ++this.indexBuildGeneration;
    const files = [
      ...new Set([...this.trackedFiles, ...this.untrackedFiles]),
    ].sort(comparePaths);
    const directories = [
      ...new Set([
        ...this.topLevelDirectories,
        ...(await deriveDirectories(files)),
      ]),
    ].sort(compareDirectories);
    const nextPaths = [...directories, ...files];

    if (generation !== this.indexBuildGeneration) return;
    if (this.resultCache && samePaths(this.allFiles, nextPaths)) return;

    const nextResultCache = new ResultCache(nextPaths);
    const nextFzf = this.options.enableFuzzySearch
      ? new AsyncFzf(nextPaths, {
          fuzzy: nextPaths.length > 20000 ? 'v1' : 'v2',
          forward: false,
          tiebreakers: [byBasenamePrefix, byMatchPosFromEnd, byLengthAsc],
        })
      : undefined;

    this.allFiles = nextPaths;
    this.resultCache = nextResultCache;
    this.fzf = nextFzf;
  }

  private async readTopLevelDirectories(): Promise<string[]> {
    if (!this.fallbackIgnore) return [];
    try {
      const pathFilter = this.fallbackIgnore.getPathFilter();
      const entries = await fs.readdir(this.options.projectRoot, {
        withFileTypes: true,
      });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `${entry.name}/`)
        .filter(
          (entry) =>
            !pathFilter(entry) &&
            !this.gitDirectoryIgnore?.isIgnored(
              path.join(this.options.projectRoot, entry),
              true,
            ),
        )
        .sort(comparePaths);
    } catch {
      return [];
    }
  }

  private async filterCaseSensitiveSubsequence(
    candidates: string[],
    pattern: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const results: string[] = [];
    for (const [index, candidate] of candidates.entries()) {
      if (isSubsequence(candidate, pattern)) {
        results.push(candidate);
      }
      if (index % 1000 === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        if (signal?.aborted) throw new AbortError();
      }
    }
    return results;
  }
}

function normalizeRelativePath(candidate: string): string | null {
  const platformNormalized =
    path.sep === '\\' ? candidate.replaceAll('\\', '/') : candidate;
  const normalized = path.posix.normalize(platformNormalized);
  if (
    normalized === '.' ||
    normalized === '' ||
    path.posix.isAbsolute(normalized) ||
    normalized === '..' ||
    normalized.startsWith('../')
  ) {
    return null;
  }
  return normalized;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function samePaths(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

async function deriveDirectories(files: string[]): Promise<string[]> {
  const directories = new Set<string>();
  let lastYieldAt = performance.now();

  for (const [index, file] of files.entries()) {
    let directory = path.posix.dirname(file);
    while (directory !== '.') {
      directories.add(`${directory}/`);
      const parent = path.posix.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }

    if (
      (index & (ASYNC_YIELD_INTERVAL - 1)) === ASYNC_YIELD_INTERVAL - 1 &&
      performance.now() - lastYieldAt > ASYNC_YIELD_AFTER_MS
    ) {
      await new Promise((resolve) => setImmediate(resolve));
      lastYieldAt = performance.now();
    }
  }

  return [...directories].sort(compareDirectories);
}

function compareDirectories(a: string, b: string): number {
  const depthDifference = a.split('/').length - b.split('/').length;
  return depthDifference || comparePaths(a, b);
}

function isSubsequence(candidate: string, pattern: string): boolean {
  let patternIndex = 0;
  for (
    let candidateIndex = 0;
    candidateIndex < candidate.length;
    candidateIndex++
  ) {
    if (candidate[candidateIndex] === pattern[patternIndex]) {
      patternIndex++;
      if (patternIndex === pattern.length) return true;
    }
  }
  return pattern.length === 0;
}

class DirectoryFileSearch implements FileSearch {
  private ignore: Ignore | undefined;

  constructor(private readonly options: FileSearchOptions) {}

  async initialize(): Promise<void> {
    this.ignore = loadIgnoreRules(
      this.options.fileDiscoveryService,
      this.options.ignoreDirs,
    );
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

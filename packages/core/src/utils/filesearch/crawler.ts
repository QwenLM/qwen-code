/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { execSync } from 'node:child_process';
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

function toPosixPath(p: string) {
  return p.split(path.sep).join(path.posix.sep);
}

/**
 * Detects git submodules (gitlinks) in the given directory.
 * Returns an array of submodule paths relative to the directory.
 */
function detectSubmodules(dirPath: string): string[] {
  try {
    // git ls-files --stage outputs lines like:
    // 160000 <object> 0 <path> (for submodules)
    const output = execSync('git ls-files --stage', {
      cwd: dirPath,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'], // Ignore stderr
    });

    const submodules: string[] = [];
    for (const line of output.split('\n')) {
      if (!line) continue;
      const parts = line.split(/\s+/);
      if (parts[0] === '160000') {
        // Format: mode hash stage path
        // We need to extract the path (everything after the first 3 space-separated parts)
        const pathPart = line.split(/\s+/).slice(3).join(' ').trim();
        if (pathPart) {
          submodules.push(pathPart);
        }
      }
    }

    return submodules;
  } catch {
    // Not a git repository or command failed
    return [];
  }
}

/**
 * Recursively crawls a submodule directory and returns relative paths.
 */
async function crawlSubmodule(
  submodulePath: string,
  crawlDirectory: string,
  posixCwd: string,
  dirFilter: (path: string) => boolean,
  fileFilter: (path: string) => boolean,
  maxDepth: number | undefined,
  maxFiles: number | undefined,
): Promise<string[]> {
  try {
    const fullSubmodulePath = path.join(crawlDirectory, submodulePath);
    const api = new fdir()
      .withRelativePaths()
      .withDirs()
      .withPathSeparator('/') // Always use unix style paths
      .exclude((_, dirPath) => {
        const relativePath = path.posix.relative(
          toPosixPath(fullSubmodulePath),
          dirPath,
        );
        return dirFilter(`${relativePath}/`);
      })
      .filter((filePath, isDirectory) => {
        if (isDirectory) return true;
        // Apply file-level ignore patterns
        const relativeToSubmodule = path.posix.join(
          toPosixPath(submodulePath),
          filePath,
        );
        const cwdRelative = path.posix.relative(
          posixCwd,
          path.posix.join(toPosixPath(crawlDirectory), relativeToSubmodule),
        );
        return !fileFilter(cwdRelative);
      });

    if (maxDepth !== undefined) {
      api.withMaxDepth(maxDepth);
    }

    if (maxFiles !== undefined) {
      api.withMaxFiles(maxFiles);
    }

    const submoduleResults = await api.crawl(fullSubmodulePath).withPromise();

    // Prefix submodule results with the submodule path
    return submoduleResults.map((p) =>
      path.posix.join(toPosixPath(submodulePath), p),
    );
  } catch {
    // Submodule doesn't exist or can't be crawled
    return [];
  }
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
  } catch (_e) {
    // The directory probably doesn't exist.
    return [];
  }

  const relativeToCwdResults = results.map((p) =>
    path.posix.join(relativeToCrawlDir, p),
  );

  // Detect and crawl git submodules
  const submodules = detectSubmodules(options.crawlDirectory);
  for (const submodule of submodules) {
    const submoduleResults = await crawlSubmodule(
      submodule,
      options.crawlDirectory,
      posixCwd,
      options.ignore.getDirectoryFilter(),
      options.ignore.getFileFilter(),
      options.maxDepth,
      options.maxFiles,
    );
    relativeToCwdResults.push(...submoduleResults);
  }

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

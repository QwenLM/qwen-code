/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import picomatch from 'picomatch';
import type { FileDiscoveryService } from '../../services/fileDiscoveryService.js';

const hasFileExtension = picomatch('**/*[*.]*');

export function loadIgnoreRules(
  service: FileDiscoveryService,
  ignoreDirs: string[] = [],
  options: {
    includeGitIgnore?: boolean;
    standardIgnoreRoots?: string[];
    candidateRoot?: string;
  } = {},
): Ignore {
  const ignorer = new Ignore();
  const ignoreFiles =
    options.includeGitIgnore === false
      ? service.getIgnoreFilePaths()
      : service.getAllIgnoreFilePaths();

  for (const filePath of ignoreFiles) {
    if (fs.existsSync(filePath)) {
      ignorer.add(fs.readFileSync(filePath, 'utf8'));
    }
  }

  const standardIgnoreRoots = options.standardIgnoreRoots ?? [];
  const candidateRoot = path.resolve(
    options.candidateRoot ?? standardIgnoreRoots.at(-1) ?? '.',
  );
  const loadedStandardIgnoreFiles = new Set<string>();

  for (const root of standardIgnoreRoots) {
    const resolvedRoot = path.resolve(root);
    const pathPrefix = relativePathPrefix(resolvedRoot, candidateRoot);
    if (pathPrefix === null) continue;

    for (const fileName of ['.ignore', '.rgignore']) {
      const filePath = path.join(resolvedRoot, fileName);
      if (loadedStandardIgnoreFiles.has(filePath) || !fs.existsSync(filePath)) {
        continue;
      }
      loadedStandardIgnoreFiles.add(filePath);
      ignorer.addPathPatterns(fs.readFileSync(filePath, 'utf8'), pathPrefix);
    }
  }

  const allIgnoreDirs = ['.git', ...ignoreDirs];
  ignorer.add(
    allIgnoreDirs.map((dir) => {
      if (dir.endsWith('/')) {
        return dir;
      }
      return `${dir}/`;
    }),
  );

  return ignorer;
}

export class Ignore {
  private readonly allPatterns: string[] = [];
  private allIgnorer = ignore();
  private dirIgnorer = ignore();
  private fileIgnorer = ignore();
  private readonly pathIgnorers: Array<{
    prefix: string;
    matcher: ReturnType<typeof ignore>;
  }> = [];

  /**
   * Adds one or more ignore patterns.
   * @param patterns A single pattern string or an array of pattern strings.
   *                 Each pattern can be a glob-like string similar to .gitignore rules.
   * @returns The `Ignore` instance for chaining.
   */
  add(patterns: string | string[]): this {
    for (const pattern of normalizePatterns(patterns)) {
      this.allPatterns.push(pattern);
      this.allIgnorer.add(pattern);

      const isPositiveDirPattern =
        pattern.endsWith('/') && !pattern.startsWith('!');

      if (isPositiveDirPattern) {
        this.dirIgnorer.add(pattern);
      } else {
        // An ambiguous pattern (e.g., "build") could match a file or a
        // directory. To optimize the file system crawl, we use a heuristic:
        // patterns without a dot in the last segment are included in the
        // directory exclusion check.
        //
        // This heuristic can fail. For example, an ignore pattern of "my.assets"
        // intended to exclude a directory will not be treated as a directory
        // pattern because it contains a ".". This results in crawling a
        // directory that should have been excluded, reducing efficiency.
        // Correctness is still maintained. The incorrectly crawled directory
        // will be filtered out by the final ignore check.
        //
        // For maximum crawl efficiency, users should explicitly mark directory
        // patterns with a trailing slash (e.g., "my.assets/").
        this.fileIgnorer.add(pattern);
        if (!hasFileExtension(pattern)) {
          this.dirIgnorer.add(pattern);
        }
      }
    }

    return this;
  }

  /** Adds rules evaluated relative to a parent root of the candidate paths. */
  addPathPatterns(patterns: string | string[], prefix: string): this {
    const normalizedPatterns = normalizePatterns(patterns);
    if (normalizedPatterns.length === 0) return this;

    this.pathIgnorers.push({
      prefix,
      matcher: ignore().add(normalizedPatterns),
    });
    this.allPatterns.push(
      ...normalizedPatterns.map((pattern) => `[${prefix}]${pattern}`),
    );
    return this;
  }

  /**
   * Returns a predicate that matches explicit directory ignore patterns (patterns ending with '/').
   * @returns {(dirPath: string) => boolean}
   */
  getDirectoryFilter(): (dirPath: string) => boolean {
    return (dirPath: string) => this.dirIgnorer.ignores(dirPath);
  }

  /**
   * Returns a predicate that matches file ignore patterns (all patterns not ending with '/').
   * Note: This may also match directories if a file pattern matches a directory name, but all explicit directory patterns are handled by getDirectoryFilter.
   * @returns {(filePath: string) => boolean}
   */
  getFileFilter(): (filePath: string) => boolean {
    return (filePath: string) => this.fileIgnorer.ignores(filePath);
  }

  /**
   * Returns a predicate for final path filtering. Unlike getFileFilter(), this
   * also applies directory patterns to files contained by those directories.
   */
  getPathFilter(): (filePath: string) => boolean {
    return (filePath: string) => {
      let ignored = false;
      for (const { prefix, matcher } of this.pathIgnorers) {
        const result = matcher.test(prefixCandidatePath(prefix, filePath));
        if (result.ignored) ignored = true;
        if (result.unignored) ignored = false;
      }

      const localResult = this.allIgnorer.test(filePath);
      if (localResult.ignored) ignored = true;
      if (localResult.unignored) ignored = false;
      return ignored;
    };
  }

  /**
   * Returns a string representing the current set of ignore patterns.
   * This can be used to generate a unique identifier for the ignore configuration,
   * useful for caching purposes.
   * @returns A string fingerprint of the ignore patterns.
   */
  getFingerprint(): string {
    return this.allPatterns.join('\n');
  }
}

function normalizePatterns(patterns: string | string[]): string[] {
  const patternList =
    typeof patterns === 'string' ? patterns.split(/\r?\n/) : patterns;
  return patternList
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '' && !pattern.startsWith('#'));
}

function relativePathPrefix(
  root: string,
  candidateRoot: string,
): string | null {
  const relativePath = path.relative(root, candidateRoot);
  if (
    path.isAbsolute(relativePath) ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    return null;
  }
  return relativePath.split(path.sep).join('/');
}

function prefixCandidatePath(prefix: string, candidate: string): string {
  if (!prefix) return candidate;
  const isDirectory = candidate.endsWith('/');
  const prefixed = path.posix.join(prefix, candidate);
  return isDirectory ? `${prefixed}/` : prefixed;
}

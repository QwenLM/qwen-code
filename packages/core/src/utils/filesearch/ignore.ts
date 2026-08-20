/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';
import picomatch from 'picomatch';
import { getQwenIgnoreFileNames } from '../qwenIgnoreParser.js';
import { createDebugLogger } from '../debugLogger.js';

const hasFileExtension = picomatch('**/*[*.]*');
const debugLogger = createDebugLogger('FILE_SEARCH_IGNORE');

export interface LoadIgnoreRulesOptions {
  projectRoot: string;
  useGitignore: boolean;
  useQwenignore: boolean;
  customIgnoreFiles?: string[];
  ignoreDirs: string[];
}

export function loadIgnoreRules(options: LoadIgnoreRulesOptions): Ignore {
  const ignorer = new Ignore();
  if (options.useGitignore) {
    const gitignorePath = path.join(options.projectRoot, '.gitignore');
    const gitignoreContent = readIgnoreFile(gitignorePath);
    if (gitignoreContent !== undefined) {
      ignorer.add(gitignoreContent);
    }
  }

  if (options.useQwenignore) {
    for (const ignoreFileName of getQwenIgnoreFileNames(
      options.customIgnoreFiles,
    )) {
      const qwenignorePath = path.join(options.projectRoot, ignoreFileName);
      const qwenignoreContent = readIgnoreFile(qwenignorePath);
      if (qwenignoreContent !== undefined) {
        ignorer.addSource(qwenignoreContent);
      }
    }
  }

  const ignoreDirs = ['.git', ...options.ignoreDirs];
  ignorer.add(
    ignoreDirs.map((dir) => {
      if (dir.endsWith('/')) {
        return dir;
      }
      return `${dir}/`;
    }),
  );

  return ignorer;
}

function readIgnoreFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    const error = _error as NodeJS.ErrnoException;
    if (error.code !== 'ENOENT') {
      debugLogger.warn(`Failed to read ${filePath}: ${error.message}`);
    }
    return undefined;
  }
}

export class Ignore {
  private readonly allPatterns: string[] = [];
  private dirIgnorer = ignore();
  private fileIgnorer = ignore();
  private readonly sourceIgnorers: Ignore[] = [];

  /**
   * Adds one or more ignore patterns.
   * @param patterns A single pattern string or an array of pattern strings.
   *                 Each pattern can be a glob-like string similar to .gitignore rules.
   * @returns The `Ignore` instance for chaining.
   */
  add(patterns: string | string[]): this {
    if (typeof patterns === 'string') {
      patterns = patterns.split(/\r?\n/);
    }

    for (const p of patterns) {
      const pattern = p.trim();

      if (pattern === '' || pattern.startsWith('#')) {
        continue;
      }

      this.allPatterns.push(pattern);

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

  addSource(patterns: string | string[]): this {
    const sourceIgnorer = new Ignore().add(patterns);
    if (!sourceIgnorer.isEmpty()) {
      this.sourceIgnorers.push(sourceIgnorer);
    }
    return this;
  }

  /**
   * Returns a predicate that matches explicit directory ignore patterns (patterns ending with '/').
   * @returns {(dirPath: string) => boolean}
   */
  getDirectoryFilter(): (dirPath: string) => boolean {
    return (dirPath: string) => this.isDirectoryIgnored(dirPath);
  }

  /**
   * Returns a predicate that matches file ignore patterns (all patterns not ending with '/').
   * Note: This may also match directories if a file pattern matches a directory name, but all explicit directory patterns are handled by getDirectoryFilter.
   * @returns {(filePath: string) => boolean}
   */
  getFileFilter(): (filePath: string) => boolean {
    return (filePath: string) => this.isFileIgnored(filePath);
  }

  /**
   * Returns a string representing the current set of ignore patterns.
   * This can be used to generate a unique identifier for the ignore configuration,
   * useful for caching purposes.
   * @returns A string fingerprint of the ignore patterns.
   */
  getFingerprint(): string {
    return JSON.stringify({
      patterns: this.allPatterns,
      sources: this.sourceIgnorers.map((sourceIgnorer) =>
        sourceIgnorer.getFingerprint(),
      ),
    });
  }

  private isDirectoryIgnored(dirPath: string): boolean {
    return (
      this.dirIgnorer.ignores(dirPath) ||
      this.sourceIgnorers.some((sourceIgnorer) =>
        sourceIgnorer.isDirectoryIgnored(dirPath),
      )
    );
  }

  private isFileIgnored(filePath: string): boolean {
    return (
      this.fileIgnorer.ignores(filePath) ||
      this.sourceIgnorers.some((sourceIgnorer) =>
        sourceIgnorer.isFileIgnored(filePath),
      )
    );
  }

  private isEmpty(): boolean {
    return this.allPatterns.length === 0 && this.sourceIgnorers.length === 0;
  }
}

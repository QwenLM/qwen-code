/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import * as path from 'path';
import ignore, { type Ignore } from 'ignore';
import { isGitRepository } from './gitUtils.js';

/**
 * An interface for a filter that uses .gitignore-style patterns.
 */
export interface GitIgnoreFilter {
  /**
   * Checks if a given file path is ignored by the filter.
   * @param filePath The path to check.
   * @returns `true` if the file is ignored, `false` otherwise.
   */
  isIgnored(filePath: string): boolean;
  /**
   * Gets the raw patterns that the filter is using.
   * @returns An array of pattern strings.
   */
  getPatterns(): string[];
}

/**
 * A parser for .gitignore files that can be used to filter file paths.
 */
export class GitIgnoreParser implements GitIgnoreFilter {
  private projectRoot: string;
  private ig: Ignore = ignore();
  private patterns: string[] = [];

  /**
   * Creates a new GitIgnoreParser.
   * @param projectRoot The root directory of the project.
   */
  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /**
   * Loads the ignore patterns from the `.gitignore` and `.git/info/exclude` files
   * in the project's Git repository.
   */
  loadGitRepoPatterns(): void {
    if (!isGitRepository(this.projectRoot)) return;

    // Always ignore .git directory regardless of .gitignore content
    this.addPatterns(['.git']);

    const patternFiles = ['.gitignore', path.join('.git', 'info', 'exclude')];
    for (const pf of patternFiles) {
      this.loadPatterns(pf);
    }
  }

  /**
   * Loads ignore patterns from a specified file.
   * @param patternsFileName The name of the file containing the patterns (e.g., '.gitignore').
   */
  loadPatterns(patternsFileName: string): void {
    const patternsFilePath = path.join(this.projectRoot, patternsFileName);
    let content: string;
    try {
      content = fs.readFileSync(patternsFilePath, 'utf-8');
    } catch (_error) {
      // ignore file not found
      return;
    }
    const patterns = (content ?? '')
      .split('\n')
      .map((p) => p.trim())
      .filter((p) => p !== '' && !p.startsWith('#'));
    this.addPatterns(patterns);
  }

  private addPatterns(patterns: string[]) {
    this.ig.add(patterns);
    this.patterns.push(...patterns);
  }

  /**
   * Checks if a given file path is ignored by the loaded patterns.
   * @param filePath The path to check.
   * @returns `true` if the file is ignored, `false` otherwise.
   */
  isIgnored(filePath: string): boolean {
    const resolved = path.resolve(this.projectRoot, filePath);
    const relativePath = path.relative(this.projectRoot, resolved);

    if (relativePath === '' || relativePath.startsWith('..')) {
      return false;
    }

    // Even in windows, Ignore expects forward slashes.
    const normalizedPath = relativePath.replace(/\\/g, '/');
    return this.ig.ignores(normalizedPath);
  }

  /**
   * Gets the raw patterns that have been loaded.
   * @returns An array of pattern strings.
   */
  getPatterns(): string[] {
    return this.patterns;
  }
}

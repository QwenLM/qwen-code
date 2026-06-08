/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';

const QWEN_IGNORE_FILE_NAME = '.qwenignore';

export const DEFAULT_QWEN_CUSTOM_IGNORE_FILE_NAMES = [
  '.agentignore',
  '.aiignore',
] as const;

export function normalizeQwenCustomIgnoreFileNames(
  ignoreFileNames: readonly string[] = DEFAULT_QWEN_CUSTOM_IGNORE_FILE_NAMES,
): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const ignoreFileName of ignoreFileNames) {
    const candidate = ignoreFileName.trim().replace(/\\/g, '/');
    if (
      candidate === '' ||
      path.isAbsolute(candidate) ||
      candidate.startsWith('/') ||
      candidate.includes('\0') ||
      candidate === QWEN_IGNORE_FILE_NAME ||
      candidate.split('/').includes('..')
    ) {
      continue;
    }
    if (!seen.has(candidate)) {
      normalized.push(candidate);
      seen.add(candidate);
    }
  }

  return normalized;
}

export function getQwenIgnoreFileNames(
  customIgnoreFileNames?: readonly string[],
): string[] {
  return [
    QWEN_IGNORE_FILE_NAME,
    ...normalizeQwenCustomIgnoreFileNames(customIgnoreFileNames),
  ];
}

export function formatQwenIgnoreFileNames(
  customIgnoreFileNames?: readonly string[],
): string {
  return getQwenIgnoreFileNames(customIgnoreFileNames).join(', ');
}

export interface QwenIgnoreFilter {
  isIgnored(filePath: string): boolean;
  getPatterns(): string[];
}

export class QwenIgnoreParser implements QwenIgnoreFilter {
  private projectRoot: string;
  private patterns: string[] = [];
  private ig = ignore();
  private readonly ignoreFileNames: string[];

  constructor(projectRoot: string, customIgnoreFileNames?: readonly string[]) {
    this.projectRoot = path.resolve(projectRoot);
    this.ignoreFileNames = getQwenIgnoreFileNames(customIgnoreFileNames);
    this.loadPatterns();
  }

  private loadPatterns(): void {
    for (const ignoreFileName of this.ignoreFileNames) {
      const patternsFilePath = path.join(this.projectRoot, ignoreFileName);
      let content: string;
      try {
        content = fs.readFileSync(patternsFilePath, 'utf-8');
      } catch (_error) {
        // ignore file not found
        continue;
      }

      const patterns = (content ?? '')
        .split('\n')
        .map((p) => p.trim())
        .filter((p) => p !== '' && !p.startsWith('#'));
      this.patterns.push(...patterns);
    }

    if (this.patterns.length > 0) {
      this.ig.add(this.patterns);
    }
  }

  isIgnored(filePath: string): boolean {
    if (this.patterns.length === 0) {
      return false;
    }

    if (!filePath || typeof filePath !== 'string') {
      return false;
    }

    if (
      filePath.startsWith('\\') ||
      filePath === '/' ||
      filePath.includes('\0')
    ) {
      return false;
    }

    const resolved = path.resolve(this.projectRoot, filePath);
    const relativePath = path.relative(this.projectRoot, resolved);

    if (relativePath === '' || relativePath.startsWith('..')) {
      return false;
    }

    // Even in windows, Ignore expects forward slashes.
    const normalizedPath = relativePath.replace(/\\/g, '/');

    if (normalizedPath.startsWith('/') || normalizedPath === '') {
      return false;
    }

    return this.ig.ignores(normalizedPath);
  }

  getPatterns(): string[] {
    return this.patterns;
  }

  getIgnoreFileNames(): string[] {
    return this.ignoreFileNames;
  }
}

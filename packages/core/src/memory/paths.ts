/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { QWEN_DIR, sanitizeCwd } from '../utils/paths.js';
import type { AutoMemoryType } from './types.js';

export const AUTO_MEMORY_DIRNAME = 'memory';
export const AUTO_MEMORY_INDEX_FILENAME = 'MEMORY.md';
export const AUTO_MEMORY_METADATA_FILENAME = 'meta.json';
export const AUTO_MEMORY_EXTRACT_CURSOR_FILENAME = 'extract-cursor.json';
export const AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME = 'consolidation.lock';

function findGitRoot(startPath: string): string | null {
  let current = path.resolve(startPath);

  while (true) {
    const gitPath = path.join(current, '.git');
    if (fs.existsSync(gitPath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function findCanonicalGitRoot(startPath: string): string | null {
  const gitRoot = findGitRoot(startPath);
  if (!gitRoot) {
    return null;
  }

  try {
    const gitContent = fs
      .readFileSync(path.join(gitRoot, '.git'), 'utf-8')
      .trim();
    if (!gitContent.startsWith('gitdir:')) {
      return gitRoot;
    }

    const worktreeGitDir = path.resolve(
      gitRoot,
      gitContent.slice('gitdir:'.length).trim(),
    );
    const commonDir = path.resolve(
      worktreeGitDir,
      fs.readFileSync(path.join(worktreeGitDir, 'commondir'), 'utf-8').trim(),
    );

    if (
      path.resolve(path.dirname(worktreeGitDir)) !==
      path.join(commonDir, 'worktrees')
    ) {
      return gitRoot;
    }

    const backlink = fs.realpathSync(
      fs.readFileSync(path.join(worktreeGitDir, 'gitdir'), 'utf-8').trim(),
    );
    if (backlink !== path.join(fs.realpathSync(gitRoot), '.git')) {
      return gitRoot;
    }

    if (path.basename(commonDir) !== '.git') {
      return commonDir.normalize('NFC');
    }
    return path.dirname(commonDir).normalize('NFC');
  } catch {
    return gitRoot;
  }
}

/**
 * Returns the base directory for all auto-memory storage.
 * Defaults to `~/.qwen`; overridable via QWEN_CODE_MEMORY_BASE_DIR for tests.
 */
export function getMemoryBaseDir(): string {
  if (process.env['QWEN_CODE_MEMORY_BASE_DIR']) {
    return process.env['QWEN_CODE_MEMORY_BASE_DIR'];
  }
  return path.join(os.homedir(), QWEN_DIR);
}

// Memoize by projectRoot — findCanonicalGitRoot() walks the file system (existsSync
// per directory) and is called from hot-path code such as schedulers and scanners.
const _autoMemoryRootCache = new Map<string, string>();

export function getAutoMemoryRoot(projectRoot: string): string {
  const cached = _autoMemoryRootCache.get(projectRoot);
  if (cached !== undefined) return cached;

  let result: string;
  if (process.env['QWEN_CODE_MEMORY_LOCAL'] === '1') {
    result = path.join(projectRoot, QWEN_DIR, AUTO_MEMORY_DIRNAME);
  } else {
    const canonicalRoot =
      findCanonicalGitRoot(projectRoot) ?? path.resolve(projectRoot);
    result = path.join(
      getMemoryBaseDir(),
      'projects',
      sanitizeCwd(canonicalRoot),
      AUTO_MEMORY_DIRNAME,
    );
  }
  _autoMemoryRootCache.set(projectRoot, result);
  return result;
}

/** Clear the memoization cache (for tests that change environment or git layout). */
export function clearAutoMemoryRootCache(): void {
  _autoMemoryRootCache.clear();
}

/**
 * Returns the project-level state directory that holds auxiliary files
 * (meta.json, extract-cursor.json, consolidation.lock) for the given project.
 * This is the parent of getAutoMemoryRoot(), so memory/ stays clean:
 * only MEMORY.md and topic files live inside it.
 */
export function getAutoMemoryProjectStateDir(projectRoot: string): string {
  return path.dirname(getAutoMemoryRoot(projectRoot));
}

/**
 * Returns true if the given absolute path is inside the auto-memory root for
 * the given project.
 *
 * Uses path.relative() instead of startsWith() to correctly handle
 * platform path-separator differences (e.g. Windows backslash vs forward
 * slash) and to be resilient against path-traversal edge cases.
 */
export function isAutoMemPath(
  absolutePath: string,
  projectRoot: string,
): boolean {
  const normalizedPath = path.normalize(absolutePath);
  const memRoot = path.normalize(getAutoMemoryRoot(projectRoot));
  const rel = path.relative(memRoot, normalizedPath);
  // rel === '' means absolutePath IS memRoot itself.
  // !rel.startsWith('..') && !path.isAbsolute(rel) means it's strictly inside.
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function getAutoMemoryIndexPath(projectRoot: string): string {
  return path.join(getAutoMemoryRoot(projectRoot), AUTO_MEMORY_INDEX_FILENAME);
}

export function getAutoMemoryMetadataPath(projectRoot: string): string {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    AUTO_MEMORY_METADATA_FILENAME,
  );
}

export function getAutoMemoryExtractCursorPath(projectRoot: string): string {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    AUTO_MEMORY_EXTRACT_CURSOR_FILENAME,
  );
}

export function getAutoMemoryConsolidationLockPath(
  projectRoot: string,
): string {
  return path.join(
    getAutoMemoryProjectStateDir(projectRoot),
    AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME,
  );
}

export function getAutoMemoryTopicFilename(type: AutoMemoryType): string {
  return `${type}.md`;
}

export function getAutoMemoryTopicPath(
  projectRoot: string,
  type: AutoMemoryType,
): string {
  return path.join(
    getAutoMemoryRoot(projectRoot),
    getAutoMemoryTopicFilename(type),
  );
}

export function getAutoMemoryFilePath(
  projectRoot: string,
  relativePath: string,
): string {
  return path.join(getAutoMemoryRoot(projectRoot), relativePath);
}

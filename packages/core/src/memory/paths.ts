/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import { QWEN_DIR, resolvePath, sanitizeCwd } from '../utils/paths.js';
import type { AutoMemoryType } from './types.js';

export const AUTO_MEMORY_DIRNAME = 'memory';
export const AUTO_MEMORY_INDEX_FILENAME = 'MEMORY.md';
export const AUTO_MEMORY_METADATA_FILENAME = 'meta.json';
export const AUTO_MEMORY_EXTRACT_CURSOR_FILENAME = 'extract-cursor.json';
export const AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME = 'consolidation.lock';

/**
 * Top-level directory name (under getMemoryBaseDir()) for the user-level
 * auto-memory layer — cross-project facts about the user (preferences,
 * working style, background). Mirror layout of the per-project memory dir.
 */
export const USER_AUTO_MEMORY_DIRNAME = 'memories';

/**
 * Directory name (under the repo's `.qwen/`) for the team auto-memory layer —
 * project memory shared with every collaborator. Unlike the private layers it
 * lives INSIDE the repository and is tracked by git, which is the sync transport.
 */
export const TEAM_AUTO_MEMORY_DIRNAME = 'team-memory';

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

/**
 * Returns the base directory for all auto-memory storage.
 * Defaults to the runtime output dir (`runtimeOutputDir`, `QWEN_RUNTIME_DIR`,
 * or the global qwen dir);
 * overridable via QWEN_CODE_MEMORY_BASE_DIR for tests.
 */
export function getMemoryBaseDir(): string {
  if (process.env['QWEN_CODE_MEMORY_BASE_DIR']) {
    return resolvePath(undefined, process.env['QWEN_CODE_MEMORY_BASE_DIR']);
  }
  return Storage.getRuntimeBaseDir();
}

// Memoize by projectRoot plus the runtime-specific base dir. In daemon mode,
// different sessions can share a project root while writing to different output dirs.
const _autoMemoryRootCache = new Map<string, string>();

// Memoized on projectRoot alone: the team root resolves via findGitRoot, which
// does sync fs I/O — and isTeamAutoMemPath runs on every file write.
const _teamAutoMemoryRootCache = new Map<string, string>();

export function getAutoMemoryRoot(projectRoot: string): string {
  const useLocalMemory = process.env['QWEN_CODE_MEMORY_LOCAL'] === '1';
  const memoryBaseDir = useLocalMemory ? '' : getMemoryBaseDir();
  const cacheKey = `${useLocalMemory ? 'local' : memoryBaseDir}\0${projectRoot}`;
  const cached = _autoMemoryRootCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: string;
  if (useLocalMemory) {
    result = path.join(projectRoot, QWEN_DIR, AUTO_MEMORY_DIRNAME);
  } else {
    // Anchor at the nearest git root WITHOUT resolving linked worktrees back
    // to their canonical repository root: each worktree gets its own memory,
    // consistent with the per-worktree isolation of chats/, workflows/, and
    // team memory (getTeamAutoMemoryRoot). See #6449.
    const gitRoot = findGitRoot(projectRoot) ?? path.resolve(projectRoot);
    result = path.join(
      memoryBaseDir,
      'projects',
      sanitizeCwd(gitRoot),
      AUTO_MEMORY_DIRNAME,
    );
  }
  _autoMemoryRootCache.set(cacheKey, result);
  return result;
}

/** Clear the memoization caches (for tests that change environment or git layout). */
export function clearAutoMemoryRootCache(): void {
  _autoMemoryRootCache.clear();
  _teamAutoMemoryRootCache.clear();
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

/**
 * Returns the user-level (cross-project) auto-memory root.
 * Lives at `${getMemoryBaseDir()}/memories/` — typically `~/.qwen/memories/`.
 * Unlike project memory, this is NOT scoped to a git root; it is shared
 * across every project the user works in.
 */
export function getUserAutoMemoryRoot(): string {
  return path.join(getMemoryBaseDir(), USER_AUTO_MEMORY_DIRNAME);
}

export function getUserAutoMemoryIndexPath(): string {
  return path.join(getUserAutoMemoryRoot(), AUTO_MEMORY_INDEX_FILENAME);
}

export function getUserAutoMemoryTopicPath(type: AutoMemoryType): string {
  return path.join(getUserAutoMemoryRoot(), getAutoMemoryTopicFilename(type));
}

/**
 * Returns true if the given absolute path is inside the user-level
 * auto-memory root. Uses path.relative() (not startsWith) so platform
 * path-separator differences and path-traversal edge cases are handled.
 */
export function isUserAutoMemPath(absolutePath: string): boolean {
  const normalizedPath = path.normalize(absolutePath);
  const memRoot = path.normalize(getUserAutoMemoryRoot());
  const rel = path.relative(memRoot, normalizedPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Returns the team auto-memory root: `<gitRoot>/.qwen/team-memory/`.
 * Anchored at the current worktree root so tracked writes appear in the active
 * branch diff. Falls back to projectRoot when there is no git root.
 */
export function getTeamAutoMemoryRoot(projectRoot: string): string {
  const cached = _teamAutoMemoryRootCache.get(projectRoot);
  if (cached !== undefined) return cached;
  const root = findGitRoot(projectRoot) ?? path.resolve(projectRoot);
  const result = path.join(root, QWEN_DIR, TEAM_AUTO_MEMORY_DIRNAME);
  _teamAutoMemoryRootCache.set(projectRoot, result);
  return result;
}

export function getTeamAutoMemoryIndexPath(projectRoot: string): string {
  return path.join(
    getTeamAutoMemoryRoot(projectRoot),
    AUTO_MEMORY_INDEX_FILENAME,
  );
}

/**
 * True if the given absolute path is inside the team memory root for the
 * given project. Uses path.relative() (not startsWith) so platform
 * path-separator differences and path-traversal edge cases are handled.
 */
export function isTeamAutoMemPath(
  absolutePath: string,
  projectRoot: string,
): boolean {
  const normalizedPath = path.normalize(realpathNearestExisting(absolutePath));
  const memRoot = path.normalize(
    realpathNearestExisting(getTeamAutoMemoryRoot(projectRoot)),
  );
  const rel = path.relative(memRoot, normalizedPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Follow a leading symlink chain at `inputPath` to its eventual target, even
 * when that target does not exist yet (a dangling link).
 *
 * Security-load-bearing: `fs.existsSync` follows links and reports a dangling
 * symlink as "missing". Relying on it lets an attacker pre-place
 * `decoy.md -> .qwen/team-memory/leak.md` (target absent) so the path classifies
 * OUTSIDE team memory and the secret scanner is skipped — while the real write
 * follows the link INTO team memory. lstat/readlink (no-follow) resolve the link
 * target so classification matches where the bytes will actually land.
 */
function resolveLeafSymlink(inputPath: string): string {
  const maxHops = 40; // POSIX SYMLOOP_MAX
  let current = path.resolve(inputPath);
  for (let i = 0; i < maxHops; i++) {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return current; // missing or unreadable — nothing left to follow
    }
    if (!stat.isSymbolicLink()) {
      return current;
    }
    const target = fs.readlinkSync(current);
    if (path.isAbsolute(target)) {
      current = target;
    } else {
      // Resolve relative targets against the link's real parent so an
      // intermediate directory symlink can't mis-resolve the target.
      let parent: string;
      try {
        parent = fs.realpathSync(path.dirname(current));
      } catch {
        parent = path.dirname(current);
      }
      current = path.resolve(parent, target);
    }
  }
  return current; // chain too deep — caller still range-checks the result
}

function realpathNearestExisting(inputPath: string): string {
  // Resolve a leading (possibly dangling) symlink first so a dangling link into
  // team memory is classified by its target, not treated as a plain missing file.
  const resolved = resolveLeafSymlink(inputPath);
  const missingSegments: string[] = [];
  let current = resolved;

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return resolved;
    }
    missingSegments.unshift(path.basename(current));
    current = parent;
  }

  try {
    return path.join(fs.realpathSync(current), ...missingSegments);
  } catch {
    return resolved;
  }
}

/**
 * True if the path lives in EITHER the project-level memory root for the
 * given project OR the user-level memory root. Used by the extraction
 * agent's sandbox to allow writes to both scopes.
 *
 * Security-load-bearing: team memory is deliberately EXCLUDED. It is committed
 * to the repo and shared with collaborators, so its writes must stay 'ask' and
 * never be auto-approved through this predicate. Do not add team paths here.
 */
export function isAnyAutoMemPath(
  absolutePath: string,
  projectRoot: string,
): boolean {
  return (
    isAutoMemPath(absolutePath, projectRoot) || isUserAutoMemPath(absolutePath)
  );
}

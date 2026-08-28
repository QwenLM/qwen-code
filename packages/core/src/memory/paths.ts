/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Storage } from '../config/storage.js';
import {
  QWEN_DIR,
  realpathNearestExisting,
  resolvePath,
  sanitizeCwd,
} from '../utils/paths.js';
import type { AutoMemoryType } from './types.js';
import { MEMORY_PROJECT_SCOPES } from './scopes.js';

export const AUTO_MEMORY_DIRNAME = 'memory';
export const AUTO_MEMORY_INDEX_FILENAME = 'MEMORY.md';
export const AUTO_MEMORY_PINNED_DIRNAME = 'pinned';
export const AUTO_MEMORY_METADATA_FILENAME = 'meta.json';
export const AUTO_MEMORY_EXTRACT_CURSOR_FILENAME = 'extract-cursor.json';
export const AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME = 'consolidation.lock';
export const USER_AUTO_MEMORY_METADATA_FILENAME = 'user-memory-meta.json';
export const USER_AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME =
  'user-memory-consolidation.lock';

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

// Canonical definitions live in scopes.ts (a zero-import leaf module that can
// be subpath-imported without pulling the core barrel). Re-exported here so
// the barrel surface is unchanged.
export { MEMORY_PROJECT_SCOPES, type MemoryProjectScope } from './scopes.js';

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

// Memoize by projectRoot, project scope, and the runtime-specific base dir.
// The base dir is part of the key because in daemon mode different sessions can
// share one projectRoot yet write to different output dirs.
const _autoMemoryRootCache = new Map<string, string>();

// Memoized on projectRoot alone: the team root resolves via findGitRoot, which
// does sync fs I/O — and isTeamAutoMemPath runs on every file write.
const _teamAutoMemoryRootCache = new Map<string, string>();

let warnedUnknownMemoryProjectScope = false;

/**
 * Resolve QWEN_CODE_MEMORY_PROJECT_SCOPE. Only "workspace" (after trimming and
 * lowercasing) opts into per-workspace partitioning; anything else keeps the
 * git-root scope. An unrecognized non-empty value warns once so a typo surfaces
 * instead of silently falling back to the shared scope this flag exists to
 * prevent.
 */
function resolveWorkspaceProjectScope(): boolean {
  const raw = process.env['QWEN_CODE_MEMORY_PROJECT_SCOPE'];
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'workspace') return true;
  if (
    normalized !== '' &&
    !(MEMORY_PROJECT_SCOPES as readonly string[]).includes(normalized) &&
    !warnedUnknownMemoryProjectScope
  ) {
    warnedUnknownMemoryProjectScope = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code] Ignoring unrecognized QWEN_CODE_MEMORY_PROJECT_SCOPE="${raw}"; ` +
        'falling back to "git-root". Expected "git-root" or "workspace".',
    );
  }
  return false;
}

export function getAutoMemoryRoot(projectRoot: string): string {
  const useLocalMemory = process.env['QWEN_CODE_MEMORY_LOCAL'] === '1';
  const useWorkspaceRoot = resolveWorkspaceProjectScope();
  const memoryBaseDir = useLocalMemory ? '' : getMemoryBaseDir();
  const cacheKey = `${useLocalMemory ? 'local' : memoryBaseDir}\0${
    useWorkspaceRoot ? 'workspace' : 'git-root'
  }\0${projectRoot}`;
  const cached = _autoMemoryRootCache.get(cacheKey);
  if (cached !== undefined) return cached;

  let result: string;
  if (useLocalMemory) {
    result = path.join(projectRoot, QWEN_DIR, AUTO_MEMORY_DIRNAME);
  } else {
    // In git-root scope, anchor at the nearest git root WITHOUT resolving
    // linked worktrees back to their canonical repository root: each worktree
    // gets its own memory, consistent with the per-worktree isolation of
    // chats/, workflows/, and team memory (getTeamAutoMemoryRoot). See #6449.
    // In workspace scope, key by the exact resolved workspace dir instead so
    // nested workspaces in one checkout do not share memory.
    const projectKey = useWorkspaceRoot
      ? path.resolve(projectRoot)
      : (findGitRoot(projectRoot) ?? path.resolve(projectRoot));
    result = path.join(
      memoryBaseDir,
      'projects',
      sanitizeCwd(projectKey),
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
  warnedUnknownMemoryProjectScope = false;
}

/**
 * The trusted filesystem anchor for a project's managed-memory root: the prefix
 * of getAutoMemoryRoot() that is derived from the user's environment rather than
 * repo-tracked contents, and is therefore safe to canonicalize through symlinks.
 *
 * In local-memory mode (`QWEN_CODE_MEMORY_LOCAL=1`) the root is
 * `<projectRoot>/.qwen/memory`, so the anchor is the project root; otherwise the
 * root lives under the shared memory base dir, which is the anchor. The write
 * boundary (isAllowedMemoryPath) canonicalizes this anchor but appends the
 * managed suffix literally, so a symlink planted INSIDE the suffix (e.g. a
 * repo-tracked `.qwen -> /outside`) can't silently relocate the allowed root
 * out of the trusted anchor.
 */
export function getAutoMemoryTrustedAnchor(projectRoot: string): string {
  return process.env['QWEN_CODE_MEMORY_LOCAL'] === '1'
    ? projectRoot
    : getMemoryBaseDir();
}

export function getMemoryRootTrustedAnchor(root: string): string {
  const baseDir = path.resolve(getMemoryBaseDir());
  const resolvedRoot = path.resolve(root);
  const relativeToBase = path.relative(baseDir, resolvedRoot);
  if (
    relativeToBase === '' ||
    (!relativeToBase.startsWith(`..${path.sep}`) &&
      relativeToBase !== '..' &&
      !path.isAbsolute(relativeToBase))
  ) {
    return baseDir;
  }
  return path.dirname(path.dirname(resolvedRoot));
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

export function getUserAutoMemoryMetadataPath(): string {
  return path.join(getMemoryBaseDir(), USER_AUTO_MEMORY_METADATA_FILENAME);
}

export function getUserAutoMemoryConsolidationLockPath(): string {
  return path.join(
    getMemoryBaseDir(),
    USER_AUTO_MEMORY_CONSOLIDATION_LOCK_FILENAME,
  );
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
 * Returns true when the resolved file lives in any managed-memory layer.
 *
 * Unlike {@link isAnyAutoMemPath}, this helper includes team memory and is
 * intended only for read retention. It does not grant write permissions.
 * Resolving the nearest existing path prevents a symlink inside a memory root
 * from protecting content that actually lives outside that root.
 */
export function isManagedMemoryPath(
  filePath: string,
  projectRoot: string,
  baseDir: string = projectRoot,
): boolean {
  const absolutePath = path.resolve(baseDir, filePath);
  const resolvedPath = path.normalize(realpathNearestExisting(absolutePath));
  const projectsRoot = path.normalize(
    realpathNearestExisting(path.join(getMemoryBaseDir(), 'projects')),
  );
  const projectRelative = path.relative(projectsRoot, resolvedPath);
  const projectSegments = projectRelative.split(path.sep);
  if (
    projectRelative !== '' &&
    projectRelative !== '..' &&
    !projectRelative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(projectRelative) &&
    projectSegments.length >= 2 &&
    projectSegments[1] === AUTO_MEMORY_DIRNAME
  ) {
    return true;
  }
  const roots = [
    getAutoMemoryRoot(projectRoot),
    path.join(projectRoot, QWEN_DIR, AUTO_MEMORY_DIRNAME),
    getUserAutoMemoryRoot(),
    getTeamAutoMemoryRoot(projectRoot),
  ];
  return roots.some((root) => {
    const resolvedRoot = path.normalize(realpathNearestExisting(root));
    const rel = path.relative(resolvedRoot, resolvedPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

export function isPrivateMemoryProjectsPath(filePath: string): boolean {
  const resolvedPath = path.normalize(
    realpathNearestExisting(path.resolve(filePath)),
  );
  const projectsRoot = path.normalize(
    realpathNearestExisting(path.join(getMemoryBaseDir(), 'projects')),
  );
  const relative = path.relative(projectsRoot, resolvedPath);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
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

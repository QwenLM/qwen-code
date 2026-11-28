/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const DEFAULT_WORKTREE_ROOT = '.qwen/worktrees';
export const DEFAULT_WORKTREE_ROOT_SEGMENTS: readonly string[] = [
  '.qwen',
  'worktrees',
];
export const WORKTREE_ROOT_MAX_LENGTH = 240;

export class InvalidWorktreeRootError extends Error {
  readonly code = 'invalid_worktree_root';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidWorktreeRootError';
  }
}

export interface ParsedWorktreeRoot {
  readonly normalized: string;
  readonly segments: readonly string[];
  readonly isDefault: boolean;
}

const DEFAULT_PARSED_WORKTREE_ROOT: ParsedWorktreeRoot = Object.freeze({
  normalized: DEFAULT_WORKTREE_ROOT,
  segments: DEFAULT_WORKTREE_ROOT_SEGMENTS,
  isDefault: true,
});

const WINDOWS_DRIVE_RE = /^[A-Za-z]:/;

function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function foldsPathCase(): boolean {
  return process.platform === 'win32' || process.platform === 'darwin';
}

function normalizeForComparison(value: string): string {
  return foldsPathCase() ? value.toLowerCase() : value;
}

function isWithinDirectory(candidate: string, root: string): boolean {
  const rel = path.relative(
    normalizeForComparison(root),
    normalizeForComparison(candidate),
  );
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
  );
}

function isStrictlyWithinDirectory(candidate: string, root: string): boolean {
  const rel = path.relative(
    normalizeForComparison(root),
    normalizeForComparison(candidate),
  );
  return (
    rel.length > 0 &&
    rel !== '..' &&
    !rel.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(rel)
  );
}

function resolveExistingOrAncestorSync(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fsSync.realpathSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const trailing: string[] = [];
  let cursor = resolved;
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    trailing.push(path.basename(cursor));
    cursor = parent;
    try {
      const realAncestor = fsSync.realpathSync(cursor);
      return path.join(realAncestor, ...trailing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

async function resolveExistingOrAncestorAsync(
  targetPath: string,
): Promise<string> {
  const resolved = path.resolve(targetPath);
  try {
    return await fs.realpath(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
  const trailing: string[] = [];
  let cursor = resolved;
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) return resolved;
    trailing.push(path.basename(cursor));
    cursor = parent;
    try {
      const realAncestor = await fs.realpath(cursor);
      return path.join(realAncestor, ...trailing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
}

function extractSegments(raw: string): string[] | { error: string } {
  if (raw.length === 0 || raw.trim().length === 0) {
    return { error: 'worktree.root must be a non-empty relative path' };
  }
  if (raw !== raw.trim()) {
    return {
      error: 'worktree.root must not have leading or trailing whitespace',
    };
  }
  if (raw.length > WORKTREE_ROOT_MAX_LENGTH) {
    return {
      error: `worktree.root must be at most ${WORKTREE_ROOT_MAX_LENGTH} characters`,
    };
  }
  if (hasControlChar(raw)) {
    return { error: 'worktree.root must not contain control characters' };
  }
  if (
    raw.startsWith('/') ||
    raw.startsWith('\\') ||
    WINDOWS_DRIVE_RE.test(raw) ||
    raw === '~' ||
    raw.startsWith('~/') ||
    raw.startsWith('~\\')
  ) {
    return {
      error: 'worktree.root must be a relative path inside the repository',
    };
  }
  const rawSegments = raw.split(/[/\\]/);
  for (const segment of rawSegments) {
    if (segment === '..') {
      return { error: 'worktree.root must not contain ".." segments' };
    }
    if (segment.includes(':')) {
      return { error: 'worktree.root must not contain ":" characters' };
    }
  }
  const segments = rawSegments.filter(
    (segment) => segment.length > 0 && segment !== '.',
  );
  if (segments.length === 0) {
    return { error: 'worktree.root must not resolve to the repository root' };
  }
  if (segments[0]!.toLowerCase() === '.git') {
    return { error: 'worktree.root must not be inside .git' };
  }
  if (segments.length === 1 && segments[0]!.toLowerCase() === '.qwen') {
    return {
      error:
        'worktree.root must not be ".qwen" directly; use a subdirectory such as ".qwen/worktrees"',
    };
  }
  return segments;
}

/**
 * Validates a candidate `worktree.root` setting value. Returns `undefined` when
 * valid (including `undefined`, which uses the default `.qwen/worktrees`), or
 * a human-readable error message when invalid.
 */
export function validateWorktreeRoot(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    return 'worktree.root must be a string';
  }
  const parsed = extractSegments(value);
  return Array.isArray(parsed) ? undefined : parsed.error;
}

/**
 * Parses and normalizes a `worktree.root` setting value into its canonical
 * POSIX path and segments. Throws {@link InvalidWorktreeRootError} on invalid
 * input rather than falling back to the default.
 */
export function parseWorktreeRoot(value?: unknown): ParsedWorktreeRoot {
  if (value === undefined) {
    return DEFAULT_PARSED_WORKTREE_ROOT;
  }
  if (typeof value !== 'string') {
    throw new InvalidWorktreeRootError('worktree.root must be a string');
  }
  const segments = extractSegments(value);
  if (!Array.isArray(segments)) {
    throw new InvalidWorktreeRootError(segments.error);
  }
  const normalized = segments.join('/');
  if (normalized === DEFAULT_WORKTREE_ROOT) {
    return DEFAULT_PARSED_WORKTREE_ROOT;
  }
  return Object.freeze({
    normalized,
    segments: Object.freeze(segments),
    isDefault: false,
  });
}

export function resolveWorktreeRootPath(
  baseDir: string,
  worktreeRoot?: string,
): string {
  const parsed = parseWorktreeRoot(worktreeRoot);
  return path.join(baseDir, ...parsed.segments);
}

/**
 * Returns each cumulative directory prefix from `baseDir` down to the resolved
 * worktree root (e.g. `['<base>/.qwen', '<base>/.qwen/worktrees']`).
 */
export function getWorktreeRootPrefixes(
  baseDir: string,
  worktreeRoot?: string,
): string[] {
  const parsed = parseWorktreeRoot(worktreeRoot);
  const prefixes: string[] = [];
  let cursor = baseDir;
  for (const segment of parsed.segments) {
    cursor = path.join(cursor, segment);
    prefixes.push(cursor);
  }
  return prefixes;
}

/**
 * Returns true when `candidatePath` sits inside a worktree directory under the
 * configured `worktreeRoot` (i.e. contains `<...segments>/<slug>`).
 */
export function isPathInsideWorktreeRoot(
  candidatePath: string,
  worktreeRoot?: string,
): boolean {
  const parsed = parseWorktreeRoot(worktreeRoot);
  const pathSegments = candidatePath
    .split(/[/\\]/)
    .filter((segment) => segment.length > 0)
    .map(normalizeForComparison);
  const targetSegments = parsed.segments.map(normalizeForComparison);
  const targetLen = targetSegments.length;
  for (let i = 0; i + targetLen < pathSegments.length; i += 1) {
    let matched = true;
    for (let j = 0; j < targetLen; j += 1) {
      if (pathSegments[i + j] !== targetSegments[j]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * Extracts the innermost `{ repoRoot, slug, worktreePath }` when `candidatePath`
 * is at or inside `<repoRoot>/<worktreeRoot>/<slug>`.
 */
export function extractWorktreeFromPath(
  candidatePath: string,
  worktreeRoot?: string,
): { repoRoot: string; slug: string; worktreePath: string } | null {
  const parsed = parseWorktreeRoot(worktreeRoot);
  const targetSegments = parsed.segments.map(normalizeForComparison);
  let cursor = path.resolve(candidatePath);
  for (;;) {
    const slug = path.basename(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    if (slug.length > 0) {
      let dir = parent;
      let matched = true;
      for (let i = targetSegments.length - 1; i >= 0; i -= 1) {
        const dirParent = path.dirname(dir);
        if (
          dirParent === dir ||
          normalizeForComparison(path.basename(dir)) !== targetSegments[i]
        ) {
          matched = false;
          break;
        }
        dir = dirParent;
      }
      if (matched) {
        return { repoRoot: dir, slug, worktreePath: cursor };
      }
    }
    cursor = parent;
  }
}

/**
 * Verifies runtime filesystem containment for a resolved worktree root.
 *
 * - For all roots, rejects targets resolving to the repository root itself or
 *   inside `.git`, and rejects existing non-directory prefix components.
 * - For custom roots (`!parsedRoot.isDefault`), additionally enforces that the
 *   target root and every existing prefix component resolve strictly inside the
 *   canonical repository root (blocking symlinks/junctions that escape).
 */
export async function assertWorktreeRootContainment(
  repoTop: string,
  worktreesDir: string,
  parsedRoot: ParsedWorktreeRoot,
  gitDir?: string,
): Promise<void> {
  let realRepoTop: string;
  let realWorktreesDir: string;
  try {
    realRepoTop = await resolveExistingOrAncestorAsync(repoTop);
    realWorktreesDir = await resolveExistingOrAncestorAsync(worktreesDir);
  } catch (error) {
    throw new InvalidWorktreeRootError(
      `Cannot verify worktree.root containment: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const realGitDir = gitDir
    ? await resolveExistingOrAncestorAsync(gitDir).catch(() =>
        path.resolve(gitDir),
      )
    : undefined;

  if (
    normalizeForComparison(realWorktreesDir) ===
    normalizeForComparison(realRepoTop)
  ) {
    throw new InvalidWorktreeRootError(
      'worktree.root must not resolve to the repository root',
    );
  }
  if (realGitDir && isWithinDirectory(realWorktreesDir, realGitDir)) {
    throw new InvalidWorktreeRootError(
      'worktree.root must not resolve inside .git',
    );
  }

  for (const prefix of getWorktreeRootPrefixes(
    repoTop,
    parsedRoot.normalized,
  )) {
    let stat: fsSync.Stats | null;
    try {
      stat = await fs.lstat(prefix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        break;
      }
      throw new InvalidWorktreeRootError(
        `Cannot inspect worktree.root component ${prefix}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new InvalidWorktreeRootError(
        `worktree.root path component is not a directory: ${prefix}`,
      );
    }
    if (!parsedRoot.isDefault) {
      let realPrefix: string;
      try {
        realPrefix = await fs.realpath(prefix);
      } catch (error) {
        throw new InvalidWorktreeRootError(
          `Cannot resolve worktree.root component ${prefix}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!isStrictlyWithinDirectory(realPrefix, realRepoTop)) {
        throw new InvalidWorktreeRootError(
          `Custom worktree.root "${parsedRoot.normalized}" resolves outside the repository root`,
        );
      }
      if (realGitDir && isWithinDirectory(realPrefix, realGitDir)) {
        throw new InvalidWorktreeRootError(
          `Custom worktree.root "${parsedRoot.normalized}" resolves inside .git`,
        );
      }
    }
  }

  if (
    !parsedRoot.isDefault &&
    !isStrictlyWithinDirectory(realWorktreesDir, realRepoTop)
  ) {
    throw new InvalidWorktreeRootError(
      `Custom worktree.root "${parsedRoot.normalized}" resolves outside the repository root`,
    );
  }
}

/** Synchronous counterpart of {@link assertWorktreeRootContainment}. */
export function assertWorktreeRootContainmentSync(
  repoTop: string,
  worktreesDir: string,
  parsedRoot: ParsedWorktreeRoot,
  gitDir?: string,
): void {
  let realRepoTop: string;
  let realWorktreesDir: string;
  try {
    realRepoTop = resolveExistingOrAncestorSync(repoTop);
    realWorktreesDir = resolveExistingOrAncestorSync(worktreesDir);
  } catch (error) {
    throw new InvalidWorktreeRootError(
      `Cannot verify worktree.root containment: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  let realGitDir: string | undefined;
  if (gitDir) {
    try {
      realGitDir = resolveExistingOrAncestorSync(gitDir);
    } catch {
      realGitDir = path.resolve(gitDir);
    }
  }

  if (
    normalizeForComparison(realWorktreesDir) ===
    normalizeForComparison(realRepoTop)
  ) {
    throw new InvalidWorktreeRootError(
      'worktree.root must not resolve to the repository root',
    );
  }
  if (realGitDir && isWithinDirectory(realWorktreesDir, realGitDir)) {
    throw new InvalidWorktreeRootError(
      'worktree.root must not resolve inside .git',
    );
  }

  for (const prefix of getWorktreeRootPrefixes(
    repoTop,
    parsedRoot.normalized,
  )) {
    let stat: fsSync.Stats | null;
    try {
      stat = fsSync.lstatSync(prefix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        break;
      }
      throw new InvalidWorktreeRootError(
        `Cannot inspect worktree.root component ${prefix}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (!stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new InvalidWorktreeRootError(
        `worktree.root path component is not a directory: ${prefix}`,
      );
    }
    if (!parsedRoot.isDefault) {
      let realPrefix: string;
      try {
        realPrefix = fsSync.realpathSync(prefix);
      } catch (error) {
        throw new InvalidWorktreeRootError(
          `Cannot resolve worktree.root component ${prefix}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (!isStrictlyWithinDirectory(realPrefix, realRepoTop)) {
        throw new InvalidWorktreeRootError(
          `Custom worktree.root "${parsedRoot.normalized}" resolves outside the repository root`,
        );
      }
      if (realGitDir && isWithinDirectory(realPrefix, realGitDir)) {
        throw new InvalidWorktreeRootError(
          `Custom worktree.root "${parsedRoot.normalized}" resolves inside .git`,
        );
      }
    }
  }

  if (
    !parsedRoot.isDefault &&
    !isStrictlyWithinDirectory(realWorktreesDir, realRepoTop)
  ) {
    throw new InvalidWorktreeRootError(
      `Custom worktree.root "${parsedRoot.normalized}" resolves outside the repository root`,
    );
  }
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_WORKTREE_ROOT_SEGMENTS,
  parseWorktreeRoot,
} from './worktree-root.js';

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildWorktreeDirRegex(segments: readonly string[]): RegExp {
  const joined = segments.map(escapeRegex).join('[\\\\/]');
  return new RegExp(`^(.*)[\\\\/]${joined}[\\\\/][^\\\\/]+$`);
}

const WORKTREE_DIR_RE = buildWorktreeDirRegex(DEFAULT_WORKTREE_ROOT_SEGMENTS);

function normalizeForComparison(value: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? value.toLowerCase()
    : value;
}

function isLinkedWorktreeOfBase(
  candidateWorktreeDir: string,
  candidateBaseDir: string,
): boolean {
  try {
    // A linked git worktree stores a `.git` file pointing at the common repo's
    // `worktrees/<name>` directory, whereas a regular repository has a `.git`
    // directory. Also verify the matched base directory actually owns `.git`.
    if (!fs.lstatSync(path.join(candidateWorktreeDir, '.git')).isFile()) {
      return false;
    }
    return fs.existsSync(path.join(candidateBaseDir, '.git'));
  } catch {
    return false;
  }
}

function finalizeBaseMatch(resolved: string, base: string): string {
  if (!base) {
    return path.parse(resolved).root;
  }
  // `C:\.qwen\worktrees\x` captures `C:`, which is drive-relative, not `C:\`.
  if (/^[A-Za-z]:$/.test(base)) {
    return `${base}${path.sep}`;
  }
  return base;
}

/**
 * Session cwd may be a worktree (`<root>/<worktree.root>/<slug>`, default
 * `<root>/.qwen/worktrees/<slug>`). Artifact consumers (`GET /file`,
 * SessionArtifactStore) always resolve workspacePath against the bound
 * workspace root, so producers must strip that suffix.
 *
 * Custom worktree roots are only stripped when the matched base is proved to be
 * the session's repository root (either matching explicit `repoRoot`, or
 * verified on disk as a linked worktree `.git` file under a parent repository),
 * so a normal repository living under `<parent>/<worktree.root>/<repo>` never
 * widens its workspace root to `<parent>`.
 *
 * Both sides of a comparison should use the same path namespace: either both
 * realpath'd or both unresolved. Mixing them on macOS (`/var` vs `/private/var`)
 * makes a valid file look like it escaped the workspace.
 */
export function resolveBoundWorkspaceRoot(
  targetDir: string,
  worktreeRoot?: string,
  repoRoot?: string,
): string {
  const resolved = path.resolve(targetDir);
  // Check the dedicated default `.qwen/worktrees/<slug>` suffix first so a
  // legacy `.qwen/worktrees/<slug>` checkout under `worktree.root: "worktrees"`
  // still strips cleanly to `<repo>` rather than `<repo>/.qwen`.
  const defaultMatch = resolved.match(WORKTREE_DIR_RE);
  if (defaultMatch) {
    return finalizeBaseMatch(resolved, defaultMatch[1] ?? '');
  }
  if (worktreeRoot !== undefined) {
    try {
      const parsed = parseWorktreeRoot(worktreeRoot);
      if (!parsed.isDefault) {
        const customMatch = resolved.match(
          buildWorktreeDirRegex(parsed.segments),
        );
        if (customMatch) {
          const base = finalizeBaseMatch(resolved, customMatch[1] ?? '');
          if (repoRoot !== undefined) {
            if (
              normalizeForComparison(path.resolve(base)) ===
              normalizeForComparison(path.resolve(repoRoot))
            ) {
              return base;
            }
          } else if (isLinkedWorktreeOfBase(resolved, base)) {
            return base;
          }
        }
      }
    } catch {
      // Invalid worktree.root — do not strip a custom prefix.
    }
  }
  return resolved;
}

/**
 * Convert an absolute file path into the root-relative posix workspacePath
 * that the daemon store and `GET /file` understand. Returns null when the
 * file is outside the bound workspace root (including the root itself).
 *
 * This helper does not apply write_file's extension whitelist. Callers that
 * only auto-record selected kinds must filter first.
 */
export function toCanonicalWorkspaceArtifactPath(
  absoluteFilePath: string,
  targetDir: string,
  worktreeRoot?: string,
  repoRoot?: string,
): string | null {
  const baseDir = resolveBoundWorkspaceRoot(targetDir, worktreeRoot, repoRoot);
  const relativePath = path.relative(baseDir, path.resolve(absoluteFilePath));
  if (
    !relativePath ||
    relativePath === '..' ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
  return relativePath.split(path.sep).join('/');
}

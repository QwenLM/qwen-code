/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

const WORKTREE_DIR_RE = /^(.*)[\\/]\.qwen[\\/]worktrees[\\/][^\\/]+$/;

/**
 * Session cwd may be a worktree (`<root>/.qwen/worktrees/<slug>`). Artifact
 * consumers (`GET /file`, SessionArtifactStore) always resolve workspacePath
 * against the bound workspace root, so producers must strip that suffix.
 *
 * Both sides of a comparison should use the same path namespace: either both
 * realpath'd or both unresolved. Mixing them on macOS (`/var` vs `/private/var`)
 * makes a valid file look like it escaped the workspace.
 */
export function resolveBoundWorkspaceRoot(targetDir: string): string {
  const resolved = path.resolve(targetDir);
  const match = resolved.match(WORKTREE_DIR_RE);
  if (!match) {
    return resolved;
  }
  const base = match[1];
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
): string | null {
  const baseDir = resolveBoundWorkspaceRoot(targetDir);
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

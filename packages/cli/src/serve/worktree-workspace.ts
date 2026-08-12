/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { findGitRoot } from '@qwen-code/qwen-code-core';

export interface SessionLister {
  listWorkspaceSessions(
    workspaceCwd: string,
  ): ReadonlyArray<{ worktree?: { path: string } }>;
}

/**
 * Resolve the effective workspace for settings/context-file operations.
 * Returns the first worktree session's path when one exists on disk,
 * otherwise the bound workspace itself.
 *
 * Containment is checked against both the bound workspace and its git
 * repo top-level (mirroring the session-restore candidateRoots logic),
 * so monorepo subdirectory workspaces still match repo-root worktrees.
 *
 * TODO(#8138): This only sees worktrees populated via REST session creation
 * or restore (BridgeSessionSummary.worktree). Worktrees entered mid-session
 * via the `enter_worktree` tool are not visible here because the tool only
 * mutates in-child Config state without calling setSessionWorktree.
 */
export function findEffectiveWorkspace(
  bridge: SessionLister,
  boundWorkspace: string,
  pathExists: (p: string) => boolean = existsSync,
): string {
  const sessions = bridge.listWorkspaceSessions(boundWorkspace);
  const normalizedBound = path.normalize(boundWorkspace);

  const candidateRoots = [normalizedBound];
  const repoTop = findGitRoot(normalizedBound);
  if (repoTop && path.normalize(repoTop) !== normalizedBound) {
    candidateRoots.push(path.normalize(repoTop));
  }

  const relocated = sessions.find(
    (s) =>
      s.worktree &&
      candidateRoots.some((root) =>
        path.normalize(s.worktree!.path).startsWith(root + path.sep),
      ) &&
      pathExists(s.worktree.path),
  );
  return relocated?.worktree
    ? path.normalize(relocated.worktree.path)
    : boundWorkspace;
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

interface SessionLister {
  listWorkspaceSessions(
    workspaceCwd: string,
  ): ReadonlyArray<{ worktree?: { path: string } }>;
}

/**
 * Resolve the effective workspace for settings/context-file operations.
 * Returns the first worktree session's path when one exists, otherwise
 * the bound workspace itself.
 */
export function findEffectiveWorkspace(
  bridge: SessionLister,
  boundWorkspace: string,
): string {
  const sessions = bridge.listWorkspaceSessions(boundWorkspace);
  const relocated = sessions.find((s) => s.worktree);
  return relocated?.worktree?.path ?? boundWorkspace;
}

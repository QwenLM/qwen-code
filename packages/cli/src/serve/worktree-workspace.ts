/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

interface SessionLister {
  listWorkspaceSessions(
    workspaceCwd: string,
  ): ReadonlyArray<{ workspaceCwd: string }>;
}

/**
 * Resolve the effective workspace for settings/context-file operations.
 * Returns the first relocated session's cwd when one exists, otherwise
 * the bound workspace itself.
 */
export function findEffectiveWorkspace(
  bridge: SessionLister,
  boundWorkspace: string,
): string {
  const sessions = bridge.listWorkspaceSessions(boundWorkspace);
  const relocated = sessions.find((s) => s.workspaceCwd !== boundWorkspace);
  return relocated?.workspaceCwd ?? boundWorkspace;
}

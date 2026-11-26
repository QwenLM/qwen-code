/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import type { WorkspaceContext } from './workspaceContext.js';
import { getCwd, getOriginalCwd, setCwdAndNotify } from './Shell.js';

/**
 * Builds a stderr addendum announcing the CWD reset to the model.
 * Mirrors reference project's `stdErrAppendShellResetMessage`.
 */
export function stdErrAppendShellResetMessage(stderr: string): string {
  return `${stderr.trim()}\nShell cwd was reset to ${getOriginalCwd()}`;
}

/**
 * If the current Shell CWD has drifted outside the allowed workspace
 * directories, resets it back to `originalCwd` and returns true.
 *
 * Returns false (no-op) when:
 *   - CWD is still equal to originalCwd (fast path — avoids syscalls)
 *   - CWD is inside a workspace directory
 *
 * Mirrors reference project's `resetCwdIfOutsideProject`.
 *
 * @param workspace The current WorkspaceContext to check against.
 */
export function resetCwdIfOutsideWorkspace(
  workspace: WorkspaceContext,
): boolean {
  const cwd = getCwd();
  const originalCwd = getOriginalCwd();

  // Fast path: cwd hasn't moved, so it's trivially in the workspace.
  if (cwd === originalCwd) {
    return false;
  }

  if (workspace.isPathWithinWorkspace(cwd)) {
    return false;
  }

  setCwdAndNotify(originalCwd);
  return true;
}

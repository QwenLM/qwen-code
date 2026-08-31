/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DaemonWorkspaceGitStatus } from '@qwen-code/sdk/daemon';

/**
 * Whether an armed git-mode intent (new branch / worktree) for the next
 * session can no longer apply and must fall back to the current branch.
 *
 * Only definitive states reset it: a session already exists, the workspace
 * is not trusted, or git status answered and reported no branch. A status
 * that is merely absent — not fetched yet, or a poll round that failed — is
 * transient and leaves the intent alone; otherwise one rejected refetch
 * while a draft sits would silently turn a requested worktree task into a
 * plain session in the main checkout.
 */
export function gitModeIntentMustReset({
  sessionId,
  workspaceTrusted,
  gitStatus,
}: {
  sessionId: string | null | undefined;
  workspaceTrusted: boolean | undefined;
  gitStatus: Pick<DaemonWorkspaceGitStatus, 'branch'> | undefined;
}): boolean {
  if (sessionId) return true;
  if (workspaceTrusted !== true) return true;
  return gitStatus !== undefined && !gitStatus.branch;
}

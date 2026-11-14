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
 * is not trusted, git status answered and reported no branch, or the
 * workspace has no commits (an unborn HEAD has no worktree base — the
 * create path would refuse, and the fast status that armed the intent may
 * have omitted hasHead entirely). A status that is merely absent — not
 * fetched yet, or a poll round that failed — is transient and leaves the
 * intent alone; otherwise one rejected refetch while a draft sits would
 * silently turn a requested worktree task into a plain session in the main
 * checkout. hasHead === undefined is transient the same way.
 */
export function gitModeIntentMustReset({
  sessionId,
  workspaceTrusted,
  gitStatus,
}: {
  sessionId: string | null | undefined;
  workspaceTrusted: boolean | undefined;
  gitStatus: Pick<DaemonWorkspaceGitStatus, 'branch' | 'hasHead'> | undefined;
}): boolean {
  if (sessionId) return true;
  if (workspaceTrusted !== true) return true;
  if (gitStatus === undefined) return false;
  return !gitStatus.branch || gitStatus.hasHead === false;
}

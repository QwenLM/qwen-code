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
 * is not trusted, git status answered and reported neither a branch nor a
 * detached HEAD, or the workspace has no commits (an unborn HEAD has no
 * worktree base — the create path would refuse, and the fast status that
 * armed the intent may have omitted hasHead entirely). A status that is
 * merely absent — not fetched yet, or a poll round that failed — is
 * transient and leaves the intent alone; otherwise one rejected refetch
 * while a draft sits would silently turn a requested worktree task into a
 * plain session in the main checkout. hasHead === undefined is transient
 * the same way.
 *
 * The git-status test mirrors `App.gitModeEligible`: a detached HEAD
 * (tag/SHA checkout) reports branch:null with detached:true and is exactly
 * the shared-checkout shape the worktree default isolates, so it must NOT
 * reset the intent — only a non-Git workspace (no branch and not detached)
 * or an unborn HEAD does.
 */
export function gitModeIntentMustReset({
  sessionId,
  workspaceTrusted,
  gitStatus,
}: {
  sessionId: string | null | undefined;
  workspaceTrusted: boolean | undefined;
  gitStatus:
    | Pick<DaemonWorkspaceGitStatus, 'branch' | 'hasHead' | 'detached'>
    | undefined;
}): boolean {
  if (sessionId) return true;
  if (workspaceTrusted !== true) return true;
  if (gitStatus === undefined) return false;
  return (
    !(gitStatus.branch || gitStatus.detached) || gitStatus.hasHead === false
  );
}

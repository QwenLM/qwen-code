/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr sync`: adopt a PR head someone else pushed, and record it
// as the head the next push builds on. The worktree fast-forwards to a head
// built on it. A worktree with unpushed commits of a round merges a head
// pushed on top of the known one (never rebase). A head that rewrote the
// history the worktree stands on (a rebase or force-push by the author)
// replaces the worktree: what the tool pushed is part of that history now,
// and an unpushed attempt made on the old history is dropped, since `push`
// would refuse it anyway.

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt } from '../review/lib/git.js';
import {
  assertOwnedBySession,
  autofixPrPaths,
  repoRoot,
  requireState,
  writeState,
} from './state.js';
import {
  hasUncommittedChanges,
  isAncestor,
  requireWorktree,
} from './worktree.js';

export interface SyncOutcome {
  synced: boolean;
  headSha: string;
  /** Whether the PR head differs from the one the watch knew. */
  moved: boolean;
  /** When not synced: what the worktree must do first. */
  action?: 'merge';
  reason?: string;
  /** Unpushed commits of an attempt dropped because the author rewrote the
   * history they were made on. */
  dropped?: number;
}

export function runSync(prNumber: number): SyncOutcome {
  const paths = autofixPrPaths(repoRoot(), prNumber);
  const state = requireState(paths.statePath, prNumber);
  assertOwnedBySession(state);
  const worktree = paths.worktreePath;
  requireWorktree(worktree, prNumber);

  // FETCH_HEAD is per worktree, so this leaves the user's checkout alone. The
  // PR ref lives on the base repository, fork PRs included.
  git(
    '-C',
    worktree,
    'fetch',
    '--quiet',
    state.remote,
    `refs/pull/${prNumber}/head`,
  );
  const prHead = git('-C', worktree, 'rev-parse', 'FETCH_HEAD^{commit}');
  const head = git('-C', worktree, 'rev-parse', 'HEAD');
  const moved = prHead !== state.lastKnownHeadSha;

  let dropped: number | undefined;
  if (head !== prHead && !isAncestor(worktree, prHead, head)) {
    // Commits of a round that are not on the PR: the worktree's own work.
    const own = Number(
      gitOpt(
        '-C',
        worktree,
        'rev-list',
        '--count',
        'HEAD',
        '--not',
        state.lastKnownHeadSha,
      ) ?? 'NaN',
    );
    if (!Number.isInteger(own)) {
      throw new Error(`git cannot count the unpushed commits in ${worktree}`);
    }
    const fastForward = isAncestor(worktree, head, prHead);
    if (
      !fastForward &&
      own > 0 &&
      isAncestor(worktree, state.lastKnownHeadSha, prHead)
    ) {
      return {
        synced: false,
        headSha: prHead,
        moved,
        action: 'merge',
        reason:
          `the worktree has ${own} unpushed commit(s) and the PR head ${prHead.slice(0, 12)} was pushed on top of the known head: ` +
          `merge ${prHead} into the worktree (never rebase), then run sync again`,
      };
    }
    if (hasUncommittedChanges(worktree)) {
      throw new Error(
        `${worktree} has uncommitted changes; commit or discard them before moving it to the new PR head.`,
      );
    }
    if (fastForward) {
      git('-C', worktree, 'merge', '--ff-only', '--quiet', prHead);
    } else {
      // The author rewrote the history the worktree stands on.
      git('-C', worktree, 'reset', '--hard', '--quiet', prHead);
      if (own > 0) dropped = own;
    }
  }

  if (moved)
    writeState(paths.statePath, { ...state, lastKnownHeadSha: prHead });
  return dropped === undefined
    ? { synced: true, headSha: prHead, moved }
    : { synced: true, headSha: prHead, moved, dropped };
}

export const syncCommand: CommandModule = {
  command: 'sync <pr>',
  describe:
    'Adopt a PR head pushed by someone else: fast-forward the worktree to it, or say what to merge first',
  builder: (yargs) =>
    yargs.positional('pr', {
      type: 'number',
      demandOption: true,
      describe: 'PR number',
    }),
  handler: (argv) => {
    writeStdoutLine(JSON.stringify(runSync(Number(argv['pr']))));
  },
};

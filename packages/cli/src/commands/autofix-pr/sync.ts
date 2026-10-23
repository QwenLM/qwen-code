/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr sync`: adopt a PR head someone else pushed, and record it
// as the head the next push builds on. The head is read from the PR branch
// where pushes go — the ref the push lease protects, which moves at once,
// unlike `refs/pull/<n>/head`.
//
// A head built on the known one is adopted: the worktree fast-forwards to
// it, or, holding unpushed commits of a round, must merge it first (never
// rebase). A head that does not contain the known one rewrote the history
// (the author rebased, force-pushed or rolled the branch back): the
// worktree is replaced by it, since anything built on the old history would
// put back what the author removed, and an unpushed attempt is dropped.
// `--discard` returns the worktree to the PR head whatever it holds, to end
// a round whose work was not pushed.

import type { CommandModule } from 'yargs';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt } from '../review/lib/git.js';
import { liveDestination } from './push.js';
import {
  assertOwnedBySession,
  autofixPrPaths,
  repoRoot,
  requireState,
  withWatchLock,
  writeState,
  type AutofixPrPaths,
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
  /** Unpushed commits dropped: the author rewrote the history they were
   * made on, or `--discard` asked for it. */
  dropped?: number;
  /** `--discard` threw away uncommitted changes as well. */
  discardedChanges?: true;
}

export function runSync(prNumber: number, discard = false): SyncOutcome {
  const paths = autofixPrPaths(repoRoot(), prNumber);
  return withWatchLock(paths, prNumber, () =>
    syncLocked(paths, prNumber, discard),
  );
}

function syncLocked(
  paths: AutofixPrPaths,
  prNumber: number,
  discard: boolean,
): SyncOutcome {
  const state = requireState(paths.statePath, prNumber);
  assertOwnedBySession(state);
  const worktree = paths.worktreePath;
  requireWorktree(paths, prNumber);

  const known = state.lastKnownHeadSha;
  // FETCH_HEAD is per worktree, so this leaves the user's checkout alone.
  const fetchPrHead = (): string => {
    const live = liveDestination(state, prNumber);
    if (live.state !== 'OPEN') {
      throw new Error(
        `PR #${prNumber} is ${live.state.toLowerCase()}; there is no head to follow.`,
      );
    }
    git(
      '-C',
      worktree,
      'fetch',
      '--quiet',
      state.pushTarget,
      `refs/heads/${state.headRefName}`,
    );
    return git('-C', worktree, 'rev-parse', 'FETCH_HEAD^{commit}');
  };
  let prHead: string;
  if (discard) {
    // Ending a round must not depend on the PR still having a branch: a
    // closed PR, a deleted branch or a lost connection leave the worktree
    // at the head the watch last knew.
    try {
      prHead = fetchPrHead();
    } catch {
      prHead = known;
    }
  } else {
    prHead = fetchPrHead();
  }
  const head = git('-C', worktree, 'rev-parse', 'HEAD');
  const moved = prHead !== known;
  // Commits of a round that are not on the PR: the worktree's own work.
  const own = Number(
    gitOpt('-C', worktree, 'rev-list', '--count', 'HEAD', '--not', known) ??
      'NaN',
  );
  if (!Number.isInteger(own)) {
    throw new Error(`git cannot count the unpushed commits in ${worktree}`);
  }

  let dropped: number | undefined;
  let discardedChanges = false;
  if (discard) {
    discardedChanges = hasUncommittedChanges(worktree);
    git('-C', worktree, 'reset', '--hard', '--quiet', prHead);
    // `-ff`: an untracked nested repository would survive one `-f`, and
    // keep the worktree from ever being clean again.
    git('-C', worktree, 'clean', '-ffdq');
    alignSubmodules(worktree);
    if (own > 0) dropped = own;
    if (hasUncommittedChanges(worktree)) {
      if (moved) {
        writeState(paths.statePath, { ...state, lastKnownHeadSha: prHead });
      }
      return {
        synced: false,
        headSha: prHead,
        moved,
        reason: `${worktree} is still not clean after discarding (a submodule git could not reset?); remove it with \`qwen autofix-pr cleanup ${prNumber} --force\` and prepare the watch again`,
      };
    }
  } else if (!isAncestor(worktree, known, prHead)) {
    // The author rewrote the history the watch knew.
    if (hasUncommittedChanges(worktree)) {
      throw new Error(
        `${worktree} has uncommitted changes; commit or discard them before moving it to the new PR head.`,
      );
    }
    git('-C', worktree, 'reset', '--hard', '--quiet', prHead);
    alignSubmodules(worktree);
    if (own > 0) dropped = own;
  } else if (head !== prHead && !isAncestor(worktree, prHead, head)) {
    if (!isAncestor(worktree, head, prHead)) {
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
    git('-C', worktree, 'merge', '--ff-only', '--quiet', prHead);
    alignSubmodules(worktree);
  }

  if (moved) {
    writeState(paths.statePath, { ...state, lastKnownHeadSha: prHead });
  }
  // A submodule the new head moved, which git could not check out, would
  // otherwise be committed back to its old commit by the next fix.
  if (!discard && hasUncommittedChanges(worktree)) {
    return {
      synced: false,
      headSha: prHead,
      moved,
      reason: `${worktree} is not clean after moving to ${prHead.slice(0, 12)} (a submodule git could not update?); run \`qwen autofix-pr sync ${prNumber} --discard\``,
    };
  }
  return {
    synced: true,
    headSha: prHead,
    moved,
    ...(dropped === undefined ? {} : { dropped }),
    ...(discardedChanges ? { discardedChanges: true as const } : {}),
  };
}

/**
 * Moves the checked-out submodules to the commits the worktree's head
 * records, and cleans them. `foreach` visits only checked-out submodules: a
 * reset with `--recurse-submodules` would write a gitfile for one that is
 * not, and leave the worktree unreadable.
 */
function alignSubmodules(worktree: string): void {
  gitOpt(
    '-C',
    worktree,
    'submodule',
    'foreach',
    '--quiet',
    '--recursive',
    'git reset --hard --quiet $sha1 && git clean -ffdq',
  );
}

export const syncCommand: CommandModule = {
  command: 'sync <pr>',
  describe:
    'Adopt a PR head pushed by someone else: fast-forward the worktree to it, say what to merge first, or follow a rewritten history',
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .option('discard', {
        type: 'boolean',
        default: false,
        describe:
          "Return the worktree to the PR head, dropping a round's unpushed commits and uncommitted changes",
      }),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(runSync(Number(argv['pr']), Boolean(argv['discard']))),
    );
  },
};

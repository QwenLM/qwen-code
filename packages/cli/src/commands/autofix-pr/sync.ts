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
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isWithinRoot } from '../../config/path-comparison.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt } from '../review/lib/git.js';
import { liveDestination, withLiveBase } from './push.js';
import {
  assertWatching,
  TASK_OPTION,
  taskArg,
  autofixPrPaths,
  statePaths,
  trustAnchor,
  resolveWatchRoot,
  requireState,
  withWatchLock,
  writeState,
  type AutofixPrPaths,
} from './state.js';
import {
  checkoutHoldsWork,
  hasUncommittedChanges,
  isAncestor,
  networkGit,
  networkGitEnv,
  requireWorktree,
} from './worktree.js';
import { assertNoFixInFlight, clearAbandonedFix } from './fix.js';

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
  /** Commits the worktree holds that the PR does not: a round's work not
   * pushed yet — or left behind by a round that never ended. */
  unpushed?: number;
  /** A background fix whose session ended before its round went on: its
   * marker is gone, and the round discards what the worktree holds. */
  abandonedFix?: { startedAt: string | null };
}

/**
 * `task` is the scheduled task that woke the round: a round starts with
 * `sync`, so one a replaced task's queued fire began goes no further.
 */
export function runSync(
  prNumber: number,
  discard = false,
  task?: string,
): SyncOutcome {
  const root = resolveWatchRoot(prNumber);
  const paths = autofixPrPaths(root, prNumber);
  return withWatchLock(paths, prNumber, () => {
    // Before anything moves: the attempt's agent may be working in the
    // worktree. Only the session that owns the watch removes a marker its
    // session left behind (Section 6.14): `syncLocked` checks it first.
    assertNoFixInFlight(paths, prNumber);
    // Removed once the sync answered: one that fails keeps it for the
    // next, which then reports it.
    const outcome = syncLocked(paths, prNumber, discard, root, task);
    const abandonedFix = clearAbandonedFix(paths);
    return abandonedFix ? { ...outcome, abandonedFix } : outcome;
  });
}

function syncLocked(
  paths: AutofixPrPaths,
  prNumber: number,
  discard: boolean,
  root: string,
  task: string | undefined,
): SyncOutcome {
  const state = requireState(paths.statePath, prNumber);
  assertWatching(state, task);
  // An in-place watch works in the checkout the state names, not the
  // worktree path the PR number alone derives.
  paths = statePaths(root, state);
  const worktree = paths.worktreePath;
  const inPlace = state.inPlace === true;
  if (discard && inPlace) {
    throw new Error(
      `an in-place watch never discards the user's checkout (${worktree}); commit or stash what it holds, or end the watch with \`qwen autofix-pr cleanup ${prNumber}\``,
    );
  }
  requireWorktree(paths, prNumber, root, discard, trustAnchor(state), inPlace);

  const known = state.lastKnownHeadSha;
  // The state with the PR's base as GitHub names it now.
  let current = state;
  // FETCH_HEAD is per worktree, so this leaves the user's checkout alone.
  const fetchPrHead = (): string => {
    const live = liveDestination(state, prNumber);
    if (live.state !== 'OPEN') {
      throw new Error(
        `PR #${prNumber} is ${live.state.toLowerCase()}; there is no head to follow.`,
      );
    }
    current = withLiveBase(state, live, prNumber);
    // Submodules are fetched by `alignSubmodules`, as each one needs it: a
    // submodule commit that cannot be fetched must not fail the PR's own.
    networkGit([
      '-C',
      worktree,
      'fetch',
      '--quiet',
      '--no-recurse-submodules',
      state.pushTarget,
      `refs/heads/${state.headRefName}`,
    ]);
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
  // Not the PR head's either: a round that merged it holds its commits.
  const own = Number(
    gitOpt(
      '-C',
      worktree,
      'rev-list',
      '--count',
      'HEAD',
      '--not',
      known,
      prHead,
    ) ?? 'NaN',
  );
  if (!Number.isInteger(own)) {
    throw new Error(`git cannot count the unpushed commits in ${worktree}`);
  }

  let dropped: number | undefined;
  let discardedChanges = false;
  if (discard) {
    // Whatever git can still read of it: a worktree it cannot read is
    // reset all the same, and judged again below.
    discardedChanges = dirtyOrUnreadable(worktree);
    git(
      '-C',
      worktree,
      'reset',
      '--hard',
      '--quiet',
      '--no-recurse-submodules',
      prHead,
    );
    // `-ff`: an untracked nested repository would survive one `-f`, and
    // keep the worktree from ever being clean again.
    git('-C', worktree, 'clean', '-ffdq');
    alignSubmodules(worktree);
    if (own > 0) dropped = own;
    if (dirtyOrUnreadable(worktree)) {
      if (moved || current !== state) {
        writeState(paths.statePath, { ...current, lastKnownHeadSha: prHead });
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
    if (inPlace) {
      // The user's branch is theirs to reconcile: no reset, ever.
      return {
        synced: false,
        headSha: prHead,
        moved,
        reason: `the author rewrote the PR's history; reconcile ${worktree} with the new head ${prHead.slice(0, 12)} yourself — an in-place watch never resets your branch`,
      };
    }
    if (hasUncommittedChanges(worktree)) {
      throw new Error(
        `${worktree} has uncommitted changes; commit or discard them before moving it to the new PR head.`,
      );
    }
    git(
      '-C',
      worktree,
      'reset',
      '--hard',
      '--quiet',
      '--no-recurse-submodules',
      prHead,
    );
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
    // The checkout holds the watch's own files under .qwen/tmp: they are
    // not the user's work.
    const dirty = inPlace
      ? (checkoutHoldsWork(worktree) ?? true)
      : hasUncommittedChanges(worktree);
    if (dirty) {
      if (inPlace) {
        return {
          synced: false,
          headSha: prHead,
          moved,
          reason: `${worktree} has uncommitted changes; commit or stash them before the round moves it to the new PR head.`,
        };
      }
      throw new Error(
        `${worktree} has uncommitted changes; commit or discard them before moving it to the new PR head.`,
      );
    }
    git(
      '-c',
      'submodule.recurse=false',
      '-C',
      worktree,
      'merge',
      '--ff-only',
      '--quiet',
      prHead,
    );
    // In the user's checkout a submodule holding work is left alone.
    alignSubmodules(worktree, inPlace);
  }

  if (!discard && (head === prHead || isAncestor(worktree, prHead, head))) {
    // The worktree contains the PR head already (a round merged it): a
    // merge moves the gitlinks, not the checked-out submodules. Nothing was
    // checked for uncommitted changes on this path, so a submodule holding
    // work of its own is left for the check below.
    alignSubmodules(worktree, true);
  }
  if (moved || current !== state) {
    writeState(paths.statePath, { ...current, lastKnownHeadSha: prHead });
  }
  // A submodule the new head moved, which git could not check out, would
  // otherwise be committed back to its old commit by the next fix.
  const stillDirty = inPlace
    ? (checkoutHoldsWork(worktree) ?? true)
    : dirtyOrUnreadable(worktree);
  if (!discard && stillDirty) {
    return {
      synced: false,
      headSha: prHead,
      moved,
      ...(dropped === undefined ? {} : { dropped }),
      reason: inPlace
        ? `${worktree} is not clean at ${prHead.slice(0, 12)}: it has uncommitted or untracked files, or a submodule holding work or one whose recorded commit could not be fetched; commit or stash what it holds, or fetch the submodule's commit yourself`
        : `${worktree} is not clean at ${prHead.slice(0, 12)}: it has uncommitted or untracked files, or a submodule git could not move; run \`qwen autofix-pr sync ${prNumber} --discard\``,
    };
  }
  return {
    synced: true,
    headSha: prHead,
    moved,
    ...(dropped === undefined ? {} : { dropped }),
    ...(discardedChanges ? { discardedChanges: true as const } : {}),
    ...(!discard && dropped === undefined && own > 0 ? { unpushed: own } : {}),
  };
}

/** A submodule fetch gets less than the helper's own time. */
const SUBMODULE_FETCH_TIMEOUT_MS = 60_000;
/** All the submodule fetches of one `sync` together. */
const SUBMODULE_FETCH_BUDGET_MS = 180_000;

interface Alignment {
  root: string;
  /** Leave a submodule that holds work a reset would lose. */
  keepWork: boolean;
  deadline: number;
}

/**
 * Moves the checked-out submodules to the commits the worktree's head
 * records, and cleans them. Only checked-out submodules are visited (one
 * that is not would get a gitfile pointing nowhere, and leave the worktree
 * unreadable). `foreach` only lists them: a child it starts would outlive a
 * timeout that kills the top-level git, and go on changing the submodule
 * after the helper returned. A commit a submodule lacks is fetched from its
 * own remote, under the protocol policy git applies to submodules.
 */
function alignSubmodules(repository: string, keepWork = false): void {
  alignLevel(
    repository,
    {
      root: realpathSync(repository),
      keepWork,
      deadline: Date.now() + SUBMODULE_FETCH_BUDGET_MS,
    },
    0,
  );
}

function alignLevel(
  repository: string,
  alignment: Alignment,
  depth: number,
): void {
  // One level at a time: a nested submodule's commit is the one its parent
  // records once the parent has moved, so it is listed only then.
  if (depth > 8) return;
  // NUL-terminated: a path the PR names may hold a newline, and read by
  // lines, what follows it would pass for another submodule.
  const listed = gitOpt(
    '-C',
    repository,
    'submodule',
    'foreach',
    '--quiet',
    'printf "%s %s\\0" "$sha1" "$sm_path"',
  );
  if (!listed) return;
  const modules = gitOpt(
    '-C',
    repository,
    'rev-parse',
    '--git-path',
    'modules',
  );
  let ownModules: string | null = null;
  try {
    if (modules !== null)
      ownModules = realpathSync(resolve(repository, modules));
  } catch {
    // No submodule git directory here yet.
  }
  for (const record of listed.split('\0')) {
    const match = /^([0-9a-f]{40,64}) (.+)$/s.exec(record);
    if (!match) continue;
    const [, sha, path] = match;
    const dir = join(repository, path);
    if (!isOwnSubmodule(dir, alignment.root, ownModules)) continue;
    if (gitOpt('-C', dir, 'cat-file', '-e', `${sha}^{commit}`) === null) {
      fetchSubmoduleCommit(dir, sha, alignment.deadline);
    }
    if (alignment.keepWork && holdsWork(dir, sha)) continue;
    if (
      gitOpt(
        '-C',
        dir,
        'reset',
        '--hard',
        '--quiet',
        '--no-recurse-submodules',
        sha,
      ) !== null
    ) {
      gitOpt('-C', dir, 'clean', '-ffdq');
      alignLevel(dir, alignment, depth + 1);
    }
  }
}

/**
 * Whether `dir` is a submodule checked out inside the worktree, with a
 * repository of its own: inside a plain directory `git -C` finds the
 * enclosing repository, and through a `.git` file naming another one — or
 * a `core.worktree` naming another tree — a reset would move that
 * repository's branch, or write to that tree.
 */
function isOwnSubmodule(
  dir: string,
  root: string,
  ownModules: string | null,
): boolean {
  try {
    const real = realpathSync(dir);
    if (real === root || !isWithinRoot(real, root)) return false;
    const top = gitOpt('-C', dir, 'rev-parse', '--show-toplevel');
    const gitDir = gitOpt('-C', dir, 'rev-parse', '--absolute-git-dir');
    if (top === null || gitDir === null || realpathSync(top) !== real) {
      return false;
    }
    // Where `git submodule` puts it, or embedded in the submodule itself.
    const realGitDir = realpathSync(gitDir);
    return (
      isWithinRoot(realGitDir, real) ||
      (ownModules !== null && isWithinRoot(realGitDir, ownModules))
    );
  } catch {
    return false;
  }
}

/**
 * Whether a reset would lose work held in a submodule: uncommitted
 * changes, or commits the recorded one does not contain.
 */
function holdsWork(dir: string, sha: string): boolean {
  try {
    return hasUncommittedChanges(dir) || !isAncestor(dir, 'HEAD', sha);
  } catch {
    return true;
  }
}

/** A worktree git cannot read counts as not clean. */
function dirtyOrUnreadable(worktree: string): boolean {
  try {
    return hasUncommittedChanges(worktree);
  } catch {
    return true;
  }
}

function fetchSubmoduleCommit(
  dir: string,
  sha: string,
  deadline: number,
): void {
  const timeout = Math.min(SUBMODULE_FETCH_TIMEOUT_MS, deadline - Date.now());
  if (timeout <= 0) return;
  try {
    execFileSync(
      'git',
      ['-C', dir, 'fetch', '--quiet', '--no-recurse-submodules', 'origin', sha],
      {
        timeout,
        killSignal: 'SIGKILL',
        stdio: 'ignore',
        // As in `git submodule` itself: transports a submodule's URL may
        // use only with the user's own consent (`file://` among them) stay
        // refused.
        env: { ...networkGitEnv(), GIT_PROTOCOL_FROM_USER: '0' },
      },
    );
  } catch {
    // Not fetched: the reset fails, and sync answers synced:false.
  }
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
      })
      .option('task', TASK_OPTION),
  handler: (argv) => {
    writeStdoutLine(
      JSON.stringify(
        runSync(Number(argv['pr']), Boolean(argv['discard']), taskArg(argv)),
      ),
    );
  },
};

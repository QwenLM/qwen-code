/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr cleanup`: end a watch. The worktree, its branch and the
// state file go away together, unless the worktree or the branch still holds
// work the PR does not have; then all three stay so the user can pick it up.

import type { CommandModule } from 'yargs';
import {
  existsSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { isWithinRoot } from '../../config/path-comparison.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt, refExists, releaseWorktree } from '../review/lib/git.js';
import {
  assertOwnedBySession,
  autofixPrPaths,
  currentSessionId,
  historyPrefix,
  isRegularFile,
  keepHistory,
  readState,
  repoRoot,
  resolveWatchRoot,
  trustAnchor,
  requireState,
  withWatchLock,
  writeState,
  type AutofixPrPaths,
  type AutofixPrState,
} from './state.js';
import { assertNoFixInFlight } from './fix.js';
import {
  remoteRef,
  untrustedGitfile,
  untrustedSubmodules,
} from './worktree.js';

/**
 * The PR head on the remote, when it is reachable and its commit is here.
 * Work pushed from the worktree without the push helper is already on the
 * PR, although the recorded head never moved.
 */
function livePrHead(state: AutofixPrState, prNumber: number): string | null {
  const sha = remoteRef(state.remote, `refs/pull/${prNumber}/head`) ?? '';
  if (!/^[0-9a-f]{40,64}$/.test(sha)) return null;
  return gitOpt('cat-file', '-e', `${sha}^{commit}`) === null ? null : sha;
}

/**
 * Why the watch must be kept, or null when nothing would be lost. Commits are
 * looked for on the worktree's HEAD, or on the branch once the worktree is
 * gone, and count when no PR head the watch knows of contains them: the
 * recorded and pushed heads, then — only if those leave commits over, since
 * it asks the remote — `liveHead`. Without a recorded head they cannot be
 * ruled out.
 */
export function unsavedWork(
  paths: AutofixPrPaths,
  prHeads: string[] | null,
  liveHead: () => string | null = () => null,
  trustRoot: string = repoRoot(),
): string | null {
  const hasWorktree = existsSync(paths.worktreePath);
  if (hasWorktree) {
    // Trust is anchored to the genuine clone, never to the watch's root
    // worktree: a sibling checkout's `.git` can be rewritten by code that ran
    // inside it, so it must not vouch for a watch nested in it.
    const untrusted =
      untrustedGitfile(paths.worktreePath, trustRoot) ??
      untrustedSubmodules(paths.worktreePath, trustRoot);
    // Not read: git would take the config of a git directory the tree holds.
    if (untrusted !== null) return untrusted;
    // Inside a directory that is not a worktree of its own, git finds the
    // enclosing clone and would judge that instead.
    const top = gitOpt(
      '-C',
      paths.worktreePath,
      'rev-parse',
      '--show-toplevel',
    );
    if (top === null) return `git cannot read ${paths.worktreePath}`;
    if (realpathSync(top) !== realpathSync(paths.worktreePath)) {
      return `${paths.worktreePath} is not a git worktree, so git cannot tell what it holds`;
    }
    // Explicit: `status.showUntrackedFiles=no` would hide new files, and an
    // `ignore` setting for a submodule (in git config or `.gitmodules`) the
    // changes inside it.
    // No optional locks: `status` asks while a round's agent may commit
    // there, and a refreshed index would take its index.lock.
    const status = gitOpt(
      '--no-optional-locks',
      '-C',
      paths.worktreePath,
      'status',
      '--porcelain',
      '--untracked-files=normal',
      '--ignore-submodules=none',
    );
    if (status === null) return `git cannot read ${paths.worktreePath}`;
    if (status !== '') return 'it has uncommitted changes';
  }
  const hasBranch = refExists(`refs/heads/${paths.branch}`);
  if (!hasWorktree && !hasBranch) return null;
  if (prHeads === null) {
    const where = hasWorktree ? paths.worktreePath : `branch ${paths.branch}`;
    return `${where} may hold commits and no PR head is recorded to compare it with`;
  }
  // Cleanup removes the checkout and the branch, so each one that exists is
  // compared with the PR head: a worktree parked on an older commit says
  // nothing about the branch it was cut from.
  const compared: Array<[string, string[]]> = [];
  if (hasWorktree) {
    compared.push([
      paths.worktreePath,
      ['-C', paths.worktreePath, 'rev-list', '--count', 'HEAD'],
    ]);
  }
  if (hasBranch) {
    compared.push([
      `branch ${paths.branch}`,
      ['rev-list', '--count', `refs/heads/${paths.branch}`],
    ]);
  }
  let live: string | null | undefined;
  for (const [where, args] of compared) {
    let ahead = gitOpt(...args, '--not', ...prHeads);
    if (ahead !== null && ahead !== '0') {
      live ??= liveHead();
      if (live !== null) ahead = gitOpt(...args, '--not', ...prHeads, live);
    }
    if (ahead === null) return `git cannot compare ${where} with the PR head`;
    if (ahead !== '0') {
      return `${where} has ${ahead} commit(s) the PR does not have`;
    }
  }
  return null;
}

export function runCleanup(
  prNumber: number,
  force: boolean,
  takeOver = false,
): void {
  const root = resolveWatchRoot(prNumber);
  const paths = autofixPrPaths(root, prNumber);
  if (
    existsSync(paths.worktreePath) &&
    isWithinRoot(realpathSync(process.cwd()), realpathSync(paths.worktreePath))
  ) {
    throw new Error(
      `cannot remove ${paths.worktreePath} from inside it; run cleanup from ${root}.`,
    );
  }
  // With --force too: the worktree is the one a fix agent works in now.
  assertNoFixInFlight(paths, prNumber);
  let state: AutofixPrState | null;
  try {
    state = readState(paths.statePath);
  } catch (err) {
    // An unreadable state file must not pin the watch: --force discards it.
    if (!force) throw err;
    state = null;
  }
  // Stopping a watch another session left behind — one whose session
  // ended, or whose PR the gate saw end — takes it over; unlike --force,
  // the work its worktree holds is still kept. The watch moves only as it
  // ends, under the lock below: moved before a step that fails, it would be
  // left owned by no running session, and its owner's gate would stop it.
  const takenFrom =
    state && !force && takeOver && state.sessionId !== currentSessionId()
      ? state.sessionId
      : null;
  // Taken by a third session meanwhile, the watch is that one's.
  const assertStoppable = (current: AutofixPrState) => {
    if (takenFrom === null || current.sessionId !== takenFrom) {
      assertOwnedBySession(current);
    }
  };
  if (state && !force) assertStoppable(state);

  if (!force) {
    const reason = unsavedWork(
      paths,
      state ? [state.lastKnownHeadSha, ...state.pushedShas] : null,
      () => (state ? livePrHead(state, prNumber) : null),
      state ? trustAnchor(state) : repoRoot(),
    );
    if (reason) {
      // The watch has ended all the same. A round of it that still runs —
      // a fire queued before its task was deleted, a second process of the
      // session — is refused by its helpers, or it would discard what is
      // kept; and `resume` does not start its task again. A start does.
      if (state) {
        withWatchLock(paths, prNumber, () => {
          const current = readState(paths.statePath);
          if (!current) return;
          // Taken over meanwhile: the watch is the new owner's, and goes on.
          assertStoppable(current);
          assertNoFixInFlight(paths, prNumber);
          const { watch: _ended, ...rest } = current;
          // Ended under this session, as a stop of its own would.
          writeState(paths.statePath, {
            ...rest,
            sessionId: currentSessionId(),
            ended: { at: new Date().toISOString(), reason },
          });
          // Its gate answers `watch_ended` from now on and checks nothing,
          // so no check of it may look recent.
          rmSync(paths.checkedPath, { force: true });
        });
      }
      writeStdoutLine(
        JSON.stringify({
          removed: false,
          worktreePath: paths.worktreePath,
          reason: `kept because ${reason}; re-run with --force to discard it`,
        }),
      );
      return;
    }
  }

  const remove = (watch: AutofixPrState | null): string | null => {
    const released = releaseWorktree(paths.worktreePath);
    if (released.existed && !released.freed) {
      throw new Error(
        `could not remove ${paths.worktreePath}: ${released.reason ?? 'unknown'}`,
      );
    }
    // `git`, not `gitOpt`: a branch that survives must keep its state file,
    // or the next `prepare` finds a leftover branch with nothing to compare
    // it to.
    if (refExists(`refs/heads/${paths.branch}`)) {
      git('branch', '-D', paths.branch);
    }
    // What the watch posted and handled outlives it, so a later watch of
    // the PR does not answer the same comments again.
    const kept = watch ? keepHistory(paths, watch) : null;
    // The state file and everything else this PR's watch wrote beside it
    // (CI logs, briefs). The gate cursor belongs to the scheduled task,
    // which outlives a watch and would report everything again without it.
    const tmp = dirname(paths.statePath);
    const prefix = `autofix-pr-${prNumber}-`;
    for (const name of existsSync(tmp) ? readdirSync(tmp) : []) {
      const path = join(tmp, name);
      if (
        name.startsWith(prefix) &&
        path !== paths.gatePath &&
        !name.startsWith(historyPrefix(paths))
      ) {
        // Recursive: a directory planted under one of these names would
        // otherwise outlive the --force meant to discard it.
        rmSync(path, { force: true, recursive: true });
      }
    }
    return kept;
  };
  // Under the lock, the ownership checked again: taken over while the
  // checks above asked the remote, the watch is the new owner's, and no
  // helper of it can start between the check and the removal.
  // Removed without the lock: checked once more just before.
  if (!state || force) assertNoFixInFlight(paths, prNumber);
  const history =
    state && !force
      ? withWatchLock(paths, prNumber, () => {
          const current = requireState(paths.statePath, prNumber);
          assertStoppable(current);
          assertNoFixInFlight(paths, prNumber);
          return remove(current);
        })
      : remove(state);
  if (force) {
    // A lock a killed helper left behind would otherwise outlive the watch.
    rmSync(paths.lockPath, { force: true, recursive: true });
    rmSync(`${paths.lockPath}.break`, { force: true, recursive: true });
    // So would a cursor that is no regular file, which fails every gate.
    if (
      lstatSync(paths.gatePath, { throwIfNoEntry: false }) &&
      !isRegularFile(paths.gatePath)
    ) {
      rmSync(paths.gatePath, { force: true, recursive: true });
    }
  }
  // Named, so a later watch of another repository's PR of this number
  // knows which file its gate refuses.
  const kept = {
    ...(existsSync(paths.gatePath) ? { gateCursor: paths.gatePath } : {}),
    ...(history ? { history } : {}),
  };
  writeStdoutLine(
    JSON.stringify({
      removed: true,
      worktreePath: paths.worktreePath,
      ...kept,
    }),
  );
}

export const cleanupCommand: CommandModule = {
  command: 'cleanup <pr>',
  describe:
    'End a watch: remove its worktree, branch and state file unless the worktree holds unpushed work',
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .option('force', {
        type: 'boolean',
        default: false,
        describe:
          'Remove even when the worktree holds unpushed work or another session owns the watch',
      })
      .option('take-over', {
        type: 'boolean',
        default: false,
        describe:
          'Take the watch from the session that owns it first; unpushed work is still kept',
      }),
  handler: (argv) => {
    runCleanup(
      Number(argv['pr']),
      Boolean(argv['force']),
      Boolean(argv['takeOver']),
    );
  },
};

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr cleanup`: end a watch. The worktree, its branch and the
// state file go away together, unless the worktree or the branch still holds
// work the PR does not have; then all three stay so the user can pick it up.

import type { CommandModule } from 'yargs';
import { existsSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isWithinRoot } from '../../config/path-comparison.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt, refExists, releaseWorktree } from '../review/lib/git.js';
import {
  assertOwnedBySession,
  autofixPrPaths,
  historyPrefix,
  keepHistory,
  readState,
  repoRoot,
  type AutofixPrPaths,
  type AutofixPrState,
} from './state.js';
import { remoteRef } from './worktree.js';

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
): string | null {
  const hasWorktree = existsSync(paths.worktreePath);
  if (hasWorktree) {
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
    const status = gitOpt(
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

export function runCleanup(prNumber: number, force: boolean): void {
  const root = repoRoot();
  const paths = autofixPrPaths(root, prNumber);
  if (
    existsSync(paths.worktreePath) &&
    isWithinRoot(realpathSync(process.cwd()), realpathSync(paths.worktreePath))
  ) {
    throw new Error(
      `cannot remove ${paths.worktreePath} from inside it; run cleanup from ${root}.`,
    );
  }
  let state: AutofixPrState | null;
  try {
    state = readState(paths.statePath);
  } catch (err) {
    // An unreadable state file must not pin the watch: --force discards it.
    if (!force) throw err;
    state = null;
  }
  if (state && !force) assertOwnedBySession(state);

  if (!force) {
    const reason = unsavedWork(
      paths,
      state ? [state.lastKnownHeadSha, ...state.pushedShas] : null,
      () => (state ? livePrHead(state, prNumber) : null),
    );
    if (reason) {
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

  const released = releaseWorktree(paths.worktreePath);
  if (released.existed && !released.freed) {
    throw new Error(
      `could not remove ${paths.worktreePath}: ${released.reason ?? 'unknown'}`,
    );
  }
  // `git`, not `gitOpt`: a branch that survives must keep its state file, or
  // the next `prepare` finds a leftover branch with nothing to compare it to.
  if (refExists(`refs/heads/${paths.branch}`)) {
    git('branch', '-D', paths.branch);
  }
  // What the watch posted and handled outlives it, so a later watch of the
  // PR does not answer the same comments again.
  const history = state ? keepHistory(paths, state) : null;
  // A lock a killed helper left behind would otherwise outlive the watch.
  if (force) {
    rmSync(paths.lockPath, { force: true, recursive: true });
    rmSync(`${paths.lockPath}.break`, { force: true, recursive: true });
  }
  // The state file and everything else this PR's watch wrote beside it (CI
  // logs, briefs). The gate cursor belongs to the scheduled task, which
  // outlives a watch and would report everything again without it.
  const tmp = dirname(paths.statePath);
  const prefix = `autofix-pr-${prNumber}-`;
  for (const name of existsSync(tmp) ? readdirSync(tmp) : []) {
    const path = join(tmp, name);
    if (
      name.startsWith(prefix) &&
      path !== paths.gatePath &&
      !name.startsWith(historyPrefix(paths))
    ) {
      rmSync(path, { force: true });
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
      }),
  handler: (argv) => {
    runCleanup(Number(argv['pr']), Boolean(argv['force']));
  },
};

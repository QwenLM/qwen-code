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
import { dirname, isAbsolute, join, relative } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt, refExists, releaseWorktree } from '../review/lib/git.js';
import {
  assertOwnedBySession,
  autofixPrPaths,
  readState,
  repoRoot,
  type AutofixPrPaths,
  type AutofixPrState,
} from './state.js';

/**
 * Why the watch must be kept, or null when nothing would be lost. Commits are
 * looked for on the worktree's HEAD, or on the branch once the worktree is
 * gone; without the recorded PR head they cannot be ruled out.
 */
export function unsavedWork(
  paths: AutofixPrPaths,
  lastKnownHeadSha: string | null,
): string | null {
  const hasWorktree = existsSync(paths.worktreePath);
  if (hasWorktree) {
    const status = gitOpt('-C', paths.worktreePath, 'status', '--porcelain');
    if (status === null) return `git cannot read ${paths.worktreePath}`;
    if (status !== '') return 'it has uncommitted changes';
  } else if (!refExists(`refs/heads/${paths.branch}`)) {
    return null;
  }
  const where = hasWorktree ? paths.worktreePath : `branch ${paths.branch}`;
  if (lastKnownHeadSha === null) {
    return `${where} may hold commits and no PR head is recorded to compare it with`;
  }
  const ahead = hasWorktree
    ? gitOpt(
        '-C',
        paths.worktreePath,
        'rev-list',
        '--count',
        'HEAD',
        '--not',
        lastKnownHeadSha,
      )
    : gitOpt(
        'rev-list',
        '--count',
        `refs/heads/${paths.branch}`,
        '--not',
        lastKnownHeadSha,
      );
  if (ahead === null) return `git cannot compare ${where} with the PR head`;
  return ahead === '0'
    ? null
    : `${where} has ${ahead} commit(s) the PR does not have`;
}

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function runCleanup(prNumber: number, force: boolean): void {
  const root = repoRoot();
  const paths = autofixPrPaths(root, prNumber);
  if (
    existsSync(paths.worktreePath) &&
    isWithin(realpathSync(paths.worktreePath), realpathSync(process.cwd()))
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
    const reason = unsavedWork(paths, state?.lastKnownHeadSha ?? null);
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
  // The state file and everything else this PR's watch wrote beside it (CI
  // logs, briefs).
  const tmp = dirname(paths.statePath);
  const prefix = `autofix-pr-${prNumber}-`;
  for (const name of existsSync(tmp) ? readdirSync(tmp) : []) {
    if (name.startsWith(prefix)) rmSync(join(tmp, name), { force: true });
  }
  writeStdoutLine(
    JSON.stringify({ removed: true, worktreePath: paths.worktreePath }),
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

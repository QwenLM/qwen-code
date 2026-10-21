/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr cleanup`: end a watch. The worktree, its branch and the
// state file go away together, unless the worktree still holds work the PR
// does not have; then all three stay so the user can pick it up.

import type { CommandModule } from 'yargs';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { git, gitOpt, releaseWorktree } from '../review/lib/git.js';
import { assertOwnedBySession, autofixPrPaths, readState } from './state.js';

/**
 * Why the worktree must be kept, or null when nothing would be lost. Without
 * the recorded PR head only uncommitted changes can be detected.
 */
export function unsavedWork(
  worktreePath: string,
  lastKnownHeadSha: string | null,
): string | null {
  const status = gitOpt('-C', worktreePath, 'status', '--porcelain');
  if (status === null) return `git cannot read ${worktreePath}`;
  if (status !== '') return 'it has uncommitted changes';
  if (lastKnownHeadSha === null) return null;
  const ahead = gitOpt(
    '-C',
    worktreePath,
    'rev-list',
    '--count',
    'HEAD',
    '--not',
    lastKnownHeadSha,
  );
  if (ahead === null)
    return `git cannot compare ${worktreePath} with the PR head`;
  return ahead === '0'
    ? null
    : `it has ${ahead} commit(s) the PR does not have`;
}

export function runCleanup(prNumber: number, force: boolean): void {
  const root = git('rev-parse', '--show-toplevel');
  const paths = autofixPrPaths(root, prNumber);
  const state = readState(paths.statePath);
  if (state && !force) assertOwnedBySession(state);

  if (!force && existsSync(paths.worktreePath)) {
    const reason = unsavedWork(
      paths.worktreePath,
      state?.lastKnownHeadSha ?? null,
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
  gitOpt('branch', '-D', paths.branch);
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

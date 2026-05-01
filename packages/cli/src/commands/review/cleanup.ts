/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Post-review cleanup for /review Step 11.
//   - Remove the temporary worktree at .qwen/tmp/review-pr-<n>.
//   - Delete the local branch ref qwen-review/pr-<n>.
//   - Remove any .qwen/tmp/qwen-review-<target>-* side files.
//
// The command is idempotent — missing files / branches are silent OK.

import type { CommandModule } from 'yargs';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { refExists } from './lib/git.js';
import {
  worktreePath,
  reviewBranch,
  REVIEW_TMP_DIR,
  tmpPrefix,
} from './lib/paths.js';

interface CleanupArgs {
  target: string;
}

function runCleanup(target: string): void {
  let removedAny = false;

  // --- Worktree + branch (only for PR targets) -------------------------
  const prMatch = /^pr-(\d+)$/.exec(target);
  if (prMatch) {
    const prNumber = prMatch[1];

    const wt = worktreePath(prNumber);
    if (existsSync(wt)) {
      try {
        execFileSync('git', ['worktree', 'remove', wt, '--force'], {
          stdio: 'pipe',
        });
        writeStdoutLine(`Removed worktree: ${wt}`);
        removedAny = true;
      } catch (err) {
        writeStderrLine(
          `Failed to remove worktree ${wt}: ${(err as Error).message}`,
        );
      }
    }

    const branch = reviewBranch(prNumber);
    if (refExists(branch)) {
      try {
        execFileSync('git', ['branch', '-D', branch], { stdio: 'pipe' });
        writeStdoutLine(`Deleted ref: ${branch}`);
        removedAny = true;
      } catch (err) {
        writeStderrLine(
          `Failed to delete branch ${branch}: ${(err as Error).message}`,
        );
      }
    }
  }

  // --- Per-target side files (under .qwen/tmp/) -------------------------
  const prefix = tmpPrefix(target);
  let tmpEntries: string[] = [];
  try {
    tmpEntries = existsSync(REVIEW_TMP_DIR) ? readdirSync(REVIEW_TMP_DIR) : [];
  } catch (err) {
    writeStderrLine(
      `Failed to read ${REVIEW_TMP_DIR}: ${(err as Error).message}`,
    );
  }

  for (const file of tmpEntries) {
    if (!file.startsWith(prefix)) continue;
    const full = join(REVIEW_TMP_DIR, file);
    try {
      unlinkSync(full);
      writeStdoutLine(`Removed temp file: ${full}`);
      removedAny = true;
    } catch (err) {
      writeStderrLine(
        `Failed to remove ${full}: ${(err as Error).message}`,
      );
    }
  }

  if (!removedAny) {
    writeStdoutLine(`Nothing to clean for target "${target}".`);
  }
}

export const cleanupCommand: CommandModule = {
  command: 'cleanup <target>',
  describe:
    'Post-review cleanup: remove worktree, branch ref, and per-target temp files',
  builder: (yargs) =>
    yargs.positional('target', {
      type: 'string',
      demandOption: true,
      describe:
        'Review target — "pr-<n>" for a PR review, "local" for an uncommitted review, or a filename for a file review',
    }),
  handler: (argv) => {
    runCleanup((argv as unknown as CleanupArgs).target);
  },
};

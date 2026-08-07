/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The one shared `git check-ignore` probe. Consolidated from two
// module-private copies (review's test-plan.ts, team memory's
// team-memory-git-status.ts) so every guard that asks "can this path be
// committed?" gets git's own answer, under a deadline, with no memo — a
// caller that re-asks the same key (a remedy re-check, a write-time
// re-check) must receive a fresh answer, so caching stays caller-side.
//
// Deliberately NOT GitIgnoreParser (gitIgnoreParser.ts): that in-process
// matcher reads the ignore files itself and misses sources a linked
// worktree or a global excludesFile would supply, so its verdict can
// diverge from git's in either direction — a guard needs git's own answer.

import { execFileSync } from 'node:child_process';

const GIT_TIMEOUT_MS = 5_000;

/**
 * Returns true when `path` is git-ignored under the worktree at `worktree`.
 * Uses `git check-ignore` (exit 0 = ignored, 1 = not). Any other outcome
 * (git missing, not a worktree, fatal error) is treated as not-ignored so a
 * guard never passes on a false signal.
 *
 * Probe a representative FILE, not the directory: a directory-form
 * re-include negation only applies to paths git knows are directories, so
 * probing the directory can spuriously report ignored. The path need not
 * exist — check-ignore evaluates the ignore rules against the pathname.
 */
export function isGitIgnored(worktree: string, path: string): boolean {
  try {
    execFileSync('git', ['-C', worktree, 'check-ignore', '-q', '--', path], {
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

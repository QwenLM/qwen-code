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
 * (git missing, not a worktree, fatal error, kill on the deadline) is
 * treated as not-ignored so a guard never passes on a false signal.
 *
 * Probe a representative FILE, not the directory: a directory-form
 * re-include negation only applies to paths git knows are directories, so
 * probing the directory can spuriously report ignored. The path need not
 * exist — check-ignore evaluates the ignore rules against the pathname.
 *
 * `timeoutMs` bounds the spawn. The 5 s default suits a guard probing its
 * own repository; a caller probing a worktree it does not control passes
 * the generous deadline its other git calls run under — a kill reads as
 * "not ignored", which would accuse a correct Test Plan.
 */
export function isGitIgnored(
  worktree: string,
  path: string,
  timeoutMs: number = GIT_TIMEOUT_MS,
): boolean {
  // A leading ':' in the first component would be parsed as pathspec magic
  // and probe the wrong pathname ('./' disambiguates it as a literal).
  const probe = path.startsWith(':') ? `./${path}` : path;
  // The verdict must come from `worktree`'s own rules, but git's env
  // family can redirect every input check-ignore reads — repository
  // selectors (GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
  // GIT_OBJECT_DIRECTORY, GIT_COMMON_DIR), the config tiers and the
  // inline -c channels (GIT_CONFIG_*), pathspec parsing
  // (GIT_*_PATHSPECS) — and any redirect flips the verdict in one
  // direction or the other. Drop the whole family rather than
  // enumerating channels; `-C worktree` plus the user's own config tiers
  // is all the probe needs. The system tier then gets closed explicitly
  // because it is neither the repo's nor the user's config, and
  // inheriting the ambient GIT_CONFIG_NOSYSTEM would let host policy
  // (/etc/gitconfig) answer for the worktree.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  try {
    execFileSync('git', ['-C', worktree, 'check-ignore', '-q', '--', probe], {
      stdio: 'ignore',
      timeout: timeoutMs,
      env,
    });
    return true;
  } catch {
    return false;
  }
}

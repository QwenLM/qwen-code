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
  // GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE override `-C` path resolution, so
  // an ambient value would answer against a foreign repository's ignore
  // rules; strip them so `-C` is the sole repository selector.
  // GIT_COMMON_DIR is the same class: it selects where check-ignore
  // resolves info/exclude and config (core.excludesFile), so an ambient
  // value answers against a foreign repository's rules.
  // GIT_CONFIG_COUNT activates inline GIT_CONFIG_KEY_<n>/VALUE_<n>
  // injection, and GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM redirect the config
  // files — any of them can aim core.excludesFile at a foreign rules file,
  // the same leak class.
  // GIT_LITERAL/GLOB/NOGLOB_PATHSPECS are pathspec-parse modifiers: any one
  // set makes check-ignore reject every pathspec (fatal, exit 128), which
  // the catch reads as not-ignored — the GIT_OBJECT_DIRECTORY class.
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env['GIT_DIR'];
  delete env['GIT_WORK_TREE'];
  delete env['GIT_INDEX_FILE'];
  delete env['GIT_OBJECT_DIRECTORY'];
  delete env['GIT_COMMON_DIR'];
  delete env['GIT_CONFIG_COUNT'];
  delete env['GIT_CONFIG_GLOBAL'];
  delete env['GIT_CONFIG_SYSTEM'];
  delete env['GIT_LITERAL_PATHSPECS'];
  delete env['GIT_GLOB_PATHSPECS'];
  delete env['GIT_NOGLOB_PATHSPECS'];
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

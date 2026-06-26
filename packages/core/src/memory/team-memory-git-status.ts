/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { createDebugLogger } from '../utils/debugLogger.js';
import { findGitRoot } from '../utils/gitUtils.js';
import { getTeamAutoMemoryIndexPath, getTeamAutoMemoryRoot } from './paths.js';

const debugLogger = createDebugLogger('TEAM_MEMORY_GIT_STATUS');
const GIT_TIMEOUT_MS = 5_000;

/**
 * Returns true when `filePath` is git-ignored in the repo at `gitRoot`.
 * Uses `git check-ignore` (exit 0 = ignored, 1 = not). Best-effort: any other
 * outcome (git missing, fatal error) is treated as not-ignored so we never warn
 * on a false signal. The path need not exist — check-ignore evaluates the
 * ignore rules against the pathname.
 *
 * We check a representative FILE we would write (the team index), not the
 * directory: a `!.qwen/team-memory/` re-include is a directory-form negation
 * that git only applies to paths it knows are directories, so checking the
 * (nonexistent) directory would spuriously report it ignored. The file path is
 * what actually governs whether our writes can be tracked.
 */
function isTeamFileGitIgnored(gitRoot: string, filePath: string): boolean {
  const rel = path.relative(gitRoot, filePath) || '.';
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--', rel], {
      cwd: gitRoot,
      stdio: 'ignore',
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Team memory only actually reaches collaborators when its directory is
 * git-tracked. Two silent-inert cases defeat that: there is no git root (saved
 * memories land in an untracked local dir), or the directory is git-ignored —
 * e.g. a `.qwen/` directory-form ignore, which git never descends into, so a
 * `!`-reinclude below it is a no-op. Both leave the tier looking enabled while
 * sharing nothing.
 *
 * Returns a one-line user-facing warning for those cases, or null when team
 * memory will be shared normally. Call only when the tier is actually active.
 */
export function getTeamMemoryShareabilityWarning(
  projectRoot: string,
): string | null {
  const teamRoot = getTeamAutoMemoryRoot(projectRoot);
  const gitRoot = findGitRoot(teamRoot);
  if (!gitRoot) {
    debugLogger.debug(`No git root for team memory at ${teamRoot}.`);
    return (
      `Team memory is enabled, but ${teamRoot} is not inside a git ` +
      `repository, so saved memories stay local and are not shared with ` +
      `collaborators.`
    );
  }
  if (isTeamFileGitIgnored(gitRoot, getTeamAutoMemoryIndexPath(projectRoot))) {
    debugLogger.debug(`Team memory dir ${teamRoot} is git-ignored.`);
    return (
      `Team memory is enabled, but ${teamRoot} is git-ignored, so saved ` +
      `memories are not shared. If your .gitignore excludes '.qwen/' ` +
      `(directory form), change it to '.qwen/*' and re-include ` +
      `'.qwen/team-memory/'.`
    );
  }
  return null;
}

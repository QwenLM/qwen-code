/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { createDebugLogger } from '../utils/debugLogger.js';
import { findGitRoot, isGitRepository } from '../utils/gitUtils.js';
import { getTeamAutoMemoryRoot } from './paths.js';

const execFileAsync = promisify(execFile);
const debugLogger = createDebugLogger('TEAM_MEMORY_SYNC');
const GIT_TIMEOUT_MS = 30_000;

export interface TeamMemorySyncResult {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  skippedReason?: 'not-a-git-repo' | 'no-upstream';
}

/**
 * Best-effort git command. Returns stdout on success, or null on any failure.
 * Uses execFile (no shell) so paths with spaces / metacharacters are safe.
 */
async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    });
    return stdout;
  } catch (error) {
    debugLogger.debug(`git ${args[0]} failed`, error);
    return null;
  }
}

/**
 * Sync the team memory directory with the repository's remote. Best-effort and
 * never throws: any git failure is swallowed so it cannot break a session.
 *
 * Steps: commit local team-memory changes (only that path), fast-forward-only
 * pull, then push. `--ff-only` is deliberate — it never creates a merge commit
 * or a conflict; if the branch has diverged it simply skips rather than touching
 * the working tree. Only the team path is staged, so unrelated local changes are
 * never committed. The commit is authored by `opts.author` when supplied
 * (cooperative per-user attribution on a shared daemon), otherwise by the
 * repo's configured git user.
 */
export async function syncTeamMemory(
  projectRoot: string,
  opts: {
    message: string;
    /**
     * Cooperative per-user attribution (from the unauthenticated client
     * identity). When set, the commit is authored as `name <email>` so a
     * shared-daemon commit reflects the acting user rather than the server's
     * git identity. Omitted in the single-user case, where the repo's git
     * config already attributes correctly.
     */
    author?: { name: string; email?: string };
  },
): Promise<TeamMemorySyncResult> {
  const result: TeamMemorySyncResult = {
    committed: false,
    pulled: false,
    pushed: false,
  };

  const teamRoot = getTeamAutoMemoryRoot(projectRoot);
  const gitRoot = findGitRoot(teamRoot);
  if (!gitRoot || !isGitRepository(gitRoot)) {
    result.skippedReason = 'not-a-git-repo';
    return result;
  }
  const relPath = path.relative(gitRoot, teamRoot) || '.';

  // 1. Commit local team-memory changes (only the team path).
  const status = await tryGit(gitRoot, [
    'status',
    '--porcelain',
    '--',
    relPath,
  ]);
  if (status && status.trim().length > 0) {
    await tryGit(gitRoot, ['add', '--', relPath]);
    const commitArgs = ['commit', '-m', opts.message];
    if (opts.author) {
      const email = opts.author.email ?? `${opts.author.name}@users.noreply`;
      commitArgs.push('--author', `${opts.author.name} <${email}>`);
    }
    commitArgs.push('--', relPath);
    result.committed = (await tryGit(gitRoot, commitArgs)) !== null;
  }

  // 2. Pull (fast-forward only) + push, only when an upstream is configured.
  const upstream = await tryGit(gitRoot, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);
  if (upstream === null) {
    result.skippedReason = 'no-upstream';
    return result;
  }
  result.pulled = (await tryGit(gitRoot, ['pull', '--ff-only'])) !== null;
  result.pushed = (await tryGit(gitRoot, ['push'])) !== null;
  return result;
}

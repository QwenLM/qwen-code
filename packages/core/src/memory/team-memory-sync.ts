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
// Bounds the worst-case session-start delay: this runs on the awaited
// session-start path, and there are at most two network steps (pull + push).
const GIT_TIMEOUT_MS = 15_000;

export interface TeamMemorySyncResult {
  committed: boolean;
  pulled: boolean;
  pushed: boolean;
  skippedReason?:
    | 'not-a-git-repo'
    | 'no-upstream'
    // HEAD is detached: a commit would be orphaned (no branch to advance), so we
    // skip without committing rather than stranding it.
    | 'detached-head'
    | 'pull-failed'
    | 'push-failed'
    // The branch carried commits unrelated to this sync, so pushing would
    // publish them; we created our commit but deliberately did not push.
    | 'local-ahead';
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
      // Graceful kill: SIGTERM lets git release index.lock and finish cleanup,
      // so a timeout mid-commit/-pull can't corrupt the index. The
      // non-interactive ssh guards below already bound the network-hang case, so
      // a hard SIGKILL (which would skip that cleanup) isn't needed.
      killSignal: 'SIGTERM',
      env: {
        ...process.env,
        // Force non-interactive git so a missing credential / askpass prompt
        // fails fast instead of hanging session start on the network steps.
        GIT_TERMINAL_PROMPT: '0',
        // Non-interactive ssh, but APPEND onto a user's GIT_SSH_COMMAND rather
        // than clobbering it — their custom identity (`-i`), proxy jump (`-J`),
        // or port stays intact; we only add the batch guards (theirs win on any
        // duplicate option, since ssh takes the first value).
        GIT_SSH_COMMAND: process.env['GIT_SSH_COMMAND']
          ? `${process.env['GIT_SSH_COMMAND']} -oBatchMode=yes -oConnectTimeout=5`
          : 'ssh -oBatchMode=yes -oConnectTimeout=5',
      },
    });
    return stdout;
  } catch (error) {
    debugLogger.debug(`git ${args[0]} failed`, error);
    return null;
  }
}

/**
 * Resolve the explicit single refspec for pushing the current branch only.
 * Returns null when HEAD is detached or the branch lacks upstream config, so the
 * caller can skip rather than fall back to an unqualified `git push` (which could
 * publish other branches under `push.default=matching`).
 */
async function resolvePushTarget(
  gitRoot: string,
): Promise<{ remote: string; mergeRef: string } | null> {
  const branch = (
    await tryGit(gitRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  )?.trim();
  if (!branch) {
    return null; // detached HEAD — no branch to push
  }
  const remote = (
    await tryGit(gitRoot, ['config', '--get', `branch.${branch}.remote`])
  )?.trim();
  const mergeRef = (
    await tryGit(gitRoot, ['config', '--get', `branch.${branch}.merge`])
  )?.trim();
  if (!remote || !mergeRef) {
    return null;
  }
  return { remote, mergeRef };
}

/**
 * Sync the team memory directory with the repository's remote. Best-effort and
 * never throws: any git failure is swallowed so it cannot break a session.
 *
 * Order is deliberate: fast-forward-only PULL first (reconcile), THEN commit the
 * local team path on top of upstream, THEN push. Reconciling before committing
 * keeps a two-writer branch from diverging and wedging `--ff-only`. `--ff-only`
 * never creates a merge commit or a conflict; a diverged branch is left
 * untouched and surfaced as `pull-failed`. Only the team path is staged, so
 * unrelated local changes are never committed; the push is an explicit
 * single-branch refspec gated on this sync having created the commit, so it can
 * never publish unrelated local commits. The commit is authored by `opts.author`
 * when supplied (cooperative per-user attribution on a shared daemon), otherwise
 * by the repo's configured git user.
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

  // Detached HEAD: there is no branch to advance, so a commit here would be
  // orphaned (unreachable, never pushable). Skip the whole sync cleanly instead
  // of stranding a commit. (A branch with no upstream is different — that commit
  // still lands on the user's branch — and is handled by `no-upstream` below.)
  const branch = (
    await tryGit(gitRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  )?.trim();
  if (!branch) {
    result.skippedReason = 'detached-head';
    return result;
  }

  // Resolve upstream up-front: it gates both the reconcile-before-commit pull
  // and whether a push is even possible.
  const upstream = await tryGit(gitRoot, [
    'rev-parse',
    '--abbrev-ref',
    '--symbolic-full-name',
    '@{u}',
  ]);

  // Capture whether the branch was ALREADY ahead of upstream BEFORE this sync.
  // If so, pushing would publish those unrelated commits, so we must not push
  // this cycle — only a commit THIS sync creates may be pushed.
  let wasAheadBeforeSync = false;
  if (upstream !== null) {
    const ahead = await tryGit(gitRoot, ['rev-list', '@{u}..HEAD']);
    wasAheadBeforeSync = !!ahead && ahead.trim().length > 0;

    // 1. Reconcile FIRST — fast-forward-pull upstream BEFORE committing, so the
    // local commit lands on top of upstream and can ff-push. Committing first
    // would diverge a two-writer branch and wedge `--ff-only`.
    result.pulled = (await tryGit(gitRoot, ['pull', '--ff-only'])) !== null;
    if (!result.pulled) {
      // ff refused (diverged) or a transient error — nothing can be shared this
      // cycle. Skip cleanly WITHOUT committing, leaving the working tree as-is.
      result.skippedReason = 'pull-failed';
      return result;
    }
  }

  // 2. Commit local team-memory changes (only the team path) on top of upstream.
  const status = await tryGit(gitRoot, [
    'status',
    '--porcelain',
    '--',
    relPath,
  ]);
  if (status && status.trim().length > 0) {
    const staged = (await tryGit(gitRoot, ['add', '--', relPath])) !== null;
    const commitArgs = ['commit', '-m', opts.message];
    if (opts.author) {
      const email = opts.author.email ?? `${opts.author.name}@users.noreply`;
      commitArgs.push('--author', `${opts.author.name} <${email}>`);
    }
    commitArgs.push('--', relPath);
    result.committed = (await tryGit(gitRoot, commitArgs)) !== null;
    if (!result.committed && staged) {
      // Commit failed (hook/GPG/missing user.email — tryGit swallowed it).
      // Unstage the team paths so a user's next manual `git commit` does not
      // sweep them in; the working tree is left exactly as it was.
      await tryGit(gitRoot, ['reset', '--quiet', '--', relPath]);
    }
  }

  // 3. Push — only when an upstream exists, THIS sync created the commit, and the
  // branch was not already ahead (never publish unrelated local commits).
  if (upstream === null) {
    result.skippedReason = 'no-upstream';
    return result;
  }
  if (!result.committed) {
    return result; // nothing of ours to share this cycle
  }
  if (wasAheadBeforeSync) {
    result.skippedReason = 'local-ahead';
    return result;
  }
  const pushTarget = await resolvePushTarget(gitRoot);
  if (!pushTarget) {
    result.skippedReason = 'push-failed';
    return result;
  }
  // Explicit single-branch refspec — never an unqualified `git push`.
  result.pushed =
    (await tryGit(gitRoot, [
      'push',
      pushTarget.remote,
      `HEAD:${pushTarget.mergeRef}`,
    ])) !== null;
  if (!result.pushed) {
    result.skippedReason = 'push-failed';
  }
  return result;
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen autofix-pr push`: send the worktree's commits to the PR branch. Only
// a fast-forward of the head the watch knows goes out, with a lease on that
// head, so a push from anyone else in the meantime turns into `resync`
// instead of being overwritten. Pre-push hooks run; nothing is forced.

import type { CommandModule } from 'yargs';
import { execFileSync } from 'node:child_process';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { ensureAuthenticated, gh, setGhHost } from '../review/lib/gh.js';
import { git } from '../review/lib/git.js';
import { pushTargetFor } from './prepare.js';
import {
  MAX_PUSHES,
  assertWatching,
  TASK_OPTION,
  taskArg,
  autofixPrPaths,
  isBranchName,
  isCommandSafeName,
  trustAnchor,
  resolveWatchRoot,
  requireState,
  withWatchLock,
  writeState,
  type AutofixPrPaths,
  type AutofixPrState,
} from './state.js';
import { assertNoFixInFlight } from './fix.js';
import {
  hasUncommittedChanges,
  isAncestor,
  networkGitEnv,
  remoteRef,
  requireWorktree,
} from './worktree.js';

/**
 * Pre-push hooks may run a test suite; the 2-minute git default is short.
 * Nine minutes ends the push inside the shell tool's longest timeout (ten),
 * so the helper still records what happened.
 */
const PUSH_TIMEOUT_MS = 9 * 60_000;

interface LivePr {
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  headRefName: string;
  baseRefName: string;
  isCrossRepository: boolean;
  headRepository: { name: string } | null;
  headRepositoryOwner: { login: string } | null;
}

/**
 * Asks GitHub for the PR and, while it is open, checks that its head branch
 * and the destination of pushes to it — found from this clone's remotes the
 * way `prepare` found them — are still the ones the state file names. The
 * state file alone must not redirect a push, nor a fetch into the worktree.
 */
export function liveDestination(
  state: AutofixPrState,
  prNumber: number,
): LivePr {
  setGhHost(state.host);
  ensureAuthenticated();
  const live = JSON.parse(
    gh(
      'pr',
      'view',
      String(prNumber),
      '-R',
      `${state.owner}/${state.repo}`,
      '--json',
      'state,headRefName,baseRefName,isCrossRepository,headRepository,headRepositoryOwner',
    ),
  ) as LivePr;
  if (live.state !== 'OPEN') return live;
  if (!live.headRepository || !live.headRepositoryOwner) {
    throw new Error(`PR #${prNumber}'s head repository no longer exists.`);
  }
  if (live.headRefName !== state.headRefName) {
    throw new Error(
      `PR #${prNumber}'s head branch is ${live.headRefName}, not the ${state.headRefName} this watch was prepared for.`,
    );
  }
  const target = pushTargetFor(
    git('remote', '-v'),
    state.host,
    live.headRepositoryOwner.login,
    live.headRepository.name,
  );
  if (target !== state.pushTarget) {
    throw new Error(
      `pushes to PR #${prNumber}'s head repository now go to ${target}, not the ${state.pushTarget} this watch was prepared with; ` +
        `run \`qwen autofix-pr cleanup ${prNumber}\` and prepare it again.`,
    );
  }
  return live;
}

/**
 * The state with the base branch GitHub names now: a PR can be retargeted
 * while a watch runs, and the round's brief merges the recorded base.
 */
export function withLiveBase(
  state: AutofixPrState,
  live: LivePr,
  prNumber: number,
): AutofixPrState {
  if (live.state !== 'OPEN' || live.baseRefName === state.baseRefName) {
    return state;
  }
  if (!isBranchName(live.baseRefName) || !isCommandSafeName(live.baseRefName)) {
    throw new Error(
      `PR #${prNumber}'s base branch is now ${JSON.stringify(live.baseRefName)}, which cannot be named in a command as it is.`,
    );
  }
  return { ...state, baseRefName: live.baseRefName };
}

export interface PushOutcome {
  pushed: boolean;
  /** What the skill does next when nothing was pushed. */
  action?: 'resync' | 'stop';
  sha?: string;
  pushes?: number;
  maxPushes?: number;
  reason?: string;
}

/**
 * One porcelain line of `git push --porcelain` per ref: `<flag>\t<from>:<to>\t<summary>`.
 * A lease that no longer holds is reported as `[rejected] (stale info)`.
 */
export function leaseRejected(porcelain: string): boolean {
  return porcelain
    .split('\n')
    .some((line) => line.startsWith('!\t') && line.includes('(stale info)'));
}

/** Whether the branch on the remote is no longer `known` (or is gone). */
export function remoteHeadMoved(
  worktreePath: string,
  target: string,
  headRef: string,
  known: string,
): boolean {
  const remote = remoteHead(worktreePath, target, headRef);
  return remote !== undefined && remote !== known;
}

/**
 * The branch's commit on the remote: `null` when the branch is gone,
 * `undefined` when the remote could not be asked.
 */
function remoteHead(
  worktreePath: string,
  target: string,
  headRef: string,
): string | null | undefined {
  return remoteRef(target, `refs/heads/${headRef}`, worktreePath);
}

function pushRef(
  worktreePath: string,
  target: string,
  sha: string,
  headRef: string,
  expected: string,
): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      'git',
      [
        '-C',
        worktreePath,
        'push',
        '--porcelain',
        // Only the one ref: `push.followTags` would send the annotated tags
        // the commit reaches, `push.recurseSubmodules` submodule branches.
        '--no-follow-tags',
        '--recurse-submodules=no',
        target,
        // The commit that was checked, not `HEAD`: the worktree may move
        // while GitHub is asked, and the lease alone would let a commit
        // that does not build on the known head through.
        `${sha}:refs/heads/${headRef}`,
        `--force-with-lease=refs/heads/${headRef}:${expected}`,
      ],
      {
        encoding: 'utf8',
        timeout: PUSH_TIMEOUT_MS,
        // A hook that runs a test suite prints more than the 1 MiB default.
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: networkGitEnv(),
      },
    );
    return { ok: true, stdout, stderr: '' };
  } catch (err) {
    const { stdout, stderr } = err as { stdout?: unknown; stderr?: unknown };
    return {
      ok: false,
      stdout: typeof stdout === 'string' ? stdout : '',
      stderr:
        typeof stderr === 'string' ? stderr : ((err as Error).message ?? ''),
    };
  }
}

export function runPush(prNumber: number, task?: string): PushOutcome {
  const root = resolveWatchRoot(prNumber);
  const paths = autofixPrPaths(root, prNumber);
  return withWatchLock(paths, prNumber, () =>
    pushLocked(paths, prNumber, root, task),
  );
}

function pushLocked(
  paths: AutofixPrPaths,
  prNumber: number,
  root: string,
  task: string | undefined,
): PushOutcome {
  const state = requireState(paths.statePath, prNumber);
  assertWatching(state, task);
  assertNoFixInFlight(paths, prNumber);
  const worktree = paths.worktreePath;
  requireWorktree(paths, prNumber, root, false, trustAnchor(state));
  if (hasUncommittedChanges(worktree)) {
    throw new Error(
      `${worktree} has uncommitted changes; commit them, or discard what should not be pushed, before pushing.`,
    );
  }
  const head = git('-C', worktree, 'rev-parse', 'HEAD');
  const known = state.lastKnownHeadSha;
  if (head === known) {
    return { pushed: false, reason: 'nothing to push: HEAD is the PR head' };
  }
  if (!isAncestor(worktree, known, head)) {
    throw new Error(
      `HEAD ${head.slice(0, 12)} does not build on the PR head ${known.slice(0, 12)}; autofix never rewrites a PR's history. ` +
        `Merge the PR head into the worktree instead of rebasing.`,
    );
  }
  const pushes = state.pushCount ?? 0;
  if (pushes >= MAX_PUSHES) {
    return {
      pushed: false,
      action: 'stop',
      pushes,
      maxPushes: MAX_PUSHES,
      reason: `this watch has used its ${MAX_PUSHES} pushes`,
    };
  }

  const live = liveDestination(state, prNumber);
  if (live.state !== 'OPEN') {
    return {
      pushed: false,
      action: 'stop',
      reason: `PR #${prNumber} is ${live.state.toLowerCase()}`,
    };
  }
  const current = withLiveBase(state, live, prNumber);
  const slug = `${state.owner}/${state.repo}`;
  // Asked at push time, not trusted from `prepare`: the default branch can
  // be renamed while a watch runs.
  if (!live.isCrossRepository) {
    const defaultBranch = gh(
      'repo',
      'view',
      slug,
      '--json',
      'defaultBranchRef',
      '--jq',
      '.defaultBranchRef.name',
    );
    if (state.headRefName === defaultBranch) {
      throw new Error(
        `PR #${prNumber}'s head is the default branch (${defaultBranch}); autofix never pushes there.`,
      );
    }
  }

  // A commit the remote holds already was not pushed by this watch — the
  // worktree was moved onto someone else's push — so it is adopted through
  // `sync`, never recorded as a push (git would answer it "up to date").
  if (remoteHead(worktree, state.pushTarget, state.headRefName) === head) {
    return {
      pushed: false,
      action: 'resync',
      reason: `the PR branch already holds ${head.slice(0, 12)}: it was pushed from elsewhere`,
    };
  }
  const result = pushRef(
    worktree,
    state.pushTarget,
    head,
    state.headRefName,
    known,
  );
  // A push whose answer was lost (the connection dropped after the remote
  // took it) is a push: the remote already holds the commit.
  const landed =
    !result.ok &&
    remoteHead(worktree, state.pushTarget, state.headRefName) === head;
  if (!result.ok && !landed) {
    // The porcelain summary is one witness; asking the remote is the other,
    // and does not depend on the language git prints in.
    if (
      leaseRejected(result.stdout) ||
      remoteHeadMoved(worktree, state.pushTarget, state.headRefName, known)
    ) {
      return {
        pushed: false,
        action: 'resync',
        reason: `the PR head is no longer ${known.slice(0, 12)}: someone else pushed`,
      };
    }
    const detail = (result.stderr || result.stdout).trim().split('\n');
    throw new Error(
      `git push to ${state.headRefName} failed:\n${detail.slice(-20).join('\n')}`,
    );
  }

  writeState(paths.statePath, {
    ...current,
    lastKnownHeadSha: head,
    pushedShas: [...state.pushedShas, head],
    pushCount: pushes + 1,
  });
  return {
    pushed: true,
    sha: head,
    pushes: pushes + 1,
    maxPushes: MAX_PUSHES,
  };
}

export const pushCommand: CommandModule = {
  command: 'push <pr>',
  describe:
    "Push the worktree's commits to the PR branch: fast-forward only, leased on the known head, never to the default branch",
  builder: (yargs) =>
    yargs
      .positional('pr', {
        type: 'number',
        demandOption: true,
        describe: 'PR number',
      })
      .option('task', TASK_OPTION),
  handler: (argv) => {
    writeStdoutLine(JSON.stringify(runPush(Number(argv['pr']), taskArg(argv))));
  },
};

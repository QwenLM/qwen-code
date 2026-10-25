/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The checks every helper that writes from the autofix worktree makes first.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { GIT_TIMEOUT_MS, gitOpt, gitProbe } from '../review/lib/git.js';
import { redirectedAncestor, sanitizedGitEnv } from '../review/lib/worktree.js';
import type { AutofixPrPaths } from './state.js';

function isBrokenLink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Why the worktree's `.git` is not to be trusted, or null. It is a file a
 * round's code can rewrite: pointed at a git directory that code built,
 * every git command in the worktree would read that directory's config, and
 * a `core.fsmonitor` command there runs on the next `git status`. So before
 * any git command in the worktree, the file must name this clone's own
 * admin entry for a worktree, and that entry must point back at it. Read
 * from the files, not asked of git, which would read the config in
 * question; `root` is the clone's main worktree, whose git is the user's.
 */
export function untrustedGitfile(
  worktreePath: string,
  root: string,
): string | null {
  const dotGit = join(worktreePath, '.git');
  // None at all: git walks up to the clone itself, the user's own, and the
  // caller's own check finds the directory is no worktree.
  if (!existsSync(dotGit) && !isBrokenLink(dotGit)) return null;
  let text: string;
  try {
    if (!lstatSync(dotGit).isFile()) {
      return `${dotGit} is not the gitfile of a linked worktree`;
    }
    text = readFileSync(dotGit, 'utf8');
  } catch {
    return `${dotGit} cannot be read`;
  }
  const pointer = /^gitdir: *(.+?)\s*$/m.exec(text)?.[1];
  if (!pointer) return `${dotGit} names no git directory`;
  const common = gitOpt('-C', root, 'rev-parse', '--git-common-dir');
  if (common === null) return `git cannot find the git directory of ${root}`;
  try {
    const entry = realpathSync(resolve(worktreePath, pointer));
    const entries = realpathSync(join(resolve(root, common), 'worktrees'));
    if (dirname(entry) !== entries) {
      return `${dotGit} points to ${pointer}, not to this clone's own entry for a worktree`;
    }
    const back = readFileSync(join(entry, 'gitdir'), 'utf8').trim();
    if (realpathSync(resolve(entry, back)) !== realpathSync(dotGit)) {
      return `${dotGit} points to ${entry}, the entry of another worktree`;
    }
  } catch {
    return `${dotGit} points to ${pointer}, which is not this clone's entry for it`;
  }
  return null;
}

/**
 * Throws unless the watch's worktree is a git worktree of its own, at its
 * own path, with the watch's branch checked out. Inside a directory that is
 * not a worktree, git finds the enclosing clone; through a symlink — the
 * worktree's own path or a directory above it, up to the clone's `root` —
 * another checkout; on another branch — the user's copy of the PR branch,
 * say — a push would publish that branch's commits and a reset would
 * discard them.
 */
export function requireWorktree(
  paths: AutofixPrPaths,
  prNumber: number,
  root: string,
  switchBack = false,
): void {
  const worktreePath = paths.worktreePath;
  if (!existsSync(worktreePath)) {
    throw new Error(
      `${worktreePath} does not exist; run \`qwen autofix-pr prepare ${prNumber} --repo <owner>/<repo>\` to recreate it.`,
    );
  }
  if (lstatSync(worktreePath).isSymbolicLink()) {
    throw new Error(`${worktreePath} is a symlink, not the watch's worktree.`);
  }
  const redirected = redirectedAncestor(worktreePath, root);
  if (redirected !== null) {
    throw new Error(
      `${worktreePath} resolves through the symlink ${redirected}; it is not the watch's worktree.`,
    );
  }
  const untrusted = untrustedGitfile(worktreePath, root);
  if (untrusted !== null) {
    throw new Error(
      `${untrusted}: no git command runs in ${worktreePath} until the worktree is checked and removed.`,
    );
  }
  const top = gitOpt('-C', worktreePath, 'rev-parse', '--show-toplevel');
  if (top === null || realpathSync(top) !== realpathSync(worktreePath)) {
    throw new Error(`${worktreePath} is not a git worktree.`);
  }
  const branch = gitOpt('-C', worktreePath, 'symbolic-ref', '-q', 'HEAD');
  // Ending a round may take the worktree back to the watch's branch from
  // one a fix switched to: that branch keeps its commits, and what is not
  // committed is discarded anyway. A merge, rebase or cherry-pick a fix
  // left stopped refuses the switch (a rebase holds HEAD detached), so it is
  // quit first; none of these touches a branch.
  if (branch !== `refs/heads/${paths.branch}` && switchBack) {
    for (const quit of [
      ['merge', '--quit'],
      ['rebase', '--quit'],
      ['cherry-pick', '--quit'],
      ['revert', '--quit'],
      ['am', '--quit'],
    ]) {
      gitProbe('-C', worktreePath, ...quit);
    }
  }
  if (
    branch !== `refs/heads/${paths.branch}` &&
    switchBack &&
    gitOpt(
      '-c',
      'submodule.recurse=false',
      '-C',
      worktreePath,
      'switch',
      '--quiet',
      '--discard-changes',
      paths.branch,
    ) !== null
  ) {
    return;
  }
  if (branch !== `refs/heads/${paths.branch}`) {
    throw new Error(
      `${worktreePath} has ${branch ? branch.replace(/^refs\/heads\//, 'branch ') : 'a detached HEAD'} checked out, not ${paths.branch}; switch it back before pushing or syncing.`,
    );
  }
}

/**
 * What the user's own `git fetch` and `git push` connect and authenticate
 * with — an ssh command, an askpass helper, the global config holding a
 * credential helper — which `sanitizedGitEnv` drops for every other call.
 */
const USER_TRANSPORT_ENV = [
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_ASKPASS',
  'GIT_PROXY_COMMAND',
  'GIT_CONFIG_GLOBAL',
  'XDG_CONFIG_HOME',
];

/** The environment of a git call that reaches a remote, as the user would. */
export function networkGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...sanitizedGitEnv(),
    GIT_TERMINAL_PROMPT: '0',
  };
  for (const key of USER_TRANSPORT_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Runs a git command that reaches a remote; throws when it fails. */
export function networkGit(args: string[]): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: networkGitEnv(),
  }).trim();
}

/**
 * The commit `ref` names on `target`, from `git ls-remote`: undefined when
 * the remote cannot be read, null when it has no such ref. Only the line of
 * `ref` itself counts: ls-remote matches the tail of a ref name, so asking
 * for `refs/heads/x` also lists `refs/heads/a/refs/heads/x`, which may sort
 * first.
 */
export function remoteRef(
  target: string,
  ref: string,
  cwd?: string,
): string | null | undefined {
  let listed: string;
  try {
    listed = networkGit([
      ...(cwd ? ['-C', cwd] : []),
      'ls-remote',
      target,
      ref,
    ]);
  } catch {
    return undefined;
  }
  for (const line of listed.split('\n')) {
    const [sha, name] = line.split('\t');
    if (name === ref && sha) return sha;
  }
  return null;
}

/**
 * Whether the worktree has anything uncommitted, untracked files included
 * whatever `status.showUntrackedFiles` says.
 */
export function hasUncommittedChanges(worktreePath: string): boolean {
  const status = gitOpt(
    '-C',
    worktreePath,
    'status',
    '--porcelain',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  );
  if (status === null) throw new Error(`git cannot read ${worktreePath}`);
  return status !== '';
}

/**
 * Whether `ancestor` is an ancestor of (or equal to) `descendant`, asked in
 * the worktree. Exit 1 is git's "no"; anything else means it could not tell.
 */
export function isAncestor(
  worktreePath: string,
  ancestor: string,
  descendant: string,
): boolean {
  const { status } = gitProbe(
    '-C',
    worktreePath,
    'merge-base',
    '--is-ancestor',
    ancestor,
    descendant,
  );
  if (status === 0) return true;
  if (status === 1) return false;
  throw new Error(
    `git cannot compare ${ancestor.slice(0, 12)} with ${descendant.slice(0, 12)} in ${worktreePath}`,
  );
}

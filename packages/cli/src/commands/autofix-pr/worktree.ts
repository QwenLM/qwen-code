/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The checks every helper that writes from the autofix worktree makes first.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { GIT_TIMEOUT_MS, gitOpt, gitProbe, gitRaw } from '../review/lib/git.js';
import { redirectedAncestor, sanitizedGitEnv } from '../review/lib/worktree.js';
import type { AutofixPrPaths } from './state.js';

/**
 * Why the worktree's `.git` is not to be trusted, or null. It is a file a
 * round's code can rewrite: pointed at a git directory that code built,
 * every git command in the worktree would read that directory's config, and
 * a `core.fsmonitor` command there runs on the next `git status`. So before
 * any git command in the worktree, the file must name this clone's own
 * admin entry for a worktree, and that entry must point back at it. Read
 * from the files, not asked of git, which would read the config in
 * question; `root` is the genuine clone (its main worktree), whose git is the
 * user's — never a linked worktree the calling round could repoint at a
 * replacement repository, which would vouch for itself.
 */
export function untrustedGitfile(
  worktreePath: string,
  root: string,
): string | null {
  const dotGit = join(worktreePath, '.git');
  let text: string;
  try {
    if (!lstatSync(dotGit).isFile()) {
      return `${dotGit} is not the gitfile of a linked worktree`;
    }
    text = readFileSync(dotGit, 'utf8');
  } catch {
    // None: git walks up, and finds a git directory a round's code may have
    // planted beside the worktree, naming it as its `core.worktree`.
    return `${worktreePath} is not a git worktree: it has no gitfile of its own`;
  }
  const pointer = gitfilePointer(text);
  if (typeof pointer !== 'string') return `${dotGit} ${pointer.refused}`;
  const common = gitOpt('-C', root, 'rev-parse', '--git-common-dir');
  if (common === null) return `git cannot find the git directory of ${root}`;
  try {
    const entry = asGitNames(worktreePath, pointer);
    const entries = realpathSync.native(
      join(resolve(root, common), 'worktrees'),
    );
    if (dirname(entry) !== entries) {
      return `${dotGit} points to ${pointer}, not to this clone's own entry for a worktree`;
    }
    const back = readFileSync(join(entry, 'gitdir'), 'utf8').replace(
      /[\r\n]+$/,
      '',
    );
    if (asGitNames(entry, back) !== realpathSync.native(dotGit)) {
      return `${dotGit} points to ${entry}, the entry of another worktree`;
    }
  } catch {
    return `${dotGit} points to ${pointer}, which is not this clone's entry for it`;
  }
  return null;
}

/**
 * Why an in-place watch's checkout — the user's own, which may be the
 * clone's main worktree — is not to be trusted, or null. A linked worktree
 * is judged by `untrustedGitfile` as ever; the main worktree has a `.git`
 * directory instead of a gitfile, and that directory must be this clone's
 * own git directory, compared as the kernel resolves the paths — no git
 * command runs in the checkout, which would read the config in question.
 * `root` is the genuine clone (its main worktree), as for `untrustedGitfile`.
 */
export function untrustedCheckoutGit(
  worktreePath: string,
  root: string,
): string | null {
  const dotGit = join(worktreePath, '.git');
  const kind = lstatSync(dotGit, { throwIfNoEntry: false });
  if (!kind) return `${worktreePath} has no .git of its own`;
  if (kind.isFile()) return untrustedGitfile(worktreePath, root);
  if (!kind.isDirectory()) {
    return `${dotGit} is neither a gitfile nor a git directory`;
  }
  const common = gitOpt('-C', root, 'rev-parse', '--git-common-dir');
  if (common === null) return `git cannot find the git directory of ${root}`;
  try {
    if (
      realpathSync.native(dotGit) !== realpathSync.native(resolve(root, common))
    ) {
      return `${dotGit} is not the git directory of this clone`;
    }
  } catch {
    return `${dotGit} names a git directory this check cannot read`;
  }
  return null;
}

/**
 * Why a checked-out submodule of the worktree could hand git a config the
 * tree controls, or null: `git status --ignore-submodules=none` goes into
 * every submodule with that submodule's own config. Each `.git` there must
 * be a gitfile naming a git directory inside the clone's own, where `git
 * submodule` keeps them — one embedded in the submodule, or anywhere else
 * a round's code can write, is not. Call it once `untrustedGitfile` passed:
 * it lists the submodules with git, in the worktree.
 */
export function untrustedSubmodules(
  worktreePath: string,
  root: string,
): string | null {
  const common = gitOpt('-C', root, 'rev-parse', '--git-common-dir');
  if (common === null) return `git cannot find the git directory of ${root}`;
  try {
    return untrustedSubmodulesIn(
      worktreePath,
      realpathSync.native(resolve(root, common)),
      0,
    );
  } catch {
    return `the submodules of ${worktreePath} cannot be checked`;
  }
}

/**
 * The path a gitfile names, read as git reads it (setup.c,
 * read_gitfile_gently): the file starts with `gitdir: `, one space, and the
 * path is the rest of it, less the line breaks that end it — spaces and
 * all. Any other reading could pass a path git resolves elsewhere, inside
 * the worktree.
 */
function gitfilePointer(text: string): string | { refused: string } {
  if (!text.startsWith('gitdir: ')) {
    return { refused: 'is not a gitfile git reads' };
  }
  const pointer = text.slice('gitdir: '.length).replace(/[\r\n]+$/, '');
  if (pointer === '' || pointer.includes('\0') || /[\r\n]/.test(pointer)) {
    return { refused: 'names no git directory git and this check read alike' };
  }
  return pointer;
}

/**
 * Resolved as the kernel resolves what git hands it: symlinks first, a `..`
 * after the link it follows. A lexical resolve() reads `link/..`
 * differently, so the joined string goes to the native realpath as is.
 */
function asGitNames(base: string, named: string): string {
  return realpathSync.native(
    isAbsolute(named) ? named : `${base}${sep}${named}`,
  );
}

/** Refuses a path that is not UTF-8, which a lossy read would rename. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true });

/** Deep enough for any real nesting; deeper is refused, not trusted. */
const MAX_SUBMODULE_DEPTH = 8;

/**
 * Why a checked-out submodule under `dir` could hand git a config the tree
 * controls, or null. Each one's `.git` must be a gitfile naming a git
 * directory inside the clone's own (`common`), where `git submodule` keeps
 * them — never one inside the worktree, which a round's code can build —
 * and so on for the submodules of each.
 */
function untrustedSubmodulesIn(
  dir: string,
  common: string,
  depth: number,
): string | null {
  // The bytes as git wrote them, however many: a path may hold a CR or an
  // LF, which a line-normalising read would turn into another path, and an
  // index runs past the default 1 MiB of output in a large repository.
  let listed: string;
  try {
    listed = STRICT_UTF8.decode(gitRaw('-C', dir, 'ls-files', '--stage', '-z'));
  } catch {
    return `git cannot list the files of ${dir} as paths this check reads exactly`;
  }
  for (const record of listed.split('\0')) {
    // `<mode> <object> <stage>\t<path>`; 160000 is a submodule.
    if (!record.startsWith('160000 ')) continue;
    const path = record.slice(record.indexOf('\t') + 1);
    const sub = join(dir, path);
    const dotGit = join(sub, '.git');
    const kind = (file: string) => {
      try {
        return lstatSync(file);
      } catch (error) {
        // Absent — not checked out — is the one answer git also skips.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    };
    let text: string;
    try {
      const subStat = kind(sub);
      if (subStat === null) continue;
      if (subStat.isSymbolicLink()) {
        return `the submodule ${sub} is a symlink`;
      }
      const gitStat = kind(dotGit);
      if (gitStat === null) continue;
      if (!gitStat.isFile()) {
        return `${dotGit} is not the gitfile of a submodule the clone keeps`;
      }
      text = readFileSync(dotGit, 'utf8');
    } catch {
      return `the submodule ${sub} cannot be read`;
    }
    const pointer = gitfilePointer(text);
    if (typeof pointer !== 'string') return `${dotGit} ${pointer.refused}`;
    let entry: string;
    try {
      entry = asGitNames(sub, pointer);
    } catch {
      return `${dotGit} points to ${pointer}, which does not exist`;
    }
    const inside = relative(common, entry);
    if (
      inside === '' ||
      inside.startsWith(`..${sep}`) ||
      inside === '..' ||
      isAbsolute(inside)
    ) {
      return `${dotGit} points to ${pointer}, outside the clone's own git directory`;
    }
    if (depth + 1 >= MAX_SUBMODULE_DEPTH) {
      return `the submodules under ${dir} nest too deep to check`;
    }
    const nested = untrustedSubmodulesIn(sub, common, depth + 1);
    if (nested !== null) return nested;
  }
  return null;
}

/**
 * Throws unless the watch's worktree is a git worktree of its own, at its
 * own path, with the watch's branch checked out. Inside a directory that is
 * not a worktree, git finds the enclosing clone; through a symlink — the
 * worktree's own path or a directory above it, up to `root` — another
 * checkout; on another branch — the user's copy of the PR branch, say — a
 * push would publish that branch's commits and a reset would discard them.
 *
 * `root` is the watch's root worktree, the stop of the symlink walk. `trustRoot`
 * is the genuine clone the gitfile is validated against — the clone's main
 * worktree (`repoRoot()`), the stable identity of the clone, never a linked
 * worktree a round could repoint at a replacement repository. They differ
 * whenever a watch is rooted in a linked worktree, so the trust anchor is a
 * separate parameter, not `root`. This is defense-in-depth against the
 * git-level gitfile rewrite, not a boundary against a round that can write any
 * same-user file (see `anchorStoreRoot` in state.ts).
 *
 * `inPlace` marks the user's own checkout (`prepare --in-place`): the git
 * trust check accepts the clone's main worktree too, and `switchBack` is
 * never honored — a checkout on another branch is the user's to switch back.
 */
export function requireWorktree(
  paths: AutofixPrPaths,
  prNumber: number,
  root: string,
  switchBack = false,
  trustRoot: string = root,
  inPlace = false,
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
  const untrusted = inPlace
    ? untrustedCheckoutGit(worktreePath, trustRoot)
    : untrustedGitfile(worktreePath, trustRoot);
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
  // quit first; none of these touches a branch. Never in the user's own
  // checkout (`inPlace`): switching it is the user's to do.
  if (branch !== `refs/heads/${paths.branch}` && switchBack && !inPlace) {
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
    !inPlace &&
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
 * Whether a checkout holds work git reports, or null when git cannot read it.
 * The flags override `status.showUntrackedFiles` and submodule `ignore`
 * settings, as this directory's other scans do. Only `.qwen` is the watch's:
 * anything beside its `tmp` directory under there is the user's work. An
 * in-place watch's checkout holds the watch's own files under `.qwen/tmp`,
 * so its dirty checks use this, not `hasUncommittedChanges`.
 */
export function checkoutHoldsWork(path: string): boolean | null {
  // -z: porcelain v1 C-quotes a non-ASCII path, and a quoted `.qwen/tmp`
  // watch file would read as the user's work. NUL-delimited records carry
  // the path as git stores it; a rename's old path is its own record and,
  // not starting `??`, still counts as work.
  const status = gitOpt(
    '--no-optional-locks',
    '-C',
    path,
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  );
  if (status === null) return null;
  const records = status.split('\0').filter((record) => record !== '');
  const onlyWatchDir = (record: string) =>
    record.startsWith('??') && isUnderQwen(record.slice(3));
  if (records.some((record) => !onlyWatchDir(record))) return true;
  if (records.length === 0) return false;
  // Only `.qwen` is untracked: ask what it holds besides the watch's `tmp`.
  const userFiles = gitOpt(
    '--no-optional-locks',
    '-C',
    path,
    'ls-files',
    '--others',
    '--exclude-standard',
    '--',
    '.qwen',
    ':(exclude).qwen/tmp',
  );
  if (userFiles === null) return null;
  return userFiles.trim() !== '';
}

/** A porcelain path at or under `.qwen`. */
function isUnderQwen(file: string): boolean {
  return file === '.qwen' || file.startsWith('.qwen/');
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

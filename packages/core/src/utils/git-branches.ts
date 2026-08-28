/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { isValidGitSha, isValidRefName } from './gitDirect.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const MAX_RECENT_BRANCHES = 20;
const MAX_REFLOG_ENTRIES = 200;

export interface GitBranchInfo {
  name: string;
  isHead: boolean;
  upstream?: string;
  ahead: number;
  behind: number;
  /** Unix epoch seconds of the branch tip commit. */
  commitDate: number;
  commitSubject: string;
}

export interface GitTagInfo {
  name: string;
  /** Unix epoch seconds of the tag (annotated) or tagged commit (lightweight). */
  date: number;
  subject: string;
}

export interface GitBranchesResult {
  local: GitBranchInfo[];
  remote: GitBranchInfo[];
  tags: GitTagInfo[];
  recent: string[];
  head: string;
  detached: boolean;
}

// Repository-shifting variables that a daemon process may inherit from its
// launch environment.  Clearing them prevents a trusted workspace request
// from operating on a completely different repository despite the resolved
// `cwd`.
const GIT_ENV_VARS_TO_CLEAR = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  'GIT_CONFIG_NOSYSTEM',
  // Repository selectors that an inherited daemon environment could use to
  // redirect a trusted-workspace git/gh invocation to a different repository
  // or object database despite the resolved cwd.
  'GH_REPO',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
];

// Command-scope config injection uses numbered GIT_CONFIG_KEY_<n> /
// GIT_CONFIG_VALUE_<n> pairs (an inherited `url.<base>.insteadOf` can retarget
// a clone/push). The index count is unbounded, so strip them by prefix.
const GIT_ENV_PREFIXES_TO_CLEAR = ['GIT_CONFIG_KEY_', 'GIT_CONFIG_VALUE_'];

export function gitEnv(
  base?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const env = { ...(base ?? process.env) };
  for (const key of GIT_ENV_VARS_TO_CLEAR) {
    delete env[key];
  }
  for (const key of Object.keys(env)) {
    if (GIT_ENV_PREFIXES_TO_CLEAR.some((prefix) => key.startsWith(prefix))) {
      delete env[key];
    }
  }
  env['LC_ALL'] = 'C';
  env['LANG'] = 'C';
  return env;
}

function runGit(
  cwd: string,
  args: string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  return execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: gitEnv(env),
  }).then(({ stdout }) => stdout);
}

const SEPARATOR = '\x00';

/**
 * List all local branches, remote branches, tags, and recent branches for
 * the repository at `cwd`. Uses `git for-each-ref` for structured output and
 * `git reflog` for recency.
 */
export async function fetchGitBranches(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitBranchesResult> {
  // Defining probe: fail fast with a clear error when `cwd` is not inside a
  // git repository, instead of letting every individual query swallow its
  // error and returning an empty-but-"available" result.
  await runGit(cwd, ['rev-parse', '--git-dir'], env);

  const [localRaw, remoteRaw, tagsRaw, headRaw, reflogRaw] = await Promise.all([
    runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)%00%(symref)',
        'refs/heads/',
      ],
      env,
    ).catch(() => ''),
    runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)%00%(symref)',
        'refs/remotes/',
      ],
      env,
    ).catch(() => ''),
    runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)%00%(creatordate:unix)%00%(subject)',
        '--sort=-creatordate',
        'refs/tags/',
      ],
      env,
    ).catch(() => ''),
    runGit(cwd, ['symbolic-ref', '--short', 'HEAD'], env).catch(() => ''),
    runGit(
      cwd,
      ['reflog', 'show', '--format=%gs', `-${MAX_REFLOG_ENTRIES}`],
      env,
    ).catch(() => ''),
  ]);

  const local = parseBranchLines(localRaw);
  const remote = parseBranchLines(remoteRaw);
  const tags = parseTagLines(tagsRaw);
  const recent = parseRecentBranches(reflogRaw, headRaw.trim());

  const headTrimmed = headRaw.trim();
  const detached = !headTrimmed;

  return {
    local,
    remote,
    tags,
    recent,
    head: headTrimmed || (await getDetachedHead(cwd, env)),
    detached,
  };
}

function parseBranchLines(raw: string): GitBranchInfo[] {
  if (!raw.trim()) return [];
  return (
    raw
      .trim()
      .split('\n')
      .filter(Boolean)
      // Filter symbolic refs (e.g. origin/HEAD → origin/main) by their symref
      // target rather than by a /HEAD name suffix, which would also remove
      // legitimate user branches like feature/HEAD.
      .filter((line) => {
        const parts = line.split(SEPARATOR);
        return !(parts[6] ?? '');
      })
      .map((line) => {
        const parts = line.split(SEPARATOR);
        const name = parts[0] ?? '';
        const isHead = parts[1] === '*';
        const upstream = parts[2] || undefined;
        const track = parts[3] ?? '';
        const commitDate = parseInt(parts[4] ?? '0', 10) || 0;
        const commitSubject = parts[5] ?? '';

        let ahead = 0;
        let behind = 0;
        const aheadMatch = /ahead (\d+)/.exec(track);
        const behindMatch = /behind (\d+)/.exec(track);
        if (aheadMatch) ahead = parseInt(aheadMatch[1], 10);
        if (behindMatch) behind = parseInt(behindMatch[1], 10);

        return {
          name,
          isHead,
          upstream,
          ahead,
          behind,
          commitDate,
          commitSubject,
        };
      })
  );
}

function parseTagLines(raw: string): GitTagInfo[] {
  if (!raw.trim()) return [];
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(SEPARATOR);
      return {
        name: parts[0] ?? '',
        date: parseInt(parts[1] ?? '0', 10) || 0,
        subject: parts[2] ?? '',
      };
    });
}

function parseRecentBranches(reflogRaw: string, currentHead: string): string[] {
  if (!reflogRaw.trim()) return [];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const line of reflogRaw.trim().split('\n')) {
    // reflog messages for checkouts look like:
    //   "checkout: moving from X to Y"
    if (!line.startsWith('checkout: moving from ')) continue;
    const idx = line.indexOf(' to ');
    if (idx === -1) continue;
    const branch = line.slice(idx + 4);
    if (
      branch &&
      !seen.has(branch) &&
      branch !== currentHead &&
      !/^[0-9a-f]{7,40}$/.test(branch)
    ) {
      seen.add(branch);
      result.push(branch);
      if (result.length >= MAX_RECENT_BRANCHES) break;
    }
  }
  return result;
}

async function getDetachedHead(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  try {
    const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], env);
    return sha.trim();
  } catch {
    return '';
  }
}

/**
 * Whether `value` is safe to pass to git as a checkout target or branch start
 * point: a plausible ref name (branch, tag, or short/full SHA) that cannot be
 * mistaken for a git option (`-f`, `--patch`, `--output=…`) or a pathspec (`.`)
 * that `git checkout` would act on destructively.
 */
export function isValidCheckoutRef(value: string): boolean {
  const ref = value.trim();
  if (!ref || ref.startsWith('-')) return false;
  // 'HEAD' is a valid checkout target/start point even though
  // isValidRefName rejects it as a branch name.
  if (ref === 'HEAD') return true;
  return isValidRefName(ref) || isValidGitSha(ref);
}

export interface GitCheckoutResult {
  branch: string;
  detached: boolean;
}

/**
 * Checkout a branch, tag, or revision. Returns the resulting HEAD state.
 * Throws on dirty tree or invalid ref.
 */
export async function gitCheckout(
  cwd: string,
  ref: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitCheckoutResult> {
  if (!isValidCheckoutRef(ref)) {
    throw new Error(`invalid checkout ref: ${ref}`);
  }
  // A remote-tracking ref (remote/branch) needs more than a bare
  // `git checkout <branch>`: with two remotes carrying the same branch name
  // the bare name is ambiguous ("matched multiple remote tracking branches"),
  // and checking out the remote ref directly detaches HEAD. When no local
  // branch of that name exists yet, create one tracking the exact remote ref
  // so a fork layout (origin + upstream) lands on the clicked commit.
  const isRemoteTracking = await runGit(
    cwd,
    ['show-ref', '--verify', '--quiet', `refs/remotes/${ref}`],
    env,
  )
    .then(() => true)
    .catch(() => false);
  if (isRemoteTracking) {
    const localName = ref.slice(ref.indexOf('/') + 1);
    if (!isValidCheckoutRef(localName)) {
      throw new Error(
        `invalid local branch name derived from remote ref: ${localName}`,
      );
    }
    const hasLocal = await runGit(
      cwd,
      ['show-ref', '--verify', '--quiet', `refs/heads/${localName}`],
      env,
    )
      .then(() => true)
      .catch(() => false);
    if (hasLocal) {
      await runGit(cwd, ['checkout', localName, '--'], env);
    } else {
      // `--track` forces commit-ish interpretation of the verified
      // remote-tracking ref, so no pathspec terminator is needed.
      await runGit(cwd, ['checkout', '--track', ref], env);
    }
    const head = (
      await runGit(cwd, ['symbolic-ref', '--short', 'HEAD'], env)
    ).trim();
    return { branch: head, detached: false };
  }
  // `--` terminates options/pathspecs so a validated ref can never be
  // reinterpreted as a path (e.g. `.` wiping the working tree).
  await runGit(cwd, ['checkout', ref, '--'], env);
  const headRaw = await runGit(
    cwd,
    ['symbolic-ref', '--short', 'HEAD'],
    env,
  ).catch(() => '');
  const trimmed = headRaw.trim();
  if (trimmed) {
    return { branch: trimmed, detached: false };
  }
  const sha = await runGit(cwd, ['rev-parse', '--short', 'HEAD'], env);
  return { branch: sha.trim(), detached: true };
}

/**
 * Create a new branch and check it out. Throws if the branch already exists
 * or the working tree is dirty.
 */
export async function gitCreateBranch(
  cwd: string,
  name: string,
  startPoint?: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitCheckoutResult> {
  if (!isValidRefName(name) || name.startsWith('-')) {
    throw new Error(`invalid branch name: ${name}`);
  }
  const args = ['checkout', '-b', name];
  if (startPoint) {
    if (!isValidCheckoutRef(startPoint)) {
      throw new Error(`invalid start point: ${startPoint}`);
    }
    args.push(startPoint);
  }
  args.push('--');
  // `git checkout -b` creates the ref and switches HEAD before running the
  // post-checkout hook. If that hook fails the call throws even though the
  // workspace is already on the new branch; capture the previous HEAD so we
  // can roll the half-created branch back instead of leaving it in place.
  const originalRef = (
    await runGit(
      cwd,
      ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      env,
    ).catch(() => '')
  ).trim();
  const originalCommit = originalRef
    ? ''
    : (await runGit(cwd, ['rev-parse', 'HEAD'], env).catch(() => '')).trim();
  try {
    await runGit(cwd, args, env);
  } catch (err) {
    const nowOn = (
      await runGit(
        cwd,
        ['symbolic-ref', '--quiet', '--short', 'HEAD'],
        env,
      ).catch(() => '')
    ).trim();
    if (nowOn === name) {
      if (originalRef) {
        await runGit(cwd, ['checkout', originalRef, '--'], env).catch(() => {});
      } else if (originalCommit) {
        await runGit(
          cwd,
          ['checkout', '--detach', originalCommit, '--'],
          env,
        ).catch(() => {});
      }
      await runGit(cwd, ['branch', '-D', name], env).catch(() => {});
    }
    throw err;
  }
  return { branch: name, detached: false };
}

export interface GitPushResult {
  success: boolean;
  output: string;
}

/**
 * Push the current branch. When `setUpstream` is requested and the branch
 * already has an upstream, a plain `git push` is used so the configured
 * remote is preserved. Only when no upstream exists does it fall back to
 * `--set-upstream <remote> <branch>`, resolving the push remote with Git's
 * precedence (branch.<name>.pushRemote, remote.pushDefault,
 * branch.<name>.remote, sole remote, then origin).
 */
export async function gitPush(
  cwd: string,
  opts?: { setUpstream?: boolean; force?: boolean },
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitPushResult> {
  const args = ['push'];
  if (opts?.force) args.push('--force-with-lease');
  if (opts?.setUpstream) {
    let branch: string;
    try {
      branch = (
        await runGit(cwd, ['symbolic-ref', '--short', 'HEAD'], env)
      ).trim();
    } catch {
      throw new Error(
        'cannot push with --set-upstream in detached HEAD state; check out a branch first',
      );
    }
    // If the branch already tracks an upstream, push without rewriting it.
    const hasUpstream = await runGit(
      cwd,
      ['rev-parse', '--abbrev-ref', `${branch}@{u}`],
      env,
    ).catch(() => '');
    if (hasUpstream.trim()) {
      const output = await runGit(cwd, args, env);
      return { success: true, output: output.trim() };
    }
    // No upstream — resolve the push remote using Git's precedence:
    // branch.<name>.pushRemote, then remote.pushDefault, then the branch's
    // pull remote, then the sole configured remote, then `origin`. Pushing
    // with the pull remote when a push remote is configured would publish to
    // the wrong repository (e.g. the shared upstream instead of a fork).
    let remote = (
      await runGit(cwd, ['config', `branch.${branch}.pushRemote`], env).catch(
        () => '',
      )
    ).trim();
    if (!remote) {
      remote = (
        await runGit(cwd, ['config', 'remote.pushDefault'], env).catch(() => '')
      ).trim();
    }
    if (!remote) {
      remote = (
        await runGit(cwd, ['config', `branch.${branch}.remote`], env).catch(
          () => '',
        )
      ).trim();
    }
    if (!remote) {
      const remotes = (
        await runGit(cwd, ['remote'], env).catch(() => '')
      ).trim();
      const remoteList = remotes ? remotes.split('\n') : [];
      remote = remoteList.length === 1 ? (remoteList[0] ?? 'origin') : 'origin';
    }
    args.push('--set-upstream', remote, branch);
  }
  const output = await runGit(cwd, args, env);
  return { success: true, output: output.trim() };
}

export interface GitPullResult {
  success: boolean;
  output: string;
  /**
   * Present and true when the pull succeeded but restoring the auto-stashed
   * changes failed (a conflict, or an incoming file at an untracked path).
   * Git keeps the stash entry, so nothing is lost; `output` carries git's
   * notice and the entry's SHA.
   */
  stashRestoreConflict?: boolean;
}

export interface GitPullOptions {
  rebase?: boolean;
  fetchOnly?: boolean;
  /**
   * Stash local changes (including untracked files) before pulling and
   * restore them afterwards, so a dirty working tree does not block the
   * update. Mutually exclusive with `force`.
   */
  stash?: boolean;
  /**
   * Discard all local changes (tracked modifications and untracked files;
   * ignored files are kept) before pulling. Destructive, so the update is
   * validated first: it is refused unless it is a fast-forward, and nothing
   * is discarded for an update that could not be applied. Mutually
   * exclusive with `stash`.
   */
  force?: boolean;
}

export type GitPullFailureCode =
  | 'operation_in_progress'
  | 'force_unsupported'
  | 'diverged'
  | 'pull_failed';

/**
 * A stash or force pull that was refused, or failed after the repository
 * was put back into a known state. `code` is stable for clients; `message`
 * carries git's own detail and, when the auto-stash could not be restored,
 * the entry that still holds the user's changes.
 */
export class GitPullFailure extends Error {
  readonly code: GitPullFailureCode;

  constructor(code: GitPullFailureCode, message: string) {
    super(message);
    this.name = 'GitPullFailure';
    this.code = code;
  }
}

const AUTO_STASH_MESSAGE = 'qwen-code: auto-stash before pull';

// Sequencer states a stash or discard would silently destroy: `git stash
// push` and `git reset --hard` both clear MERGE_HEAD / CHERRY_PICK_HEAD /
// REVERT_HEAD (a resolved-but-uncommitted merge, pick or revert lives only
// there), and a stopped rebase or am parks in the rebase directories. The
// plain pull is not guarded — git itself refuses to merge in these states.
const OPERATION_STATE_PATHS: ReadonlyArray<readonly [string, string]> = [
  ['MERGE_HEAD', 'merge'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase or am'],
];

function gitDetail(err: unknown): string {
  if (err && typeof err === 'object' && ('stdout' in err || 'stderr' in err)) {
    const e = err as { stdout?: string; stderr?: string };
    const detail = `${e.stdout ?? ''}\n${e.stderr ?? ''}`.trim();
    if (detail) return detail;
  }
  return err instanceof Error ? err.message : String(err);
}

function exitCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Name of the git operation currently parked in this worktree, if any.
 * Resolved through `--git-path` so linked worktrees and a branch that
 * happens to be named `MERGE_HEAD` cannot mislead it.
 */
async function operationInProgress(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const args = ['rev-parse'];
  for (const [statePath] of OPERATION_STATE_PATHS) {
    args.push('--git-path', statePath);
  }
  const lines = (await runGit(cwd, args, env)).trim().split('\n');
  for (let i = 0; i < OPERATION_STATE_PATHS.length; i++) {
    const line = lines[i];
    if (line && fs.existsSync(path.resolve(cwd, line))) {
      return OPERATION_STATE_PATHS[i]![1];
    }
  }
  return undefined;
}

async function refuseOperationInProgress(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const operation = await operationInProgress(cwd, env);
  if (operation) {
    throw new GitPullFailure(
      'operation_in_progress',
      `cannot update: a ${operation} is in progress; finish or abort it from a terminal first`,
    );
  }
}

/** SHA of the top stash entry, or '' when the stash is empty. */
async function stashRef(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  try {
    return (
      await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'refs/stash'], env)
    ).trim();
  } catch (err) {
    // `--quiet` exits 1 for a missing ref; anything else is a real failure.
    if (exitCode(err) === 1) return '';
    throw err;
  }
}

interface StashRestore {
  restored: boolean;
  output: string;
}

/**
 * Restore and drop the auto-stash by identity. Never `stash pop`: it takes
 * whatever sits on top of `refs/stash`, which the user's terminal may have
 * pushed to since. A failed apply leaves the entry in place.
 */
async function restoreStash(
  cwd: string,
  sha: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<StashRestore> {
  // A clean apply only prints a `git status` dump, which is noise next to
  // the pull's own output; keep the restore silent unless something is off.
  let output = '';
  try {
    await runGit(cwd, ['stash', 'apply', sha], env);
  } catch (err) {
    return { restored: false, output: gitDetail(err) };
  }
  const entries = (
    await runGit(cwd, ['stash', 'list', '--format=%H %gd'], env)
  ).split('\n');
  const slot = entries
    .find((line) => line.startsWith(`${sha} `))
    ?.slice(sha.length + 1)
    .trim();
  if (slot) {
    try {
      await runGit(cwd, ['stash', 'drop', '--quiet', slot], env);
    } catch (err) {
      output = `restored, but stash entry ${slot} could not be dropped:\n${gitDetail(err)}`;
    }
  }
  return { restored: true, output: output.trim() };
}

function pullArgs(opts?: GitPullOptions): string[] {
  const args = ['pull'];
  if (opts?.rebase) args.push('--rebase');
  return args;
}

async function requireUpstream(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  // Fails with git's own "no upstream configured" message before anything
  // is stashed or discarded, so the caller classifies it as it always has.
  await runGit(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'], env);
}

async function stashPull(
  cwd: string,
  opts: GitPullOptions,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitPullResult> {
  await refuseOperationInProgress(cwd, env);
  await requireUpstream(cwd, env);
  // Compare refs/stash before/after instead of parsing the push output,
  // which differs between git versions and locales. An unchanged ref means
  // there was nothing to stash and the pull is a plain one.
  const before = await stashRef(cwd, env);
  await runGit(
    cwd,
    ['stash', 'push', '--include-untracked', '-m', AUTO_STASH_MESSAGE],
    env,
  );
  const after = await stashRef(cwd, env);
  const stashed = after !== '' && after !== before ? after : undefined;

  let output: string;
  try {
    output = (await runGit(cwd, pullArgs(opts), env)).trim();
  } catch (err) {
    if (stashed === undefined) throw err;
    const detail = gitDetail(err);
    // Abort only what this pull started: the guard above proved no merge or
    // rebase was in progress before it ran, so any state present now is the
    // pull's own.
    const operation = await operationInProgress(cwd, env).catch(
      () => undefined,
    );
    if (operation === 'merge') {
      await runGit(cwd, ['merge', '--abort'], env).catch(() => {});
    } else if (operation !== undefined) {
      await runGit(cwd, ['rebase', '--abort'], env).catch(() => {});
    }
    const restore = await restoreStash(cwd, stashed, env);
    throw new GitPullFailure(
      'pull_failed',
      restore.restored
        ? `update failed; your local changes were restored:\n${detail}`
        : `update failed and your local changes could not be restored automatically; they are kept in stash entry ${stashed}:\n${detail}\n${restore.output}`,
    );
  }
  if (stashed === undefined) return { success: true, output };
  const restore = await restoreStash(cwd, stashed, env);
  if (restore.restored) {
    return { success: true, output: `${output}\n${restore.output}`.trim() };
  }
  return {
    success: true,
    stashRestoreConflict: true,
    output:
      `${output}\nrestoring your local changes failed; they are kept in stash entry ${stashed}:\n${restore.output}`.trim(),
  };
}

async function forcePull(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitPullResult> {
  await refuseOperationInProgress(cwd, env);
  const toplevel = (
    await runGit(cwd, ['rev-parse', '--show-toplevel'], env)
  ).trim();
  if (
    (await fs.promises.realpath(cwd)) !== (await fs.promises.realpath(toplevel))
  ) {
    // `git reset --hard` acts on the whole repository, so a discard issued
    // from a workspace below the root would also erase changes outside it.
    throw new GitPullFailure(
      'force_unsupported',
      'cannot discard changes: the workspace is a subdirectory of its repository, so discarding would also reset changes outside the workspace; resolve them from a terminal',
    );
  }
  await requireUpstream(cwd, env);
  // Validate before destroying anything: fetch, then refuse unless the
  // update is a fast-forward. A diverged branch would need a merge that
  // could stop on conflicts after the local changes were already gone.
  await runGit(cwd, ['fetch'], env);
  try {
    await runGit(
      cwd,
      ['merge-base', '--is-ancestor', 'HEAD', '@{upstream}'],
      env,
    );
  } catch (err) {
    if (exitCode(err) === 1) {
      throw new GitPullFailure(
        'diverged',
        'cannot discard and update: the branch has diverged from its upstream; merge or rebase the local commits from a terminal first',
      );
    }
    throw err;
  }
  await runGit(cwd, ['reset', '--hard'], env);
  await runGit(cwd, ['clean', '-fd'], env);
  // A fast-forward is the same commit whether merged or rebased, so the
  // `rebase` option has nothing to add here.
  const output = await runGit(cwd, ['pull', '--ff-only'], env);
  return { success: true, output: output.trim() };
}

/**
 * Pull (fetch + merge) or fetch-only from the remote.
 *
 * Without `stash` or `force` this is a plain `git pull`, exactly as before:
 * ambient git configuration applies and a dirty working tree is refused by
 * git. The two options are the resolutions the branch picker offers for
 * that refusal and mirror what a user would do in a terminal — stash around
 * the pull, or discard and pull — with the repository returned to a known
 * state whenever the update itself fails.
 */
export async function gitPull(
  cwd: string,
  opts?: GitPullOptions,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitPullResult> {
  if (opts?.stash && opts?.force) {
    throw new Error('stash and force are mutually exclusive');
  }
  if (opts?.fetchOnly) {
    const output = await runGit(cwd, ['fetch', '--all', '--prune'], env);
    return { success: true, output: output.trim() };
  }
  if (opts?.force) return forcePull(cwd, env);
  if (opts?.stash) return stashPull(cwd, opts, env);
  const output = await runGit(cwd, pullArgs(opts), env);
  return { success: true, output: output.trim() };
}

export interface GitCommitResult {
  sha: string;
  subject: string;
}

/**
 * Commit changes. With `all: true`, stages every change in the working tree
 * (including untracked files) via `git add -A` before committing, so the
 * commit matches what the UI displays.
 */
export async function gitCommit(
  cwd: string,
  message: string,
  opts?: { all?: boolean },
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitCommitResult> {
  // Snapshot the index before `git add -A` so a failed commit (e.g. a
  // rejecting pre-commit hook) can restore the user's original staging
  // instead of leaving the whole working tree staged.
  let savedIndex: string | null = null;
  if (opts?.all) {
    const tree = (
      await runGit(cwd, ['write-tree'], env).catch(() => '')
    ).trim();
    if (tree) {
      savedIndex = tree;
    } else {
      // write-tree fails on an unmerged index; add -A would destroy the
      // conflict state with no way to roll back.
      const unmerged = (
        await runGit(cwd, ['ls-files', '--unmerged'], env)
      ).trim();
      if (unmerged) {
        throw new Error(
          'cannot stage all changes: unresolved merge conflicts in the index',
        );
      }
      throw new Error(
        'cannot stage all changes: failed to snapshot index (write-tree failed)',
      );
    }
  }
  try {
    if (opts?.all) {
      await runGit(cwd, ['add', '-A'], env);
    }
    await runGit(cwd, ['commit', '-m', message], env);
  } catch (err) {
    if (savedIndex) {
      await runGit(cwd, ['read-tree', savedIndex], env).catch((rollbackErr) => {
        // A failed rollback leaves the whole `add -A` result staged; surface
        // it so the stale index can be diagnosed instead of failing silently.
        // eslint-disable-next-line no-console
        console.error('git index rollback failed:', rollbackErr);
      });
    }
    throw err;
  }
  const sha = (await runGit(cwd, ['rev-parse', '--short', 'HEAD'], env)).trim();
  const subject = (await runGit(cwd, ['log', '-1', '--format=%s'], env)).trim();
  return { sha, subject };
}

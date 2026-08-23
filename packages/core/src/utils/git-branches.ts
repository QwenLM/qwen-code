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
   * The pull succeeded but restoring the auto-stashed changes failed —
   * conflict markers in the working tree, or an untracked-file collision
   * that restored nothing. Git keeps the stash entry, so nothing is lost,
   * but the user must restore it manually.
   */
  stashRestoreConflict?: boolean;
}

export interface GitPullOptions {
  rebase?: boolean;
  fetchOnly?: boolean;
  /**
   * Stash local changes (including untracked files) before pulling and
   * restore them afterwards, so a dirty working tree does not block the
   * update.
   */
  stash?: boolean;
  /**
   * Discard all local changes (tracked modifications and untracked files)
   * before pulling. Destructive.
   */
  force?: boolean;
}

export type GitPullFailureCode =
  | 'dirty_working_tree'
  | 'merge_in_progress'
  | 'rebase_in_progress'
  | 'diverged'
  | 'ignored_collision';

/**
 * A pull refusal or failure classified from repository state instead of
 * git's rendered diagnostics, which vary by version and locale and embed
 * arbitrary file names. `message` carries the redaction-ready detail
 * (output of the failed git invocation, or authored text for the state
 * guards); `code` is what callers switch on. `unmerged` marks a dirty
 * tree whose index carries unmerged entries, where stashing cannot help.
 */
export class GitPullFailure extends Error {
  constructor(
    readonly code: GitPullFailureCode,
    message: string,
    readonly unmerged: boolean = false,
  ) {
    super(message);
    this.name = 'GitPullFailure';
  }
}

async function currentStashSha(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  return (
    await runGit(cwd, ['rev-parse', '-q', '--verify', 'refs/stash'], env).catch(
      () => '',
    )
  ).trim();
}

async function hasMergeHead(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return runGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], env)
    .then(() => true)
    .catch(() => false);
}

async function hasInProgressRebase(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  for (const stateDir of ['rebase-merge', 'rebase-apply']) {
    // --git-path resolves the state directory for linked worktrees too.
    const rel = (
      await runGit(cwd, ['rev-parse', '--git-path', stateDir], env).catch(
        () => '',
      )
    ).trim();
    if (rel && fs.existsSync(path.resolve(cwd, rel))) {
      return true;
    }
  }
  return false;
}

async function hasUnmergedEntries(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return (
    (
      await runGit(cwd, ['ls-files', '--unmerged'], env).catch(() => '')
    ).trim() !== ''
  );
}

async function isDirtyTree(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return (
    (
      await runGit(cwd, ['status', '--porcelain'], env).catch(() => '')
    ).trim() !== ''
  );
}

async function aheadBehind(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<{ ahead: number; behind: number } | null> {
  const counts = (
    await runGit(
      cwd,
      ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
      env,
    ).catch(() => '')
  ).trim();
  if (!counts) return null;
  const [ahead, behind] = counts.split(/\s+/).map((n) => parseInt(n, 10) || 0);
  return { ahead: ahead ?? 0, behind: behind ?? 0 };
}

// Paths the incoming merge would add that exist locally as IGNORED files:
// git silently checks an incoming tracked file out over a local ignored
// file of the same path, and neither the auto-stash (--include-untracked
// skips ignored files) nor the force reset/clean protects them.
async function incomingIgnoredPaths(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const added = (
    await runGit(
      cwd,
      ['diff', '--diff-filter=A', '--name-only', 'HEAD', '@{u}'],
      env,
    ).catch(() => '')
  ).trim();
  if (!added) return [];
  const paths = added.split('\n').filter(Boolean);
  const ignored = (
    await runGit(cwd, ['check-ignore', '--', ...paths], env).catch(() => '')
  ).trim();
  return ignored ? ignored.split('\n') : [];
}

function refusedIgnoredCollision(paths: string[]): GitPullFailure {
  return new GitPullFailure(
    'ignored_collision',
    `cannot pull: the incoming changes add files that exist locally as ignored files and would be overwritten silently: ${paths.join(', ')}`,
  );
}

function gitFailureDetail(err: unknown): string {
  if (err && typeof err === 'object' && ('stdout' in err || 'stderr' in err)) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

async function classifyPullFailure(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  err: unknown,
  wasStashPull: boolean,
): Promise<unknown> {
  const detail = gitFailureDetail(err);
  if (await hasMergeHead(cwd, env)) {
    return new GitPullFailure('merge_in_progress', detail);
  }
  if (await hasInProgressRebase(cwd, env)) {
    return new GitPullFailure('rebase_in_progress', detail);
  }
  const unmerged = await hasUnmergedEntries(cwd, env);
  const counts = await aheadBehind(cwd, env);
  if (!counts) {
    // No upstream tracking: the pull's own error names the cause better
    // than any state classification; keep it unless unmerged entries make
    // the tree unambiguously panel-recoverable by discard.
    return unmerged
      ? new GitPullFailure('dirty_working_tree', detail, true)
      : err;
  }
  const diverged = counts.ahead > 0 && counts.behind > 0;
  const dirty = await isDirtyTree(cwd, env);
  // A stash pull that still failed conflicted on committed content, and in
  // a diverged tree neither stashing nor discarding can converge, so the
  // state must be resolved from a terminal. A plain pull on a diverged but
  // dirty tree stays panel-recoverable: the stash option can still succeed
  // when the local commits do not conflict.
  if (diverged && (wasStashPull || unmerged || !dirty)) {
    return new GitPullFailure('diverged', detail);
  }
  if (unmerged) {
    return new GitPullFailure('dirty_working_tree', detail, true);
  }
  if (dirty) {
    return new GitPullFailure('dirty_working_tree', detail);
  }
  return err;
}

/**
 * Pull (fetch + merge) or fetch-only from the remote.
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
  // A pull must never run into a merge or rebase that predates it: the
  // failure recovery below aborts merge/rebase state indiscriminately and
  // would destroy the user's in-progress operation, stranding any
  // auto-stashed changes. This guard is also what makes that recovery safe
  // — any state it aborts was started by this pull.
  if (await hasMergeHead(cwd, env)) {
    throw new GitPullFailure(
      'merge_in_progress',
      'cannot pull: a merge is already in progress — finish or abort it before updating',
    );
  }
  if (await hasInProgressRebase(cwd, env)) {
    throw new GitPullFailure(
      'rebase_in_progress',
      'cannot pull: a rebase is already in progress — finish or abort it before updating',
    );
  }
  if (opts?.force) {
    // `reset --hard` resets the whole repository regardless of cwd, and so
    // does the pull's merge, but `clean -fd` from a subdirectory only
    // removes untracked files inside that subtree. Refuse instead of
    // destroying tracked changes outside the workspace while still leaving
    // the files that block the merge in place.
    const prefix = (
      await runGit(cwd, ['rev-parse', '--show-prefix'], env)
    ).trim();
    if (prefix) {
      throw new Error(
        'cannot discard changes: the workspace is a subdirectory of the git repository, and discarding is only supported at the repository root',
      );
    }
    // Validate before destroying: a failing fetch or missing upstream must
    // surface while the local changes are still intact, and a diverged
    // branch is refused because the post-discard pull would have to merge
    // the local commits and could wedge the repository mid-merge.
    await runGit(cwd, ['fetch'], env);
    // Without a catch: a missing upstream must surface here, before
    // anything is discarded.
    const countsRaw = (
      await runGit(
        cwd,
        ['rev-list', '--left-right', '--count', 'HEAD...@{u}'],
        env,
      )
    ).trim();
    const [ahead, behind] = countsRaw
      .split(/\s+/)
      .map((n) => parseInt(n, 10) || 0);
    if ((ahead ?? 0) > 0 && (behind ?? 0) > 0) {
      throw new GitPullFailure(
        'diverged',
        'cannot discard changes and update: the branch has diverged from its upstream, so the update would still need to merge your local commits; merge or rebase them manually first',
      );
    }
    const ignored = await incomingIgnoredPaths(cwd, env);
    if (ignored.length > 0) {
      throw refusedIgnoredCollision(ignored);
    }
    await runGit(cwd, ['reset', '--hard'], env);
    await runGit(cwd, ['clean', '-fd'], env);
  }
  let stashed = false;
  if (opts?.stash) {
    // Fetch before stashing so the collision probe sees the incoming
    // commits and any later failure surfaces while the tree is intact.
    await runGit(cwd, ['fetch'], env);
    const ignored = await incomingIgnoredPaths(cwd, env);
    if (ignored.length > 0) {
      throw refusedIgnoredCollision(ignored);
    }
    // Compare refs/stash before/after instead of parsing the push output,
    // which differs between git versions and locales.
    const before = await currentStashSha(cwd, env);
    await runGit(
      cwd,
      [
        'stash',
        'push',
        '--include-untracked',
        '-m',
        'qwen-code: auto-stash before pull',
      ],
      env,
    );
    const after = await currentStashSha(cwd, env);
    stashed = after !== '' && after !== before;
  }
  const args = ['pull'];
  if (opts?.rebase) {
    args.push('--rebase');
  } else {
    // Pin the merge default explicitly: on git builds without pull.rebase /
    // pull.ff configured a bare `git pull` on divergent branches fatals
    // with "Need to specify how to reconcile divergent branches". --no-edit
    // keeps the merge-commit message from waiting on an editor.
    args.push('--no-rebase', '--no-edit');
  }
  let output: string;
  try {
    output = await runGit(cwd, args, env);
  } catch (err) {
    if (stashed || opts?.force) {
      // Never leave the repository wedged mid-merge: abort any partial
      // merge/rebase (restoring the pre-pull HEAD), then bring the
      // stashed changes back. A failed restore leaves the stash entry in
      // place, so nothing is lost either way.
      await runGit(cwd, ['merge', '--abort'], env).catch(() => {});
      await runGit(cwd, ['rebase', '--abort'], env).catch(() => {});
      if (stashed) {
        await runGit(cwd, ['stash', 'pop'], env).catch(() => {});
      }
    }
    throw await classifyPullFailure(cwd, env, err, opts?.stash === true);
  }
  if (stashed) {
    let stashRestoreConflict = false;
    const popOutput = await runGit(cwd, ['stash', 'pop'], env).catch(
      (popErr) => {
        // A failed pop always keeps the stash entry and leaves the changes
        // unrestored — conflict markers, or an untracked-file collision — so
        // flag it instead of failing an otherwise successful pull.
        stashRestoreConflict = true;
        const e = popErr as { stdout?: string; stderr?: string };
        return `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      },
    );
    return {
      success: true,
      output: `${output.trim()}\n${popOutput.trim()}`.trim(),
      ...(stashRestoreConflict ? { stashRestoreConflict: true } : {}),
    };
  }
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

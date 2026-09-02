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
  /**
   * `true` when the configured upstream ref no longer exists (git's
   * `[gone]` tracking state, e.g. after the remote branch was deleted and
   * pruned). `upstream` still names the configured ref in that case.
   */
  upstreamGone?: boolean;
  ahead: number;
  behind: number;
  /**
   * Where `git push` would push, by git's own resolution
   * (`branch.<name>.pushRemote` / `remote.pushDefault` / the upstream via
   * `push.default`). Absent when git cannot resolve a push destination.
   * Differs from `upstream` in triangular (fork) workflows.
   */
  pushTarget?: string;
  /** Commits ahead of the push target; absent when `pushTarget` is. */
  pushAhead?: number;
  /** Commits behind the push target; absent when `pushTarget` is. */
  pushBehind?: number;
  /**
   * Push destination resolves but its ref does not exist yet (`git push`
   * would create the remote branch). `pushAhead`/`pushBehind` are absent.
   */
  pushGone?: boolean;
  /**
   * A push destination override is configured for this branch
   * (`branch.<name>.pushRemote` or `remote.pushDefault`). Notably,
   * `%(push)` cannot resolve a destination under the default
   * `push.default=simple` in exactly this triangular shape even though a
   * plain `git push` succeeds — so when this is set and `pushTarget` is
   * absent, the push side is configured-but-unknown, not "the upstream".
   */
  pushConfigured?: boolean;
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

  // Which branches have a push destination override. `--get-regexp` exits 1
  // on no matches; treat that as empty. Keys print lowercased but the
  // branch subsection keeps its case.
  const pushConfigRaw = await runGit(
    cwd,
    [
      'config',
      '--get-regexp',
      '^branch\\..*\\.pushremote$|^remote\\.pushdefault$',
    ],
    env,
  ).catch(() => '');
  const pushDefaultSet = /^remote\.pushdefault /m.test(pushConfigRaw);
  const pushRemoteBranches = new Set(
    [...pushConfigRaw.matchAll(/^branch\.(.*)\.pushremote /gm)].map(
      (m) => m[1],
    ),
  );

  const [localRaw, remoteRaw, tagsRaw, headRaw, reflogRaw] = await Promise.all([
    runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)%00%(symref)%00%(push:short)%00%(push:track,nobracket)',
        'refs/heads/',
      ],
      env,
    ).catch(() => ''),
    runGit(
      cwd,
      [
        'for-each-ref',
        '--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(committerdate:unix)%00%(subject)%00%(symref)%00%(push:short)%00%(push:track,nobracket)',
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

  const local = parseBranchLines(localRaw).map((b) =>
    pushDefaultSet || pushRemoteBranches.has(b.name)
      ? { ...b, pushConfigured: true }
      : b,
  );
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
        // `%(upstream:track,nobracket)` prints `gone` when the upstream is
        // configured but its ref is missing; ahead/behind are meaningless then.
        const upstreamGone = upstream !== undefined && /\bgone\b/.test(track);

        // Push-side counterpart: `%(push)` is git's own answer to "where
        // would `git push` go", honoring pushRemote/pushDefault — the same
        // resolution a plain `git push` uses, so no precedence is re-derived
        // here. Empty when unresolvable (e.g. `push.default` cannot pick).
        const pushTarget = parts[7] || undefined;
        const pushTrack = parts[8] ?? '';
        const pushGone = pushTarget !== undefined && /\bgone\b/.test(pushTrack);
        let pushAhead: number | undefined;
        let pushBehind: number | undefined;
        if (pushTarget !== undefined && !pushGone) {
          const pa = /ahead (\d+)/.exec(pushTrack);
          const pb = /behind (\d+)/.exec(pushTrack);
          pushAhead = pa ? parseInt(pa[1], 10) : 0;
          pushBehind = pb ? parseInt(pb[1], 10) : 0;
        }

        return {
          name,
          isHead,
          upstream,
          ...(upstreamGone ? { upstreamGone } : {}),
          ahead,
          behind,
          ...(pushTarget !== undefined ? { pushTarget } : {}),
          ...(pushAhead !== undefined ? { pushAhead } : {}),
          ...(pushBehind !== undefined ? { pushBehind } : {}),
          ...(pushGone ? { pushGone } : {}),
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
  /**
   * Present and true when the pull and restore succeeded but a stash entry
   * was kept on the stack (a failed drop, or a displaced entry that needs
   * recovering); `output` carries the notice and `stashSha` the entry.
   */
  stashKept?: boolean;
  /**
   * SHA of the kept auto-stash entry when `stashRestoreConflict` or
   * `stashKept` is set.
   */
  stashSha?: string;
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
    // Some git commands exit silently against a stale lock; say so rather
    // than surfacing only the command line.
    return 'git exited without diagnostic output; a stale lock file (e.g. .git/index.lock) or another git process is the usual cause';
  }
  return err instanceof Error ? err.message : String(err);
}

function exitCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'number' ? code : undefined;
}

/**
 * Exit code of a failed pull for recovery purposes. A pull killed without
 * a numeric code — our own 30s timeout (`killed`), an external or OOM kill
 * (`signal`) — may already have written MERGE_HEAD or the rebase dir, so
 * it counts as 1 (state possibly created); the tip-identity check still
 * decides whether that state is actually the pull's own.
 */
function pullExitCode(err: unknown): number | undefined {
  const code = exitCode(err);
  if (code !== undefined) return code;
  const e = err as { killed?: boolean; signal?: unknown } | null;
  if (e && (e.killed === true || typeof e.signal === 'string')) return 1;
  return undefined;
}

/** Absolute paths of the given `--git-path` names, in order. */
async function gitPaths(
  cwd: string,
  names: readonly string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string[]> {
  const args = ['rev-parse'];
  for (const name of names) args.push('--git-path', name);
  return (await runGit(cwd, args, env))
    .trim()
    .split('\n')
    .map((line) => path.resolve(cwd, line));
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
  const paths = await gitPaths(
    cwd,
    OPERATION_STATE_PATHS.map(([statePath]) => statePath),
    env,
  );
  for (let i = 0; i < OPERATION_STATE_PATHS.length; i++) {
    if (fs.existsSync(paths[i]!)) return OPERATION_STATE_PATHS[i]![1];
  }
  return undefined;
}

/**
 * Refuse while an operation is parked. Called immediately before every
 * command that would absorb or destroy that state (`stash push`, `reset
 * --hard`), so the window in which a terminal can park one unseen is the
 * command itself.
 */
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

/**
 * SHA of the upstream tip of `ref` (the checked-out branch by default), or
 * '' when it does not resolve.
 */
async function upstreamSha(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
  ref = '',
): Promise<string> {
  try {
    return (
      await runGit(
        cwd,
        ['rev-parse', '--verify', '--quiet', `${ref}@{upstream}`],
        env,
      )
    ).trim();
  } catch {
    return '';
  }
}

function readTrimmed(file: string): string {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * Abort the merge or rebase a failed `git pull` left behind — and only that
 * one. Provenance comes from git itself: when a merge or rebase already
 * exists, `git pull` exits 128 before touching the tree, so a state that
 * is present after an exit of 1 (git attempted the integration and stopped
 * on conflicts) was created by the pull. The state must also point at the
 * upstream tip the pull integrated. Anything else — a merge a terminal
 * parked meanwhile, whatever its tip — is left alone; the caller then
 * reports the stash entry as kept. Best-effort: a probe failure aborts
 * nothing, so the caller still reaches its typed failure.
 */
async function abortOwnPullState(
  cwd: string,
  pullExitCode: number | undefined,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  if (pullExitCode !== 1) return;
  try {
    const [mergeHead, rebaseMergeDir, rebaseApplyDir] = await gitPaths(
      cwd,
      ['MERGE_HEAD', 'rebase-merge', 'rebase-apply'],
      env,
    );
    if (fs.existsSync(mergeHead!)) {
      // A merge keeps HEAD on the branch, so its upstream resolves directly.
      const upstream = await upstreamSha(cwd, env);
      if (upstream && readTrimmed(mergeHead!) === upstream) {
        await runGit(cwd, ['merge', '--abort'], env);
      }
      return;
    }
    for (const dir of [rebaseMergeDir!, rebaseApplyDir!]) {
      if (!fs.existsSync(dir)) continue;
      // A rebase detaches HEAD; the branch being replayed is recorded in
      // head-name, and its upstream is what the pull rebased onto.
      const headName = readTrimmed(path.join(dir, 'head-name')).replace(
        /^refs\/heads\//,
        '',
      );
      const upstream = headName ? await upstreamSha(cwd, env, headName) : '';
      if (upstream && readTrimmed(path.join(dir, 'onto')) === upstream) {
        await runGit(cwd, ['rebase', '--abort'], env);
      }
      return;
    }
  } catch {
    // Leave whatever is there; the restore step reports the entry as kept.
  }
}

interface StashEntry {
  sha: string;
  subject: string;
}

async function stashEntries(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<StashEntry[]> {
  const raw = await runGit(cwd, ['stash', 'list', '--format=%H%x00%s'], env);
  return raw
    .split('\n')
    .filter((line) => line.includes('\0'))
    .map((line) => {
      const [sha, subject] = line.split('\0');
      return { sha: sha!, subject: subject ?? '' };
    });
}

/**
 * SHA git reports for a dropped entry (`Dropped refs/stash@{1} (<sha>)`,
 * stable under the `LC_ALL=C` the git env pins). Exported for tests.
 */
export function parseDroppedStashSha(output: string): string | undefined {
  const match = /\(([0-9a-f]{40,64})\)\s*$/m.exec(output.trim());
  return match?.[1];
}

interface StashRestore {
  restored: boolean;
  output: string;
}

/**
 * Restore and drop the auto-stash by identity. Never `stash pop`: it takes
 * whatever sits on top of `refs/stash`, which the user's terminal may have
 * pushed to since. A failed apply leaves the entry in place. Git has no
 * identity-addressed drop, so the drop names the slot resolved right before
 * it and then checks the SHA git reports as dropped: if a concurrent push
 * shifted the slots and a different entry went, that entry is stored back
 * and ours is reported as kept. Every step after the apply is best-effort
 * and reports what it could not do, naming the entry by SHA — the changes
 * are in the tree by then, so nothing here may turn into a failure.
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
  let entries: StashEntry[];
  try {
    entries = await stashEntries(cwd, env);
  } catch (err) {
    return {
      restored: true,
      output: `restored, but stash entry ${sha} was kept because the stash could not be listed:\n${gitDetail(err)}`,
    };
  }
  const index = entries.findIndex((entry) => entry.sha === sha);
  if (index === -1) return { restored: true, output };
  const slot = `stash@{${index}}`;
  let dropped: string | undefined;
  try {
    dropped = parseDroppedStashSha(
      await runGit(cwd, ['stash', 'drop', slot], env),
    );
  } catch (err) {
    return {
      restored: true,
      output: `restored, but stash entry ${slot} (${sha}) could not be dropped:\n${gitDetail(err)}`,
    };
  }
  if (dropped !== undefined && dropped !== sha) {
    // The slot moved under us; put the other entry back where git can see
    // it and leave ours in place.
    const subject = (
      await runGit(cwd, ['log', '-1', '--format=%s', dropped], env).catch(
        () => '',
      )
    ).trim();
    const storeArgs = ['stash', 'store', '--quiet'];
    if (subject) storeArgs.push('-m', subject);
    storeArgs.push(dropped);
    const stored = await runGit(cwd, storeArgs, env)
      .then(() => true)
      .catch(() => false);
    output = stored
      ? `restored; stash entry ${sha} was kept because the stash changed while dropping it`
      : `restored; stash entry ${sha} was kept because the stash changed while dropping it, and the displaced entry ${dropped} could not be stored back — recover it with: git stash store ${dropped}`;
  }
  return { restored: true, output };
}

function pullArgs(opts?: GitPullOptions): string[] {
  const args = ['pull'];
  if (opts?.rebase) args.push('--rebase');
  return args;
}

/** The upstream ref configured for the checked-out branch, or ''. */
async function configuredUpstream(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  try {
    const branch = (
      await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env)
    ).trim();
    return (
      await runGit(
        cwd,
        ['for-each-ref', '--format=%(upstream)', `refs/heads/${branch}`],
        env,
      )
    ).trim();
  } catch {
    return '';
  }
}

/**
 * SHA of the upstream tip, resolved after the flow's own fetch (so a
 * tracking ref pruned earlier is back if the remote branch exists again).
 * A branch with no upstream configured fails with git's own message, as a
 * plain pull always has; a configured upstream whose remote branch is
 * gone is a typed refusal — nothing has been touched at this point.
 */
async function validatedUpstream(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const sha = await upstreamSha(cwd, env);
  if (sha) return sha;
  if (await configuredUpstream(cwd, env)) {
    throw new GitPullFailure(
      'pull_failed',
      'cannot update: the upstream branch no longer exists on the remote; nothing was changed',
    );
  }
  await runGit(cwd, ['rev-parse', '--abbrev-ref', '@{upstream}'], env);
  throw new GitPullFailure(
    'pull_failed',
    'cannot update: the upstream branch could not be resolved; nothing was changed',
  );
}

/**
 * Push the auto-stash and identify the entry it created by provenance: an
 * entry absent from the pre-push listing whose subject carries the
 * auto-stash message. A terminal push landing between ours and the
 * re-listing sits above it and is left alone. Returns undefined when there
 * was nothing to stash.
 */
async function pushAutoStash(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const before = new Set((await stashEntries(cwd, env)).map((e) => e.sha));
  await refuseOperationInProgress(cwd, env);
  try {
    await runGit(
      cwd,
      ['stash', 'push', '--include-untracked', '-m', AUTO_STASH_MESSAGE],
      env,
    );
  } catch (err) {
    // Nothing was stashed or pulled (git refuses atomically, e.g. on an
    // intent-to-add entry); report why the update was not attempted.
    throw new GitPullFailure(
      'pull_failed',
      `cannot stash the local changes, so the update was not attempted:\n${gitDetail(err)}`,
    );
  }
  let after: StashEntry[];
  try {
    after = await stashEntries(cwd, env);
  } catch (err) {
    // The changes are in the stash but the entry's SHA was never learned:
    // point at it by its message and stop before pulling.
    throw new GitPullFailure(
      'pull_failed',
      `cannot identify the auto-stash entry, so the update was not attempted; your changes are in the entry labelled "${AUTO_STASH_MESSAGE}" in git stash list:\n${gitDetail(err)}`,
    );
  }
  const created = after.filter(
    (e) => !before.has(e.sha) && e.subject.endsWith(AUTO_STASH_MESSAGE),
  );
  // Listing is newest-first; ours is the oldest of the new entries.
  return created.length > 0 ? created[created.length - 1]!.sha : undefined;
}

async function stashPull(
  cwd: string,
  opts: GitPullOptions,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitPullResult> {
  await refuseOperationInProgress(cwd, env);
  await runGit(cwd, ['fetch', '--prune'], env);
  await validatedUpstream(cwd, env);
  const stashed = await pushAutoStash(cwd, env);

  let output: string;
  try {
    output = (await runGit(cwd, pullArgs(opts), env)).trim();
  } catch (err) {
    const detail = gitDetail(err);
    await abortOwnPullState(cwd, pullExitCode(err), env);
    if (stashed === undefined) {
      // Nothing to restore, but the update still failed under the stash
      // flow — report it as such so the client shows git's reason instead
      // of re-offering the same resolution.
      throw new GitPullFailure('pull_failed', `update failed:\n${detail}`);
    }
    const restore = await restoreStash(cwd, stashed, env);
    // The kept-entry notice, when there is one, leads: it is what the user
    // needs first, and the route caps the message length.
    throw new GitPullFailure(
      'pull_failed',
      restore.restored
        ? `update failed; your local changes were restored${restore.output ? ` (${restore.output})` : ''}:\n${detail}`
        : `update failed and your local changes could not be restored automatically; they are kept in stash entry ${stashed}:\n${restore.output}\n${detail}`,
    );
  }
  if (stashed === undefined) return { success: true, output };
  const restore = await restoreStash(cwd, stashed, env);
  if (restore.restored) {
    if (restore.output === '') return { success: true, output };
    // The restore left a notice — the entry could not be dropped, or a
    // displaced entry needs recovering. Mark the result so the client can
    // keep that notice visible; it is the only record of where the
    // entries went.
    return {
      success: true,
      stashKept: true,
      stashSha: stashed,
      output: `${output}\n${restore.output}`.trim(),
    };
  }
  return {
    success: true,
    stashRestoreConflict: true,
    stashSha: stashed,
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
  // Validate before destroying anything: fetch (pruning, so a branch deleted
  // on the remote does not pass the check on its stale tracking ref), then
  // refuse unless the update is a fast-forward. A diverged branch would need
  // a merge that could stop on conflicts after the local changes were gone.
  await runGit(cwd, ['fetch', '--prune'], env);
  const validated = await validatedUpstream(cwd, env);
  try {
    await runGit(cwd, ['merge-base', '--is-ancestor', 'HEAD', validated], env);
  } catch (err) {
    if (exitCode(err) === 1) {
      throw new GitPullFailure(
        'diverged',
        'cannot discard and update: the branch has diverged from its upstream; merge or rebase the local commits from a terminal first',
      );
    }
    throw err;
  }
  await refuseOperationInProgress(cwd, env);
  await runGit(cwd, ['reset', '--hard'], env);
  await runGit(cwd, ['clean', '-fd'], env);
  // Integrate exactly the commit that was validated, by SHA: `git pull`
  // would fetch again, and even the symbolic `@{upstream}` can move under a
  // concurrent fetch — either could turn the validated fast-forward into a
  // refusal after the local changes are already gone. A fast-forward is
  // the same commit whether merged or rebased, so the `rebase` option has
  // nothing to add here.
  let output: string;
  try {
    output = await runGit(cwd, ['merge', '--ff-only', validated], env);
  } catch (err) {
    // A validated fast-forward can still be refused — e.g. a tracked file
    // carrying the skip-worktree bit survives reset+clean and blocks the
    // checkout. Type it: the raw text would send the route's classifier
    // back to dirty_working_tree and the panel would loop on a discard
    // that can never succeed.
    throw new GitPullFailure(
      'pull_failed',
      `discard applied, but the update failed:\n${gitDetail(err)}`,
    );
  }
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

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { isValidGitSha, isValidRefName } from './gitDirect.js';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
const MAX_RECENT_BRANCHES = 20;
const MAX_REFLOG_ENTRIES = 200;

// The unique SHA of the empty tree: the merge base for a pull into an
// unborn HEAD, where every incoming path is new.
const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

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

function runGitBuffer(
  cwd: string,
  args: string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<Buffer> {
  return execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: gitEnv(env),
    encoding: 'buffer',
  }).then(({ stdout }) => stdout);
}

function runGit(
  cwd: string,
  args: string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  return runGitBuffer(cwd, args, env).then((stdout) => stdout.toString('utf8'));
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
 * Pointer to the unrestored changes when a failure-recovery stash restore
 * fails; exported so the route can keep it outside the capped message.
 */
export const STASH_RESTORE_NOTE =
  'The auto-stashed changes were not restored; they are kept in the stash entry (git stash list).';

/**
 * A pull refusal or failure classified from repository state instead of
 * git's rendered diagnostics, which vary by version and locale and embed
 * arbitrary file names. `message` carries the redaction-ready detail
 * (output of the failed git invocation, or authored text for the state
 * guards); `code` is what callers switch on. `unmerged` marks a dirty
 * tree whose index carries unmerged entries, where stashing cannot help.
 * `stashRestoreFailed` marks a failure whose auto-stash restore did not
 * complete, leaving the user's changes in the kept stash entry.
 */
export class GitPullFailure extends Error {
  constructor(
    readonly code: GitPullFailureCode,
    message: string,
    readonly unmerged: boolean = false,
    readonly stashRestoreFailed: boolean = false,
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
      (err) => {
        // Exit 1 is rev-parse's legitimate "no stash exists" answer; any
        // other probe failure must refuse the pull instead of reading as
        // "nothing to restore" and silently leaving the user's
        // auto-stashed changes in refs/stash behind a success report.
        if ((err as { code?: number })?.code === 1) return '';
        throw err;
      },
    )
  ).trim();
}

// The pull lock serializes daemon pulls only, not the user's terminal:
// a stash pushed by another actor between the auto-stash and the restore
// becomes stash@{0}, so the restore checks the recorded identity instead
// of popping blindly. Probe failures read as "not ours" — the entry is
// kept either way.
async function stashTopIs(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  recorded: string,
): Promise<boolean> {
  if (recorded === '') return false;
  const top = await currentStashSha(cwd, env).catch(() => '');
  return top === recorded;
}

async function hasMergeHead(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  return runGit(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], env)
    .then(() => true)
    .catch(() => false);
}

async function inProgressRebaseDir(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  for (const stateDir of ['rebase-merge', 'rebase-apply']) {
    // --git-path resolves the state directory for linked worktrees too.
    const rel = (
      await runGit(cwd, ['rev-parse', '--git-path', stateDir], env)
    ).trim();
    if (!rel) continue;
    const abs = path.resolve(cwd, rel);
    if (!fs.existsSync(abs)) continue;
    // `git am` parks its state in the same rebase-apply directory, but
    // never writes `onto` — a stopped am is not a rebase, and none of
    // the pull's recovery steps (stash, reset, clean, aborting state
    // matched to the fetched tip) disturb it.
    if (stateDir === 'rebase-apply' && !fs.existsSync(path.join(abs, 'onto'))) {
      continue;
    }
    return abs;
  }
  return '';
}

async function hasInProgressRebase(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  try {
    return (await inProgressRebaseDir(cwd, env)) !== '';
  } catch {
    return false;
  }
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

function splitBuffer(buf: Buffer, byte: number): Buffer[] {
  const parts: Buffer[] = [];
  let start = 0;
  for (
    let idx = buf.indexOf(byte);
    idx !== -1;
    idx = buf.indexOf(byte, start)
  ) {
    if (idx > start) parts.push(buf.subarray(start, idx));
    start = idx + 1;
  }
  if (start < buf.length) parts.push(buf.subarray(start));
  return parts;
}

// Paths the incoming update would add over local IGNORED files: git
// refuses a merge that would overwrite an untracked file, but silently
// checks the incoming file out over an IGNORED one of the same path, and
// neither the auto-stash (--include-untracked skips ignored files) nor
// the force reset/clean (clean -fd keeps ignored entries) protects them.
//
// Both sides are enumerated structurally. The incoming side comes from
// `diff --no-renames --diff-filter=d -z` starting at the merge base:
// every path the update writes — additions AND modifications, since the
// modify/delete conflict on a locally untracked path still checks the
// incoming content out over the ignored file — excluding deletions,
// which write nothing (so unpushed local deletions are not counted;
// rename destinations count as additions). On an unborn HEAD the merge
// base is the empty tree, since HEAD does not resolve yet and every
// incoming path is new to the branch. The local side enumerates the
// ignored files present in the worktree with `ls-files --others
// --ignored --exclude-standard -z`, so no pathspec parsing and no
// filesystem walk is involved: names holding glob characters, `:(`
// pathspec magic, invalid UTF-8, or symlinks compare literally, and a
// symlinked prefix cannot poison the probe. The listing is streamed
// entry-by-entry: a worktree whose ignored listing exceeds
// runGitBuffer's cap must still be pullable. Keys compare as raw bytes,
// folded case-wise when the repository says the filesystem folds
// (core.ignorecase): a case-variant incoming path is the same file
// there, and git's own ignore matching folds too, so nothing else
// catches the overwrite. A collision is an exact match or a
// segment-boundary prefix in either direction: an ignored file `docs`
// blocks an incoming `docs/guide.md`, and an incoming file `dist`
// replaces an ignored `dist/` with everything inside it. A rebase
// replays the local commits on top of the fetched tip, so the paths
// their commits write join the incoming set — including paths a later
// local commit untracked again, which the net range diff no longer
// shows but the replay still checks out over the worktree.
async function incomingIgnoredPaths(
  cwd: string,
  fetchedTip: string,
  includeReplayedAdditions: boolean,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<Buffer[]> {
  // No catches below: a probe failure (index.lock contention with a
  // concurrent git process, the 30s timeout, a git fatal) must refuse the
  // pull instead of masquerading as "no collision" and letting an
  // overwriting merge through. The caller classifies these like any other
  // pull failure.
  const toplevel = (
    await runGit(cwd, ['rev-parse', '--show-toplevel'], env)
  ).trim();
  // rev-parse -q --verify exits 1 on an unborn HEAD (a zero-commit
  // branch with a configured upstream); merge-base would fatal there.
  const headExists = await hasForeignHead(toplevel, 'HEAD', env);
  const base = headExists
    ? (await runGit(toplevel, ['merge-base', 'HEAD', fetchedTip], env)).trim()
    : EMPTY_TREE_SHA;
  const foldCase = await repoFoldsCase(toplevel, env);
  const additions = splitBuffer(
    await runGitBuffer(
      toplevel,
      [
        'diff',
        '--no-renames',
        '--diff-filter=d',
        '--name-only',
        '-z',
        base,
        fetchedTip,
      ],
      env,
    ),
    0,
  );
  // An unborn branch has no local commits to replay.
  if (includeReplayedAdditions && headExists) {
    additions.push(
      ...splitBuffer(
        await runGitBuffer(
          toplevel,
          [
            'log',
            '--no-renames',
            '--diff-filter=d',
            '--name-only',
            '--format=',
            '-z',
            `${base}..HEAD`,
          ],
          env,
        ),
        0,
      ),
    );
  }
  if (additions.length === 0) return [];
  const ignoredFiles = new Set<string>();
  const ignoredDirs = new Set<string>();
  await streamIgnoredListing(toplevel, env, (entry) => {
    // Collapsed directory entries (a nested repository under an ignored
    // path) carry a trailing slash; strip it so the entry compares like
    // its path.
    let key = collisionKey(entry, foldCase);
    if (key.endsWith('/')) key = key.slice(0, -1);
    ignoredFiles.add(key);
    for (
      let slash = key.indexOf('/');
      slash !== -1;
      slash = key.indexOf('/', slash + 1)
    ) {
      ignoredDirs.add(key.slice(0, slash));
    }
  });
  return findIgnoredCollisions(additions, ignoredFiles, ignoredDirs, foldCase);
}

// 'binary' maps bytes 1:1 onto code units, unlike UTF-8 which corrupts
// invalid sequences to U+FFFD. Folding applies only when the repository
// says the filesystem folds case.
function collisionKey(raw: Buffer, foldCase: boolean): string {
  const key = raw.toString('binary');
  return foldCase ? key.toLowerCase() : key;
}

function findIgnoredCollisions(
  additions: Buffer[],
  ignoredFiles: ReadonlySet<string>,
  ignoredDirs: ReadonlySet<string>,
  foldCase: boolean,
): Buffer[] {
  return additions.filter((addition) => {
    const key = collisionKey(addition, foldCase);
    // Exact match, or the incoming file sits where an ignored directory's
    // contents live.
    if (ignoredFiles.has(key) || ignoredDirs.has(key)) return true;
    // An ignored file sits at a directory prefix of the incoming path.
    for (
      let slash = key.indexOf('/');
      slash !== -1;
      slash = key.indexOf('/', slash + 1)
    ) {
      if (ignoredFiles.has(key.slice(0, slash))) return true;
    }
    return false;
  });
}

// Fail closed: an unreadable ignorecase setting assumes a folding
// filesystem, which only widens the refusal set.
async function repoFoldsCase(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  const value = (
    await runGit(
      cwd,
      ['config', '--default=false', 'core.ignorecase'],
      env,
    ).catch(() => 'true')
  ).trim();
  return value === 'true';
}

// Streams the ignored listing entry-by-entry instead of buffering it:
// workspaces whose listing exceeds runGitBuffer's fixed maxBuffer must
// not die in the probe. Non-zero exits and timeouts reject, refusing the
// pull like any other probe failure.
function streamIgnoredListing(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  onEntry: (entry: Buffer) => void,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      'git',
      ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
      { cwd, env: gitEnv(env) },
    );
    let rest: Buffer | undefined;
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`git ls-files timed out after ${GIT_TIMEOUT_MS}ms`));
    }, GIT_TIMEOUT_MS);
    child.stdout?.on('data', (chunk: Buffer) => {
      const buf = rest === undefined ? chunk : Buffer.concat([rest, chunk]);
      let start = 0;
      for (let nul = buf.indexOf(0); nul !== -1; nul = buf.indexOf(0, start)) {
        if (nul > start) onEntry(buf.subarray(start, nul));
        start = nul + 1;
      }
      rest = start < buf.length ? buf.subarray(start) : undefined;
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(stderr.trim() || `git ls-files exited with code ${code}`),
        );
        return;
      }
      if (rest !== undefined && rest.length > 0) onEntry(rest);
      resolve();
    });
  });
}

function refusedIgnoredCollision(paths: Buffer[]): GitPullFailure {
  const names = paths.map((p) => p.toString('utf8')).join(', ');
  return new GitPullFailure(
    'ignored_collision',
    `cannot pull: the incoming changes add files that exist locally as ignored files and would be overwritten silently: ${names}`,
  );
}

// Names where the unrestored changes live when a failure-recovery stash
// pop fails; without the pointer the edits sit in refs/stash invisibly.
// Typed failures carry the structured flag (the route serializes the
// note outside the capped message); untyped ones keep it in the text.
function withStashRestoreNote(failure: unknown): unknown {
  if (failure instanceof GitPullFailure) {
    return new GitPullFailure(
      failure.code,
      failure.message,
      failure.unmerged,
      true,
    );
  }
  return new Error(`${gitFailureDetail(failure).trim()} ${STASH_RESTORE_NOTE}`);
}

function gitFailureDetail(err: unknown): string {
  if (err && typeof err === 'object' && ('stdout' in err || 'stderr' in err)) {
    const e = err as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// Concurrent pulls on one repository cross-apply each other's auto-stashes
// (they share the single refs/stash LIFO), and one pull's failure recovery
// aborts the merge or rebase another pull started. Serialize pulls per
// repository identity with a promise chain: everything the lock protects is
// repository-wide, while the same repository can be addressed through any of
// its subdirectories (or a symlinked path), so keying on the resolved cwd
// would hand two paths into one repository independent chains.
const pullLocks = new Map<string, Promise<void>>();

async function pullLockKey(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  // --git-common-dir prints relative to cwd for the common case and is
  // shared by linked worktrees. No catch: a pull whose repository
  // identity cannot be probed cannot be serialized against concurrent
  // pulls on the same repository, so a probe failure refuses the pull
  // instead of falling back to the per-cwd key — the exact key shape
  // that hands two paths into one repository independent chains.
  const commonDir = (
    await runGit(cwd, ['rev-parse', '--git-common-dir'], env)
  ).trim();
  const abs = path.resolve(cwd, commonDir);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function withPullLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pullLocks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  pullLocks.set(key, tail);
  void tail.then(() => {
    if (pullLocks.get(key) === tail) {
      pullLocks.delete(key);
    }
  });
  return run;
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

// Probe errors fail closed: reading a failed probe as "no foreign state"
// would admit the pull into a foreign merge/rebase that the failure
// recovery then destroys. Exit 1 is rev-parse's legitimate "absent"
// answer; every other error refuses the pull.
async function hasForeignHead(
  cwd: string,
  head: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<boolean> {
  try {
    await runGit(cwd, ['rev-parse', '-q', '--verify', head], env);
    return true;
  } catch (err) {
    if ((err as { code?: number })?.code !== 1) throw err;
    return false;
  }
}

// Throws when a merge, rebase, cherry-pick, or revert this pull did not
// start is in progress. A conflict-resolved-and-staged cherry-pick or
// revert carries no MERGE_HEAD or rebase state dir, yet `stash push` and
// `reset --hard` both abandon it and the staged resolution blob is
// unrecoverable by reflog, so the guard covers those heads too.
async function refuseForeignMergeOrRebase(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  if (await hasForeignHead(cwd, 'MERGE_HEAD', env)) {
    throw new GitPullFailure(
      'merge_in_progress',
      'cannot pull: a merge is already in progress — finish or abort it before updating',
    );
  }
  if (
    (await hasForeignHead(cwd, 'CHERRY_PICK_HEAD', env)) ||
    (await hasForeignHead(cwd, 'REVERT_HEAD', env))
  ) {
    throw new GitPullFailure(
      'merge_in_progress',
      'cannot pull: a cherry-pick or revert is already in progress — finish or abort it before updating',
    );
  }
  if ((await inProgressRebaseDir(cwd, env)) !== '') {
    throw new GitPullFailure(
      'rebase_in_progress',
      'cannot pull: a rebase is already in progress — finish or abort it before updating',
    );
  }
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
  return withPullLock(await pullLockKey(cwd, env), () =>
    gitPullInner(cwd, opts, env),
  );
}

async function gitPullInner(
  cwd: string,
  opts?: GitPullOptions,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<GitPullResult> {
  if (opts?.fetchOnly) {
    const output = await runGit(cwd, ['fetch', '--all', '--prune'], env);
    return { success: true, output: output.trim() };
  }
  // A pull must never run into a merge or rebase that predates it: the
  // failure recovery below aborts merge/rebase state indiscriminately and
  // would destroy the user's in-progress operation, stranding any
  // auto-stashed changes. This guard is also what makes that recovery safe
  // — any state it aborts was started by this pull. A concurrent actor can
  // create state at any point, so the mutating steps below re-run it.
  await refuseForeignMergeOrRebase(cwd, env);
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
  }
  // Fetch once, then probe and merge exactly the fetched tip. A bare
  // `git pull` would re-fetch and merge whatever arrives between the probe
  // and the merge, bypassing the collision probe; on the force path that
  // re-fetch could also fail after the local changes were already
  // discarded.
  await runGit(cwd, ['fetch'], env);
  // The update merges/rebases exactly this tip; the failure recovery
  // below compares any in-progress state against it to tell state this
  // pull started from a concurrent actor's.
  const fetchedTip = (await runGit(cwd, ['rev-parse', '@{u}'], env)).trim();
  if (opts?.force) {
    // Without a catch: a missing upstream must surface here, before
    // anything is discarded. A diverged branch is refused because the
    // post-discard merge would have to merge the local commits and could
    // wedge the repository mid-merge. An unborn HEAD has no local
    // commits, so ahead is 0 by definition and the divergence refusal
    // cannot apply — rev-list would only fatal on the missing ref.
    if (await hasForeignHead(cwd, 'HEAD', env)) {
      const countsRaw = (
        await runGit(
          cwd,
          ['rev-list', '--left-right', '--count', `HEAD...${fetchedTip}`],
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
    }
  }
  // Every pull shape refuses an incoming collision with local ignored
  // files: ignored paths never appear in `git status`, so the plain path
  // reads clean and would silently check the incoming file out over the
  // local one. Probe failures must refuse the pull, not read as "no
  // collision" (see incomingIgnoredPaths).
  let ignored: Buffer[];
  try {
    ignored = await incomingIgnoredPaths(
      cwd,
      fetchedTip,
      opts?.rebase === true,
      env,
    );
  } catch (err) {
    throw await classifyPullFailure(cwd, env, err, opts?.stash === true);
  }
  if (ignored.length > 0) {
    throw refusedIgnoredCollision(ignored);
  }
  let stashed = false;
  let stashedSha = '';
  if (opts?.force) {
    await refuseForeignMergeOrRebase(cwd, env);
    await runGit(cwd, ['reset', '--hard'], env);
    await runGit(cwd, ['clean', '-fd'], env);
  } else if (opts?.stash) {
    await refuseForeignMergeOrRebase(cwd, env);
    // An unborn HEAD cannot be stashed (no initial commit yet) and
    // has no tracked changes to protect: the merge refuses to
    // overwrite an untracked file on its own, so pull through
    // without a stash.
    if (await hasForeignHead(cwd, 'HEAD', env)) {
      // Compare refs/stash before/after instead of parsing the push output,
      // which differs between git versions and locales.
      const before = await currentStashSha(cwd, env);
      try {
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
      } catch (err) {
        // Git creates the stash commit, updates refs/stash, and only then
        // resets the worktree, so a failed push can leave the entry behind
        // with the changes gone from the worktree. Pop it back before
        // refusing; classify from repository state, since the push's own
        // error text (e.g. "needs merge") is version- and locale-dependent.
        let stashStateUnknown = false;
        const afterPush = await currentStashSha(cwd, env).catch(() => {
          // The push failed mid-way: whether it managed to create an entry
          // is now unknown, and a created one may hold the user's changes.
          // Flag the restore like a failed pop-back instead of leaking a
          // bare probe error with no pointer.
          stashStateUnknown = true;
          return '';
        });
        let popBackFailed = false;
        if (afterPush !== '' && afterPush !== before) {
          await runGit(cwd, ['stash', 'pop'], env).catch((popErr) => {
            popBackFailed = true;
            // eslint-disable-next-line no-console
            console.error(
              'git pull: failed to pop back a partially created auto-stash:',
              popErr,
            );
          });
        }
        const failure = await classifyPullFailure(cwd, env, err, true);
        // A failed pop-back leaves the changes in the kept entry; name it,
        // like every sibling restore-failure path. An unreadable stash
        // state after a failed push may hold them too.
        throw popBackFailed || stashStateUnknown
          ? withStashRestoreNote(failure)
          : failure;
      }
      const after = await currentStashSha(cwd, env).catch((probeErr) => {
        // The push succeeded, so an entry exists but its identity is
        // unreadable: the restore below could not tell it apart from a
        // concurrent actor's. Refuse with the stash pointer instead of
        // leaking a bare probe error while the edits sit in refs/stash.
        throw withStashRestoreNote(probeErr);
      });
      stashed = after !== '' && after !== before;
      stashedSha = stashed ? after : '';
    }
  }
  // Merge or rebase exactly the probed tip. --no-autostash neutralizes
  // ambient merge.autostash/rebase.autostash config: an auto-stash inside
  // the update can exit 0 on a pop conflict, leaving conflict markers in
  // the tree and the user's changes stranded in a stash entry the caller
  // never learns about.
  let output: string;
  let restoreFailed = false;
  try {
    // Re-run the guard immediately before the update: merge/rebase state
    // that appeared since the pre-fetch check belongs to a concurrent
    // actor. The recovery below aborts whatever state exists, which is
    // only safe for state this pull started — so refuse here (restoring
    // the auto-stash) instead of merging into the foreign state.
    await refuseForeignMergeOrRebase(cwd, env);
    output = await runGit(
      cwd,
      opts?.rebase
        ? ['rebase', '--no-autostash', fetchedTip]
        : ['merge', '--no-edit', '--no-autostash', fetchedTip],
      env,
    );
  } catch (err) {
    const foreignState =
      err instanceof GitPullFailure &&
      (err.code === 'merge_in_progress' || err.code === 'rebase_in_progress');
    if (stashed || opts?.force) {
      if (!foreignState) {
        // Never leave the repository wedged mid-merge: abort the partial
        // merge/rebase this update started (restoring the pre-pull HEAD) —
        // and only that. The guard re-ran immediately before the update,
        // but a concurrent actor can still create state in the window
        // between the two; the update then fails fast without touching the
        // foreign state, and aborting it would destroy the actor's work.
        // Identify ours first: a merge this pull started wrote the
        // fetched tip to MERGE_HEAD, and a rebase it started wrote it to
        // the state directory's `onto` file.
        if (!opts?.rebase) {
          const mergeHead = (
            await runGit(
              cwd,
              ['rev-parse', '-q', '--verify', 'MERGE_HEAD'],
              env,
            ).catch(() => '')
          ).trim();
          if (mergeHead !== '' && mergeHead === fetchedTip) {
            await runGit(cwd, ['merge', '--abort'], env).catch((abortErr) => {
              // eslint-disable-next-line no-console
              console.error(
                'git pull recovery: merge --abort failed:',
                abortErr,
              );
            });
          }
        } else {
          const rebaseDir = await inProgressRebaseDir(cwd, env).catch(() => '');
          if (rebaseDir !== '') {
            let onto = '';
            try {
              onto = fs
                .readFileSync(path.join(rebaseDir, 'onto'), 'utf8')
                .trim();
            } catch {
              // A state directory without an `onto` file is not one this
              // update created.
            }
            if (onto === fetchedTip) {
              await runGit(cwd, ['rebase', '--abort'], env).catch(
                (abortErr) => {
                  // eslint-disable-next-line no-console
                  console.error(
                    'git pull recovery: rebase --abort failed:',
                    abortErr,
                  );
                },
              );
            }
          }
        }
      }
      if (stashed) {
        // Bring the stashed changes back. A failed restore leaves the
        // stash entry in place, so nothing is lost either way. Pop only
        // the entry this pull created: the lock does not cover the user's
        // terminal, so a concurrent `git stash` in the merge window
        // would otherwise be applied and dropped in its place.
        if (await stashTopIs(cwd, env, stashedSha)) {
          await runGit(cwd, ['stash', 'pop'], env).catch(() => {
            restoreFailed = true;
          });
        } else {
          restoreFailed = true;
        }
      }
    }
    const failure = await classifyPullFailure(
      cwd,
      env,
      err,
      opts?.stash === true,
    );
    throw restoreFailed ? withStashRestoreNote(failure) : failure;
  }
  if (stashed) {
    let stashRestoreConflict = false;
    let popOutput: string;
    // Pop only the entry this pull created (see the failure-recovery
    // pop): on a mismatch the edits stay in the kept entry and the note
    // names them, instead of a foreign stash being applied and dropped.
    if (await stashTopIs(cwd, env, stashedSha)) {
      popOutput = await runGit(cwd, ['stash', 'pop'], env).catch((popErr) => {
        // A failed pop always keeps the stash entry and leaves the changes
        // unrestored — conflict markers, or an untracked-file collision — so
        // flag it instead of failing an otherwise successful pull.
        stashRestoreConflict = true;
        const e = popErr as { stdout?: string; stderr?: string };
        return `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
      });
    } else {
      stashRestoreConflict = true;
      popOutput = STASH_RESTORE_NOTE;
    }
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

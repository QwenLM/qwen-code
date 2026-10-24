/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import {
  HOSTNAME_RE,
  isOwnerRepo,
  normalizeGhHostForUrl,
} from '../review/lib/gh.js';
import { normalizeSegment } from '../review/lib/remote-match.js';

export const REPLY_MARKER = '<!-- qwen-autofix-pr:v1 -->';

export interface AutofixPrState {
  version: 1;
  /** Session that owns the watch; '' when created outside a Qwen session. */
  sessionId: string;
  host: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** Local remote serving the base repository. */
  remote: string;
  /** Remote name or URL that receives pushes to the PR head. */
  pushTarget: string;
  headRefName: string;
  baseRefName: string;
  branch: string;
  worktreePath: string;
  viewer: string;
  prAuthor: string;
  lastKnownHeadSha: string;
  pushedShas: string[];
  /** GraphQL node ids of comments and reviews already acted on. */
  handledCommentIds: string[];
  /** GraphQL node ids of comments this tool posted. */
  postedCommentIds: string[];
  // The fields below are written by `push`, `reply`, `rerun` and `sync`, and
  // are absent from a state file no reaction has touched yet.
  /** `<check>@<headSha>@<attempt>` of failures handled without a push (declined,
   * left for a human, or re-run), keyed like the gate cursor's checks. */
  handledChecks?: string[];
  /** `<identity>@<headSha>@<check run id>` of checks re-run once already,
   * with the check run a later run must come after to be the re-run's
   * answer; the failure of such a run on that head is treated as real. A
   * re-run a deferral holds is in `heldChecks` until it is spent. */
  rerunChecks?: string[];
  /** Head SHA whose merge conflict was left for a human. */
  handledConflictSha?: string | null;
  /** Pushes made by this watch. */
  pushCount?: number;
  /** Head SHA the last round summary was posted for. */
  summarizedSha?: string;
  /** Whether the PR author could push to the base repository (`prepare`). */
  authorCanPush?: boolean;
  /** Runs `rerun` was asked for while they were still in progress. */
  deferredRuns?: number[];
  /** `<run id>:<identity>@<headSha>@<check run id>` of the re-runs a
   * deferral holds for its run until it ends, apart from the ones spent
   * (`rerunChecks`): only the run that holds one may spend it, and a later
   * run of the check answers for it. */
  heldChecks?: string[];
  /** Replies `reply` is about to post, written before each POST: one whose
   * answer is lost is recognized on the PR by these, never by a new plan. */
  pendingPosts?: PendingPost[];
}

export interface PendingPost {
  /** A review thread's `replyTo`, or `summary` for the PR comment. */
  where: number | 'summary';
  handled: string[];
  /** sha256 of the body as posted, marker included. */
  bodyHash: string;
  /** The head the reply was posted on: a summary reports that head's push. */
  sha: string;
}

/**
 * What a watch posted and handled, kept by `cleanup` after the state file
 * is gone: a later watch of the same PR starts from it, so it neither
 * answers the same comments again nor re-runs a check twice on one head.
 */
export interface AutofixPrHistory {
  version: 1;
  host: string;
  owner: string;
  repo: string;
  prNumber: number;
  handledCommentIds: string[];
  postedCommentIds: string[];
  handledChecks: string[];
  rerunChecks: string[];
  handledConflictSha?: string | null;
  /** Replies announced but not settled when the watch ended: the next watch
   * recognizes those that reached the PR. */
  pendingPosts?: PendingPost[];
  deferredRuns?: number[];
  heldChecks?: string[];
}

/** The re-run floors of a watch, spent and held alike: a later run of a
 * check is the answer to either (`<identity>@<headSha>@<check run id>`). */
export function rerunFloors(state: {
  rerunChecks?: string[];
  heldChecks?: string[];
}): string[] {
  return [
    ...(state.rerunChecks ?? []),
    ...(state.heldChecks ?? []).map((entry) => entry.replace(/^\d+:/, '')),
  ];
}

/** Pushes one watch may make before it stops (Section 10 of the design). */
export const MAX_PUSHES = 10;

/** Key of one failed attempt of a check on a head, as the gate cursor keys it. */
export function checkAttemptKey(
  check: string,
  headSha: string,
  attempt: string,
): string {
  return `${check}@${headSha}@${attempt}`;
}

/**
 * Cursor of `snapshot --gate`: what the probe has already reported, so a
 * fire wakes the session only for a transition. Independent of the prepared
 * state file — a gate needs no worktree — and never moved by push or reply.
 */
export interface AutofixPrGateCursor {
  version: 1;
  host: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** The `gh` identity; its own comments are never events. */
  viewer: string;
  prAuthor: string;
  /** Head SHA seen by the previous run; a different one is `head_moved`. */
  headSha: string | null;
  /** GraphQL node ids of comments and reviews already reported, newest last.
   * Ids the query still returns are always kept; the rest are bounded. */
  reportedCommentIds: string[];
  /** `<check>@<headSha>@<attempt>` of failures already reported on the
   * current head. The attempt is the check run's id (`#<databaseId>`) or the
   * commit status's creation time, so a re-run that fails again is new. */
  reportedChecks: string[];
  /** Head SHA whose merge conflict was reported; null while mergeable. */
  conflictSha: string | null;
  /** Set once a merge or close was reported; the probe is quiet afterwards. */
  stopped: 'merged' | 'closed' | null;
  /** Connections the previous run found cut; a new cut is reported once. */
  reportedTruncated: string[];
  /** `<identity>@<headSha>~<check run id>`: the latest run of each check the
   * last read of every check run listed. A read the time cut keeps it, and
   * reports no failure of an earlier run. */
  latestChecks?: string[];
}

export interface AutofixPrPaths {
  worktreePath: string;
  statePath: string;
  /** `snapshot --gate` cursor; separate from the state file on purpose. */
  gatePath: string;
  /** The last prepared snapshot, whole: too long for a line of output. */
  snapshotPath: string;
  /** What GitHub said of bot comments: whether each answers another. */
  repliesPath: string;
  /** Held while a helper reads and writes the state file. */
  lockPath: string;
  branch: string;
}

/**
 * The root of the clone's main worktree. Branches are shared by every
 * worktree of a clone, so a watch belongs to the clone rather than to the
 * worktree a helper runs from, the autofix worktree itself included.
 */
export { repoRoot } from '../review/lib/git.js';

/** Throws unless `value` is a positive integer; `what` names it. */
export function assertPositiveInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${what} must be a positive integer, got ${value}`);
  }
}

export function autofixPrPaths(root: string, prNumber: number): AutofixPrPaths {
  // The number goes into file names, the branch name and `refs/pull/<n>/head`.
  assertPositiveInteger(prNumber, 'PR number');
  const tmp = join(root, '.qwen', 'tmp');
  return {
    worktreePath: join(tmp, `autofix-pr-${prNumber}`),
    statePath: join(tmp, `autofix-pr-${prNumber}-state.json`),
    gatePath: join(tmp, `autofix-pr-${prNumber}-gate.json`),
    snapshotPath: join(tmp, `autofix-pr-${prNumber}-snapshot.json`),
    repliesPath: join(tmp, `autofix-pr-${prNumber}-replies.json`),
    // Not `autofix-pr-<n>-…`: cleanup's sweep of the watch's files must not
    // take a lock another helper holds.
    lockPath: join(tmp, `autofix-pr-${prNumber}.lock`),
    branch: `qwen-autofix/pr-${prNumber}`,
  };
}

export function readGateCursor(gatePath: string): AutofixPrGateCursor | null {
  if (!existsSync(gatePath)) return null;
  const parsed = JSON.parse(
    readFileSync(gatePath, 'utf8'),
  ) as AutofixPrGateCursor;
  if (parsed.version !== 1) {
    throw new Error(
      `unsupported autofix-pr gate cursor version in ${gatePath}: ${String(parsed.version)}`,
    );
  }
  return { ...parsed, reportedTruncated: parsed.reportedTruncated ?? [] };
}

export function writeGateCursor(
  gatePath: string,
  cursor: AutofixPrGateCursor,
): void {
  atomicWriteFileSync(gatePath, `${JSON.stringify(cursor, null, 2)}\n`);
}

/**
 * Whether two `host/owner/repo` triples name the same repository. GitHub
 * compares owner and repository names without case. The hosts are API
 * hosts: case, a trailing dot and the default port do not change the
 * instance, but any other port may name another one, so it is kept (unlike
 * remote matching, where a Git transport's port says nothing about the API).
 */
export function sameRepository(
  a: { host: string; owner: string; repo: string },
  b: { host: string; owner: string; repo: string },
): boolean {
  return (
    normalizeGhHostForUrl(a.host) === normalizeGhHostForUrl(b.host) &&
    normalizeSegment(a.owner) === normalizeSegment(b.owner) &&
    normalizeSegment(a.repo) === normalizeSegment(b.repo)
  );
}

const SHA_RE = /^[0-9a-f]{40,64}$/;

/**
 * A branch name git accepts (`git check-ref-format --branch`), checked
 * without running git. The name reaches git inside refspecs, where a `:`
 * would name a second ref to write and a `*` a pattern.
 */
export function isBranchName(name: string): boolean {
  return !(
    name === '' ||
    name === '@' ||
    name.startsWith('-') ||
    name.endsWith('/') ||
    name.endsWith('.') ||
    // Control characters and space, and the characters git reserves.
    [...name].some((char) => char.charCodeAt(0) <= 0x20 || char === '\x7f') ||
    /[~^:?*[\\]/.test(name) ||
    name.includes('..') ||
    name.includes('@{') ||
    name.includes('//') ||
    name
      .split('/')
      .some((part) => part.startsWith('.') || part.endsWith('.lock'))
  );
}

/** What a POSIX shell gives a meaning to, beyond what git refuses in a ref. */
const SHELL_SPECIAL = /[;&|$`<>()'"{}!#]/;

/**
 * Whether a name can go into a shell command as it is: the round's brief has
 * the fix agent fetch and merge `<remote>/<baseRefName>`.
 */
export function isCommandSafeName(name: string): boolean {
  return !SHELL_SPECIAL.test(name);
}

/** The strings of a list read from a file, or [] for anything else. */
export function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

const isRunList = (value: unknown): value is number[] =>
  Array.isArray(value) && value.every((item) => Number.isInteger(item));

function isPendingPost(value: unknown): value is PendingPost {
  const post = value as PendingPost | null;
  return (
    typeof post === 'object' &&
    post !== null &&
    (post.where === 'summary' || Number.isInteger(post.where)) &&
    isStringList(post.handled) &&
    typeof post.bodyHash === 'string' &&
    typeof post.sha === 'string'
  );
}

/**
 * Why a state file's values cannot be handed to git and gh as they are, or
 * null. The helpers pass the remote, the push target, the head ref and the
 * SHAs as arguments: a value starting with `-` would be read as an option
 * (`--upload-pack=<command>` runs a command), so whatever wrote the file —
 * by hand or through a tool — cannot widen what a helper does.
 */
export function stateDefect(state: AutofixPrState): string | null {
  const word = (value: unknown) =>
    typeof value === 'string' && value !== '' && !value.startsWith('-');
  if (
    !word(state.remote) ||
    !isBranchName(state.remote) ||
    !isCommandSafeName(state.remote)
  ) {
    return 'remote';
  }
  if (!word(state.pushTarget)) return 'pushTarget';
  if (!word(state.headRefName) || !isBranchName(state.headRefName)) {
    return 'headRefName';
  }
  if (
    !word(state.baseRefName) ||
    !isBranchName(state.baseRefName) ||
    !isCommandSafeName(state.baseRefName)
  ) {
    return 'baseRefName';
  }
  if (!isOwnerRepo(`${state.owner}/${state.repo}`)) return 'owner/repo';
  if (typeof state.host !== 'string' || !HOSTNAME_RE.test(state.host)) {
    return 'host';
  }
  if (!Number.isInteger(state.prNumber) || state.prNumber < 1) {
    return 'prNumber';
  }
  if (
    typeof state.lastKnownHeadSha !== 'string' ||
    !SHA_RE.test(state.lastKnownHeadSha)
  ) {
    return 'lastKnownHeadSha';
  }
  if (
    !Array.isArray(state.pushedShas) ||
    !state.pushedShas.every(
      (sha) => typeof sha === 'string' && SHA_RE.test(sha),
    )
  ) {
    return 'pushedShas';
  }
  // Lists the helpers spread and look up: anything else would fail them
  // halfway through, or count a budget wrong.
  if (!isStringList(state.handledCommentIds)) return 'handledCommentIds';
  if (!isStringList(state.postedCommentIds)) return 'postedCommentIds';
  if (state.handledChecks !== undefined && !isStringList(state.handledChecks)) {
    return 'handledChecks';
  }
  if (state.rerunChecks !== undefined && !isStringList(state.rerunChecks)) {
    return 'rerunChecks';
  }
  if (state.deferredRuns !== undefined && !isRunList(state.deferredRuns)) {
    return 'deferredRuns';
  }
  if (state.heldChecks !== undefined && !isStringList(state.heldChecks)) {
    return 'heldChecks';
  }
  if (
    state.pendingPosts !== undefined &&
    !(
      Array.isArray(state.pendingPosts) &&
      state.pendingPosts.every(isPendingPost)
    )
  ) {
    return 'pendingPosts';
  }
  if (
    state.pushCount !== undefined &&
    !(Number.isInteger(state.pushCount) && state.pushCount >= 0)
  ) {
    return 'pushCount';
  }
  return null;
}

export function readState(statePath: string): AutofixPrState | null {
  if (!existsSync(statePath)) return null;
  const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as AutofixPrState;
  if (parsed.version !== 1) {
    throw new Error(
      `unsupported autofix-pr state version in ${statePath}: ${String(parsed.version)}`,
    );
  }
  const defect = stateDefect(parsed);
  if (defect) {
    throw new Error(
      `${statePath} has an invalid ${defect}; run \`qwen autofix-pr cleanup ${String(parsed.prNumber)} --force\` and prepare the watch again.`,
    );
  }
  return parsed;
}

export function writeState(statePath: string, state: AutofixPrState): void {
  atomicWriteFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Where the history of a PR of one repository is kept. One clone can watch
 * PRs of the same number in several repositories (a fork and its upstream),
 * so the file is named after the repository as well.
 */
export function historyPath(
  paths: AutofixPrPaths,
  repository: { host: string; owner: string; repo: string },
): string {
  // `+` and `@` appear in no host, owner or repository name, so every
  // repository has a name of its own; `.history.json` keeps the name from
  // ever ending like a file the skill may write (`-plan.json`).
  const slug = [
    normalizeGhHostForUrl(repository.host).replace(/:/g, '@'),
    normalizeSegment(repository.owner),
    normalizeSegment(repository.repo),
  ]
    .join('+')
    .replace(/[^a-z0-9._@+-]/g, '_');
  return join(
    dirname(paths.statePath),
    `${historyPrefix(paths)}${slug}.history.json`,
  );
}

/** Every history file of the PR's number starts with this. */
export function historyPrefix(paths: AutofixPrPaths): string {
  return basename(paths.statePath).replace(/-state\.json$/, '-history-');
}

export function readHistory(path: string): AutofixPrHistory | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as AutofixPrHistory;
  if (parsed.version !== 1) {
    throw new Error(
      `unsupported autofix-pr history version in ${path}: ${String(parsed.version)}`,
    );
  }
  // A field that is not what it should be is dropped, not the history: the
  // rest still keeps a later watch from answering or re-running twice.
  return {
    ...parsed,
    handledCommentIds: stringList(parsed.handledCommentIds),
    postedCommentIds: stringList(parsed.postedCommentIds),
    handledChecks: stringList(parsed.handledChecks),
    rerunChecks: stringList(parsed.rerunChecks),
    handledConflictSha:
      typeof parsed.handledConflictSha === 'string' &&
      SHA_RE.test(parsed.handledConflictSha)
        ? parsed.handledConflictSha
        : null,
    pendingPosts: Array.isArray(parsed.pendingPosts)
      ? parsed.pendingPosts.filter(isPendingPost)
      : [],
    deferredRuns: Array.isArray(parsed.deferredRuns)
      ? parsed.deferredRuns.filter((run) => Number.isInteger(run))
      : [],
    heldChecks: stringList(parsed.heldChecks),
  };
}

/** Adds what a watch's state posted and handled to its PR's history. */
export function keepHistory(
  paths: AutofixPrPaths,
  state: AutofixPrState,
): string {
  const path = historyPath(paths, state);
  let earlier: AutofixPrHistory | null = null;
  try {
    earlier = readHistory(path);
  } catch {
    // An unreadable history is replaced rather than blocking cleanup.
  }
  if (earlier && !sameRepository(earlier, state)) earlier = null;
  const union = (a: unknown, b: unknown) => [
    ...new Set([...stringList(a), ...stringList(b)]),
  ];
  const history: AutofixPrHistory = {
    version: 1,
    host: state.host,
    owner: state.owner,
    repo: state.repo,
    prNumber: state.prNumber,
    handledCommentIds: union(
      earlier?.handledCommentIds,
      state.handledCommentIds,
    ),
    postedCommentIds: union(earlier?.postedCommentIds, state.postedCommentIds),
    handledChecks: union(earlier?.handledChecks, state.handledChecks),
    rerunChecks: union(earlier?.rerunChecks, state.rerunChecks),
    handledConflictSha:
      state.handledConflictSha ?? earlier?.handledConflictSha ?? null,
    // The watch's own lists: `prepare` started it from the history, and
    // `reply` and `rerun` have settled what they could since. Merging the
    // history in again would bring back what was settled.
    pendingPosts: state.pendingPosts ?? earlier?.pendingPosts ?? [],
    deferredRuns: state.deferredRuns ?? earlier?.deferredRuns ?? [],
    heldChecks: state.heldChecks ?? earlier?.heldChecks ?? [],
  };
  atomicWriteFileSync(path, `${JSON.stringify(history, null, 2)}\n`);
  return path;
}

/**
 * Longer than any helper may run (a push waits up to nine minutes for its
 * hooks, inside the shell tool's ten), so a lock this old is left over.
 */
const LOCK_STALE_MS = 15 * 60_000;

interface LockToken {
  pid: number;
  /** The pid namespace: a pid means something only inside its own. */
  ns: string | null;
  at: number;
  id: string;
}

function pidNamespace(): string | null {
  try {
    return readlinkSync('/proc/self/ns/pid');
  } catch {
    return null;
  }
}

/**
 * Whether a lock was left by a helper that is gone. A sandbox may run each
 * command in a pid namespace of its own, where pids repeat and pid 1 is
 * always alive, so the holder's pid is asked only from the same namespace;
 * otherwise a lock is stale once it is older than any helper runs.
 */
function lockIsStale(raw: string, mtimeMs: number): boolean {
  let token: LockToken | null = null;
  try {
    token = JSON.parse(raw) as LockToken;
  } catch {
    // Unreadable: judged by its age alone.
  }
  const at = typeof token?.at === 'number' ? token.at : mtimeMs;
  if (Date.now() - at > LOCK_STALE_MS) return true;
  if (!token || token.ns !== pidNamespace()) return false;
  return !processAlive(token.pid);
}

/**
 * Runs `fn` holding the watch's lock, so two helpers never read and write
 * the state file at once (the model may issue tool calls in parallel): the
 * second would write back what it read and undo the first one's record of
 * a push, a reply or a re-run. The lock appears whole, through a hard link
 * of a file already written, and is removed only while it is still ours.
 */
export function withWatchLock<T>(
  paths: AutofixPrPaths,
  prNumber: number,
  fn: () => T,
): T {
  const lockPath = paths.lockPath;
  const token = JSON.stringify({
    pid: process.pid,
    ns: pidNamespace(),
    at: Date.now(),
    id: randomUUID(),
  } satisfies LockToken);
  const pending = `${lockPath}.${randomUUID()}`;
  writeFileSync(pending, token, { flag: 'wx' });
  try {
    for (let attempt = 0; ; attempt += 1) {
      if (takeLock(pending, lockPath, token)) break;
      if (attempt >= 4) {
        throw new Error(`could not take the lock ${lockPath}`);
      }
      let stat;
      try {
        stat = lstatSync(lockPath);
      } catch {
        continue; // Released meanwhile.
      }
      if (stat.isSymbolicLink()) {
        rmSync(lockPath, { force: true });
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(
          `${lockPath} is not a lock file; remove it, or run \`qwen autofix-pr cleanup ${prNumber} --force\`.`,
        );
      }
      let held: string;
      try {
        held = readFileSync(lockPath, 'utf8');
      } catch {
        continue; // Released meanwhile.
      }
      if (attempt === 0 && lockIsStale(held, stat.mtimeMs)) {
        if (breakStaleLock(lockPath, held, pending)) break;
        continue;
      }
      throw new Error(
        `another autofix-pr helper is working on PR #${prNumber}; run one at a time (a lock left by a helper that was killed expires after ${LOCK_STALE_MS / 60_000} minutes, or \`qwen autofix-pr cleanup ${prNumber} --force\` removes it).`,
      );
    }
  } finally {
    rmSync(pending, { force: true });
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(lockPath, 'utf8') === token) unlinkSync(lockPath);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Takes over a stale lock: under `<lock>.break`, so one helper at a time,
 * the lock still holding the stale token is replaced by `pending` (this
 * helper's own token) in one rename. The lock path never stands empty, so
 * no other helper can slip in between, and a fresh lock is never touched.
 * True when this helper now holds the lock.
 */
export function breakStaleLock(
  lockPath: string,
  stale: string,
  pending: string,
): boolean {
  const breaker = `${lockPath}.break`;
  if (!takeBreaker(breaker)) return false;
  try {
    let current: string;
    try {
      current = readFileSync(lockPath, 'utf8');
    } catch {
      return false; // Gone already: the caller takes it the usual way.
    }
    if (current !== stale) return false;
    renameSync(pending, lockPath);
    return true;
  } finally {
    rmSync(breaker, { force: true });
  }
}

/**
 * Takes `<lock>.break`. One left by a killed helper is cleared once it is a
 * minute old — either way from now, for a clock that is off — and taken.
 */
function takeBreaker(breaker: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(breaker, String(process.pid), { flag: 'wx' });
      return true;
    } catch {
      try {
        if (Math.abs(Date.now() - statSync(breaker).mtimeMs) <= 60_000) {
          return false;
        }
        rmSync(breaker, { force: true });
      } catch {
        // Gone: try again.
      }
    }
  }
  return false;
}

/** Creates the lock, or answers false when it exists. */
function takeLock(pending: string, lockPath: string, token: string): boolean {
  try {
    linkSync(pending, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
  }
  // No hard links on this file system: an exclusive create is still
  // exclusive, though its content lands a moment later.
  try {
    writeFileSync(lockPath, token, { flag: 'wx' });
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw err;
  }
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, under another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function currentSessionId(): string {
  return process.env['QWEN_CODE_SESSION_ID']?.trim() ?? '';
}

export function requireState(
  statePath: string,
  prNumber: number,
): AutofixPrState {
  const state = readState(statePath);
  if (!state) {
    throw new Error(
      `PR #${prNumber} is not prepared here; run \`qwen autofix-pr prepare ${prNumber} --repo <owner>/<repo>\` first.`,
    );
  }
  return state;
}

export function assertOwnedBySession(state: AutofixPrState): void {
  const sessionId = currentSessionId();
  if (state.sessionId !== sessionId) {
    throw new Error(
      `PR #${state.prNumber} is watched by another session ` +
        `(${state.sessionId || 'no session'}). Stop it there, or run ` +
        `\`qwen autofix-pr cleanup ${state.prNumber} --force\` to discard that watch.`,
    );
  }
}

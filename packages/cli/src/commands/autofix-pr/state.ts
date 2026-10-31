/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { isWithinRoot } from '../../config/path-comparison.js';
import {
  HOSTNAME_RE,
  isOwnerRepo,
  normalizeGhHostForUrl,
} from '../review/lib/gh.js';
import { git, gitOpt, repoRoot } from '../review/lib/git.js';
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
  /** `prepare --in-place`: the watch fixes in the user's own checkout of
   * the head branch — `worktreePath` is that checkout and `branch` the head
   * branch itself. Attended, one round per start; no scheduled task, no
   * background fix, and no helper ever discards what the checkout holds. */
  inPlace?: true;
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
  /** The watch's scheduled task, recorded by `schedule`: a later session
   * starts the same task again from it (`/autofix-pr resume`). Absent for
   * `--once`, which schedules nothing. */
  watch?: AutofixPrWatchOptions;
  /** What rounds left for a person, newest last, for `status`. */
  needsHuman?: NeedsHumanItem[];
  /** The `needsHuman` lines a summary that reached the PR has reported, and
   * the head it reported them on. Kept apart from `needsHuman`, which is
   * recorded before any POST so `status` survives a later failure: this one
   * advances only on a delivered (or adopted) summary, so a report that never
   * arrived stays due on the next run. */
  reportedNeedsHuman?: { sha: string; texts: string[] };
  /** When `prepare` made this state (ISO 8601): a gate cursor older than
   * it is a former watch's, which `status` does not report. */
  preparedAt?: string;
  /** Set by a `cleanup` that kept the worktree: the watch is over, and the
   * helpers of its rounds refuse until a start (`prepare`) resumes it. */
  ended?: { at: string; reason: string };
}

export interface AutofixPrWatchOptions {
  /** Minutes between fires, one of `WATCH_INTERVALS`. */
  every: number;
  /** False with `--no-reply`: rounds record what they handled, posting nothing. */
  reply: boolean;
  /** The user's instructions for every round, on one line; '' for none. */
  instructions: string;
  /** The task that drives the watch, minted by every `schedule`: the gate of
   * any other task of the watch — a copy in a second process of the same
   * session, one a later start replaced — answers stop. */
  task?: string;
}

export interface NeedsHumanItem {
  /** The head the round answered it on. */
  sha: string;
  /** When `reply` recorded it (ISO 8601). */
  at: string;
  /** One line: what it is and what a person has to decide. */
  text: string;
}

/** The fire intervals a watch may use, in minutes (`--every`). */
export const WATCH_INTERVALS: readonly number[] = [1, 2, 5, 10, 15, 30, 60];

/** Items `needsHuman` keeps: the newest, as `status` lists them. */
export const MAX_NEEDS_HUMAN = 20;

/** Longest instructions a watch's task carries in its prompt. */
export const MAX_INSTRUCTIONS_CHARS = 2000;

export interface PendingPost {
  /** A review thread's `replyTo`, or `summary` for the PR comment. */
  where: number | 'summary';
  handled: string[];
  /** sha256 of the body as posted, marker included. */
  bodyHash: string;
  /** The head the reply was posted on: a summary reports that head's push. */
  sha: string;
  /** For a summary: the `needsHuman` lines its body reports, so adopting it
   * marks exactly those as reported, never a later plan's. */
  needsHuman?: string[];
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
  /** The background fix attempt whose marker its session left behind,
   * reported once so a round handles its items again (Section 6.14). */
  reportedAbandonedFix?: string;
  /** When the last run that printed something finished reading the PR: a
   * background fix starts only from a snapshot that began to read after. */
  reportedAt?: string;
}

export interface AutofixPrPaths {
  worktreePath: string;
  statePath: string;
  /** `snapshot --gate` cursor; separate from the state file on purpose. */
  gatePath: string;
  /** Touched by every run of the watch's own gate that read the PR. */
  checkedPath: string;
  /** The last prepared snapshot, whole: too long for a line of output. */
  snapshotPath: string;
  /** What GitHub said of bot comments: whether each answers another. */
  repliesPath: string;
  /** Held while a helper reads and writes the state file. */
  lockPath: string;
  /** The user's instructions for every round, written by the skill for
   * `schedule` to read. */
  instructionsPath: string;
  /** The attempt of a fix agent running in the background (`fix-start`). */
  fixPath: string;
  branch: string;
  /** Where an in-place prepare fetches the PR head: outside refs/heads (no
   * branch of the watch's own) and private — the user's concurrent fetches
   * rewrite FETCH_HEAD in the shared checkout. Only in-place uses it. */
  headRef: string;
}

/**
 * The root of the clone's main worktree. Branches are shared by every
 * worktree of a clone, so the clone-wide watch listing reads every worktree's
 * files from here, and outside the daemon a watch is rooted here too.
 */
export { repoRoot };

/**
 * The directory a watch's worktree and state live under (`.qwen/tmp`).
 *
 * A daemon session runs the fix agent's commands only inside its own working
 * directory, so a watch prepared from a linked worktree must keep its files
 * there: under the clone's main worktree they would sit permanently outside
 * that boundary, where the daemon shell guard refuses every command, and
 * `prepare` fails closed before creating anything. Rooting at the session's
 * own worktree toplevel puts them inside it. Outside the daemon there is no
 * such boundary, so the watch stays clone-rooted and every worktree of the
 * clone shares it, as before. A main-worktree session resolves to the same
 * directory either way.
 */
export function watchRoot(): string {
  if (process.env['QWEN_CODE_SERVE'] === '1') {
    return git('rev-parse', '--show-toplevel');
  }
  return repoRoot();
}

/**
 * The worktree paths from `git worktree list --porcelain -z`, main first.
 *
 * NUL-delimited so a path holding a newline stays one record and cannot
 * fabricate an extra `worktree ` root that a scan would then read outside the
 * clone. The line form cannot represent such a path safely at all, so callers
 * only ever parse the `-z` output here and fall back to the main worktree
 * alone when git has no `-z`.
 */
export function parseWorktreePaths(nulOutput: string): string[] {
  const paths: string[] = [];
  for (const field of nulOutput.split('\0')) {
    if (field.startsWith('worktree ')) {
      paths.push(field.slice('worktree '.length));
    }
  }
  return paths;
}

/**
 * Every worktree of the clone, main first, read NUL-safely. One git command.
 * git before 2.36 has no `-z`, and the line form cannot safely list a path
 * that holds a newline, so the fallback scans the main worktree alone (always
 * the first record, never a fabricated one) rather than risk reading outside
 * the clone. `repoRoot` throws outside a repository, as it always has.
 */
export function cloneWorktreeRoots(): string[] {
  const z = gitOpt('worktree', 'list', '--porcelain', '-z');
  if (z !== null) return parseWorktreePaths(z);
  return [repoRoot()];
}

/**
 * The worktree whose `.qwen/tmp` holds this PR's state, or null when the clone
 * has no watch of it. A watch lives wherever it was prepared, which a helper
 * cannot re-derive from its own cwd — the session may have moved — so every
 * helper that operates on an existing watch finds it here rather than guessing
 * a root. A stale state file in one worktree loses to a live watch worktree in
 * another. Only the JSON metadata is read; no git command runs in a discovered
 * worktree.
 */
export function findWatchRoot(prNumber: number): string | null {
  assertPositiveInteger(prNumber, 'PR number');
  let found: string | null = null;
  for (const root of vouchedScanRoots(cloneWorktreeRoots())) {
    const paths = autofixPrPaths(root, prNumber);
    // A sibling whose `.qwen/tmp` is a regular file or inaccessible throws
    // ENOTDIR/EACCES here; isolate it so a healthy watch elsewhere is still
    // discovered (the listing isolates the same failure).
    let hasState: boolean;
    try {
      hasState = isRegularFile(paths.statePath);
    } catch {
      continue;
    }
    if (!hasState) continue;
    if (
      found === null ||
      (!existsSync(autofixPrPaths(found, prNumber).worktreePath) &&
        existsSync(paths.worktreePath))
    ) {
      found = root;
    }
  }
  return found;
}

/**
 * The root a helper operates on: the watch's discovered root when the clone
 * already holds one (wherever it was prepared, so a session that moved still
 * finds it), else the session's own root for a fresh prepare. Containment is
 * not enforced here — `prepare` refuses a resolved worktree outside the
 * session's working directory, and cleanup must reach a watch in any worktree
 * to end it; the daemon guards the fix agent's commands separately.
 */
export function resolveWatchRoot(prNumber: number): string {
  return findWatchRoot(prNumber) ?? watchRoot();
}

/**
 * The anchor store, outside every workspace. It records the clone a watch was
 * confirmed against, kept apart from the watch state and the session checkout
 * so the git-level gitfile-rewrite attack (a round repointing a `.git` pointer
 * inside its working directory) does not trivially forge it.
 *
 * Usability and defense-in-depth, NOT a security boundary: the daemon shell
 * guard confines git relocation, not general file writes, so a round that can
 * write any same-user file can write here too. Such a round is already a full
 * compromise — it can read the daemon discovery sidecar and rewrite source and
 * settings — and no file-based anchor can be the authority against it. A
 * genuinely protected anchor needs daemon-mediated validation over the ACP
 * trust oracle; see the design doc's "Threat model and limitations".
 * `QWEN_AUTOFIX_ANCHOR_DIR` overrides the root for tests.
 */
export function anchorStoreRoot(): string {
  return (
    process.env['QWEN_AUTOFIX_ANCHOR_DIR'] ??
    join(homedir(), '.qwen', 'autofix-anchors')
  );
}

/**
 * The anchor file for a PR of one repository in one clone. The key combines the
 * repository, the PR, and a discriminator for the clone's main worktree, so two
 * independent clones watching the same PR keep distinct anchors — preparing or
 * resuming one cannot revoke the other's. The discriminator is the helper's own
 * cwd-derived main worktree: a repointed cwd resolves to a different
 * (unconfirmed) key and fails closed. It survives take-overs (same clone); a
 * clone move re-confirms under the new main on resume.
 */
export function anchorPath(
  repository: { host: string; owner: string; repo: string },
  prNumber: number,
  cloneRoot: string,
): string {
  assertPositiveInteger(prNumber, 'PR number');
  const slug = [
    normalizeGhHostForUrl(repository.host).replace(/:/g, '@'),
    normalizeSegment(repository.owner),
    normalizeSegment(repository.repo),
  ]
    .join('+')
    .replace(/[^a-z0-9._@+-]/g, '_');
  // Lexical resolve, not realpath: the discriminator must be stable for a path
  // that may no longer exist (a stale anchor left by a clone move).
  const cloneKey = createHash('sha256')
    .update(resolve(cloneRoot))
    .digest('hex')
    .slice(0, 16);
  return join(anchorStoreRoot(), slug, `${cloneKey}-pr-${prNumber}.json`);
}

export interface WatchAnchor {
  trustRoot: string;
  host: string;
  owner: string;
  repo: string;
}

/**
 * Record the clone a watch is confirmed against, from the helper's cwd at
 * prepare/resume time. Written atomically, replacing any link, in the store
 * outside the workspace. A resume re-confirms from the current cwd, which also
 * re-establishes the anchor under a new main after a legitimate clone move
 * (`git worktree repair`). Defense-in-depth, not a security boundary — see
 * `anchorStoreRoot`.
 */
export function writeAnchor(
  repository: { host: string; owner: string; repo: string },
  prNumber: number,
  trustRoot: string,
): void {
  // Key by the clone being confirmed (the value), not the transient cwd, so the
  // write is correct regardless of where the caller's cwd points at this moment.
  const path = anchorPath(repository, prNumber, trustRoot);
  mkdirSync(dirname(path), { recursive: true });
  const anchor: WatchAnchor = { trustRoot, ...repository };
  atomicWriteFileSync(path, `${JSON.stringify(anchor, null, 2)}\n`, NO_FOLLOW);
}

/** Read a watch's confirmed anchor, or null when none was confirmed. */
export function readAnchor(
  repository: { host: string; owner: string; repo: string },
  prNumber: number,
): WatchAnchor | null {
  // Key by the clone the helper runs in; a genuine helper matches the clone
  // confirmed at prepare, a repointed cwd resolves to an unconfirmed key.
  const path = anchorPath(repository, prNumber, repoRoot());
  if (!isRegularFile(path)) return null;
  try {
    const parsed = JSON.parse(
      readRegularFile(path) ?? 'null',
    ) as WatchAnchor | null;
    if (
      parsed &&
      typeof parsed.trustRoot === 'string' &&
      typeof parsed.host === 'string' &&
      typeof parsed.owner === 'string' &&
      typeof parsed.repo === 'string'
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The clone a watch's gitfile is validated against: the anchor confirmed at
 * prepare/resume time, read from the store outside the workspace and keyed by
 * the helper's current main worktree (`repoRoot()`). A watch with no confirmed
 * anchor for that clone fails closed rather than falling back to the
 * round-writable state. This defeats the git-level gitfile-rewrite attack — a
 * repointed cwd resolves to an unconfirmed key — and is defense-in-depth, not a
 * security boundary against a round that can write any same-user file (see
 * `anchorStoreRoot` and the design doc's "Threat model and limitations").
 */
export function trustAnchor(state: {
  prNumber: number;
  host: string;
  owner: string;
  repo: string;
}): string {
  const anchor = readAnchor(state, state.prNumber);
  if (!anchor) {
    throw new Error(
      `PR #${state.prNumber} has no confirmed trust anchor; re-run \`qwen autofix-pr prepare ${state.prNumber}\` (or resume it) to confirm the clone before its worktree can be validated`,
    );
  }
  return anchor.trustRoot;
}

/**
 * The worktree roots a watch scan may read, main first. Drops watch worktrees
 * nested in another root's `.qwen/tmp` (a state file force-added there would
 * forge a watch), and vouches each remaining root against the genuine clone: a
 * stale entry an unrelated repository now occupies, or a sibling whose `.git`
 * was rewritten, is not this clone's worktree and must not be read as one.
 * File reads only — no git command — so the daemon's listing stays within its
 * single git call.
 */
export function vouchedScanRoots(roots: string[]): string[] {
  if (roots.length === 0) return [];
  const main = roots[0]!;
  const notNested = roots.filter(
    (r) =>
      !roots.some(
        (other) => other !== r && isWithinRoot(r, join(other, '.qwen', 'tmp')),
      ),
  );
  let genuineCommon: string;
  let genuineWorktrees: string;
  try {
    // A non-bare main worktree keeps its git dir in `.git`; a bare clone's
    // main entry IS the git dir (it has no `.git` child).
    const dotGit = join(main, '.git');
    genuineCommon = realpathSync(existsSync(dotGit) ? dotGit : main);
    genuineWorktrees = realpathSync(join(genuineCommon, 'worktrees'));
  } catch {
    // The genuine anchor cannot be established (no linked-worktree entries
    // yet, or an unreadable git dir). An unavailable anchor is not validation
    // success: do not fail open to unvouched siblings, trust only the primary.
    return notNested.slice(0, 1);
  }
  return notNested.filter(
    (r) => r === main || vouchesForClone(r, genuineCommon, genuineWorktrees),
  );
}

/** Whether `root`'s `.git` names this clone's own worktree entry, and back. */
function vouchesForClone(
  root: string,
  genuineCommon: string,
  genuineWorktrees: string,
): boolean {
  const dotGit = join(root, '.git');
  let st;
  try {
    st = lstatSync(dotGit);
  } catch {
    return false;
  }
  if (st.isDirectory()) {
    try {
      return realpathSync(dotGit) === genuineCommon;
    } catch {
      return false;
    }
  }
  if (!st.isFile()) return false;
  let text: string;
  try {
    text = readFileSync(dotGit, 'utf8');
  } catch {
    return false;
  }
  if (!text.startsWith('gitdir: ')) return false;
  const pointer = text.slice('gitdir: '.length).replace(/[\r\n]+$/, '');
  let entry: string;
  try {
    entry = realpathSync(isAbsolute(pointer) ? pointer : join(root, pointer));
  } catch {
    return false;
  }
  if (dirname(entry) !== genuineWorktrees) return false;
  let back: string;
  try {
    back = readFileSync(join(entry, 'gitdir'), 'utf8').replace(/[\r\n]+$/, '');
  } catch {
    return false;
  }
  try {
    return (
      realpathSync(isAbsolute(back) ? back : join(entry, back)) ===
      realpathSync(dotGit)
    );
  } catch {
    return false;
  }
}

/** Throws unless `value` is a positive integer; `what` names it. */
export function assertPositiveInteger(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${what} must be a positive integer, got ${value}`);
  }
}

/**
 * The paths a helper operates on once it has read the state: the watch's
 * files under `root`, and — for an in-place watch — the user's checkout
 * and head branch the state names, not the worktree path the PR number
 * alone derives.
 */
export function statePaths(
  root: string,
  state: AutofixPrState,
): AutofixPrPaths {
  const paths = autofixPrPaths(root, state.prNumber);
  return state.inPlace
    ? { ...paths, worktreePath: state.worktreePath, branch: state.branch }
    : paths;
}

export function autofixPrPaths(root: string, prNumber: number): AutofixPrPaths {
  // The number goes into file names, the branch name and `refs/pull/<n>/head`.
  assertPositiveInteger(prNumber, 'PR number');
  const tmp = join(root, '.qwen', 'tmp');
  return {
    worktreePath: join(tmp, `autofix-pr-${prNumber}`),
    statePath: join(tmp, `autofix-pr-${prNumber}-state.json`),
    gatePath: join(tmp, `autofix-pr-${prNumber}-gate.json`),
    checkedPath: join(tmp, `autofix-pr-${prNumber}-gate.checked`),
    snapshotPath: join(tmp, `autofix-pr-${prNumber}-snapshot.json`),
    repliesPath: join(tmp, `autofix-pr-${prNumber}-replies.json`),
    // Not `autofix-pr-<n>-…`: cleanup's sweep of the watch's files must not
    // take a lock another helper holds.
    lockPath: join(tmp, `autofix-pr-${prNumber}.lock`),
    instructionsPath: join(tmp, `autofix-pr-${prNumber}-instructions.txt`),
    fixPath: join(tmp, `autofix-pr-${prNumber}-fix.json`),
    branch: `qwen-autofix/pr-${prNumber}`,
    headRef: `refs/qwen-autofix/pr-${prNumber}/head`,
  };
}

/**
 * Whether `path` is a regular file. The files of a watch sit beside its
 * worktree, in reach of the code a round runs: a FIFO planted under one of
 * their names would block whatever reads it, the lock held.
 */
export function isRegularFile(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

/**
 * A regular file's text, or null when nothing is there. Opened without
 * following a link and without blocking, and judged by what was opened: a
 * FIFO put in its place after a check would otherwise hang the reader — the
 * daemon's included, which lists the watches on its own thread.
 */
export function readRegularFile(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  try {
    if (!fstatSync(fd).isFile()) {
      throw new Error(`${path} is not a regular file`);
    }
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

export function readGateCursor(gatePath: string): AutofixPrGateCursor | null {
  if (lstatSync(gatePath, { throwIfNoEntry: false }) === undefined) {
    return null;
  }
  if (!isRegularFile(gatePath)) {
    throw new Error(`${gatePath} is not a regular file`);
  }
  const text = readRegularFile(gatePath);
  if (text === null) return null;
  const parsed = JSON.parse(text) as AutofixPrGateCursor;
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
  atomicWriteFileSync(gatePath, `${JSON.stringify(cursor, null, 2)}\n`, {
    noFollow: true,
  });
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
    typeof post.sha === 'string' &&
    (post.needsHuman === undefined || isStringList(post.needsHuman))
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
  // `schedule` puts these into the scheduled task's prompt.
  if (state.watch !== undefined && !isWatchOptions(state.watch)) {
    return 'watch';
  }
  if (
    state.needsHuman !== undefined &&
    !(
      Array.isArray(state.needsHuman) &&
      state.needsHuman.every(isNeedsHumanItem)
    )
  ) {
    return 'needsHuman';
  }
  if (
    state.reportedNeedsHuman !== undefined &&
    !(
      typeof state.reportedNeedsHuman === 'object' &&
      state.reportedNeedsHuman !== null &&
      typeof state.reportedNeedsHuman.sha === 'string' &&
      SHA_RE.test(state.reportedNeedsHuman.sha) &&
      isStringList(state.reportedNeedsHuman.texts)
    )
  ) {
    return 'reportedNeedsHuman';
  }
  if (state.preparedAt !== undefined && typeof state.preparedAt !== 'string') {
    return 'preparedAt';
  }
  if (
    state.ended !== undefined &&
    !(
      typeof state.ended === 'object' &&
      state.ended !== null &&
      typeof state.ended.at === 'string' &&
      typeof state.ended.reason === 'string'
    )
  ) {
    return 'ended';
  }
  return null;
}

function isWatchOptions(value: unknown): value is AutofixPrWatchOptions {
  const watch = value as AutofixPrWatchOptions | null;
  return (
    typeof watch === 'object' &&
    watch !== null &&
    WATCH_INTERVALS.includes(watch.every) &&
    typeof watch.reply === 'boolean' &&
    typeof watch.instructions === 'string' &&
    watch.instructions.length <= MAX_INSTRUCTIONS_CHARS &&
    // A prompt is one line, and says what it shows.
    !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(watch.instructions) &&
    // It goes into the gate command.
    (watch.task === undefined || /^[0-9a-f]{12}$/.test(watch.task))
  );
}

function isNeedsHumanItem(value: unknown): value is NeedsHumanItem {
  const item = value as NeedsHumanItem | null;
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof item.sha === 'string' &&
    typeof item.at === 'string' &&
    typeof item.text === 'string'
  );
}

export function readState(statePath: string): AutofixPrState | null {
  // A FIFO planted under the name would block every helper; a link, even
  // one to nothing, is no state the helpers wrote.
  const entry = lstatSync(statePath, { throwIfNoEntry: false });
  if (entry === undefined) return null;
  if (!entry.isFile()) {
    throw new Error(
      `${statePath} is not a regular file; \`qwen autofix-pr cleanup <pr> --force\` discards it.`,
    );
  }
  // Replaced since by something that is no regular file: refused alike.
  let text: string | null;
  try {
    text = readRegularFile(statePath);
  } catch {
    throw new Error(
      `${statePath} is not a regular file; \`qwen autofix-pr cleanup <pr> --force\` discards it.`,
    );
  }
  if (text === null) return null;
  const parsed = JSON.parse(text) as AutofixPrState;
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
  // The fields these hold, and nothing else: what reaches `status`, a
  // rebuilt state and the next write is what the helpers wrote.
  const { watch, ended, needsHuman, reportedNeedsHuman } = parsed;
  return {
    ...parsed,
    ...(watch
      ? {
          watch: {
            every: watch.every,
            reply: watch.reply,
            instructions: watch.instructions,
            ...(watch.task !== undefined ? { task: watch.task } : {}),
          },
        }
      : {}),
    ...(ended ? { ended: { at: ended.at, reason: ended.reason } } : {}),
    ...(needsHuman
      ? {
          needsHuman: needsHuman.map(({ sha, at, text }) => ({
            sha,
            at,
            text,
          })),
        }
      : {}),
    ...(reportedNeedsHuman
      ? {
          reportedNeedsHuman: {
            sha: reportedNeedsHuman.sha,
            texts: [...reportedNeedsHuman.texts],
          },
        }
      : {}),
  };
}

/**
 * Writes of a watch's files replace a link rather than follow it: the code
 * a round runs could plant one there to have a helper write outside
 * `.qwen/tmp`.
 */
export const NO_FOLLOW = { noFollow: true } as const;

export function writeState(statePath: string, state: AutofixPrState): void {
  atomicWriteFileSync(
    statePath,
    `${JSON.stringify(state, null, 2)}\n`,
    NO_FOLLOW,
  );
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
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return null;
  // Its callers replace an unreadable history.
  if (!isRegularFile(path)) throw new Error(`${path} is not a regular file`);
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
  // A directory planted under the name would refuse the write forever.
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && !entry.isFile() && !entry.isSymbolicLink()) {
    rmSync(path, { recursive: true, force: true });
  }
  atomicWriteFileSync(path, `${JSON.stringify(history, null, 2)}\n`, NO_FOLLOW);
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

/** `--task` of a round's helpers: the scheduled task that woke the round. */
export const TASK_OPTION = {
  type: 'string',
  describe:
    "The scheduled task that woke the round (its prompt's --task): refused unless it still drives the watch",
} as const;

/** The `--task` a helper was given, or undefined. */
export function taskArg(argv: Record<string, unknown>): string | undefined {
  return argv['task'] === undefined ? undefined : String(argv['task']);
}

/**
 * The checks of a round's helpers: the session owns the watch, a `cleanup`
 * that kept the worktree has not ended it, and — given the task that woke
 * the round — that task still drives it. A fire queued before a later
 * `schedule` replaced its task, or before the watch was stopped, is refused
 * here rather than act on the PR with options the user has since changed.
 */
export function assertWatching(state: AutofixPrState, task?: string): void {
  // First: a stopped watch says so to whichever session asks.
  if (state.ended) {
    throw new Error(
      `PR #${state.prNumber}'s watch was stopped (${state.ended.reason}); ` +
        `its worktree was kept. Start it again with /autofix-pr ${state.prNumber}.`,
    );
  }
  assertOwnedBySession(state);
  if (task !== undefined && state.watch?.task !== task) {
    throw new Error(
      `task ${task} no longer drives PR #${state.prNumber}'s watch; ` +
        `delete the task whose gate has --task ${task}` +
        (state.watch?.task
          ? `, not the one with --task ${state.watch.task}, which drives it.`
          : '.'),
    );
  }
}

/** `gh` answered that what it asked for is not there: its own words, not
 * the command line, which names what was asked. */
export function ghNotFound(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown }).stderr;
  return /\(HTTP 404\)/.test(typeof stderr === 'string' ? stderr : '');
}

export function assertOwnedBySession(state: AutofixPrState): void {
  const sessionId = currentSessionId();
  if (state.sessionId !== sessionId) {
    throw new Error(
      `PR #${state.prNumber} is watched by another session ` +
        `(${state.sessionId || 'no session'}). Take it over with ` +
        (state.watch
          ? `\`/autofix-pr resume ${state.prNumber}\``
          : `\`/autofix-pr ${state.prNumber}\``) +
        `, end it keeping its work with ` +
        `\`qwen autofix-pr cleanup ${state.prNumber} --take-over\` (what ` +
        `\`/autofix-pr stop ${state.prNumber}\` runs), or discard it with ` +
        `\`cleanup ${state.prNumber} --force\`.`,
    );
  }
}

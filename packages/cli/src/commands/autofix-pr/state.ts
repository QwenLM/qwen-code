/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
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
  /** `<check>@<headSha>` of checks re-run once already; the next failure on
   * that head is treated as real. */
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
}

export interface AutofixPrPaths {
  worktreePath: string;
  statePath: string;
  /** `snapshot --gate` cursor; separate from the state file on purpose. */
  gatePath: string;
  /** Kept by `cleanup`, like the gate cursor. */
  historyPath: string;
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
    historyPath: join(tmp, `autofix-pr-${prNumber}-history.json`),
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
  if (!word(state.remote)) return 'remote';
  if (!word(state.pushTarget)) return 'pushTarget';
  if (!word(state.headRefName) || !isBranchName(state.headRefName)) {
    return 'headRefName';
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

export function readHistory(historyPath: string): AutofixPrHistory | null {
  if (!existsSync(historyPath)) return null;
  const parsed = JSON.parse(
    readFileSync(historyPath, 'utf8'),
  ) as AutofixPrHistory;
  if (parsed.version !== 1) {
    throw new Error(
      `unsupported autofix-pr history version in ${historyPath}: ${String(parsed.version)}`,
    );
  }
  return parsed;
}

/** Adds what a watch's state posted and handled to the PR's history. */
export function keepHistory(historyPath: string, state: AutofixPrState): void {
  let earlier: AutofixPrHistory | null = null;
  try {
    earlier = readHistory(historyPath);
  } catch {
    // An unreadable history is replaced rather than blocking cleanup.
  }
  const same = earlier && sameRepository(earlier, state) ? earlier : null;
  const union = (a: string[] | undefined, b: string[] | undefined) => [
    ...new Set([...(a ?? []), ...(b ?? [])]),
  ];
  const history: AutofixPrHistory = {
    version: 1,
    host: state.host,
    owner: state.owner,
    repo: state.repo,
    prNumber: state.prNumber,
    handledCommentIds: union(same?.handledCommentIds, state.handledCommentIds),
    postedCommentIds: union(same?.postedCommentIds, state.postedCommentIds),
    handledChecks: union(same?.handledChecks, state.handledChecks),
    rerunChecks: union(same?.rerunChecks, state.rerunChecks),
  };
  atomicWriteFileSync(historyPath, `${JSON.stringify(history, null, 2)}\n`);
}

/**
 * Runs `fn` holding the watch's lock, so two helpers never read and write
 * the state file at once (the model may issue tool calls in parallel): the
 * second would write back what it read and undo the first one's record of
 * a push, a reply or a re-run. A lock whose holder is gone is taken over.
 */
export function withWatchLock<T>(
  paths: AutofixPrPaths,
  prNumber: number,
  fn: () => T,
): T {
  let fd: number | null = null;
  for (let attempt = 0; attempt < 2 && fd === null; attempt += 1) {
    try {
      fd = openSync(paths.lockPath, 'wx');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number(readFileSync(paths.lockPath, 'utf8').trim());
      if (attempt === 0 && !processAlive(holder)) {
        unlinkSync(paths.lockPath);
        continue;
      }
      throw new Error(
        `another autofix-pr helper is working on PR #${prNumber} (process ${Number.isInteger(holder) ? holder : 'unknown'}); run one at a time.`,
      );
    }
  }
  if (fd === null) {
    throw new Error(`could not take the lock ${paths.lockPath}`);
  }
  try {
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return fn();
  } finally {
    try {
      unlinkSync(paths.lockPath);
    } catch {
      // Already gone.
    }
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

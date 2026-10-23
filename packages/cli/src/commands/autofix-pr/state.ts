/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
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
  if (!word(state.headRefName) || /[\s\0]/.test(state.headRefName)) {
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

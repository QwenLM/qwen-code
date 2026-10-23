/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import {
  hostsEquivalent,
  normalizeSegment,
} from '../review/lib/remote-match.js';

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
 * compares owner and repository names without case, and a host's spelling
 * (case, port, trailing dot) does not change the instance.
 */
export function sameRepository(
  a: { host: string; owner: string; repo: string },
  b: { host: string; owner: string; repo: string },
): boolean {
  return (
    hostsEquivalent(a.host, b.host) &&
    normalizeSegment(a.owner) === normalizeSegment(b.owner) &&
    normalizeSegment(a.repo) === normalizeSegment(b.repo)
  );
}

export function readState(statePath: string): AutofixPrState | null {
  if (!existsSync(statePath)) return null;
  const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as AutofixPrState;
  if (parsed.version !== 1) {
    throw new Error(
      `unsupported autofix-pr state version in ${statePath}: ${String(parsed.version)}`,
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

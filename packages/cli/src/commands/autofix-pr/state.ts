/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { git } from '../review/lib/git.js';

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

export interface AutofixPrPaths {
  worktreePath: string;
  statePath: string;
  branch: string;
}

/**
 * The root of the clone's main worktree. Branches are shared by every
 * worktree of a clone, so a watch belongs to the clone rather than to the
 * worktree a helper runs from, the autofix worktree itself included.
 */
export function repoRoot(): string {
  const first = git('worktree', 'list', '--porcelain').split('\n')[0] ?? '';
  if (!first.startsWith('worktree ')) {
    throw new Error(`cannot find the main worktree in: ${first}`);
  }
  return first.slice('worktree '.length);
}

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
    branch: `qwen-autofix/pr-${prNumber}`,
  };
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
      `PR #${prNumber} is not prepared here; run \`qwen autofix-pr prepare ${prNumber}\` first.`,
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

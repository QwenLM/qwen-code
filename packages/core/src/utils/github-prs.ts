/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { findGitRoot } from './gitUtils.js';

const GH_TIMEOUT_MS = 10_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;
const GH_ERROR_MESSAGE_MAX = 512;

export const GITHUB_PR_LIST_LIMIT = 30;

const GH_PR_LIST_FIELDS =
  'number,title,url,author,headRefName,isDraft,reviewDecision,statusCheckRollup,updatedAt';

export type GitHubPullRequestState = 'open' | 'draft';

export type GitHubPullRequestReviewDecision =
  | 'approved'
  | 'changes_requested'
  | 'review_required';

export type GitHubPullRequestChecks =
  | 'passing'
  | 'failing'
  | 'pending'
  | 'none';

export interface GitHubPullRequest {
  number: number;
  title: string;
  url: string;
  /** Author login, or empty when the account was deleted. */
  author: string;
  headRefName: string;
  state: GitHubPullRequestState;
  reviewDecision: GitHubPullRequestReviewDecision | null;
  /** Aggregated CI rollup — the raw per-check array stays on the daemon. */
  checks: GitHubPullRequestChecks;
  /** Epoch seconds. */
  updatedAt: number;
}

export type FetchGitHubPullRequestsResult =
  | { kind: 'ok'; pullRequests: GitHubPullRequest[] }
  | { kind: 'not_a_repo' }
  | { kind: 'cli_unavailable' }
  | { kind: 'failed'; message: string };

// Mirrors `gh pr checks`: a cancelled/stale check blocks the merge just like a
// failure, so it counts as failing rather than pending.
const FAILING_CHECK_RUN_CONCLUSIONS = new Set([
  'FAILURE',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'STALE',
]);
const FAILING_STATUS_CONTEXT_STATES = new Set(['ERROR', 'FAILURE']);

interface GhCheckRun {
  __typename?: string;
  status?: string;
  conclusion?: string | null;
}

interface GhStatusContext {
  __typename?: string;
  state?: string;
}

function aggregateChecks(
  rollup: ReadonlyArray<GhCheckRun | GhStatusContext> | undefined,
): GitHubPullRequestChecks {
  if (!Array.isArray(rollup) || rollup.length === 0) return 'none';
  let sawPassing = false;
  let sawPending = false;
  for (const entry of rollup) {
    if (entry.__typename === 'StatusContext') {
      const state = (entry as GhStatusContext).state?.toUpperCase();
      if (state && FAILING_STATUS_CONTEXT_STATES.has(state)) return 'failing';
      if (state === 'SUCCESS') sawPassing = true;
      else sawPending = true;
    } else {
      const conclusion = (entry as GhCheckRun).conclusion?.toUpperCase();
      if (conclusion) {
        if (FAILING_CHECK_RUN_CONCLUSIONS.has(conclusion)) return 'failing';
        sawPassing = true;
      } else {
        sawPending = true;
      }
    }
  }
  if (sawPending) return 'pending';
  return sawPassing ? 'passing' : 'none';
}

function mapReviewDecision(
  value: unknown,
): GitHubPullRequestReviewDecision | null {
  switch (value) {
    case 'APPROVED':
      return 'approved';
    case 'CHANGES_REQUESTED':
      return 'changes_requested';
    case 'REVIEW_REQUIRED':
      return 'review_required';
    default:
      return null;
  }
}

interface GhPrListEntry {
  number?: number;
  title?: string;
  url?: string;
  author?: { login?: string } | null;
  headRefName?: string;
  isDraft?: boolean;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<GhCheckRun | GhStatusContext>;
  updatedAt?: string;
}

function mapEntry(entry: GhPrListEntry): GitHubPullRequest | null {
  if (typeof entry.number !== 'number') return null;
  const parsed = Date.parse(entry.updatedAt ?? '');
  return {
    number: entry.number,
    title: entry.title ?? '',
    url: entry.url ?? '',
    author: entry.author?.login ?? '',
    headRefName: entry.headRefName ?? '',
    state: entry.isDraft ? 'draft' : 'open',
    reviewDecision: mapReviewDecision(entry.reviewDecision),
    checks: aggregateChecks(entry.statusCheckRollup),
    updatedAt: Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000),
  };
}

/** Exported for tests — the exec wrapper stays thin on purpose. */
export function parseGhPrList(stdout: string): GitHubPullRequest[] {
  const parsed: unknown = JSON.parse(stdout);
  if (!Array.isArray(parsed)) {
    throw new Error('unexpected gh output: expected a JSON array');
  }
  return parsed
    .map((entry) => mapEntry(entry as GhPrListEntry))
    .filter((entry): entry is GitHubPullRequest => entry !== null)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function runGhPrList(gitRoot: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'open',
        '--limit',
        String(GITHUB_PR_LIST_LIMIT),
        '--json',
        GH_PR_LIST_FIELDS,
      ],
      {
        cwd: gitRoot,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function ghErrorMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const raw =
    typeof stderr === 'string' && stderr.trim()
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, GH_ERROR_MESSAGE_MAX);
}

/**
 * List open pull requests for the GitHub repo containing `cwd`, newest
 * `updatedAt` first. Shells out to the `gh` CLI so the user's existing
 * `gh auth` login applies; returns a discriminated union instead of throwing
 * so route layers can map each failure mode to a distinct wire code.
 */
export async function fetchGitHubPullRequests(
  cwd: string,
): Promise<FetchGitHubPullRequestsResult> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return { kind: 'not_a_repo' };

  let stdout: string;
  try {
    stdout = await runGhPrList(gitRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'cli_unavailable' };
    }
    return { kind: 'failed', message: ghErrorMessage(error) };
  }

  try {
    return { kind: 'ok', pullRequests: parseGhPrList(stdout) };
  } catch (error) {
    return { kind: 'failed', message: ghErrorMessage(error) };
  }
}

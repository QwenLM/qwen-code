/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findGitRoot } from './gitUtils.js';
import { gitEnv } from './git-branches.js';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 10_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;
// Wire-safety bound for raw gh stderr. The route re-sanitizes workspace paths
// and re-truncates to GITHUB_PR_ERROR_MESSAGE_MAX, so a path that straddles the
// display boundary is still whole here and gets redacted before it is cut.
const GH_ERROR_RAW_MAX = 4096;

/** Display cap applied by the route after path sanitization. */
export const GITHUB_PR_ERROR_MESSAGE_MAX = 512;

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
  | { kind: 'failed'; message: string; gitRoot: string };

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

function runGhPrList(
  gitRoot: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
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
        env: gitEnv(env),
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function ghErrorMessage(
  error: unknown,
  commandLabel = 'gh pr list',
  timeoutMs = GH_TIMEOUT_MS,
): string {
  // A timeout kill carries an empty stderr and a "Command failed: gh pr
  // list …" message; name the timeout instead of dumping the argv.
  if ((error as { killed?: unknown } | null)?.killed === true) {
    return `${commandLabel} timed out after ${timeoutMs / 1000}s`;
  }
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const raw =
    typeof stderr === 'string' && stderr.trim()
      ? stderr
      : error instanceof Error
        ? error.message
        : String(error);
  return raw.replace(/\s+/g, ' ').trim().slice(0, GH_ERROR_RAW_MAX);
}

/**
 * List open pull requests for the GitHub repo containing `cwd`, newest
 * `updatedAt` first. Shells out to the `gh` CLI so the user's existing
 * `gh auth` login applies; returns a discriminated union instead of throwing
 * so route layers can map each failure mode to a distinct wire code. The
 * optional `env` supplies workspace credentials (e.g. GH_TOKEN / GH_CONFIG_DIR)
 * while the denylist still strips repository selectors.
 */
export async function fetchGitHubPullRequests(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<FetchGitHubPullRequestsResult> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return { kind: 'not_a_repo' };

  let stdout: string;
  try {
    stdout = await runGhPrList(gitRoot, env);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'cli_unavailable' };
    }
    return { kind: 'failed', message: ghErrorMessage(error), gitRoot };
  }

  try {
    return { kind: 'ok', pullRequests: parseGhPrList(stdout) };
  } catch (error) {
    return { kind: 'failed', message: ghErrorMessage(error), gitRoot };
  }
}

// ── Create PR ──────────────────────────────────────────────

export interface CreateGitHubPullRequestOptions {
  title: string;
  body?: string;
  base?: string;
  head?: string;
}

export type CreateGitHubPullRequestResult =
  | { kind: 'ok'; url: string; number: number | null }
  | { kind: 'not_a_repo' }
  | { kind: 'cli_unavailable' }
  | { kind: 'failed'; message: string; gitRoot: string };

const GH_CREATE_TIMEOUT_MS = 30_000;

function runGhPrCreate(
  gitRoot: string,
  opts: CreateGitHubPullRequestOptions,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string> {
  const args = ['pr', 'create', '--title', opts.title];
  // Always pass --body so gh never prompts interactively for one.
  args.push('--body', opts.body ?? '');
  if (opts.base) args.push('--base', opts.base);
  if (opts.head) args.push('--head', opts.head);
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      args,
      {
        cwd: gitRoot,
        timeout: GH_CREATE_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnv(env),
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

/**
 * Create a pull request via `gh pr create`. Returns the PR URL on success.
 */
export async function createGitHubPullRequest(
  cwd: string,
  opts: CreateGitHubPullRequestOptions,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<CreateGitHubPullRequestResult> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return { kind: 'not_a_repo' };

  let stdout: string;
  try {
    stdout = await runGhPrCreate(gitRoot, opts, env);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { kind: 'cli_unavailable' };
    }
    return {
      kind: 'failed',
      message: ghErrorMessage(error, 'gh pr create', GH_CREATE_TIMEOUT_MS),
      gitRoot,
    };
  }

  // `gh pr create` outputs the PR URL on stdout.
  const url = stdout.trim();
  const numberMatch = /\/pull\/(\d+)/.exec(url);
  const number = numberMatch ? parseInt(numberMatch[1], 10) : null;
  return { kind: 'ok', url, number };
}

/**
 * Get the default branch as a fully-qualified remote ref (e.g.
 * "origin/main").
 */
export async function getDefaultBranch(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string | null> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return null;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
      {
        cwd: gitRoot,
        timeout: 5_000,
        encoding: 'utf8',
        windowsHide: true,
        env: gitEnv(env),
      },
    );
    const raw = stdout.trim();
    if (!raw) return null;
    // Keep the fully-qualified remote ref (e.g. "origin/main"). Callers that
    // build a log range (`<base>..HEAD`) need the remote-tracking ref so a
    // stale local default branch doesn't pull other people's commits into the
    // range; the PR-create path strips the prefix itself for `gh --base`.
    return raw;
  } catch {
    return null;
  }
}

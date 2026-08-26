/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findGitRoot } from './gitUtils.js';
import { gitEnv } from './git-branches.js';
import type { SessionPrState } from '../services/session-pr-service.js';

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
  'number,title,url,author,headRefName,isDraft,reviewDecision,statusCheckRollup,updatedAt,state';

const GH_PR_LIST_FIELDS_SLIM = 'number,url,headRefName,state,updatedAt';

export type GitHubPullRequestState = 'open' | 'draft' | 'merged' | 'closed';

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
  state?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: Array<GhCheckRun | GhStatusContext>;
  updatedAt?: string;
}

function mapEntry(entry: GhPrListEntry): GitHubPullRequest | null {
  if (typeof entry.number !== 'number') return null;
  const parsed = Date.parse(entry.updatedAt ?? '');
  // `state` is only requested by slim consumers; the panel derives open/draft
  // from isDraft because its field set predates it.
  let state: GitHubPullRequestState;
  switch (entry.state?.toUpperCase()) {
    case 'MERGED':
      state = 'merged';
      break;
    case 'CLOSED':
      state = 'closed';
      break;
    default:
      state = entry.isDraft ? 'draft' : 'open';
      break;
  }
  return {
    number: entry.number,
    title: entry.title ?? '',
    url: entry.url ?? '',
    author: entry.author?.login ?? '',
    headRefName: entry.headRefName ?? '',
    state,
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

export interface FetchGitHubPullRequestsOptions {
  /** Bound on the returned list; defaults to {@link GITHUB_PR_LIST_LIMIT}. */
  limit?: number;
  /** `open` (default, glanceable panel) or `all` (merged/closed heads too). */
  state?: 'open' | 'all';
  /**
   * Request only number/url/headRefName/state/updatedAt. The panel's CI
   * rollup field makes large `--state all` queries hit GitHub GraphQL server
   * timeouts (504); branch-mapping consumers like PR backfill don't need it.
   */
  slim?: boolean;
}

function runGhPrList(
  gitRoot: string,
  env?: Readonly<Record<string, string | undefined>>,
  options: FetchGitHubPullRequestsOptions = {},
): Promise<string> {
  const limit = Math.min(
    Math.max(options.limit ?? GITHUB_PR_LIST_LIMIT, 1),
    1000,
  );
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      [
        'pr',
        'list',
        '--state',
        options.state ?? 'open',
        '--limit',
        String(limit),
        '--json',
        options.slim ? GH_PR_LIST_FIELDS_SLIM : GH_PR_LIST_FIELDS,
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
  options?: FetchGitHubPullRequestsOptions,
): Promise<FetchGitHubPullRequestsResult> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return { kind: 'not_a_repo' };

  let stdout: string;
  try {
    stdout = await runGhPrList(gitRoot, env, options);
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

// ── Git remote → repository identity ─────────────────────────────

const GIT_REMOTE_TIMEOUT_MS = 5_000;

/**
 * Converts a git remote URL (https / ssh:// / scp-style `[user@]host:path`)
 * to the repository's web URL without any port — used to build
 * `<repo>/pull/<N>` links and to compare a binding's URL against the
 * workspace repository.
 */
export function normalizeRemoteToWebUrl(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (!trimmed) return undefined;
  let input = trimmed;
  if (input.startsWith('ssh://')) {
    input = `https://${input.slice('ssh://'.length)}`;
  } else if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(input)) {
    // scp-style [user@]host:path — any user, not only `git`.
    const scp = /^(?:[^@\s/]+@)?([^:\s/]+):(.+)$/.exec(input);
    if (!scp) return undefined;
    // A Windows drive-letter local path (`C:\\src\\origin.git`) matches
    // the scp shape with the drive as "host"; real hostnames are never a
    // single character, drive letters always are.
    if (/^[A-Za-z]$/.test(scp[1])) return undefined;
    input = `https://${scp[1]}/${scp[2]}`;
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const pathname = url.pathname.replace(/\.git\/?$/, '');
  if (!pathname || pathname === '/') return undefined;
  // `hostname` drops any port an ssh:// remote carried — a web link must
  // not point at the SSH port.
  return `${url.protocol}//${url.hostname}${pathname}`.replace(/\/$/, '');
}

/**
 * Repository identity key (`host/owner/repo`, lowercased) for a GitHub web
 * or PR URL. Used to verify a bound PR URL belongs to the workspace's own
 * repository before persisting or refreshing it.
 */
export function repoKeyFromWebUrl(webUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(webUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  // Enterprise remotes can carry a `www.` prefix while gh's own URLs never
  // do; the key must canonicalize it or the two never match.
  const hostname = url.hostname.replace(/^www\./, '');
  return `${hostname}/${segments[0]}/${segments[1]}`.toLowerCase();
}

/**
 * Resolves the web URL of the `origin` remote of the repo containing `cwd`
 * (best-effort: undefined when not a repo, no origin, or git stalls past
 * the timeout). Async on purpose — callers run inside daemon request
 * handlers/timers that must not block the event loop.
 */
export function fetchRemoteWebUrl(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['remote', 'get-url', 'origin'],
      {
        cwd: gitRoot,
        timeout: GIT_REMOTE_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true,
        env: gitEnv(env),
      },
      (error, stdout) => {
        resolve(error ? undefined : normalizeRemoteToWebUrl(stdout));
      },
    );
  });
}

/**
 * The branch's current PR as seen by gh, for `gh pr create` attribution.
 * `none` is a PROVED absence (gh answered for this branch); `error` means
 * gh could not answer (timeout, rate limit, unavailable, unparseable). A
 * caller gating on the pre-run state must decline attribution on `error`
 * rather than read it as "no prior PR", or a branch whose fetch flaked
 * would bind its existing PR as this session's creation.
 */
export type BranchPullRequestSnapshot =
  | { status: 'none' }
  | { status: 'error' }
  | {
      status: 'pr';
      number: number;
      url: string;
      state: SessionPrState;
      /** The PR's head branch; lets the caller pin branch identity. */
      headRefName?: string;
    };

/**
 * Resolves the PR gh associates with the current branch of the repo
 * containing `cwd` (`gh pr view` with no argument names one). Used to
 * attribute a `gh pr create` run to the PR it created — command/output
 * text alone cannot prove which printed URL gh itself produced. The state
 * lets the caller decline an already-merged/closed PR a retry merely
 * resolved.
 */
export function fetchCurrentBranchPullRequest(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<BranchPullRequestSnapshot> {
  const gitRoot = findGitRoot(cwd);
  // No repo proves nothing about a branch's PR — the command may CREATE
  // the repo (clone into the working dir) — so this is an unproven
  // pre-state, not a proved absence; callers decline on `error`.
  if (!gitRoot) return Promise.resolve({ status: 'error' });
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['pr', 'view', '--json', 'number,url,state,headRefName'],
      {
        cwd: gitRoot,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnv(env),
      },
      (error, stdout, stderr) => {
        if (error) {
          // gh exits non-zero both when the branch has no PR and on real
          // failures (timeout, rate limit, auth); only the no-PR message
          // is a proved absence — anything else fails closed as `error`.
          resolve(
            /no pull requests found/i.test(stderr)
              ? { status: 'none' }
              : { status: 'error' },
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            number?: number;
            url?: string;
            state?: string;
            headRefName?: string;
          };
          // gh reports OPEN/MERGED/CLOSED; anything else fails closed.
          const state = parsed.state?.toLowerCase();
          resolve(
            typeof parsed.number === 'number' &&
              typeof parsed.url === 'string' &&
              (state === 'open' || state === 'merged' || state === 'closed')
              ? {
                  status: 'pr',
                  number: parsed.number,
                  url: parsed.url,
                  state,
                  ...(typeof parsed.headRefName === 'string'
                    ? { headRefName: parsed.headRefName }
                    : {}),
                }
              : { status: 'error' },
          );
        } catch {
          resolve({ status: 'error' });
        }
      },
    );
  });
}

/**
 * The checked-out branch name of the repo containing `cwd` (undefined
 * outside a repo, on a detached HEAD, or when git fails). Pins branch
 * identity across the `gh pr create` attribution window: the post-run gh
 * resolution must name this same branch, or a command that switched
 * branches mid-run would bind the new branch's existing PR as this run's
 * creation.
 */
export function fetchCurrentBranchName(
  cwd: string,
): Promise<string | undefined> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['branch', '--show-current'],
      {
        cwd: gitRoot,
        timeout: GIT_REMOTE_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true,
        env: gitEnv(),
      },
      (error, stdout) => {
        const name = stdout.trim();
        resolve(error || name === '' ? undefined : name);
      },
    );
  });
}

export interface AttributionRepoKeys {
  /** Repo key gh resolves for this checkout; undefined when unresolvable. */
  resolved?: string;
  /** The resolved repo's fork-parent key, when it is a fork. */
  parent?: string;
}

/**
 * The repo identities gh attributes PR operations to from `cwd`: the repo
 * gh resolves for this checkout plus, when it is a fork, its parent — from
 * a fork checkout `gh pr view`/`gh pr create` resolve the PARENT repo
 * (forks host no PRs), so a create legitimately made in that layout carries
 * the parent's key. Both keys are empty when gh cannot answer (no repo, gh
 * unavailable, unparseable); callers pinning repo identity across the
 * attribution window must decline on that state, or an origin retarget
 * inside the window (`git remote set-url`, `gh repo set-default`) would
 * bind a stranger's pre-existing PR.
 */
export function fetchAttributionRepoKeys(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<AttributionRepoKeys> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return Promise.resolve({});
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['repo', 'view', '--json', 'url,parent'],
      {
        cwd: gitRoot,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnv(env),
      },
      (error, stdout) => {
        if (error) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            url?: unknown;
            parent?: { url?: unknown } | null;
          };
          const resolved =
            typeof parsed.url === 'string'
              ? repoKeyFromWebUrl(parsed.url)
              : undefined;
          const parentUrl = parsed.parent?.url;
          const parent =
            typeof parentUrl === 'string'
              ? repoKeyFromWebUrl(parentUrl)
              : undefined;
          resolve({
            ...(resolved ? { resolved } : {}),
            ...(parent ? { parent } : {}),
          });
        } catch {
          resolve({});
        }
      },
    );
  });
}

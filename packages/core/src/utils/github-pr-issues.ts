/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { findGitRoot } from './gitUtils.js';
import { gitEnv } from './git-branches.js';
import { ghErrorMessage } from './github-prs.js';

const GH_TIMEOUT_MS = 10_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;

/** Aliased `pullRequest` lookups per GraphQL call; larger batches are chunked. */
export const GITHUB_PR_ISSUES_BATCH_SIZE = 100;

/**
 * Closing references fetched per PR, and the bound on the issues a session
 * PR sidecar entry keeps: the sidecar reader voids the whole file above it,
 * so the fetch and the schema must share one constant (declared here, the
 * leaf layer, and imported by the sidecar service).
 */
export const SESSION_PR_ISSUE_LIST_LIMIT = 10;

export type GitHubIssueState = 'open' | 'completed' | 'not_planned';

export interface GitHubClosingIssue {
  number: number;
  url: string;
  state: GitHubIssueState;
}

export interface GitHubPullRequestIssues {
  url: string;
  issues: GitHubClosingIssue[];
}

export type FetchGitHubPullRequestIssuesResult =
  | { kind: 'ok'; pullRequests: Map<number, GitHubPullRequestIssues> }
  | { kind: 'not_a_repo' }
  | { kind: 'cli_unavailable' }
  /**
   * The repository cannot be looked up at all: gh found no usable GitHub
   * remote, or the remote names a repository GitHub no longer serves
   * (renamed, deleted, access revoked) — structural, unlike a transient
   * `failed`.
   */
  | { kind: 'repo_unresolved' }
  | { kind: 'failed'; message: string; gitRoot: string };

// gh resolves the `{owner}`/`{repo}` placeholders before any request; these
// are its diagnostics when the workspace has no usable GitHub remote.
const GH_REPO_UNRESOLVED_PATTERN =
  /no git remotes found|point to a known GitHub host|error parsing "(owner|name)" value/i;

/**
 * One aliased `pullRequest(number:)` lookup per number against the repository
 * `gh` resolves for the cwd (`{owner}`/`{repo}` are gh's own placeholders).
 * `gh pr list` cannot serve this: its `closingIssuesReferences` field carries
 * no issue state, and nesting it under `--state all --limit 500` measurably
 * slows the sweep's list query, while a by-number lookup also reaches PRs
 * outside that window. Exported for tests.
 */
export function buildPullRequestIssuesQuery(
  numbers: readonly number[],
): string {
  const lookups = numbers
    .map(
      (number) =>
        `p${number}: pullRequest(number: ${number}) { number url ` +
        `closingIssuesReferences(first: ${SESSION_PR_ISSUE_LIST_LIMIT}) ` +
        `{ nodes { number url state stateReason } } }`,
    )
    .join(' ');
  return (
    'query($owner: String!, $name: String!) ' +
    `{ repository(owner: $owner, name: $name) { ${lookups} } }`
  );
}

interface GhIssueNode {
  number?: unknown;
  url?: unknown;
  state?: unknown;
  stateReason?: unknown;
}

interface GhPullRequestNode {
  number?: unknown;
  url?: unknown;
  closingIssuesReferences?: { nodes?: unknown } | null;
}

function mapIssueState(state: unknown, stateReason: unknown): GitHubIssueState {
  if (state !== 'CLOSED') return 'open';
  return stateReason === 'NOT_PLANNED' || stateReason === 'DUPLICATE'
    ? 'not_planned'
    : 'completed';
}

function mapIssue(node: GhIssueNode): GitHubClosingIssue | null {
  if (
    typeof node.number !== 'number' ||
    !Number.isInteger(node.number) ||
    node.number <= 0 ||
    typeof node.url !== 'string'
  ) {
    return null;
  }
  return {
    number: node.number,
    url: node.url,
    state: mapIssueState(node.state, node.stateReason),
  };
}

interface GhGraphqlError {
  type?: unknown;
  path?: unknown;
}

/** The repository itself resolved to NOT_FOUND (`path: ['repository']`). */
class GhRepositoryNotFoundError extends Error {
  constructor() {
    super('gh api graphql: the repository could not be resolved');
  }
}

/**
 * Parses a `gh api graphql` response. A PR that does not resolve (a binding
 * to another repository's same-numbered PR) comes back as a null alias plus a
 * top-level NOT_FOUND error on that alias; it is simply absent from the
 * result, and the caller's url guard keeps the wrong repository's PR from
 * matching anyway. Any other partial error — a server error nulling an
 * alias, a sub-field error nulling the closing references of a resolved PR
 * — throws: absence must mean "the repository has no such PR", never "the
 * platform hiccupped", because the caller retires merged bindings on it.
 * Throws when the payload carries no repository data at all.
 */
export function parsePullRequestIssuesResponse(
  stdout: string,
): Map<number, GitHubPullRequestIssues> {
  const parsed: unknown = JSON.parse(stdout);
  const errors = (parsed as { errors?: unknown } | null)?.errors;
  if (Array.isArray(errors)) {
    for (const error of errors as GhGraphqlError[]) {
      const notFoundAt =
        error.type === 'NOT_FOUND' && Array.isArray(error.path)
          ? error.path
          : undefined;
      if (notFoundAt?.length === 1 && notFoundAt[0] === 'repository') {
        throw new GhRepositoryNotFoundError();
      }
      const aliasNotFound =
        notFoundAt?.length === 2 && notFoundAt[0] === 'repository';
      if (!aliasNotFound) {
        throw new Error(
          `gh api graphql partial error: ${JSON.stringify(error).slice(0, 200)}`,
        );
      }
    }
  }
  const repository = (parsed as { data?: { repository?: unknown } } | null)
    ?.data?.repository;
  if (repository === null || typeof repository !== 'object') {
    throw new Error('unexpected gh output: expected repository data');
  }
  const result = new Map<number, GitHubPullRequestIssues>();
  for (const value of Object.values(repository as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object') continue;
    const pr = value as GhPullRequestNode;
    if (typeof pr.number !== 'number' || typeof pr.url !== 'string') continue;
    const nodes = pr.closingIssuesReferences?.nodes;
    const issues = Array.isArray(nodes)
      ? nodes
          .map((node) => mapIssue(node as GhIssueNode))
          .filter((issue): issue is GitHubClosingIssue => issue !== null)
      : [];
    result.set(pr.number, { url: pr.url, issues });
  }
  return result;
}

function runGhGraphql(
  gitRoot: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  query: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      [
        'api',
        'graphql',
        '-F',
        'owner={owner}',
        '-F',
        'name={repo}',
        '-f',
        `query=${query}`,
      ],
      {
        cwd: gitRoot,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnv(env),
      },
      (error, stdout, stderr) => {
        // gh exits non-zero whenever the response carries GraphQL errors,
        // even with the data of every other alias intact (a NOT_FOUND on
        // one number). Hand the payload back and let the parser decide; a
        // timeout kill leaves a truncated payload and must keep its message.
        if (error && (error.killed || !stdout.trim())) {
          // execFile's error carries no stderr of its own; the caller
          // classifies gh's repository-resolution diagnostics from it.
          reject(Object.assign(error, { stderr }));
        } else {
          resolve(stdout);
        }
      },
    );
  });
}

/**
 * Closing issues (number, url, state) for the given PR numbers of the
 * repository containing `cwd`, keyed by PR number. Shells out to `gh` so the
 * user's existing `gh auth` login applies; the discriminated union mirrors
 * {@link fetchGitHubPullRequests}. Numbers are looked up in chunks of
 * {@link GITHUB_PR_ISSUES_BATCH_SIZE}; a failing chunk fails the call.
 */
export async function fetchGitHubPullRequestIssues(
  cwd: string,
  env: Readonly<Record<string, string | undefined>> | undefined,
  numbers: readonly number[],
): Promise<FetchGitHubPullRequestIssuesResult> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return { kind: 'not_a_repo' };
  // Safe integers only: an integer-valued double at or beyond 1e21 renders
  // in exponential notation, an invalid GraphQL Int literal that would fail
  // the whole document instead of one alias.
  const valid = [
    ...new Set(numbers.filter((n) => Number.isSafeInteger(n) && n > 0)),
  ];
  const pullRequests = new Map<number, GitHubPullRequestIssues>();
  for (let i = 0; i < valid.length; i += GITHUB_PR_ISSUES_BATCH_SIZE) {
    const chunk = valid.slice(i, i + GITHUB_PR_ISSUES_BATCH_SIZE);
    let stdout: string;
    try {
      stdout = await runGhGraphql(
        gitRoot,
        env,
        buildPullRequestIssuesQuery(chunk),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { kind: 'cli_unavailable' };
      }
      const stderr = (error as { stderr?: unknown }).stderr;
      if (
        typeof stderr === 'string' &&
        GH_REPO_UNRESOLVED_PATTERN.test(stderr)
      ) {
        return { kind: 'repo_unresolved' };
      }
      return {
        kind: 'failed',
        message: ghErrorMessage(error, 'gh api graphql', GH_TIMEOUT_MS),
        gitRoot,
      };
    }
    try {
      for (const [number, entry] of parsePullRequestIssuesResponse(stdout)) {
        pullRequests.set(number, entry);
      }
    } catch (error) {
      if (error instanceof GhRepositoryNotFoundError) {
        return { kind: 'repo_unresolved' };
      }
      return {
        kind: 'failed',
        message: ghErrorMessage(error, 'gh api graphql', GH_TIMEOUT_MS),
        gitRoot,
      };
    }
  }
  return { kind: 'ok', pullRequests };
}

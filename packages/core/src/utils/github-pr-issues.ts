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
  | { kind: 'failed'; message: string; gitRoot: string };

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

/**
 * Parses a `gh api graphql` response. A PR that does not resolve (a binding
 * to another repository's same-numbered PR) comes back as a null alias plus a
 * top-level NOT_FOUND error; it is simply absent from the result, and the
 * caller's url guard keeps the wrong repository's PR from matching anyway.
 * Throws when the payload carries no repository data at all.
 */
export function parsePullRequestIssuesResponse(
  stdout: string,
): Map<number, GitHubPullRequestIssues> {
  const parsed: unknown = JSON.parse(stdout);
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
      (error, stdout) => {
        // gh exits non-zero whenever the response carries GraphQL errors,
        // even with the data of every other alias intact (a NOT_FOUND on
        // one number). Hand the payload back and let the parser decide; a
        // timeout kill leaves a truncated payload and must keep its message.
        if (error && (error.killed || !stdout.trim())) {
          reject(error);
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
  const valid = [
    ...new Set(numbers.filter((n) => Number.isInteger(n) && n > 0)),
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
      return {
        kind: 'failed',
        message: ghErrorMessage(error, 'gh api graphql', GH_TIMEOUT_MS),
        gitRoot,
      };
    }
  }
  return { kind: 'ok', pullRequests };
}

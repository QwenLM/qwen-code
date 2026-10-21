/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `qwen review watch-repo`: the reviewer's probe behind a scheduled task's
// gate (docs/design/2026-10-21-scheduled-task-gate.md). It reads the open
// pull requests of one repository, compares their heads with the cursor of
// the previous run and prints the pull requests that were opened, pushed or
// marked ready since — nothing when there are none — so a session is woken
// only to review or verify what changed. Filters decide which pull requests
// are events; the cursor follows every one, so changing a filter later does
// not replay history.

import type { CommandModule } from 'yargs';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { repoRoot } from './lib/git.js';
import {
  ensureAuthenticated,
  gh,
  isOwnerRepo,
  resolveGhHost,
  setGhHost,
} from './lib/gh.js';

const PRS_QUERY = `query($owner: String!, $name: String!, $first: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        url
        isDraft
        headRefOid
        baseRefName
        author { login __typename }
        labels(first: 20) { nodes { name } }
        reviewRequests(first: 20) {
          nodes { requestedReviewer { ... on User { login } ... on Team { slug } } }
        }
      }
    }
  }
}`;

export const DEFAULT_WATCH_LIMIT = 50;

export interface RepoPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  headRefOid: string;
  baseRefName: string;
  author: { login: string; __typename: string } | null;
  labels: { nodes: Array<{ name: string }> };
  reviewRequests: {
    nodes: Array<{
      requestedReviewer: { login?: string; slug?: string } | null;
    }>;
  };
}

export interface WatchRepoCursor {
  version: 1;
  host: string;
  owner: string;
  repo: string;
  viewer: string;
  /** Set by the first run, which records the open PRs without reporting them. */
  initialized: boolean;
  /** Head and draft flag of every open PR seen, by number. */
  heads: Record<string, { sha: string; draft: boolean }>;
}

export interface WatchRepoFilters {
  authors: string[];
  labels: string[];
  /** Only PRs whose review was requested from the viewer (team requests do not count). */
  reviewRequested: boolean;
  excludeDrafts: boolean;
  excludeBots: boolean;
  /** Skip the viewer's own PRs. */
  excludeMine: boolean;
}

export interface WatchRepoEvent {
  type: 'pr_opened' | 'pr_pushed' | 'pr_ready';
  number: number;
  title: string;
  author: string;
  url: string;
  headSha: string;
  baseRef: string;
  isDraft: boolean;
  labels: string[];
  reviewRequested: boolean;
}

function requestedFrom(pr: RepoPr, viewer: string): boolean {
  return pr.reviewRequests.nodes.some(
    (node) => node.requestedReviewer?.login === viewer,
  );
}

function matches(
  pr: RepoPr,
  viewer: string,
  filters: WatchRepoFilters,
): boolean {
  const author = pr.author?.login ?? '';
  const labels = pr.labels.nodes.map((label) => label.name);
  return (
    (filters.authors.length === 0 || filters.authors.includes(author)) &&
    (filters.labels.length === 0 ||
      filters.labels.some((label) => labels.includes(label))) &&
    (!filters.reviewRequested || requestedFrom(pr, viewer)) &&
    (!filters.excludeDrafts || !pr.isDraft) &&
    (!filters.excludeBots || pr.author?.__typename !== 'Bot') &&
    (!filters.excludeMine || author !== viewer)
  );
}

/**
 * Compares the open PRs with the cursor. `listFull` means the query may
 * have cut the list, so a number that is missing may still be open and is
 * carried; otherwise missing numbers were closed or merged and are dropped.
 *
 * Carried numbers are bounded to one more page, highest numbers first:
 * the list is ordered by last update, so a PR off the page is one nobody
 * touched lately, and without a bound the closed and merged ones would
 * accumulate for as long as the cursor lives. A dropped PR that resurfaces
 * reads as `pr_opened`.
 */
export function diffRepoWatch(
  prs: RepoPr[],
  cursor: WatchRepoCursor,
  filters: WatchRepoFilters,
  listFull: boolean,
): { events: WatchRepoEvent[]; cursor: WatchRepoCursor } {
  const events: WatchRepoEvent[] = [];
  const heads: WatchRepoCursor['heads'] = {};
  if (listFull) {
    const onPage = new Set(prs.map((pr) => String(pr.number)));
    const carried = Object.keys(cursor.heads)
      .filter((number) => !onPage.has(number))
      .sort((a, b) => Number(b) - Number(a))
      .slice(0, prs.length);
    for (const number of carried) heads[number] = cursor.heads[number]!;
  }
  for (const pr of prs) {
    const previous = cursor.heads[String(pr.number)];
    heads[String(pr.number)] = { sha: pr.headRefOid, draft: pr.isDraft };
    let type: WatchRepoEvent['type'] | null = null;
    if (!previous) {
      if (cursor.initialized) type = 'pr_opened';
    } else if (previous.sha !== pr.headRefOid) {
      type = 'pr_pushed';
    } else if (previous.draft && !pr.isDraft) {
      type = 'pr_ready';
    }
    if (type === null || !matches(pr, cursor.viewer, filters)) continue;
    events.push({
      type,
      number: pr.number,
      title: pr.title,
      author: pr.author?.login ?? 'ghost',
      url: pr.url,
      headSha: pr.headRefOid,
      baseRef: pr.baseRefName,
      isDraft: pr.isDraft,
      labels: pr.labels.nodes.map((label) => label.name),
      reviewRequested: requestedFrom(pr, cursor.viewer),
    });
  }
  return { events, cursor: { ...cursor, initialized: true, heads } };
}

export function watchRepoCursorPath(
  root: string,
  host: string,
  owner: string,
  repo: string,
): string {
  return join(
    root,
    '.qwen',
    'tmp',
    `review-watch-${host}-${owner}-${repo}.json`,
  );
}

export function readWatchRepoCursor(path: string): WatchRepoCursor | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as WatchRepoCursor;
  if (parsed.version !== 1) {
    throw new Error(
      `unsupported review watch cursor version in ${path}: ${String(parsed.version)}`,
    );
  }
  return parsed;
}

export interface WatchRepoArgs extends WatchRepoFilters {
  repo: string;
  host?: string;
  limit: number;
}

export function runWatchRepo(args: WatchRepoArgs): void {
  if (!isOwnerRepo(args.repo)) {
    throw new TypeError(`--repo must be <owner>/<repo>, got ${args.repo}`);
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 100) {
    throw new TypeError(
      `--limit must be an integer from 1 to 100, got ${args.limit}`,
    );
  }
  const [owner, repo] = args.repo.split('/');
  const host = resolveGhHost(args.host) ?? 'github.com';
  const path = watchRepoCursorPath(repoRoot(), host, owner, repo);
  const existing = readWatchRepoCursor(path);

  setGhHost(host);
  ensureAuthenticated();
  const data = JSON.parse(
    gh(
      'api',
      'graphql',
      '-f',
      `query=${PRS_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${repo}`,
      '-F',
      `first=${args.limit}`,
    ),
  ) as {
    data: {
      viewer: { login: string };
      repository: { pullRequests: { nodes: RepoPr[] } } | null;
    };
  };
  if (!data.data.repository) {
    throw new Error(`repository ${args.repo} not found on ${host}`);
  }
  const prs = data.data.repository.pullRequests.nodes;
  const cursor: WatchRepoCursor = existing ?? {
    version: 1,
    host,
    owner,
    repo,
    viewer: data.data.viewer.login,
    initialized: false,
    heads: {},
  };
  cursor.viewer = data.data.viewer.login;
  const result = diffRepoWatch(prs, cursor, args, prs.length >= args.limit);
  // The cursor lands before the output, so a probe that prints and then dies
  // cannot report the same transitions again on the next fire.
  if (JSON.stringify(result.cursor) !== JSON.stringify(existing)) {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${JSON.stringify(result.cursor, null, 2)}\n`);
  }
  if (result.events.length > 0) {
    writeStdoutLine(JSON.stringify({ repo: args.repo, events: result.events }));
  }
}

function stringList(value: unknown): string[] {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value])
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}

export const watchRepoCommand: CommandModule = {
  command: 'watch-repo',
  describe:
    'Probe for a scheduled task gate: print the open PRs of a repository that were opened, pushed or marked ready since the last run, and nothing when none were',
  builder: (yargs) =>
    yargs
      .option('repo', {
        type: 'string',
        demandOption: true,
        describe: '<owner>/<repo> to watch',
      })
      .option('host', {
        type: 'string',
        describe: 'GitHub host (default: GH_HOST or github.com)',
      })
      .option('limit', {
        type: 'number',
        default: DEFAULT_WATCH_LIMIT,
        describe: 'Most recently updated open PRs to read (1-100)',
      })
      .option('author', {
        type: 'string',
        array: true,
        describe: 'Only PRs by these logins',
      })
      .option('label', {
        type: 'string',
        array: true,
        describe: 'Only PRs carrying one of these labels',
      })
      .option('review-requested', {
        type: 'boolean',
        default: false,
        describe: 'Only PRs whose review was requested from you',
      })
      .option('exclude-drafts', {
        type: 'boolean',
        default: false,
        describe: 'Skip draft PRs',
      })
      .option('exclude-bots', {
        type: 'boolean',
        default: false,
        describe: 'Skip PRs opened by bot accounts',
      })
      .option('exclude-mine', {
        type: 'boolean',
        default: false,
        describe: 'Skip your own PRs',
      }),
  handler: (argv) => {
    runWatchRepo({
      repo: String(argv['repo']),
      host: argv['host'] as string | undefined,
      limit: Number(argv['limit']),
      authors: stringList(argv['author']),
      labels: stringList(argv['label']),
      reviewRequested: Boolean(argv['reviewRequested']),
      excludeDrafts: Boolean(argv['excludeDrafts']),
      excludeBots: Boolean(argv['excludeBots']),
      excludeMine: Boolean(argv['excludeMine']),
    });
  },
};

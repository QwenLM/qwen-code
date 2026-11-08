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
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { atomicWriteFileSync } from '@qwen-code/qwen-code-core/utils/atomicFileWrite.js';
import { writeStdoutLine } from '../../utils/stdioHelpers.js';
import { GATE_OUTPUT_BUDGET_BYTES, jsonBytes } from './lib/gate-budget.js';
import { repoRoot } from './lib/git.js';
import {
  ensureAuthenticated,
  gh,
  isOwnerRepo,
  normalizeGhHostForUrl,
  resolveGhHost,
  setGhHost,
} from './lib/gh.js';

const PRS_QUERY = `query($owner: String!, $name: String!, $first: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequests(first: $first, states: OPEN, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage }
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
  // Logins and label names are case-insensitive on GitHub.
  const fold = (value: string) => value.toLowerCase();
  const author = pr.author?.login ?? '';
  const labels = pr.labels.nodes.map((label) => fold(label.name));
  return (
    (filters.authors.length === 0 ||
      filters.authors.some((login) => fold(login) === fold(author))) &&
    (filters.labels.length === 0 ||
      filters.labels.some((label) => labels.includes(fold(label)))) &&
    (!filters.reviewRequested || requestedFrom(pr, viewer)) &&
    (!filters.excludeDrafts || !pr.isDraft) &&
    (!filters.excludeBots || pr.author?.__typename !== 'Bot') &&
    (!filters.excludeMine || author !== viewer)
  );
}

/**
 * Compares the open PRs with the cursor. `listCut` means the query cut the
 * list, so a number that is missing may still be open and is carried;
 * otherwise missing numbers were closed or merged and are dropped.
 *
 * Carried numbers are bounded to one more page, highest numbers first:
 * the list is ordered by last update, so a PR off the page is one nobody
 * touched lately, and without a bound the closed and merged ones would
 * accumulate for as long as the cursor lives. A dropped PR that resurfaces
 * reads as `pr_opened`.
 *
 * Events past the gate's output budget are `deferred`: their PRs keep the
 * head the cursor had, so the next run reports them.
 */
export function diffRepoWatch(
  prs: RepoPr[],
  cursor: WatchRepoCursor,
  filters: WatchRepoFilters,
  listCut: boolean,
): { events: WatchRepoEvent[]; deferred: number; cursor: WatchRepoCursor } {
  const events: WatchRepoEvent[] = [];
  const heads: WatchRepoCursor['heads'] = {};
  if (listCut) {
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
  const repo = `${cursor.owner}/${cursor.repo}`;
  let shown = 0;
  while (
    shown < events.length &&
    (shown === 0 ||
      jsonBytes({
        repo,
        events: events.slice(0, shown + 1),
        deferred: events.length,
      }) <= GATE_OUTPUT_BUDGET_BYTES)
  ) {
    shown++;
  }
  for (const event of events.slice(shown)) {
    const previous = cursor.heads[String(event.number)];
    if (previous) heads[String(event.number)] = previous;
    else delete heads[String(event.number)];
  }
  return {
    events: events.slice(0, shown),
    deferred: events.length - shown,
    cursor: { ...cursor, initialized: true, heads },
  };
}

/**
 * The name a filter set gives its cursor, or null without filters. Two
 * tasks on one repository with different filters must not share heads: a
 * push one of them recorded without reporting it, because its filters left
 * the PR out, would never be a transition for the other.
 */
function filterKey(filters: WatchRepoFilters): string | null {
  const fold = (values: string[]) =>
    [...new Set(values.map((value) => value.toLowerCase()))].sort();
  const canonical = {
    authors: fold(filters.authors),
    labels: fold(filters.labels),
    reviewRequested: filters.reviewRequested,
    excludeDrafts: filters.excludeDrafts,
    excludeBots: filters.excludeBots,
    excludeMine: filters.excludeMine,
  };
  const none =
    canonical.authors.length === 0 &&
    canonical.labels.length === 0 &&
    !canonical.reviewRequested &&
    !canonical.excludeDrafts &&
    !canonical.excludeBots &&
    !canonical.excludeMine;
  if (none) return null;
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 12);
}

/**
 * One file per repository and filter set, whatever the spelling: GitHub
 * compares hosts, owners and names without case. Each part is a directory
 * level of its own, since owners and names both admit `-`, and a host's
 * port separator, which Windows refuses in a file name, becomes `_`, which
 * no host contains. Filters add `@<key>` to the name; no repository name
 * contains `@`.
 */
export function watchRepoCursorPath(
  root: string,
  host: string,
  owner: string,
  repo: string,
  filters?: WatchRepoFilters,
): string {
  const key = filters ? filterKey(filters) : null;
  return join(
    root,
    '.qwen',
    'tmp',
    'review-watch',
    normalizeGhHostForUrl(host).replace(':', '_'),
    owner.toLowerCase(),
    `${repo.toLowerCase()}${key ? `@${key}` : ''}.json`,
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
  // Validates the flag (a blank one is refused, not read as no host) and
  // the resolved host before it becomes part of a path.
  setGhHost(args.host);
  const host = resolveGhHost(args.host) ?? 'github.com';
  setGhHost(host);
  const path = watchRepoCursorPath(repoRoot(), host, owner, repo, args);
  const existing = readWatchRepoCursor(path);

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
      repository: {
        pullRequests: {
          pageInfo: { hasNextPage: boolean };
          nodes: RepoPr[];
        };
      } | null;
    };
  };
  if (!data.data.repository) {
    throw new Error(`repository ${args.repo} not found on ${host}`);
  }
  const { pageInfo, nodes: prs } = data.data.repository.pullRequests;
  // A copy: `existing` is what the write below compares with.
  const cursor: WatchRepoCursor = {
    ...(existing ?? {
      version: 1,
      host,
      owner,
      repo,
      initialized: false,
      heads: {},
    }),
    viewer: data.data.viewer.login,
  };
  const result = diffRepoWatch(prs, cursor, args, pageInfo.hasNextPage);
  // The cursor lands before the output, so a probe that prints and then dies
  // cannot report the same transitions again on the next fire.
  if (JSON.stringify(result.cursor) !== JSON.stringify(existing)) {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, `${JSON.stringify(result.cursor, null, 2)}\n`);
  }
  if (result.events.length > 0) {
    writeStdoutLine(
      JSON.stringify({
        repo: args.repo,
        events: result.events,
        ...(result.deferred > 0 ? { deferred: result.deferred } : {}),
      }),
    );
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

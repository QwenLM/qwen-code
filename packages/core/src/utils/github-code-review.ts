/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import {
  ghEnv,
  ghErrorMessage,
  parseGhPrList,
  type GitHubPullRequest,
} from './github-prs.js';

const TIMEOUT_MS = 15_000;
const INBOX_LIMIT = 50;
const SEARCH_PAGE_LIMIT = 20;
const DETAIL_LIMIT = 100;
const CHECK_PAGE_LIMIT = 20;
const PATCH_LIMIT = 16 * 1024;
const PATCH_TOTAL_LIMIT = 512 * 1024;

export interface GitHubReviewRepository {
  host: string;
  nameWithOwner: string;
  url: string;
}

export interface GitHubReviewAccount {
  host: string;
  login: string;
}

export interface GitHubAccountPullRequest {
  repository: GitHubReviewRepository;
  number: number;
  title: string;
  url: string;
  author: string;
  authorAvatarUrl?: string;
  state: 'open' | 'draft';
  updatedAt: number;
}

export interface GitHubReviewSearchInfo {
  totalCount: number;
  incompleteResults: boolean;
  searchLimitReached: boolean;
}

export interface GitHubPullRequestInbox {
  account: GitHubReviewAccount;
  authored: GitHubAccountPullRequest[];
  needsMyReview: GitHubAccountPullRequest[];
  page: number;
  limit: 50;
  hasMore: { authored: boolean; needsMyReview: boolean };
  search: {
    authored: GitHubReviewSearchInfo;
    reviewRequested: GitHubReviewSearchInfo;
    assigned: GitHubReviewSearchInfo;
  };
}

export interface GitHubPullRequestDetail extends GitHubPullRequest {
  authorAvatarUrl?: string;
  body: string;
  baseRefName: string;
  baseRefOid: string;
  headRefOid: string;
  createdAt: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  mergeable: string;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
    patchTruncated: boolean;
  }>;
  checksDetails: Array<{
    id?: string;
    name: string;
    workflowName?: string;
    event?: string;
    status: string;
    conclusion: string | null;
    url: string | null;
  }>;
  reviews: Array<{
    id: string;
    author: string;
    authorAvatarUrl?: string;
    body: string;
    state: string;
    createdAt: number;
    url: string;
  }>;
  comments: Array<{
    id: string;
    author: string;
    authorAvatarUrl?: string;
    body: string;
    createdAt: number;
    url: string;
    path: string | null;
    line: number | null;
  }>;
  requestedReviewers: Array<{
    kind: 'user' | 'team';
    login: string;
    url: string | null;
    avatarUrl?: string;
  }>;
  reviewers: Array<{
    kind: 'user' | 'team';
    login: string;
    url: string | null;
    avatarUrl?: string;
    state: string;
    commentCount: number;
  }>;
  truncated: {
    files: boolean;
    checks: boolean;
    reviews: boolean;
    comments: boolean;
    requestedReviewers: boolean;
    reviewers: boolean;
  };
}

export type GitHubCodeReviewReadResult<T> =
  | { kind: 'ok'; data: T }
  | {
      kind:
        | 'cli_unavailable'
        | 'invalid_ref'
        | 'host_mismatch'
        | 'invalid_page'
        | 'not_found';
    }
  | { kind: 'failed'; message: string };

const CHECK_CONTEXTS = `contexts(first:100,after:$checksCursor){
  nodes{__typename
    ... on CheckRun{id databaseId name status conclusion detailsUrl startedAt
      checkSuite{createdAt app{id} workflowRun{databaseId createdAt event workflow{id name}}}}
    ... on StatusContext{id context state targetUrl createdAt}}
  pageInfo{hasNextPage endCursor}
}`;

const CHECKS_QUERY = `query($owner:String!,$name:String!,$oid:GitObjectID!,$checksCursor:String){
  repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{
    oid statusCheckRollup{${CHECK_CONTEXTS}}
  }}}
}`;

const DETAIL_QUERY = `query($owner:String!,$name:String!,$number:Int!,$checksCursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    number title body url state isDraft author{login avatarUrl} headRefName baseRefName
    headRefOid baseRefOid createdAt updatedAt additions deletions changedFiles
    mergeable reviewDecision
    commits(last:1){nodes{commit{oid statusCheckRollup{${CHECK_CONTEXTS}}}}}
    reviews(last:100){nodes{id author{login avatarUrl} body state submittedAt url}
      pageInfo{hasPreviousPage}}
    comments(last:100){nodes{id author{login avatarUrl} body createdAt url}
      pageInfo{hasPreviousPage}}
    reviewThreads(last:20){nodes{comments(last:10){
      nodes{id author{login avatarUrl} body createdAt url path line originalLine}
      pageInfo{hasPreviousPage}
    }}pageInfo{hasPreviousPage}}
    reviewRequests(first:100){nodes{requestedReviewer{__typename
      ... on User{login url avatarUrl} ... on Team{slug url avatarUrl}
      ... on Mannequin{login url avatarUrl}
    }}pageInfo{hasNextPage}}
    latestReviews(first:100){nodes{author{login avatarUrl url} state comments{totalCount}}
      pageInfo{hasNextPage}}
  }}
}`;

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const string = (value: unknown): string =>
  typeof value === 'string' ? value : '';
const number = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const nodes = (value: unknown): JsonObject[] => {
  const entries = object(value)['nodes'];
  return Array.isArray(entries) ? entries.filter(Boolean).map(object) : [];
};
const truncated = (value: unknown): boolean => {
  const info = object(object(value)['pageInfo']);
  return info['hasNextPage'] === true || info['hasPreviousPage'] === true;
};
const timestamp = (value: unknown): number => {
  const parsed = Date.parse(string(value));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
};
const author = (entry: JsonObject): string =>
  string(object(entry['author'])['login']);

function avatarUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

function readGh(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  assertCanRead: (() => void) | undefined,
): (args: string[]) => Promise<string> {
  if (!env) throw new Error('GitHub account environment is unavailable');
  return async (args) => {
    assertCanRead?.();
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile(
        'gh',
        args,
        {
          cwd,
          env: ghEnv(env),
          timeout: TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          encoding: 'utf8',
          windowsHide: true,
        },
        (error, output) => (error ? reject(error) : resolve(output)),
      );
    });
    assertCanRead?.();
    return stdout;
  };
}

type ReadGh = ReturnType<typeof readGh>;

function accountHost(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const host = (env['GH_HOST'] ?? 'github.com').trim().toLowerCase();
  const url = new URL(`https://${host}`);
  if (
    !host ||
    url.host !== host ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error('Invalid GitHub account host');
  return host;
}

async function readAccount(
  read: ReadGh,
  host: string,
): Promise<GitHubReviewAccount> {
  const login = string(
    object(JSON.parse(await read(['api', '--hostname', host, 'user'])))[
      'login'
    ],
  );
  if (!/^[\w-]+(?:\[bot\])?$/.test(login))
    throw new Error('Unexpected GitHub actor identity');
  return { host, login };
}

async function assertSameAccount(
  read: ReadGh,
  account: GitHubReviewAccount,
): Promise<void> {
  if ((await readAccount(read, account.host)).login !== account.login)
    throw new Error(
      'The GitHub account changed during this read. Refresh to use the current account.',
    );
}

function readFailure(error: unknown): GitHubCodeReviewReadResult<never> {
  if ((error as NodeJS.ErrnoException)?.code === 'ENOENT')
    return { kind: 'cli_unavailable' };
  const message = ghErrorMessage(error, 'GitHub PR read', TIMEOUT_MS);
  if (/HTTP 404|Could not resolve to a PullRequest/.test(message))
    return { kind: 'not_found' };
  return { kind: 'failed', message };
}

export function parseGitHubPullRequestRef(
  ref: string,
): { number: number; repositoryUrl: string } | null {
  const value = ref.trim();
  try {
    const url = new URL(value);
    const match =
      /^\/([\w.-]+)\/([\w.-]+)\/pull\/([1-9]\d*)(?:\/(?:files|commits|checks))?\/?$/.exec(
        url.pathname,
      );
    if (
      !match ||
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return null;
    const parsed = Number(match[3]);
    return Number.isSafeInteger(parsed) && parsed <= 1_000_000_000
      ? {
          number: parsed,
          repositoryUrl: `${url.host}/${match[1]}/${match[2]}`.toLowerCase(),
        }
      : null;
  } catch {
    return null;
  }
}

function repositoryFromRef(ref: string): GitHubReviewRepository | null {
  const parsed = parseGitHubPullRequestRef(ref);
  if (!parsed?.repositoryUrl) return null;
  const url = new URL(ref);
  const [, owner, name] = url.pathname.split('/');
  return {
    host: url.host,
    nameWithOwner: `${owner}/${name}`,
    url: `${url.origin}/${owner}/${name}`,
  };
}

function parseSearchResult(
  raw: unknown,
  host: string,
): { items: GitHubAccountPullRequest[]; info: GitHubReviewSearchInfo } {
  const result = object(raw);
  if (
    !Array.isArray(result['items']) ||
    typeof result['total_count'] !== 'number' ||
    typeof result['incomplete_results'] !== 'boolean'
  )
    throw new Error('Unexpected GitHub search response');
  const items = result['items']
    .slice(0, INBOX_LIMIT)
    .map((value: unknown): GitHubAccountPullRequest => {
      const item = object(value);
      const url = string(item['html_url']);
      const ref = parseGitHubPullRequestRef(url);
      const repository = repositoryFromRef(url);
      if (
        !ref ||
        !repository ||
        repository.host !== host ||
        ref.number !== item['number']
      )
        throw new Error('Unexpected GitHub search PR identity');
      return {
        repository,
        number: ref.number,
        title: string(item['title']),
        url,
        author: string(object(item['user'])['login']),
        authorAvatarUrl: avatarUrl(object(item['user'])['avatar_url']),
        state: item['draft'] === true ? 'draft' : 'open',
        updatedAt: timestamp(item['updated_at']),
      };
    });
  const totalCount = number(result['total_count']);
  return {
    items,
    info: {
      totalCount,
      incompleteResults: result['incomplete_results'],
      searchLimitReached: totalCount > INBOX_LIMIT * SEARCH_PAGE_LIMIT,
    },
  };
}

export async function fetchGitHubPullRequestInbox(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  page = 1,
  assertCanRead?: () => void,
): Promise<GitHubCodeReviewReadResult<GitHubPullRequestInbox>> {
  if (!Number.isInteger(page) || page < 1 || page > SEARCH_PAGE_LIMIT)
    return { kind: 'invalid_page' };
  try {
    const read = readGh(cwd, env, assertCanRead);
    const account = await readAccount(read, accountHost(env));
    const search = async (qualifier: string) =>
      parseSearchResult(
        JSON.parse(
          await read([
            'api',
            '--hostname',
            account.host,
            '--method',
            'GET',
            'search/issues',
            '-f',
            `q=is:pr is:open archived:false ${qualifier}:${account.login}`,
            '-f',
            'sort=updated',
            '-f',
            'order=desc',
            '-F',
            `per_page=${INBOX_LIMIT}`,
            '-F',
            `page=${page}`,
          ]),
        ),
        account.host,
      );
    const [authored, reviewRequested, assigned] = await Promise.all([
      search('author'),
      search('review-requested'),
      search('assignee'),
    ]);
    await assertSameAccount(read, account);
    const needsMyReview = [
      ...new Map(
        [...reviewRequested.items, ...assigned.items].map((pr) => [
          pr.url.toLowerCase(),
          pr,
        ]),
      ).values(),
    ].sort((a, b) => b.updatedAt - a.updatedAt || a.url.localeCompare(b.url));
    const hasMore = (result: { info: GitHubReviewSearchInfo }) =>
      page < SEARCH_PAGE_LIMIT && result.info.totalCount > page * INBOX_LIMIT;
    return {
      kind: 'ok',
      data: {
        account,
        authored: authored.items,
        needsMyReview,
        page,
        limit: INBOX_LIMIT,
        hasMore: {
          authored: hasMore(authored),
          needsMyReview: hasMore(reviewRequested) || hasMore(assigned),
        },
        search: {
          authored: authored.info,
          reviewRequested: reviewRequested.info,
          assigned: assigned.info,
        },
      },
    };
  } catch (error) {
    return readFailure(error);
  }
}

function currentChecks(checks: JsonObject[]): JsonObject[] {
  const ordered = checks
    .map((check, index) => {
      const suite = object(check['checkSuite']);
      const run = object(suite['workflowRun']);
      const workflow = object(run['workflow']);
      const appId = string(object(suite['app'])['id']);
      const workflowId = string(workflow['id']);
      const event = string(run['event']);
      const name = string(check['name']);
      const context = string(check['context']);
      let key = JSON.stringify(['id', string(check['id']) || index]);
      if (check['__typename'] === 'StatusContext' && context) {
        key = JSON.stringify(['status', context]);
      } else if (appId && workflowId && event && name) {
        key = JSON.stringify(['run', appId, workflowId, event, name]);
      }
      return {
        check,
        key,
        order: [
          timestamp(check['startedAt']) ||
            timestamp(run['createdAt']) ||
            timestamp(suite['createdAt']) ||
            timestamp(check['createdAt']),
          number(check['databaseId']),
          number(run['databaseId']),
        ],
      };
    })
    .sort((left, right) => {
      // Queued checks without a start time fall back to their run's creation.
      for (let index = 0; index < left.order.length; index++) {
        const difference = right.order[index]! - left.order[index]!;
        if (difference) return difference;
      }
      return 0;
    });
  const seen = new Set<string>();
  return ordered.flatMap(({ key, check }) => {
    if (seen.has(key)) return [];
    seen.add(key);
    return [check];
  });
}

function parseDetail(
  raw: JsonObject,
  filesRaw: unknown,
  checksConnection: JsonObject,
): GitHubPullRequestDetail {
  const checks = currentChecks(nodes(checksConnection));
  const summary = parseGhPrList(
    JSON.stringify([{ ...raw, statusCheckRollup: checks }]),
  )[0];
  if (!summary || !summary.url || !string(raw['headRefOid']))
    throw new Error('Unexpected GitHub PR detail');
  if (!Array.isArray(filesRaw)) throw new Error('Unexpected GitHub PR files');
  let patchBudget = PATCH_TOTAL_LIMIT;
  const files = filesRaw.slice(0, DETAIL_LIMIT).map((entry: unknown) => {
    const file = object(entry);
    const patch = typeof file['patch'] === 'string' ? file['patch'] : null;
    const bytes = patch === null ? null : Buffer.from(patch);
    const bound = Math.min(PATCH_LIMIT, patchBudget);
    const clipped = bytes?.subarray(0, bound);
    patchBudget -= clipped?.byteLength ?? 0;
    return {
      path: string(file['filename']),
      status: string(file['status']),
      additions: number(file['additions']),
      deletions: number(file['deletions']),
      patch: clipped?.toString('utf8') ?? null,
      patchTruncated: bytes !== null && bytes.byteLength > bound,
    };
  });
  const comment = (entry: JsonObject) => ({
    id: string(entry['id']),
    author: author(entry),
    authorAvatarUrl: avatarUrl(object(entry['author'])['avatarUrl']),
    body: string(entry['body']),
    createdAt: timestamp(entry['createdAt']),
    url: string(entry['url']),
    path: typeof entry['path'] === 'string' ? entry['path'] : null,
    line:
      typeof entry['line'] === 'number'
        ? entry['line']
        : typeof entry['originalLine'] === 'number'
          ? entry['originalLine']
          : null,
  });
  const threads = nodes(raw['reviewThreads']);
  const comments = [
    ...nodes(raw['comments']),
    ...threads.flatMap((thread) => nodes(thread['comments'])),
  ]
    .map(comment)
    .sort((a, b) => b.createdAt - a.createdAt);
  const requestedReviewers = nodes(raw['reviewRequests'])
    .map((request) => {
      const reviewer = object(request['requestedReviewer']);
      return {
        kind:
          reviewer['__typename'] === 'Team'
            ? ('team' as const)
            : ('user' as const),
        login: string(reviewer['login'] ?? reviewer['slug']),
        url: typeof reviewer['url'] === 'string' ? reviewer['url'] : null,
        avatarUrl: avatarUrl(reviewer['avatarUrl']),
      };
    })
    .filter((reviewer) => reviewer.login);
  const reviewers = new Map<
    string,
    GitHubPullRequestDetail['reviewers'][number]
  >();
  for (const review of nodes(raw['latestReviews'])) {
    const user = object(review['author']);
    const login = string(user['login']);
    if (!login) continue;
    reviewers.set(`user:${login.toLowerCase()}`, {
      kind: 'user',
      login,
      url: typeof user['url'] === 'string' ? user['url'] : null,
      avatarUrl: avatarUrl(user['avatarUrl']),
      state: string(review['state']),
      commentCount: number(object(review['comments'])['totalCount']),
    });
  }
  for (const reviewer of requestedReviewers) {
    reviewers.set(`${reviewer.kind}:${reviewer.login.toLowerCase()}`, {
      ...reviewer,
      state: 'REVIEW_REQUIRED',
      commentCount: 0,
    });
  }
  return {
    ...summary,
    authorAvatarUrl: avatarUrl(object(raw['author'])['avatarUrl']),
    body: string(raw['body']),
    baseRefName: string(raw['baseRefName']),
    baseRefOid: string(raw['baseRefOid']),
    headRefOid: string(raw['headRefOid']),
    createdAt: timestamp(raw['createdAt']),
    additions: number(raw['additions']),
    deletions: number(raw['deletions']),
    changedFiles: number(raw['changedFiles']),
    mergeable: string(raw['mergeable']),
    files,
    checksDetails: checks.slice(0, DETAIL_LIMIT).map((check) => {
      const legacy = check['__typename'] === 'StatusContext';
      const run = object(object(check['checkSuite'])['workflowRun']);
      const state = string(check['state']).toUpperCase();
      const completed = ['SUCCESS', 'FAILURE', 'ERROR'].includes(state);
      return {
        id: string(check['id']) || undefined,
        name: string(check['name'] ?? check['context']),
        workflowName: string(object(run['workflow'])['name']) || undefined,
        event: string(run['event']) || undefined,
        status: legacy
          ? completed
            ? 'COMPLETED'
            : 'PENDING'
          : string(check['status']),
        conclusion: legacy
          ? completed
            ? state === 'SUCCESS'
              ? 'SUCCESS'
              : 'FAILURE'
            : null
          : typeof check['conclusion'] === 'string'
            ? check['conclusion']
            : null,
        url:
          typeof (check['detailsUrl'] ?? check['targetUrl']) === 'string'
            ? string(check['detailsUrl'] ?? check['targetUrl'])
            : null,
      };
    }),
    reviews: nodes(raw['reviews']).map((review) => ({
      id: string(review['id']),
      author: author(review),
      authorAvatarUrl: avatarUrl(object(review['author'])['avatarUrl']),
      body: string(review['body']),
      state: string(review['state']),
      createdAt: timestamp(review['submittedAt']),
      url: string(review['url']),
    })),
    comments: comments.slice(0, DETAIL_LIMIT),
    requestedReviewers,
    reviewers: [...reviewers.values()],
    truncated: {
      files: number(raw['changedFiles']) > files.length,
      checks: truncated(checksConnection) || checks.length > DETAIL_LIMIT,
      reviews: truncated(raw['reviews']),
      comments:
        comments.length > DETAIL_LIMIT ||
        truncated(raw['comments']) ||
        truncated(raw['reviewThreads']) ||
        threads.some((thread) => truncated(thread['comments'])),
      requestedReviewers: truncated(raw['reviewRequests']),
      reviewers:
        truncated(raw['latestReviews']) || truncated(raw['reviewRequests']),
    },
  };
}

export async function fetchGitHubPullRequestDetail(
  cwd: string,
  ref: string,
  env: Readonly<Record<string, string | undefined>>,
  assertCanRead?: () => void,
): Promise<
  GitHubCodeReviewReadResult<{
    account: GitHubReviewAccount;
    repository: GitHubReviewRepository;
    pullRequest: GitHubPullRequestDetail;
  }>
> {
  const parsed = parseGitHubPullRequestRef(ref);
  const repository = repositoryFromRef(ref);
  if (!parsed?.repositoryUrl || !repository) return { kind: 'invalid_ref' };
  try {
    const read = readGh(cwd, env, assertCanRead);
    const host = accountHost(env);
    if (repository.host !== host) return { kind: 'host_mismatch' };
    const account = await readAccount(read, host);
    const [owner, name] = repository.nameWithOwner.split('/');
    const detail = object(
      JSON.parse(
        await read([
          'api',
          '--hostname',
          repository.host,
          'graphql',
          '-f',
          `query=${DETAIL_QUERY}`,
          '-f',
          `owner=${owner}`,
          '-f',
          `name=${name}`,
          '-F',
          `number=${parsed.number}`,
        ]),
      ),
    );
    if (Array.isArray(detail['errors']) && detail['errors'].length)
      throw new Error('GitHub PR detail returned an incomplete response');
    const raw = object(object(detail['data'])['repository'])['pullRequest'];
    if (!raw) return { kind: 'not_found' };
    const pr = object(raw);
    const actual = parseGitHubPullRequestRef(string(pr['url']));
    if (
      pr['number'] !== parsed.number ||
      actual?.number !== parsed.number ||
      actual.repositoryUrl !==
        `${repository.host}/${repository.nameWithOwner}`.toLowerCase()
    )
      throw new Error('GitHub PR identity changed during read');
    const commit = object(nodes(pr['commits'])[0]?.['commit']);
    if (commit['oid'] !== pr['headRefOid'])
      throw new Error('GitHub PR checks do not match its head');
    let checksPage = object(object(commit['statusCheckRollup'])['contexts']);
    const checks = nodes(checksPage);
    const cursors = new Set<string>();
    for (
      let page = 1;
      truncated(checksPage) && page < CHECK_PAGE_LIMIT;
      page++
    ) {
      const cursor = string(object(checksPage['pageInfo'])['endCursor']);
      if (!cursor || cursors.has(cursor))
        throw new Error('GitHub checks returned an invalid page cursor');
      cursors.add(cursor);
      const response = object(
        JSON.parse(
          await read([
            'api',
            '--hostname',
            repository.host,
            'graphql',
            '-f',
            `query=${CHECKS_QUERY}`,
            '-f',
            `owner=${owner}`,
            '-f',
            `name=${name}`,
            '-f',
            `oid=${string(pr['headRefOid'])}`,
            '-f',
            `checksCursor=${cursor}`,
          ]),
        ),
      );
      if (Array.isArray(response['errors']) && response['errors'].length)
        throw new Error('GitHub checks returned an incomplete response');
      const checkedCommit = object(
        object(object(response['data'])['repository'])['object'],
      );
      if (checkedCommit['oid'] !== pr['headRefOid'])
        throw new Error('GitHub checks changed commit during pagination');
      checksPage = object(
        object(checkedCommit['statusCheckRollup'])['contexts'],
      );
      checks.push(...nodes(checksPage));
    }
    const files = JSON.parse(
      await read([
        'api',
        '--hostname',
        repository.host,
        `repos/${repository.nameWithOwner}/pulls/${parsed.number}/files?per_page=${DETAIL_LIMIT}`,
      ]),
    );
    const current = object(
      JSON.parse(
        await read([
          'pr',
          'view',
          String(parsed.number),
          '--repo',
          `${repository.host}/${repository.nameWithOwner}`,
          '--json',
          'headRefOid,baseRefOid',
        ]),
      ),
    );
    if (
      current['headRefOid'] !== pr['headRefOid'] ||
      current['baseRefOid'] !== pr['baseRefOid']
    ) {
      throw new Error(
        'The PR changed while its files were being read. Refresh to load the latest revision.',
      );
    }
    await assertSameAccount(read, account);
    return {
      kind: 'ok',
      data: {
        account,
        repository,
        pullRequest: parseDetail(pr, files, {
          nodes: checks,
          pageInfo: { hasNextPage: truncated(checksPage) },
        }),
      },
    };
  } catch (error) {
    return readFailure(error);
  }
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGitHubPullRequestDetail,
  fetchGitHubPullRequestInbox,
  parseGitHubPullRequestRef,
} from './github-code-review.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const repository = {
  nameWithOwner: 'owner/repo',
  url: 'https://github.example/owner/repo',
};
const pr = {
  number: 42,
  title: 'Fix CI',
  body: 'Description',
  url: `${repository.url}/pull/42`,
  author: { login: 'alice' },
  state: 'OPEN',
  isDraft: false,
  headRefName: 'fix-ci',
  baseRefName: 'main',
  baseRefOid: 'a'.repeat(40),
  headRefOid: 'b'.repeat(40),
  createdAt: '2026-10-17T00:00:00Z',
  updatedAt: '2026-10-18T00:00:00Z',
  additions: 4,
  deletions: 2,
  changedFiles: 1,
  mergeable: 'MERGEABLE',
  reviewDecision: 'CHANGES_REQUESTED',
  commits: {
    nodes: [
      {
        commit: {
          oid: 'b'.repeat(40),
          statusCheckRollup: {
            contexts: {
              nodes: [
                {
                  __typename: 'CheckRun',
                  name: 'unit',
                  status: 'COMPLETED',
                  conclusion: 'FAILURE',
                  detailsUrl: 'https://github.example/check/1',
                },
                {
                  __typename: 'StatusContext',
                  context: 'external',
                  state: 'SUCCESS',
                  targetUrl: 'https://ci.example/1',
                },
              ],
              pageInfo: { hasNextPage: false },
            },
          },
        },
      },
    ],
  },
  reviews: {
    nodes: [
      {
        id: 'review1',
        author: { login: 'bob' },
        body: 'Fix this',
        state: 'CHANGES_REQUESTED',
        submittedAt: '2026-10-18T00:00:00Z',
        url: `${repository.url}/pull/42#review1`,
      },
    ],
    pageInfo: { hasPreviousPage: false },
  },
  latestReviews: {
    nodes: [
      {
        author: { login: 'bob', url: 'https://github.example/bob' },
        state: 'CHANGES_REQUESTED',
        comments: { totalCount: 5 },
      },
    ],
    pageInfo: { hasNextPage: false },
  },
  comments: {
    nodes: [
      {
        id: 'issue1',
        author: { login: 'bob' },
        body: 'General',
        createdAt: '2026-10-17T00:00:00Z',
        url: `${repository.url}/pull/42#issue1`,
      },
    ],
    pageInfo: { hasPreviousPage: false },
  },
  reviewThreads: {
    nodes: [
      {
        comments: {
          nodes: [
            {
              id: 'inline1',
              author: { login: 'bob' },
              body: 'Inline',
              createdAt: '2026-10-18T00:00:00Z',
              url: `${repository.url}/pull/42#inline1`,
              path: 'src/a.ts',
              line: 12,
            },
          ],
          pageInfo: { hasPreviousPage: false },
        },
      },
    ],
    pageInfo: { hasPreviousPage: false },
  },
  reviewRequests: {
    nodes: [
      {
        requestedReviewer: {
          __typename: 'User',
          login: 'carol',
          url: 'https://github.example/carol',
        },
      },
      {
        requestedReviewer: {
          __typename: 'Team',
          slug: 'maintainers',
          url: 'https://github.example/orgs/owner/teams/maintainers',
        },
      },
    ],
    pageInfo: { hasNextPage: false },
  },
};
const files = [
  {
    filename: 'src/a.ts',
    status: 'modified',
    additions: 4,
    deletions: 2,
    patch: '@@ -1 +1 @@\n-old\n+new',
  },
];

function checkRun(id: number, overrides: Record<string, unknown> = {}) {
  return {
    __typename: 'CheckRun',
    id: `check-${id}`,
    databaseId: id,
    name: 'route',
    status: 'COMPLETED',
    conclusion: 'CANCELLED',
    startedAt: '2026-10-17T00:00:00Z',
    detailsUrl: `https://github.example/check/${id}`,
    checkSuite: {
      createdAt: '2026-10-17T00:00:00Z',
      app: { id: 'github-actions' },
      workflowRun: {
        databaseId: id,
        createdAt: '2026-10-17T00:00:00Z',
        event: 'pull_request_review',
        workflow: { id: 'autofix', name: 'Autofix' },
      },
    },
    ...overrides,
  };
}

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
function mockReads(resolve: (args: string[]) => unknown = defaultRead) {
  vi.mocked(execFile).mockImplementation(
    (command: unknown, args: unknown, _options: unknown, callback: unknown) => {
      expect(command).toBe('gh');
      try {
        (callback as Callback)(
          null,
          JSON.stringify(resolve(args as string[])),
          '',
        );
      } catch (error) {
        (callback as Callback)(error as Error, '', '');
      }
      return {} as ReturnType<typeof execFile>;
    },
  );
}
const env = { GH_HOST: 'github.example', GH_TOKEN: 'operator-token' };
const prUrl = `${repository.url}/pull/42`;
const searchItem = (overrides: Record<string, unknown> = {}) => ({
  number: 42,
  title: pr.title,
  html_url: prUrl,
  user: { login: 'alice' },
  draft: false,
  state: 'open',
  updated_at: pr.updatedAt,
  ...overrides,
});
function defaultRead(args: string[]): unknown {
  if (args.includes('user')) return { login: 'alice' };
  if (args.includes('search/issues'))
    return { total_count: 1, incomplete_results: false, items: [searchItem()] };
  if (args[0] === 'pr' && args[1] === 'view')
    return { headRefOid: pr.headRefOid, baseRefOid: pr.baseRefOid };
  if (args.includes('graphql'))
    return { data: { repository: { pullRequest: structuredClone(pr) } } };
  if (args.some((arg) => arg.endsWith('/files?per_page=100'))) return files;
  throw new Error(`Unexpected command: ${args.join(' ')}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  mockReads();
});

describe('GitHub account Code Review reads', () => {
  it('searches all repositories using explicit operator credentials without Git discovery', async () => {
    const result = await fetchGitHubPullRequestInbox('/operator/home', {
      ...env,
      GH_REPO: 'foreign/repo',
      GIT_DIR: '/foreign/.git',
    });
    expect(result).toMatchObject({
      kind: 'ok',
      data: {
        account: { host: 'github.example', login: 'alice' },
        authored: [{ number: 42, author: 'alice', repository }],
        needsMyReview: [{ number: 42 }],
        page: 1,
        limit: 50,
        hasMore: { authored: false, needsMyReview: false },
      },
    });
    const calls = vi.mocked(execFile).mock.calls;
    expect(calls).toHaveLength(5);
    const queries = calls
      .filter((call) => (call[1] as string[]).includes('search/issues'))
      .map((call) => call[1] as string[]);
    expect(queries).toHaveLength(3);
    for (const qualifier of ['author', 'review-requested', 'assignee'])
      expect(
        queries.some((args) =>
          args.includes(`q=is:pr is:open archived:false ${qualifier}:alice`),
        ),
      ).toBe(true);
    for (const args of queries) {
      expect(args).toEqual(
        expect.arrayContaining([
          '--method',
          'GET',
          'per_page=50',
          'page=1',
          'sort=updated',
          'order=desc',
        ]),
      );
      expect(args.join(' ')).not.toContain('repo:');
    }
    for (const call of calls) {
      expect(call[0]).toBe('gh');
      expect(call[2]).toMatchObject({
        cwd: '/operator/home',
        env: { GH_TOKEN: 'operator-token' },
      });
      const passed = (call[2] as { env: Record<string, unknown> }).env;
      expect(passed).not.toHaveProperty('GH_REPO');
      expect(passed).not.toHaveProperty('GIT_DIR');
      expect(call[1]).not.toEqual(
        expect.arrayContaining(['create', 'edit', 'comment', 'merge']),
      );
    }
  });

  it('deduplicates requested and assigned URLs without confusing equal numbers in different repositories', async () => {
    mockReads((args) =>
      args.some((arg) => arg.includes('assignee:'))
        ? {
            total_count: 2,
            incomplete_results: false,
            items: [
              searchItem(),
              searchItem({
                html_url: 'https://github.example/other/repo/pull/42',
              }),
            ],
          }
        : defaultRead(args),
    );
    const result = await fetchGitHubPullRequestInbox('/non-git', env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.needsMyReview).toHaveLength(2);
    expect(
      result.data.needsMyReview
        .map((row) => row.repository.nameWithOwner)
        .sort(),
    ).toEqual(['other/repo', 'owner/repo']);
  });

  it.each([
    ['https://avatars.githubusercontent.com/u/1?v=4', true],
    [undefined, false],
    [null, false],
    ['', false],
    ['not-a-url', false],
    ['/alice.png', false],
    ['http://avatars.githubusercontent.com/u/1', false],
    ['data:image/png;base64,AAAA', false],
    ['https://user:secret@avatars.githubusercontent.com/u/1', false],
  ])('only forwards usable HTTPS inbox avatars: %s', async (value, valid) => {
    mockReads((args) =>
      args.includes('search/issues')
        ? {
            total_count: 1,
            incomplete_results: false,
            items: [
              searchItem({ user: { login: 'alice', avatar_url: value } }),
            ],
          }
        : defaultRead(args),
    );
    const result = await fetchGitHubPullRequestInbox('/non-git', env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.authored[0]?.authorAvatarUrl).toBe(
      valid ? value : undefined,
    );
    expect(result.data.needsMyReview[0]?.authorAvatarUrl).toBe(
      valid ? value : undefined,
    );
    expect(execFile).toHaveBeenCalledTimes(5);
  });

  it('keeps all 100 disjoint rows from the two review sources on one page', async () => {
    mockReads((args) => {
      if (!args.includes('search/issues')) return defaultRead(args);
      const repo = args.some((arg) => arg.includes('assignee:'))
        ? 'assigned'
        : 'requested';
      return {
        total_count: 51,
        incomplete_results: false,
        items: Array.from({ length: 50 }, (_, index) =>
          searchItem({
            number: index + 1,
            html_url: `https://github.example/${repo}/repo/pull/${index + 1}`,
          }),
        ),
      };
    });
    const result = await fetchGitHubPullRequestInbox('/non-git', env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.needsMyReview).toHaveLength(100);
    expect(result.data.hasMore).toEqual({
      authored: true,
      needsMyReview: true,
    });
  });

  it('exposes source counts, incomplete search and the 1000-result search limit', async () => {
    mockReads((args) =>
      args.includes('search/issues')
        ? { total_count: 1201, incomplete_results: true, items: [searchItem()] }
        : defaultRead(args),
    );
    const result = await fetchGitHubPullRequestInbox('/non-git', env, 20);
    expect(result).toMatchObject({
      kind: 'ok',
      data: {
        page: 20,
        hasMore: { authored: false, needsMyReview: false },
        search: {
          authored: {
            totalCount: 1201,
            incompleteResults: true,
            searchLimitReached: true,
          },
        },
      },
    });
    expect(vi.mocked(execFile).mock.calls[1]?.[1]).toContain('page=20');
  });

  it.each([0, 21, 1.5, NaN])(
    'rejects invalid page %s without subprocesses',
    async (page) => {
      expect(await fetchGitHubPullRequestInbox('/non-git', env, page)).toEqual({
        kind: 'invalid_page',
      });
      expect(execFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    '42',
    '#42',
    '--repo=foreign/repo',
    '0',
    '-1',
    '42;touch /tmp/no',
    'https://example.com/o/r/issues/42',
    'https://user:password@github.example/owner/repo/pull/42',
  ])('requires a complete valid PR URL: %s', async (ref) => {
    expect(await fetchGitHubPullRequestDetail('/non-git', ref, env)).toEqual({
      kind: 'invalid_ref',
    });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('validates full URL suffixes and rejects another host before sending credentials', async () => {
    expect(parseGitHubPullRequestRef(`${prUrl}/files?x=1#diff`)?.number).toBe(
      42,
    );
    expect(
      await fetchGitHubPullRequestDetail(
        '/non-git',
        'https://foreign.example/owner/repo/pull/42',
        env,
      ),
    ).toEqual({ kind: 'host_mismatch' });
    expect(execFile).not.toHaveBeenCalled();
  });

  it('maps detail, checks, reviews, all comments, file patches and reviewers from any accessible repository', async () => {
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data).toMatchObject({
      account: { host: 'github.example', login: 'alice' },
      repository,
    });
    expect(result.data.pullRequest).toMatchObject({
      number: 42,
      state: 'open',
      body: 'Description',
      checks: 'failing',
      headRefOid: 'b'.repeat(40),
      files: [
        { path: 'src/a.ts', patch: files[0].patch, patchTruncated: false },
      ],
      checksDetails: [
        { name: 'unit', conclusion: 'FAILURE' },
        { name: 'external', status: 'COMPLETED', conclusion: 'SUCCESS' },
      ],
      reviews: [{ author: 'bob', state: 'CHANGES_REQUESTED' }],
      comments: [
        { id: 'inline1', path: 'src/a.ts', line: 12 },
        { id: 'issue1', path: null, line: null },
      ],
      requestedReviewers: [
        { kind: 'user', login: 'carol' },
        { kind: 'team', login: 'maintainers' },
      ],
      reviewers: [
        { login: 'bob', state: 'CHANGES_REQUESTED', commentCount: 5 },
        { login: 'carol', state: 'REVIEW_REQUIRED', commentCount: 0 },
        { kind: 'team', login: 'maintainers', state: 'REVIEW_REQUIRED' },
      ],
      truncated: {
        files: false,
        checks: false,
        reviews: false,
        comments: false,
        requestedReviewers: false,
        reviewers: false,
      },
    });
    expect(result.data.pullRequest.createdAt).toBe(
      Date.parse(pr.createdAt) / 1000,
    );
    expect(result.data.pullRequest.authorAvatarUrl).toBeUndefined();
    expect(
      result.data.pullRequest.reviews.every(
        (review) => !review.authorAvatarUrl,
      ),
    ).toBe(true);
    expect(
      result.data.pullRequest.comments.every(
        (comment) => !comment.authorAvatarUrl,
      ),
    ).toBe(true);
    expect(
      result.data.pullRequest.requestedReviewers.every(
        (reviewer) => !reviewer.avatarUrl,
      ),
    ).toBe(true);
  });

  it('maps detail, activity and reviewer avatars from the existing GraphQL read', async () => {
    const avatarUrls = {
      author: 'https://avatars.githubusercontent.com/u/1?v=4',
      review: 'https://avatars.githubusercontent.com/u/2?v=4',
      comment: 'https://avatars.githubusercontent.com/u/3?v=4',
      inline: 'https://avatars.githubusercontent.com/u/4?v=4',
      user: 'https://avatars.githubusercontent.com/u/5?v=4',
      team: 'https://avatars.githubusercontent.com/t/6?v=4',
    };
    mockReads((args) => {
      if (!args.includes('graphql')) return defaultRead(args);
      const raw = structuredClone(pr);
      Object.assign(raw.author, { avatarUrl: avatarUrls.author });
      Object.assign(raw.reviews.nodes[0].author, {
        avatarUrl: avatarUrls.review,
      });
      Object.assign(raw.comments.nodes[0].author, {
        avatarUrl: avatarUrls.comment,
      });
      Object.assign(raw.reviewThreads.nodes[0].comments.nodes[0].author, {
        avatarUrl: avatarUrls.inline,
      });
      Object.assign(raw.reviewRequests.nodes[0].requestedReviewer, {
        avatarUrl: avatarUrls.user,
      });
      Object.assign(raw.reviewRequests.nodes[1].requestedReviewer, {
        avatarUrl: avatarUrls.team,
      });
      return { data: { repository: { pullRequest: raw } } };
    });
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.pullRequest).toMatchObject({
      authorAvatarUrl: avatarUrls.author,
      reviews: [{ authorAvatarUrl: avatarUrls.review }],
      comments: [
        { id: 'inline1', authorAvatarUrl: avatarUrls.inline },
        { id: 'issue1', authorAvatarUrl: avatarUrls.comment },
      ],
      requestedReviewers: [
        { kind: 'user', avatarUrl: avatarUrls.user },
        { kind: 'team', avatarUrl: avatarUrls.team },
      ],
    });
    expect(execFile).toHaveBeenCalledTimes(5);
    const args = vi
      .mocked(execFile)
      .mock.calls.find((call) =>
        (call[1] as string[]).includes('graphql'),
      )?.[1] as string[];
    const query = args.find((arg) => arg.startsWith('query='));
    expect(query).toContain('author{login avatarUrl}');
    expect(query).toContain('... on Team{slug url avatarUrl}');
  });

  it('preserves merged state and exposes incomplete connections and patch bounds', async () => {
    mockReads((args) => {
      if (args.includes('graphql')) {
        const raw = structuredClone(pr);
        raw.state = 'MERGED';
        raw.changedFiles = 101;
        raw.reviews.pageInfo.hasPreviousPage = true;
        raw.reviewThreads.nodes[0].comments.pageInfo.hasPreviousPage = true;
        return { data: { repository: { pullRequest: raw } } };
      }
      if (args.some((arg) => arg.endsWith('/files?per_page=100')))
        return [{ ...files[0], patch: 'x'.repeat(50_000) }];
      return defaultRead(args);
    });
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.pullRequest.state).toBe('merged');
    expect(result.data.pullRequest.truncated).toMatchObject({
      files: true,
      reviews: true,
      comments: true,
    });
    expect(result.data.pullRequest.files[0]?.patch).toHaveLength(16 * 1024);
    expect(result.data.pullRequest.files[0]?.patchTruncated).toBe(true);
  });

  it('stops after reads when the feature is disabled', async () => {
    let checks = 0;
    const result = await fetchGitHubPullRequestInbox('/non-git', env, 1, () => {
      if (++checks > 1) throw new Error('disabled');
    });
    expect(result.kind).toBe('failed');
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it('does not return a snapshot spanning a changed GitHub account', async () => {
    let reads = 0;
    mockReads((args) =>
      args.includes('user')
        ? { login: ++reads === 1 ? 'alice' : 'other' }
        : defaultRead(args),
    );
    expect(await fetchGitHubPullRequestInbox('/non-git', env)).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('account changed'),
    });
  });

  it.each([
    [
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
      'cli_unavailable',
    ],
    [Object.assign(new Error('timeout'), { killed: true }), 'failed'],
    [new Error('HTTP 404: not found'), 'not_found'],
  ])('classifies read failures', async (error, kind) => {
    mockReads(() => {
      throw error;
    });
    expect(await fetchGitHubPullRequestInbox('/non-git', env)).toMatchObject({
      kind,
    });
  });

  it('rejects incomplete GraphQL responses rather than presenting success', async () => {
    mockReads((args) =>
      args.includes('graphql')
        ? {
            data: { repository: { pullRequest: pr } },
            errors: [{ message: 'resource limit' }],
          }
        : defaultRead(args),
    );
    expect(
      await fetchGitHubPullRequestDetail('/non-git', prUrl, env),
    ).toMatchObject({ kind: 'failed' });
    expect(execFile).toHaveBeenCalledTimes(2);
  });

  it('refuses files read across a changed PR head', async () => {
    mockReads((args) =>
      args[0] === 'pr' && args[1] === 'view'
        ? { headRefOid: 'c'.repeat(40), baseRefOid: pr.baseRefOid }
        : defaultRead(args),
    );
    expect(
      await fetchGitHubPullRequestDetail('/non-git', prUrl, env),
    ).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('PR changed'),
    });
  });

  it('reads later check pages at the captured head and replaces historical attempts', async () => {
    mockReads((args) => {
      if (!args.includes('graphql')) return defaultRead(args);
      if (args.includes(`oid=${pr.headRefOid}`)) {
        expect(args).toContain('checksCursor=first-page');
        const latest = checkRun(101, {
          status: 'QUEUED',
          conclusion: null,
          startedAt: null,
        });
        const failure = checkRun(102, {
          name: 'web-shell E2E Smoke',
          conclusion: 'FAILURE',
        });
        return {
          data: {
            repository: {
              object: {
                oid: pr.headRefOid,
                statusCheckRollup: {
                  contexts: {
                    nodes: [latest, failure],
                    pageInfo: { hasNextPage: false },
                  },
                },
              },
            },
          },
        };
      }
      const raw = structuredClone(pr);
      Object.assign(raw.commits.nodes[0].commit.statusCheckRollup.contexts, {
        nodes: Array.from({ length: 100 }, (_, index) => checkRun(index + 1)),
        pageInfo: { hasNextPage: true, endCursor: 'first-page' },
      });
      return { data: { repository: { pullRequest: raw } } };
    });
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.pullRequest.checksDetails).toEqual([
      expect.objectContaining({
        name: 'web-shell E2E Smoke',
        conclusion: 'FAILURE',
      }),
      expect.objectContaining({
        id: 'check-101',
        name: 'route',
        status: 'QUEUED',
        conclusion: null,
        workflowName: 'Autofix',
        event: 'pull_request_review',
      }),
    ]);
    expect(result.data.pullRequest.checks).toBe('failing');
    expect(result.data.pullRequest.truncated.checks).toBe(false);
    expect(execFile).toHaveBeenCalledTimes(6);
  });

  it('keeps distinct apps, workflows, events and checks without grouping metadata', async () => {
    const run = checkRun(1, { conclusion: 'SUCCESS' });
    const suite = run.checkSuite;
    const workflowRun = suite.workflowRun;
    const checks = [
      run,
      checkRun(2, { status: 'QUEUED', conclusion: null, startedAt: null }),
      checkRun(3, { checkSuite: { ...suite, app: { id: 'other-app' } } }),
      checkRun(4, {
        checkSuite: {
          ...suite,
          workflowRun: {
            ...workflowRun,
            workflow: { id: 'other-workflow', name: 'Autofix' },
          },
        },
      }),
      checkRun(5, {
        checkSuite: {
          ...suite,
          workflowRun: { ...workflowRun, event: 'push' },
        },
      }),
      checkRun(6, { checkSuite: {} }),
      checkRun(7, { checkSuite: {} }),
      checkRun(8, {
        checkSuite: { app: { id: 'external' }, workflowRun: null },
      }),
      checkRun(9, {
        checkSuite: { app: { id: 'external' }, workflowRun: null },
      }),
    ];
    mockReads((args) => {
      if (!args.includes('graphql')) return defaultRead(args);
      const raw = structuredClone(pr);
      Object.assign(raw.commits.nodes[0].commit.statusCheckRollup.contexts, {
        nodes: checks,
      });
      return { data: { repository: { pullRequest: raw } } };
    });
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(
      result.data.pullRequest.checksDetails.map((check) => check.id).sort(),
    ).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map((id) => `check-${id}`));
    expect(
      result.data.pullRequest.checksDetails.find(
        (check) => check.id === 'check-2',
      )?.status,
    ).toBe('QUEUED');
  });

  it('keeps the later-started queued job when a later-created workflow skipped it', async () => {
    const suite = checkRun(1).checkSuite;
    const createdAt = '2026-10-18T05:54:20Z';
    const skipped = checkRun(117600458921, {
      name: 'review-pr',
      startedAt: '2026-10-18T05:54:21Z',
      conclusion: 'SKIPPED',
      checkSuite: {
        ...suite,
        createdAt,
        workflowRun: {
          ...suite.workflowRun,
          databaseId: 39102154518,
          createdAt,
        },
      },
    });
    const queued = checkRun(117601541609, {
      name: 'review-pr',
      status: 'QUEUED',
      conclusion: null,
      startedAt: '2026-10-18T06:00:57Z',
      checkSuite: {
        ...suite,
        createdAt,
        workflowRun: {
          ...suite.workflowRun,
          databaseId: 39102154508,
          createdAt,
        },
      },
    });
    mockReads((args) => {
      if (!args.includes('graphql')) return defaultRead(args);
      const raw = structuredClone(pr);
      Object.assign(raw.commits.nodes[0].commit.statusCheckRollup.contexts, {
        nodes: [skipped, queued],
      });
      return { data: { repository: { pullRequest: raw } } };
    });
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.pullRequest.checksDetails).toEqual([
      expect.objectContaining({ id: 'check-117601541609', status: 'QUEUED' }),
    ]);
    expect(result.data.pullRequest.checks).toBe('pending');
  });

  it('uses the latest legacy status instead of retaining historical failures', async () => {
    mockReads((args) => {
      if (!args.includes('graphql')) return defaultRead(args);
      const raw = structuredClone(pr);
      Object.assign(raw.commits.nodes[0].commit.statusCheckRollup.contexts, {
        nodes: [
          {
            __typename: 'StatusContext',
            context: 'external',
            state: 'FAILURE',
            createdAt: '2026-10-17T00:00:00Z',
          },
          {
            __typename: 'StatusContext',
            context: 'external',
            state: 'PENDING',
            createdAt: '2026-10-18T00:00:00Z',
          },
        ],
      });
      return { data: { repository: { pullRequest: raw } } };
    });
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.pullRequest.checksDetails).toEqual([
      expect.objectContaining({
        name: 'external',
        status: 'PENDING',
        conclusion: null,
      }),
    ]);
    expect(result.data.pullRequest.checks).toBe('pending');
  });

  it('bounds check pagination and marks unfinished current-check results', async () => {
    let page = 0;
    mockReads((args) => {
      if (!args.includes('graphql')) return defaultRead(args);
      const contexts = {
        nodes: [checkRun(++page)],
        pageInfo: { hasNextPage: true, endCursor: `page-${page}` },
      };
      if (args.includes(`oid=${pr.headRefOid}`)) {
        expect(args).toContain(`checksCursor=page-${page - 1}`);
        return {
          data: {
            repository: {
              object: { oid: pr.headRefOid, statusCheckRollup: { contexts } },
            },
          },
        };
      }
      const raw = structuredClone(pr);
      Object.assign(
        raw.commits.nodes[0].commit.statusCheckRollup.contexts,
        contexts,
      );
      return { data: { repository: { pullRequest: raw } } };
    });
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(page).toBe(20);
    expect(result.data.pullRequest.checksDetails).toHaveLength(1);
    expect(result.data.pullRequest.checksDetails[0].id).toBe('check-20');
    expect(result.data.pullRequest.truncated.checks).toBe(true);
  });

  it('rejects check pagination that returns another commit', async () => {
    mockReads((args) => {
      if (!args.includes('graphql')) return defaultRead(args);
      if (args.includes(`oid=${pr.headRefOid}`))
        return { data: { repository: { object: { oid: 'c'.repeat(40) } } } };
      const raw = structuredClone(pr);
      Object.assign(
        raw.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo,
        { hasNextPage: true, endCursor: 'first-page' },
      );
      return { data: { repository: { pullRequest: raw } } };
    });
    expect(
      await fetchGitHubPullRequestDetail('/non-git', prUrl, env),
    ).toMatchObject({
      kind: 'failed',
      message: expect.stringContaining('changed commit'),
    });
    expect(execFile).toHaveBeenCalledTimes(3);
  });

  it('combines latest reviewer states and counts with outstanding requests', async () => {
    mockReads((args) => {
      if (!args.includes('graphql')) return defaultRead(args);
      const raw = structuredClone(pr);
      Object.assign(raw.latestReviews, {
        nodes: [
          ...raw.latestReviews.nodes,
          {
            author: { login: 'CAROL' },
            state: 'APPROVED',
            comments: { totalCount: 3 },
          },
          {
            author: { login: 'maintainers' },
            state: 'COMMENTED',
            comments: { totalCount: 1 },
          },
          { author: null, state: 'COMMENTED', comments: { totalCount: 99 } },
        ],
        pageInfo: { hasNextPage: true },
      });
      return { data: { repository: { pullRequest: raw } } };
    });
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.pullRequest.reviewers).toEqual([
      expect.objectContaining({
        kind: 'user',
        login: 'bob',
        state: 'CHANGES_REQUESTED',
        commentCount: 5,
      }),
      expect.objectContaining({
        kind: 'user',
        login: 'carol',
        state: 'REVIEW_REQUIRED',
        commentCount: 0,
      }),
      expect.objectContaining({
        kind: 'user',
        login: 'maintainers',
        state: 'COMMENTED',
        commentCount: 1,
      }),
      expect.objectContaining({
        kind: 'team',
        login: 'maintainers',
        state: 'REVIEW_REQUIRED',
        commentCount: 0,
      }),
    ]);
    expect(result.data.pullRequest.truncated.reviewers).toBe(true);
  });

  it.each([
    ['SUCCESS', 'COMPLETED', 'SUCCESS'],
    ['FAILURE', 'COMPLETED', 'FAILURE'],
    ['ERROR', 'COMPLETED', 'FAILURE'],
    ['PENDING', 'PENDING', null],
  ])('normalizes legacy status %s', async (state, status, conclusion) => {
    mockReads((args) => {
      if (!args.includes('graphql')) return defaultRead(args);
      const raw = structuredClone(pr);
      const contexts = raw.commits.nodes[0].commit.statusCheckRollup.contexts;
      contexts.nodes = contexts.nodes.map((context) =>
        context.context !== undefined ? { ...context, state: state! } : context,
      );
      return { data: { repository: { pullRequest: raw } } };
    });
    const result = await fetchGitHubPullRequestDetail('/non-git', prUrl, env);
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data.pullRequest.checksDetails[1]).toMatchObject({
      status,
      conclusion,
    });
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildSnapshot, type PrData } from './snapshot.js';
import { REPLY_MARKER, type AutofixPrState } from './state.js';

const HEAD = 'a'.repeat(40);

function state(overrides: Partial<AutofixPrState> = {}): AutofixPrState {
  return {
    version: 1,
    sessionId: 's1',
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    remote: 'origin',
    pushTarget: 'origin',
    headRefName: 'feat',
    baseRefName: 'main',
    branch: 'qwen-autofix/pr-7',
    worktreePath: '/repo/.qwen/tmp/autofix-pr-7',
    viewer: 'me',
    prAuthor: 'me',
    lastKnownHeadSha: HEAD,
    pushedShas: [],
    handledCommentIds: [],
    postedCommentIds: [],
    ...overrides,
  };
}

type Contexts = NonNullable<
  PrData['commits']['nodes'][number]['commit']['statusCheckRollup']
>['contexts']['nodes'];

function pr(overrides: Partial<PrData> = {}, contexts: Contexts = []): PrData {
  return {
    state: 'OPEN',
    isDraft: false,
    url: 'https://github.com/o/r/pull/7',
    headRefOid: HEAD,
    mergeable: 'MERGEABLE',
    commits: {
      nodes: [
        {
          commit: {
            oid: HEAD,
            statusCheckRollup: {
              contexts: { pageInfo: { hasNextPage: false }, nodes: contexts },
            },
          },
        },
      ],
    },
    reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] },
    reviews: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: [] },
    ...overrides,
  };
}

function comment(
  id: string,
  login: string,
  association = 'NONE',
  extra: {
    bot?: boolean;
    body?: string;
    databaseId?: number;
    state?: string;
  } = {},
) {
  return {
    id,
    databaseId: extra.databaseId,
    author: { __typename: extra.bot ? 'Bot' : 'User', login },
    authorAssociation: association,
    body: extra.body ?? `please fix ${id}`,
    url: `https://github.com/o/r/pull/7#${id}`,
    state: extra.state,
  };
}

function thread(
  id: string,
  comments: Array<ReturnType<typeof comment>>,
  extra: { isResolved?: boolean; isOutdated?: boolean } = {},
) {
  return {
    id,
    isResolved: extra.isResolved ?? false,
    isOutdated: extra.isOutdated ?? false,
    path: 'src/a.ts',
    line: 3,
    root: {
      nodes: comments
        .slice(0, 1)
        .map(({ databaseId }) => ({ databaseId: databaseId ?? 0 })),
    },
    comments: { pageInfo: { hasPreviousPage: false }, nodes: comments },
  };
}

function threads(...nodes: Array<ReturnType<typeof thread>>) {
  return { reviewThreads: { pageInfo: { hasNextPage: false }, nodes } };
}

describe('buildSnapshot', () => {
  it('stops on a merged or closed PR', () => {
    expect(buildSnapshot(pr({ state: 'MERGED' }), state())).toMatchObject({
      action: 'stop',
      events: [{ type: 'merged' }],
    });
    expect(buildSnapshot(pr({ state: 'CLOSED' }), state())).toMatchObject({
      action: 'stop',
      events: [{ type: 'closed' }],
    });
  });

  it('waits when nothing changed', () => {
    expect(buildSnapshot(pr(), state())).toEqual({
      action: 'wait',
      headSha: HEAD,
      isDraft: false,
      url: 'https://github.com/o/r/pull/7',
      events: [],
      truncated: [],
    });
  });

  it('resyncs when someone else moved the head, and still lists the rest', () => {
    const moved = 'b'.repeat(40);
    const snap = buildSnapshot(
      pr({
        headRefOid: moved,
        mergeable: 'CONFLICTING',
        commits: { nodes: [] },
      }),
      state(),
    );
    expect(snap.action).toBe('resync');
    expect(snap.events).toEqual([
      { type: 'head_moved_externally', sha: moved },
      { type: 'conflict' },
    ]);
  });

  it('does not treat its own push as an external move', () => {
    const pushed = 'c'.repeat(40);
    const snap = buildSnapshot(
      pr({ headRefOid: pushed, commits: { nodes: [] } }),
      state({ pushedShas: [pushed] }),
    );
    expect(snap.action).toBe('wait');
  });

  it('asks for a fix on a merge conflict', () => {
    expect(
      buildSnapshot(pr({ mergeable: 'CONFLICTING' }), state()),
    ).toMatchObject({
      action: 'fix',
      events: [{ type: 'conflict' }],
    });
  });

  it('reports failed checks with their run id and waits on pending ones', () => {
    const snap = buildSnapshot(
      pr({}, [
        {
          __typename: 'CheckRun',
          databaseId: 1,
          name: 'Test ubuntu',
          status: 'COMPLETED',
          conclusion: 'FAILURE',
          detailsUrl: 'https://github.com/o/r/actions/runs/123/job/456',
        },
        {
          __typename: 'CheckRun',
          databaseId: 2,
          name: 'Lint',
          status: 'COMPLETED',
          conclusion: 'CANCELLED',
          detailsUrl: null,
        },
        {
          __typename: 'CheckRun',
          databaseId: 3,
          name: 'Build',
          status: 'IN_PROGRESS',
          conclusion: null,
          detailsUrl: null,
        },
        {
          __typename: 'StatusContext',
          createdAt: '2026-10-21T00:00:06Z',
          context: 'ci/external',
          state: 'ERROR',
          targetUrl: 'https://ci.example.com/1',
        },
        {
          __typename: 'StatusContext',
          createdAt: '2026-10-21T00:00:07Z',
          context: 'ci/slow',
          state: 'PENDING',
          targetUrl: null,
        },
      ]),
      state(),
    );
    expect(snap.action).toBe('fix');
    expect(snap.events).toEqual([
      {
        type: 'ci_failed',
        check: 'Test ubuntu',
        url: 'https://github.com/o/r/actions/runs/123/job/456',
        runId: 123,
      },
      {
        type: 'ci_failed',
        check: 'ci/external',
        url: 'https://ci.example.com/1',
        runId: null,
      },
      { type: 'ci_pending', checks: ['Build', 'ci/slow'] },
    ]);
  });

  it('judges each check by its latest run only', () => {
    const run = (
      databaseId: number,
      conclusion: string | null,
      workflow = 'CI',
      event = 'pull_request',
    ): Contexts[number] => ({
      __typename: 'CheckRun',
      name: 'Test ubuntu',
      status: conclusion === null ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion,
      detailsUrl: `https://github.com/o/r/actions/runs/${databaseId}/job/1`,
      databaseId,
      checkSuite: { workflowRun: { event, workflow: { name: workflow } } },
    });
    const failures = (contexts: Contexts) =>
      buildSnapshot(pr({}, contexts), state())
        .events.filter((e) => e.type === 'ci_failed')
        .map((e) => (e.type === 'ci_failed' ? e.runId : null));
    // A failure that a re-run turned green, in either order of the rollup.
    expect(failures([run(1, 'FAILURE'), run(2, 'SUCCESS')])).toEqual([]);
    expect(failures([run(2, 'SUCCESS'), run(1, 'FAILURE')])).toEqual([]);
    // A green run that a re-run turned red.
    expect(failures([run(1, 'SUCCESS'), run(2, 'FAILURE')])).toEqual([2]);
    // A re-run still going: pending, not failed.
    expect(
      buildSnapshot(pr({}, [run(1, 'FAILURE'), run(2, null)]), state()).events,
    ).toEqual([{ type: 'ci_pending', checks: ['Test ubuntu'] }]);
    // The same job name in another workflow, or on another trigger, is
    // another check.
    expect(failures([run(1, 'FAILURE'), run(2, 'SUCCESS', 'Release')])).toEqual(
      [1],
    );
    expect(
      failures([
        run(1, 'FAILURE'),
        run(2, 'SKIPPED', 'CI', 'pull_request_review'),
      ]),
    ).toEqual([1]);
  });

  it('judges a commit status by its latest post', () => {
    const status = (createdAt: string, state: string): Contexts[number] => ({
      __typename: 'StatusContext',
      context: 'ci/external',
      state,
      targetUrl: null,
      createdAt,
    });
    expect(
      buildSnapshot(
        pr({}, [
          status('2026-10-21T00:00:01Z', 'FAILURE'),
          status('2026-10-21T00:00:02Z', 'SUCCESS'),
        ]),
        state(),
      ).events,
    ).toEqual([]);
  });

  it('waits while checks are only pending', () => {
    const snap = buildSnapshot(
      pr({}, [
        {
          __typename: 'CheckRun',
          databaseId: 4,
          name: 'Build',
          status: 'QUEUED',
          conclusion: null,
          detailsUrl: null,
        },
      ]),
      state(),
    );
    expect(snap.action).toBe('wait');
    expect(snap.events).toEqual([{ type: 'ci_pending', checks: ['Build'] }]);
  });

  it('ignores a rollup that belongs to an older commit', () => {
    const data = pr({}, [
      {
        __typename: 'CheckRun',
        databaseId: 5,
        name: 'Test',
        status: 'COMPLETED',
        conclusion: 'FAILURE',
        detailsUrl: null,
      },
    ]);
    data.commits.nodes[0].commit.oid = 'd'.repeat(40);
    expect(buildSnapshot(data, state()).events).toEqual([]);
  });

  it('groups trusted thread comments and replies to the top-level comment', () => {
    const snap = buildSnapshot(
      pr(
        threads(
          thread('T1', [
            comment('C1', 'alice', 'COLLABORATOR', { databaseId: 11 }),
            comment('C2', 'me', 'NONE', { databaseId: 12 }),
            comment('C3', 'stranger', 'CONTRIBUTOR', { databaseId: 13 }),
          ]),
        ),
      ),
      state({ handledCommentIds: ['C1'] }),
    );
    expect(snap.action).toBe('fix');
    expect(snap.events).toEqual([
      {
        type: 'untrusted_comment',
        id: 'C3',
        author: 'stranger',
        url: 'https://github.com/o/r/pull/7#C3',
      },
      {
        type: 'review_thread',
        threadId: 'T1',
        replyTo: 11,
        path: 'src/a.ts',
        line: 3,
        outdated: false,
        comments: [
          {
            id: 'C2',
            author: 'me',
            trust: 'pr_author',
            body: 'please fix C2',
            url: 'https://github.com/o/r/pull/7#C2',
          },
        ],
      },
    ]);
  });

  it('maps each trusted association', () => {
    const snap = buildSnapshot(
      pr(
        threads(
          thread('T1', [comment('C1', 'a', 'OWNER')]),
          thread('T2', [comment('C2', 'b', 'MEMBER')]),
          thread('T3', [comment('C3', 'c', 'COLLABORATOR')]),
          thread('T4', [comment('C4', 'review-bot', 'NONE', { bot: true })]),
        ),
      ),
      state(),
    );
    expect(
      snap.events.map((e) =>
        e.type === 'review_thread' ? e.comments[0].trust : e.type,
      ),
    ).toEqual(['owner', 'member', 'collaborator', 'bot']);
  });

  it('waits on untrusted comments alone', () => {
    const snap = buildSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [comment('I1', 'stranger', 'CONTRIBUTOR')],
        },
      }),
      state(),
    );
    expect(snap.action).toBe('wait');
    expect(snap.events).toEqual([
      {
        type: 'untrusted_comment',
        id: 'I1',
        author: 'stranger',
        url: 'https://github.com/o/r/pull/7#I1',
      },
    ]);
  });

  it('treats a deleted author as untrusted', () => {
    const ghost = { ...comment('I1', 'x', 'OWNER'), author: null };
    const snap = buildSnapshot(
      pr({
        comments: { pageInfo: { hasPreviousPage: false }, nodes: [ghost] },
      }),
      state(),
    );
    expect(snap.events).toEqual([
      {
        type: 'untrusted_comment',
        id: 'I1',
        author: 'ghost',
        url: 'https://github.com/o/r/pull/7#I1',
      },
    ]);
  });

  it('drops bot conversation comments entirely', () => {
    const snap = buildSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [comment('I1', 'coverage', 'NONE', { bot: true })],
        },
      }),
      state(),
    );
    expect(snap).toMatchObject({ action: 'wait', events: [] });
  });

  it('takes a comment quoting a reply for a new comment', () => {
    // GitHub's quote-reply carries the quoted body, marker included.
    const quoted = `> Fixed in abc\n> ${REPLY_MARKER}\n\nnot fixed yet`;
    const snap = buildSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            comment('I1', 'alice', 'MEMBER', { body: quoted }),
            // Only the viewer posts replies, so the marker alone proves nothing.
            comment('I2', 'bob', 'MEMBER', { body: `ok\n${REPLY_MARKER}` }),
          ],
        },
      }),
      state(),
    );
    expect(snap.action).toBe('fix');
    expect(
      snap.events.map((e) => (e.type === 'issue_comment' ? e.id : e.type)),
    ).toEqual(['I1', 'I2']);
  });

  it('replies to the thread root even when only the newest replies were read', () => {
    const data = pr(
      threads(
        thread('T1', [comment('C150', 'alice', 'MEMBER', { databaseId: 150 })]),
      ),
    );
    data.reviewThreads.nodes[0].root = { nodes: [{ databaseId: 11 }] };
    data.reviewThreads.nodes[0].comments.pageInfo.hasPreviousPage = true;
    const snap = buildSnapshot(data, state());
    expect(snap.events).toMatchObject([
      { type: 'review_thread', replyTo: 11, comments: [{ id: 'C150' }] },
    ]);
    expect(snap.truncated).toEqual(['reviewThreadComments']);
  });

  it('never answers itself: marker, posted ids and handled ids are skipped', () => {
    const snap = buildSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            comment('I1', 'me', 'OWNER', {
              body: `Fixed in abc\n${REPLY_MARKER}`,
            }),
            comment('I2', 'me', 'OWNER'),
            comment('I3', 'me', 'OWNER'),
          ],
        },
      }),
      state({ postedCommentIds: ['I2'], handledCommentIds: ['I3'] }),
    );
    expect(snap).toMatchObject({ action: 'wait', events: [] });
  });

  it('skips resolved threads and keeps outdated ones', () => {
    const snap = buildSnapshot(
      pr(
        threads(
          thread('T1', [comment('C1', 'a', 'OWNER')], { isResolved: true }),
          thread('T2', [comment('C2', 'a', 'OWNER')], { isOutdated: true }),
        ),
      ),
      state(),
    );
    expect(snap.events).toMatchObject([
      { type: 'review_thread', threadId: 'T2', outdated: true },
    ]);
  });

  it('reports reviews with a body and skips empty or pending ones', () => {
    const snap = buildSnapshot(
      pr({
        reviews: {
          pageInfo: { hasPreviousPage: false },
          nodes: [
            comment('R1', 'a', 'MEMBER', { body: '', state: 'APPROVED' }),
            comment('R2', 'a', 'MEMBER', { state: 'PENDING' }),
            comment('R3', 'review-bot', 'NONE', {
              bot: true,
              state: 'CHANGES_REQUESTED',
            }),
          ],
        },
      }),
      state(),
    );
    expect(snap.action).toBe('fix');
    expect(snap.events).toEqual([
      {
        type: 'review',
        state: 'CHANGES_REQUESTED',
        id: 'R3',
        author: 'review-bot',
        trust: 'bot',
        body: 'please fix R3',
        url: 'https://github.com/o/r/pull/7#R3',
      },
    ]);
  });

  it('flags connections cut at the page size', () => {
    const data = pr();
    data.commits.nodes[0].commit.statusCheckRollup!.contexts.pageInfo.hasNextPage = true;
    data.reviewThreads.pageInfo.hasNextPage = true;
    data.reviewThreads.nodes = [
      thread('T1', [comment('C1', 'alice', 'MEMBER')]),
      thread('T2', [comment('C2', 'alice', 'MEMBER')]),
    ];
    for (const node of data.reviewThreads.nodes) {
      node.comments.pageInfo.hasPreviousPage = true;
    }
    data.reviews.pageInfo.hasPreviousPage = true;
    data.comments.pageInfo.hasPreviousPage = true;
    expect(buildSnapshot(data, state()).truncated).toEqual([
      'checks',
      'reviewThreadComments',
      'reviewThreads',
      'reviews',
      'comments',
    ]);
  });
});

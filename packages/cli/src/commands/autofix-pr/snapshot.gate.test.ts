/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildGateSnapshot, fetchPrData, type PrData } from './snapshot.js';
import { REPLY_MARKER, type AutofixPrGateCursor } from './state.js';

const mockGh = vi.hoisted(() => vi.fn());
vi.mock('../review/lib/gh.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../review/lib/gh.js')>()),
  gh: mockGh,
}));

const HEAD = 'a'.repeat(40);
const NEXT_HEAD = 'b'.repeat(40);

function cursor(
  overrides: Partial<AutofixPrGateCursor> = {},
): AutofixPrGateCursor {
  return {
    version: 1,
    host: 'github.com',
    owner: 'o',
    repo: 'r',
    prNumber: 7,
    viewer: 'me',
    prAuthor: 'me',
    headSha: HEAD,
    reportedCommentIds: [],
    reportedChecks: [],
    conflictSha: null,
    stopped: null,
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
    author: { login: 'me' },
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

function failed(name: string, job = name): Contexts[number] {
  return {
    __typename: 'CheckRun',
    name,
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: `https://github.com/o/r/actions/runs/123/job/${job}`,
  };
}

function thread(id: string, comments: Array<ReturnType<typeof comment>>) {
  return {
    id,
    isResolved: false,
    isOutdated: false,
    path: 'src/a.ts',
    line: 3,
    comments: { pageInfo: { hasNextPage: false }, nodes: comments },
  };
}

function comment(
  id: string,
  login: string,
  association = 'NONE',
  body = `please fix ${id}`,
) {
  return {
    id,
    author: { __typename: 'User', login },
    authorAssociation: association,
    body,
    url: `https://github.com/o/r/pull/7#${id}`,
  };
}

describe('buildGateSnapshot', () => {
  it('is quiet when nothing changed and keeps the cursor', () => {
    const before = cursor();
    const result = buildGateSnapshot(pr(), before);
    expect(result.snapshot).toBeNull();
    expect(result.cursor).toEqual(before);
  });

  it('treats a pending check as nothing to report', () => {
    const result = buildGateSnapshot(
      pr({}, [
        {
          __typename: 'CheckRun',
          name: 'Build',
          status: 'IN_PROGRESS',
          conclusion: null,
          detailsUrl: null,
        },
      ]),
      cursor(),
    );
    expect(result.snapshot).toBeNull();
  });

  it('reports a failed check once per head and again after it was re-run', () => {
    const first = buildGateSnapshot(pr({}, [failed('Test')]), cursor());
    expect(first.snapshot).toMatchObject({
      action: 'fix',
      events: [{ type: 'ci_failed', check: 'Test', runId: 123 }],
    });
    expect(first.cursor.reportedChecks).toEqual([
      `Test@${HEAD}@https://github.com/o/r/actions/runs/123/job/Test`,
    ]);

    // Still failing on the same head: quiet.
    const second = buildGateSnapshot(pr({}, [failed('Test')]), first.cursor);
    expect(second.snapshot).toBeNull();

    // Re-run in progress: the failure leaves the cursor…
    const rerun = buildGateSnapshot(
      pr({}, [
        {
          __typename: 'CheckRun',
          name: 'Test',
          status: 'IN_PROGRESS',
          conclusion: null,
          detailsUrl: null,
        },
      ]),
      second.cursor,
    );
    expect(rerun.snapshot).toBeNull();
    expect(rerun.cursor.reportedChecks).toEqual([]);
    // …so a second failure is a new event.
    expect(
      buildGateSnapshot(pr({}, [failed('Test')]), rerun.cursor).snapshot,
    ).not.toBeNull();

    // A new head starts over.
    const moved = buildGateSnapshot(
      pr({ headRefOid: NEXT_HEAD, commits: { nodes: [] } }, []),
      second.cursor,
    );
    expect(moved.snapshot).toMatchObject({
      action: 'resync',
      events: [{ type: 'head_moved_externally', sha: NEXT_HEAD }],
    });
    expect(moved.cursor.headSha).toBe(NEXT_HEAD);
  });

  it('reports a re-run that failed again between two polls', () => {
    // No poll saw the re-run in progress: the attempt's job URL tells the
    // failures apart.
    const first = buildGateSnapshot(pr({}, [failed('Test', '100')]), cursor());
    expect(first.snapshot?.events).toEqual([
      expect.objectContaining({ type: 'ci_failed', check: 'Test' }),
    ]);
    const again = buildGateSnapshot(
      pr({}, [failed('Test', '200')]),
      first.cursor,
    );
    expect(again.snapshot?.events).toEqual([
      expect.objectContaining({
        type: 'ci_failed',
        check: 'Test',
        url: 'https://github.com/o/r/actions/runs/123/job/200',
      }),
    ]);
    expect(again.cursor.reportedChecks).toEqual([
      `Test@${HEAD}@https://github.com/o/r/actions/runs/123/job/200`,
    ]);
    expect(
      buildGateSnapshot(pr({}, [failed('Test', '200')]), again.cursor).snapshot,
    ).toBeNull();
  });

  it('keeps every reported id the query still returns, and bounds only the rest', () => {
    // 21 unresolved threads of 100 reportable comments: more ids than the
    // off-page bound, all still on the page on the next identical poll.
    const nodes = Array.from({ length: 21 }, (_, t) =>
      thread(
        `T${t}`,
        Array.from({ length: 100 }, (_, c) =>
          comment(`T${t}C${c}`, 'alice', 'MEMBER'),
        ),
      ),
    );
    const data = pr({
      reviewThreads: { pageInfo: { hasNextPage: false }, nodes },
    });
    const first = buildGateSnapshot(data, cursor());
    expect(first.snapshot?.events).toHaveLength(21);
    expect(first.cursor.reportedCommentIds).toHaveLength(2100);
    const second = buildGateSnapshot(data, first.cursor);
    expect(second.snapshot).toBeNull();
    expect(second.cursor.reportedCommentIds).toHaveLength(2100);

    // Ids that left the page keep only their newest 2000.
    const stale = cursor({
      reportedCommentIds: Array.from({ length: 2500 }, (_, i) => `old${i}`),
    });
    const third = buildGateSnapshot(data, stale);
    expect(third.cursor.reportedCommentIds).toHaveLength(2000 + 2100);
    expect(third.cursor.reportedCommentIds[0]).toBe('old500');
  });

  it('does not report a head move on the first run', () => {
    const result = buildGateSnapshot(pr(), cursor({ headSha: null }));
    expect(result.snapshot).toBeNull();
    expect(result.cursor.headSha).toBe(HEAD);
  });

  it('reports a conflict once per head and again when it comes back', () => {
    const first = buildGateSnapshot(pr({ mergeable: 'CONFLICTING' }), cursor());
    expect(first.snapshot).toMatchObject({ events: [{ type: 'conflict' }] });
    expect(
      buildGateSnapshot(pr({ mergeable: 'CONFLICTING' }), first.cursor)
        .snapshot,
    ).toBeNull();
    // Unknown keeps the mark; mergeable clears it.
    const unknown = buildGateSnapshot(
      pr({ mergeable: 'UNKNOWN' }),
      first.cursor,
    );
    expect(unknown.cursor.conflictSha).toBe(HEAD);
    const resolved = buildGateSnapshot(pr(), unknown.cursor);
    expect(resolved.cursor.conflictSha).toBeNull();
    expect(
      buildGateSnapshot(pr({ mergeable: 'CONFLICTING' }), resolved.cursor)
        .snapshot,
    ).not.toBeNull();
  });

  it('reports a trusted comment once and never the viewer’s own', () => {
    const data = pr({
      comments: {
        pageInfo: { hasPreviousPage: false },
        nodes: [
          comment('I1', 'alice', 'MEMBER'),
          comment('I2', 'me', 'OWNER'),
          comment('I3', 'bob', 'OWNER', `done\n${REPLY_MARKER}`),
          comment('I4', 'stranger'),
        ],
      },
    });
    const first = buildGateSnapshot(data, cursor());
    expect(first.snapshot?.events).toEqual([
      {
        type: 'issue_comment',
        id: 'I1',
        author: 'alice',
        trust: 'member',
        body: 'please fix I1',
        url: 'https://github.com/o/r/pull/7#I1',
      },
      {
        type: 'untrusted_comment',
        id: 'I4',
        author: 'stranger',
        url: 'https://github.com/o/r/pull/7#I4',
      },
    ]);
    expect(first.cursor.reportedCommentIds).toEqual(['I1', 'I4']);
    expect(buildGateSnapshot(data, first.cursor).snapshot).toBeNull();
  });

  it('wakes for an untrusted comment alone, as a notice', () => {
    const result = buildGateSnapshot(
      pr({
        comments: {
          pageInfo: { hasPreviousPage: false },
          nodes: [comment('I1', 'stranger')],
        },
      }),
      cursor(),
    );
    expect(result.snapshot?.action).toBe('wait');
  });

  it('reports a merge once, then stays quiet, and watches a reopened PR again', () => {
    const merged = buildGateSnapshot(pr({ state: 'MERGED' }), cursor());
    expect(merged.snapshot).toMatchObject({
      action: 'stop',
      events: [{ type: 'merged' }],
    });
    expect(merged.cursor.stopped).toBe('merged');
    expect(
      buildGateSnapshot(pr({ state: 'MERGED' }), merged.cursor).snapshot,
    ).toBeNull();

    const closed = buildGateSnapshot(pr({ state: 'CLOSED' }), cursor());
    const reopened = buildGateSnapshot(
      pr({ mergeable: 'CONFLICTING' }),
      closed.cursor,
    );
    expect(reopened.cursor.stopped).toBeNull();
    expect(reopened.snapshot?.events).toEqual([{ type: 'conflict' }]);
  });

  it('flags a cut connection', () => {
    const data = pr({}, [failed('Test')]);
    data.commits.nodes[0].commit.statusCheckRollup!.contexts.pageInfo.hasNextPage = true;
    expect(buildGateSnapshot(data, cursor()).snapshot?.truncated).toEqual([
      'checks',
    ]);
  });
});

describe('fetchPrData', () => {
  beforeEach(() => {
    mockGh.mockReset();
  });

  function page(nodes: Contexts, next: string | null, oid = HEAD) {
    return {
      commits: {
        nodes: [
          {
            commit: {
              oid,
              statusCheckRollup: {
                contexts: {
                  pageInfo: { hasNextPage: next !== null, endCursor: next },
                  nodes,
                },
              },
            },
          },
        ],
      },
    };
  }

  it('pages the check rollup past the first 100 contexts', () => {
    const firstPage = {
      ...pr(),
      ...page([failed('A')], 'c1'),
    };
    mockGh
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: { pullRequest: firstPage },
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: { repository: { pullRequest: page([failed('B')], 'c2') } },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: { repository: { pullRequest: page([failed('C')], null) } },
        }),
      );
    const { pr: data, viewer } = fetchPrData({
      owner: 'o',
      repo: 'r',
      prNumber: 7,
    });
    expect(viewer).toBe('me');
    const contexts = data.commits.nodes[0]!.commit.statusCheckRollup!.contexts;
    expect(
      contexts.nodes.map((c) => (c.__typename === 'CheckRun' ? c.name : '')),
    ).toEqual(['A', 'B', 'C']);
    expect(contexts.pageInfo.hasNextPage).toBe(false);
    expect(mockGh).toHaveBeenCalledTimes(3);
    expect(mockGh.mock.calls[1]).toContain('after=c1');
    expect(mockGh.mock.calls[2]).toContain('after=c2');
  });

  it('stops paging when the head moved between calls and leaves the cut flagged', () => {
    mockGh
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            viewer: { login: 'me' },
            repository: {
              pullRequest: { ...pr(), ...page([failed('A')], 'c1') },
            },
          },
        }),
      )
      .mockReturnValueOnce(
        JSON.stringify({
          data: {
            repository: { pullRequest: page([failed('B')], null, NEXT_HEAD) },
          },
        }),
      );
    const { pr: data } = fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 });
    const contexts = data.commits.nodes[0]!.commit.statusCheckRollup!.contexts;
    expect(contexts.nodes).toHaveLength(1);
    expect(contexts.pageInfo.hasNextPage).toBe(true);
  });

  it('fails clearly when the PR does not exist', () => {
    mockGh.mockReturnValueOnce(
      JSON.stringify({
        data: { viewer: { login: 'me' }, repository: { pullRequest: null } },
      }),
    );
    expect(() => fetchPrData({ owner: 'o', repo: 'r', prNumber: 7 })).toThrow(
      'PR #7 not found in o/r',
    );
  });
});

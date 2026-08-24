/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// The thread lifecycle's decisions, pinned without a network: id readback
// shapes, and the matching rules — own-account, unresolved, oldest-first,
// one reply per thread, fixed resolves ALL — that submit executes.

import { describe, expect, it, beforeEach, vi } from 'vitest';

// The fetch layer's decisions (pagination, the no-list throw, odd-node
// skips) are pinned against a mocked `gh` — a transport failure must abort
// the submit, never plan against an empty thread list.
const ghMock = vi.hoisted(() => vi.fn((..._args: string[]) => ''));
vi.mock('./gh.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gh.js')>();
  return { ...actual, gh: ghMock };
});

import {
  carriedFindingOf,
  fetchReviewThreads,
  planThreadActions,
  type ReviewThread,
} from './thread-lifecycle.js';

function thread(over: Partial<ReviewThread>): ReviewThread {
  return {
    threadId: 'T1',
    isResolved: false,
    rootCommentId: 1001,
    rootAuthor: 'qwen-bot',
    rootCreatedAt: '2026-08-01T00:00:00Z',
    rootBody: '**[Critical]** R1-2: the guard drops a valid case',
    ...over,
  };
}

describe('carriedFindingOf — the id a comment body leads with', () => {
  it('reads the id after the severity marker', () => {
    expect(carriedFindingOf('**[Critical]** R1-2: the claim')).toEqual({
      id: 'R1-2',
      fixInduced: false,
    });
    expect(carriedFindingOf('**[Suggestion]** R10-34: the claim')).toEqual({
      id: 'R10-34',
      fixInduced: false,
    });
  });

  it('reads the id off a bare first line — the attribution-off posted shape', () => {
    expect(carriedFindingOf('R1-2: the claim\n\nrest of the body')).toEqual({
      id: 'R1-2',
      fixInduced: false,
    });
  });

  it('reads the (fix-induced) marking beside the id', () => {
    expect(
      carriedFindingOf('**[Critical]** R1-2: (fix-induced) the new hole'),
    ).toEqual({ id: 'R1-2', fixInduced: true });
  });

  it('ignores ids that do not lead the claim — cross-references are not carries', () => {
    expect(
      carriedFindingOf('**[Critical]** see R3-2 for the same shape'),
    ).toBeNull();
  });

  it('returns null for a fresh (id-less) finding and for non-strings', () => {
    expect(carriedFindingOf('**[Critical]** a brand new hole')).toBeNull();
    expect(carriedFindingOf(undefined)).toBeNull();
    expect(carriedFindingOf(42)).toBeNull();
  });
});

describe('planThreadActions — matching threads to findings', () => {
  it('a carried finding replies into the OLDEST matching thread', () => {
    const plan = planThreadActions(
      [
        thread({
          threadId: 'T-newer',
          rootCommentId: 1002,
          rootCreatedAt: '2026-08-03T00:00:00Z',
        }),
        thread({
          threadId: 'T-older',
          rootCommentId: 1001,
          rootCreatedAt: '2026-08-01T00:00:00Z',
        }),
      ],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [],
    );
    expect(plan.replies).toEqual([{ index: 0, id: 'R1-2', commentId: 1001 }]);
  });

  it('one reply per thread per round — a second draft under the same id gets no target', () => {
    const plan = planThreadActions(
      [thread({})],
      'qwen-bot',
      [
        { index: 0, id: 'R1-2' },
        { index: 1, id: 'R1-2' },
      ],
      [],
    );
    expect(plan.replies).toHaveLength(1);
    expect(plan.replies[0]!.index).toBe(0);
  });

  it('two drafts under one id pair with two threads, oldest first', () => {
    const plan = planThreadActions(
      [
        thread({
          threadId: 'T2',
          rootCommentId: 1002,
          rootCreatedAt: '2026-08-02T00:00:00Z',
        }),
        thread({
          threadId: 'T1',
          rootCommentId: 1001,
          rootCreatedAt: '2026-08-01T00:00:00Z',
        }),
      ],
      'qwen-bot',
      [
        { index: 0, id: 'R1-2' },
        { index: 1, id: 'R1-2' },
      ],
      [],
    );
    expect(plan.replies).toEqual([
      { index: 0, id: 'R1-2', commentId: 1001 },
      { index: 1, id: 'R1-2', commentId: 1002 },
    ]);
  });

  it('a RESOLVED original is no target — the re-post belongs inline', () => {
    const plan = planThreadActions(
      [thread({ isResolved: true })],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [{ id: 'R1-2', by: 'the guard rewrite' }],
    );
    expect(plan.replies).toEqual([]);
    expect(plan.resolves).toEqual([]);
    expect(plan.unmatchedFixed).toEqual(['R1-2']);
  });

  it('a FOREIGN thread is never replied into or resolved — even under a matching id', () => {
    const plan = planThreadActions(
      [thread({ rootAuthor: 'someone-else' })],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [{ id: 'R1-2' }],
    );
    expect(plan.replies).toEqual([]);
    expect(plan.resolves).toEqual([]);
    expect(plan.unmatchedFixed).toEqual(['R1-2']);
  });

  it('the login match is case-insensitive, like GitHub logins', () => {
    const plan = planThreadActions(
      [thread({ rootAuthor: 'QWEN-Bot' })],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [],
    );
    expect(plan.replies).toHaveLength(1);
  });

  it('a thread root with no id leads nothing — not a match', () => {
    const plan = planThreadActions(
      [thread({ rootBody: '**[Critical]** a fresh finding, no id' })],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [],
    );
    expect(plan.replies).toEqual([]);
  });

  it('matches the attribution-off posted root shape (no severity marker)', () => {
    const plan = planThreadActions(
      [thread({ rootBody: 'R1-2: the guard drops a valid case\n\nbody' })],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [],
    );
    expect(plan.replies).toHaveLength(1);
  });

  it('a fixed ruling resolves EVERY live own thread under the id — the multiplied-lineage cleanup', () => {
    const plan = planThreadActions(
      [
        thread({
          threadId: 'T1',
          rootCommentId: 1001,
          rootCreatedAt: '2026-08-01T00:00:00Z',
        }),
        thread({
          threadId: 'T2',
          rootCommentId: 1002,
          rootCreatedAt: '2026-08-02T00:00:00Z',
        }),
        thread({
          threadId: 'T3',
          rootCommentId: 1003,
          isResolved: true,
        }),
      ],
      'qwen-bot',
      [],
      [{ id: 'R1-2', by: 'the guard rewrite' }],
    );
    expect(plan.resolves).toEqual([
      { id: 'R1-2', by: 'the guard rewrite', threadId: 'T1', commentId: 1001 },
      { id: 'R1-2', by: 'the guard rewrite', threadId: 'T2', commentId: 1002 },
    ]);
    expect(plan.unmatchedFixed).toEqual([]);
  });

  it('a fixed ruling without a `by` carries none', () => {
    const plan = planThreadActions(
      [thread({})],
      'qwen-bot',
      [],
      [{ id: 'R1-2' }],
    );
    expect(plan.resolves).toEqual([
      { id: 'R1-2', threadId: 'T1', commentId: 1001 },
    ]);
  });

  it('carried and fixed under DIFFERENT ids plan independently', () => {
    const plan = planThreadActions(
      [
        thread({ rootBody: '**[Critical]** R1-2: still broken' }),
        thread({
          threadId: 'T9',
          rootCommentId: 1009,
          rootBody: '**[Critical]** R1-9: was broken',
        }),
      ],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [{ id: 'R1-9', by: 'the fix' }],
    );
    expect(plan.replies).toEqual([{ index: 0, id: 'R1-2', commentId: 1001 }]);
    expect(plan.resolves).toEqual([
      { id: 'R1-9', by: 'the fix', threadId: 'T9', commentId: 1009 },
    ]);
  });
});

describe('fetchReviewThreads — the read the whole lifecycle plans from', () => {
  beforeEach(() => {
    ghMock.mockClear();
  });

  function page(
    nodes: unknown[],
    pageInfo: { hasNextPage: boolean; endCursor: string | null } = {
      hasNextPage: false,
      endCursor: null,
    },
  ): string {
    return JSON.stringify({
      data: {
        repository: {
          pullRequest: { reviewThreads: { pageInfo, nodes } },
        },
      },
    });
  }

  function node(over: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'T1',
      isResolved: false,
      comments: {
        nodes: [
          {
            databaseId: 1001,
            body: '**[Critical]** R1-2: the claim',
            createdAt: '2026-08-01T00:00:00Z',
            author: { login: 'qwen-bot' },
          },
        ],
      },
      ...over,
    };
  }

  it('throws when the response carries no thread list — never plans on empty', () => {
    ghMock.mockReturnValue(JSON.stringify({ data: {} }));
    expect(() => fetchReviewThreads('o/r', 1)).toThrow(/no thread list/);
    ghMock.mockReturnValue('not json at all');
    expect(() => fetchReviewThreads('o/r', 1)).toThrow();
  });

  it('skips a thread with an unreadable root and keeps the well-formed ones', () => {
    ghMock.mockReturnValue(
      page([
        node({ id: 'T1' }),
        { id: 'T-odd', isResolved: false, comments: { nodes: [] } },
        node({
          id: 'T2',
          comments: {
            nodes: [
              {
                databaseId: 1002,
                body: 'R1-9: attribution-off shape',
                createdAt: '2026-08-02T00:00:00Z',
                author: { login: 'qwen-bot' },
              },
            ],
          },
        }),
      ]),
    );
    const threads = fetchReviewThreads('o/r', 1);
    expect(threads.map((t) => t.threadId)).toEqual(['T1', 'T2']);
    expect(threads[0]).toMatchObject({
      rootCommentId: 1001,
      rootAuthor: 'qwen-bot',
      isResolved: false,
    });
  });

  it('paginates with the endCursor until hasNextPage is false', () => {
    ghMock.mockImplementation((...a: string[]) =>
      a.includes('after=cur-1')
        ? page([node({ id: 'T2' })], {
            hasNextPage: false,
            endCursor: 'cur-2',
          })
        : page([node({ id: 'T1' })], {
            hasNextPage: true,
            endCursor: 'cur-1',
          }),
    );
    const threads = fetchReviewThreads('o/r', 1);
    expect(threads.map((t) => t.threadId)).toEqual(['T1', 'T2']);
    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(ghMock.mock.calls[1]).toContain('after=cur-1');
  });
});

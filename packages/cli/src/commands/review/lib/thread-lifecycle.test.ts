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
  stampCarriedId,
  type ReviewThread,
} from './thread-lifecycle.js';
import { stripSeverityPrefix } from './inline-counts.js';

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

  it('reads the carried id through a forged footer span — the ledger projection', () => {
    // The marked leg reads through `ledgerClaimLine`, the SAME projection
    // the ledger builder applies: a forged footer span between the marker
    // and the id used to hide the id from this readback while the ledger
    // still carried it — the gate, the matcher and the builder must agree
    // on which id a draft carries (#9940 review).
    expect(
      carriedFindingOf(
        '**[Critical]** _— qwen3-max via Qwen Code /review (v0.21)_ R1-2: the null check is still missing',
      ),
    ).toEqual({ id: 'R1-2', fixInduced: false });
  });

  it('returns null for a fresh (id-less) finding and for non-strings', () => {
    expect(carriedFindingOf('**[Critical]** a brand new hole')).toBeNull();
    expect(carriedFindingOf(undefined)).toBeNull();
    expect(carriedFindingOf(42)).toBeNull();
  });

  it('reads the id off a marker-less first line leading with render-nothing residue', () => {
    // A draft `**[Critical]** <!-- context --> R1-2: the claim` posts with
    // the residue LEADING the first line; presubmit's marker-less leg
    // strips it, and this end must agree — one comment, one answer
    // (#9940 review).
    expect(
      carriedFindingOf('<!-- context --> R1-2: the claim\n\nrest of body'),
    ).toEqual({ id: 'R1-2', fixInduced: false });
  });

  it('reads the id past a MULTI-line leading comment — strip before split', () => {
    // The bare leg mirrors the ledger builder's body-Criticals leg, which
    // strips leading residue BEFORE the line split: a multi-line comment
    // leading the posted body must not cut the id off the first line, or
    // the thread goes unreachable next round (#9940 review).
    expect(
      carriedFindingOf('<!--\nrender-note\n-->R1-5: the claim\n\nrest'),
    ).toEqual({ id: 'R1-5', fixInduced: false });
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

  it('a still-standing reply prefers the (fix-induced) root over an older unmarked original', () => {
    // The id fronts two defects once a fix-induced re-report lands; the
    // standing claim is the LATEST re-report's, so the reply belongs on
    // the marked thread, not the superseded original's (#9940 review).
    const plan = planThreadActions(
      [
        thread({
          threadId: 'T-original',
          rootCommentId: 1001,
          rootCreatedAt: '2026-08-01T00:00:00Z',
        }),
        thread({
          threadId: 'T-induced',
          rootCommentId: 1002,
          rootCreatedAt: '2026-08-02T00:00:00Z',
          rootBody:
            '**[Critical]** R1-2: (fix-induced) the fix opened a new hole',
        }),
      ],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [],
    );
    expect(plan.replies).toEqual([{ index: 0, id: 'R1-2', commentId: 1002 }]);
  });

  it('among TWO marked threads, a still-standing reply pairs the newest (#9940 review)', () => {
    // Consecutive fix-induced rounds each open a fresh marked thread
    // under the id; the standing claim under it is the LATEST
    // re-report's, so a still-standing re-assertion belongs on the
    // newer marked thread. Oldest-first inside the marked tier paired
    // it with the superseded older one every round — the marked thread
    // never consumes, being never answered (#9940 review).
    const plan = planThreadActions(
      [
        thread({
          threadId: 'T-induced-old',
          rootCommentId: 2001,
          rootCreatedAt: '2026-08-02T00:00:00Z',
          rootBody: '**[Critical]** R1-2: (fix-induced) the round-2 hole',
        }),
        thread({
          threadId: 'T-induced-new',
          rootCommentId: 3001,
          rootCreatedAt: '2026-08-03T00:00:00Z',
          rootBody: '**[Critical]** R1-2: (fix-induced) the round-3 hole',
        }),
      ],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [],
    );
    expect(plan.replies).toEqual([{ index: 0, id: 'R1-2', commentId: 3001 }]);
  });

  it('a fixed ruling resolves the marked and unmarked threads of one id alike', () => {
    const plan = planThreadActions(
      [
        thread({
          threadId: 'T-original',
          rootCommentId: 1001,
          rootCreatedAt: '2026-08-01T00:00:00Z',
        }),
        thread({
          threadId: 'T-induced',
          rootCommentId: 1002,
          rootCreatedAt: '2026-08-02T00:00:00Z',
          rootBody:
            '**[Critical]** R1-2: (fix-induced) the fix opened a new hole',
        }),
      ],
      'qwen-bot',
      [],
      [{ id: 'R1-2', by: 'the rewrite' }],
    );
    expect(plan.resolves.map((r) => r.threadId)).toEqual([
      'T-induced',
      'T-original',
    ]);
    expect(plan.unmatchedFixed).toEqual([]);
  });

  it('an attribution-off root with leading residue before the id still matches', () => {
    const plan = planThreadActions(
      [thread({ rootBody: '<!-- context --> R1-2: the claim\n\nbody' })],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [],
    );
    expect(plan.replies).toHaveLength(1);
  });
});

describe('stampCarriedId — the write side of the readback', () => {
  it('stamps the minted id right after the severity marker', () => {
    expect(
      stampCarriedId('**[Critical]** the guard drops a valid case', 'R1-5'),
    ).toBe('**[Critical]** R1-5: the guard drops a valid case');
    expect(stampCarriedId('**[Suggestion]** tidy', 'R2-3')).toBe(
      '**[Suggestion]** R2-3: tidy',
    );
  });

  it('leaves a draft that already leads with a carried id verbatim', () => {
    expect(stampCarriedId('**[Critical]** R1-2: still stands', 'R3-1')).toBe(
      '**[Critical]** R1-2: still stands',
    );
    expect(
      stampCarriedId('**[Critical]** R1-2: (fix-induced) the new hole', 'R3-1'),
    ).toBe('**[Critical]** R1-2: (fix-induced) the new hole');
  });

  it('returns an unmarked body unchanged — nothing to stamp into', () => {
    expect(stampCarriedId('no marker here', 'R1-1')).toBe('no marker here');
  });

  it('leaves a fence-opening body un-stamped — a stamp would break the fence (#9940 review)', () => {
    // The stamp inserts ` R<n>-<k>: ` between the marker and the body; a
    // body whose first line is a code fence would then post with text
    // before the backticks — no longer a CommonMark fence opener — and
    // the flipped fence structure is the exact exposure the gate's
    // fence refusal polices, created AFTER the gate validated the
    // pre-stamp shape. Such drafts post un-stamped and degrade to the
    // pre-stamping behaviour: their threads match no later carry or
    // fixed ruling (#9940 review).
    for (const draft of [
      '**[Suggestion]** ```diff\n-old\n+new\n```\n\nthe pin moved',
      '**[Critical]** ~~~\nthe log\n~~~',
      // The fence can LEAD with render-nothing residue — the pipeline
      // admits it between marker and content — and the ^-anchored fence
      // test reads through it, or the residue-led shape slips past and
      // the stamp flips the fence the guard exists to prevent (#9940
      // review).
      '**[Critical]** <!-- x -->```diff\n-old\n+new\n```',
    ]) {
      expect(stampCarriedId(draft, 'R3-1')).toBe(draft);
    }
    // A fence that opens on line 2 is untouched by a line-1 stamp.
    expect(
      stampCarriedId(
        '**[Suggestion]** the claim\n```diff\n-old\n+new\n```',
        'R3-2',
      ),
    ).toBe('**[Suggestion]** R3-2: the claim\n```diff\n-old\n+new\n```');
  });

  it('stamps the bare-marker draft whose fence opens on line 2 (#9940 review)', () => {
    // The fence skip protects a fence that OPENS on the marker's
    // projected first line: the stamp inserts on line 1, and a fence
    // opening on a later rendered line it cannot flip. The guard reads
    // through leading residue — and residue swallows newlines — so a
    // bare newline outside comments must still end the skip, or the
    // bare-marker draft posts un-stamped: its root carries no id, the
    // marked readback leg reads the fence opener and shadows the bare
    // one, every later carried re-report matches nothing, posts inline,
    // and opens a NEW thread — the multiplication this pass exists to
    // kill (#9940 review).
    const draft = '**[Critical]**\n```diff\n-old\n+new\n```\nthe claim';
    const stamped = stampCarriedId(draft, 'R1-5');
    expect(stamped).toBe(
      '**[Critical]** R1-5: \n```diff\n-old\n+new\n```\nthe claim',
    );
    expect(carriedFindingOf(stamped)).toEqual({
      id: 'R1-5',
      fixInduced: false,
    });
  });

  it('stamps through leading residue, and before residue after the marker', () => {
    expect(stampCarriedId('\n**[Critical]** the claim', 'R1-1')).toBe(
      '\n**[Critical]** R1-1: the claim',
    );
    const stamped = stampCarriedId(
      '**[Critical]** <!-- x --> the claim',
      'R1-1',
    );
    expect(stamped).toBe('**[Critical]** R1-1: <!-- x --> the claim');
    expect(carriedFindingOf(stamped)).toEqual({
      id: 'R1-1',
      fixInduced: false,
    });
  });

  it('normalizes separator variants — the stamped id reads back', () => {
    // A colon or nothing right after the marker are admitted draft
    // shapes; stamped between the marker and such a separator the id
    // ends in `::` or `:x`, which LEDGER_ID_READBACK refuses — the write
    // side producing text the read side cannot read (#9940 review).
    for (const draft of [
      '**[Critical]**: the claim',
      '**[Critical]**\uff1a the claim',
      '**[Critical]**the claim',
    ]) {
      const stamped = stampCarriedId(draft, 'R1-5');
      expect(stamped).toBe('**[Critical]** R1-5: the claim');
      expect(carriedFindingOf(stamped)).toEqual({
        id: 'R1-5',
        fixInduced: false,
      });
    }
  });

  it('stamps past a stacked-marker run — no stray marker survives the strip', () => {
    // stripSeverityPrefix iterates a contiguous marker run; an id
    // inserted BETWEEN the two markers breaks the run and the
    // attribution-off strip posts the second marker VISIBLE, naming the
    // wrong severity (#9940 review).
    const stamped = stampCarriedId(
      '**[Critical]** **[Suggestion]** the claim',
      'R2-3',
    );
    expect(stamped).toBe('**[Critical]** R2-3: the claim');
    expect(carriedFindingOf(stamped)).toEqual({
      id: 'R2-3',
      fixInduced: false,
    });
    expect(stripSeverityPrefix(stamped)).toBe('R2-3: the claim');
  });

  it('reads a carried id past a stacked-marker run — no re-mint into a double-id line (#9940 review)', () => {
    // The readback strips the whole marker run: a stop at the first
    // marker left the carry unrecognized, so the stamp spliced a fresh id
    // in front of it (`R2-3: R1-2: …`) while the Aone relocate leg —
    // which iterates — carried the id standing and the gate saw none.
    const stacked = '**[Critical]** **[Suggestion]** R1-2: still stands';
    expect(carriedFindingOf(stacked)).toEqual({
      id: 'R1-2',
      fixInduced: false,
    });
    // The model's carry stays verbatim — no double-id stamp.
    expect(stampCarriedId(stacked, 'R2-3')).toBe(stacked);
  });

  it('reads a carried id past post-colon multi-line residue — no re-mint (#9940 review)', () => {
    // The separator's residue arm spans a whole comment between the
    // colon and the id; a readback that stopped at the newline
    // truncated the claim line to `<!--`, so the carry went unrecognized
    // and the stamp re-minted a fresh id in front of it (#9940 review,
    // round 10).
    const body = '**[Critical]** : <!--\nx\n--> R1-2: claim';
    expect(carriedFindingOf(body)).toEqual({
      id: 'R1-2',
      fixInduced: false,
    });
    expect(stampCarriedId(body, 'R2-1')).toBe(body);
  });

  it('stamps a glued multi-line comment — the id still reads back', () => {
    const stamped = stampCarriedId(
      '**[Critical]**<!--\nrender-note\n-->the claim',
      'R2-1',
    );
    expect(carriedFindingOf(stamped)).toEqual({
      id: 'R2-1',
      fixInduced: false,
    });
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

  it('reads the thread list through CLICOLOR_FORCE colour wrappers (#9940 review)', () => {
    // `gh` wraps its pretty-printed JSON in SGR escapes when the
    // operator's environment forces colour; the read parses the JSON,
    // not the terminal rendering.
    ghMock.mockReturnValue(`\u001b[1;37m${page([node({})])}\u001b[0m`);
    const threads = fetchReviewThreads('o/r', 1);
    expect(threads.map((t) => t.threadId)).toEqual(['T1']);
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

  it('stops at MAX_THREAD_PAGES against a connection that never ends (#9940 review)', () => {
    // A stale/echoed endCursor is a known cursor-pagination failure
    // class: `hasNextPage` stays true forever. The page cap is the only
    // guard keeping the pre-write read finite — without it the submit
    // hangs in unbounded synchronous gh calls before posting anything.
    ghMock.mockReturnValue(
      page([node({})], { hasNextPage: true, endCursor: 'cur' }),
    );
    const threads = fetchReviewThreads('o/r', 1);
    expect(ghMock).toHaveBeenCalledTimes(30);
    // The echoed cursor re-fetches the SAME page thirty times; the read
    // dedupes by thread id, or one fixed ruling would post its
    // non-idempotent reply into — and resolve — the one thread thirty
    // times (#9940 review).
    expect(threads.map((t) => t.threadId)).toEqual(['T1']);
  });

  it('dedupes a thread id echoed on two distinct pages — the resolve leg is not idempotent (#9940 review)', () => {
    // A moving cursor can still echo a node an earlier page returned;
    // the plan's resolve leg pushes one entry per array element, so
    // uniqueness must hold at the read itself.
    ghMock.mockImplementation((...a: string[]) =>
      a.includes('after=cur-1')
        ? page([node({})], { hasNextPage: false, endCursor: 'cur-2' })
        : page([node({})], { hasNextPage: true, endCursor: 'cur-1' }),
    );
    const threads = fetchReviewThreads('o/r', 1);
    expect(ghMock).toHaveBeenCalledTimes(2);
    expect(threads.map((t) => t.threadId)).toEqual(['T1']);
  });

  it('stops after a page whose endCursor is empty — hasNextPage alone cannot fetch (#9940 review)', () => {
    // `hasNextPage: true` with no usable cursor: re-requesting without
    // one re-fetches page one, and planThreadActions dedupes replies
    // but NOT resolves — the break keeps the duplicate pages out.
    ghMock.mockReturnValue(
      page([node({})], { hasNextPage: true, endCursor: '' }),
    );
    const threads = fetchReviewThreads('o/r', 1);
    expect(ghMock).toHaveBeenCalledTimes(1);
    expect(threads).toHaveLength(1);
  });
});

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
  fixedRulingLine,
} from './thread-lifecycle.js';
import { severityOf, stripSeverityPrefix } from './inline-counts.js';
import { stripForUnattributedPost } from './review-footer.js';

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

  it('reads the id terminated by a full-width colon — the separator grammar admits it (#9940 review)', () => {
    // MARKER_SEPARATOR_RE admits `[:：]` after the severity marker, so a
    // carry written `R1-2：claim` is an admitted draft shape; the shared
    // readback must read it back, or the ledger builder counts the
    // re-post as first-time work, mints a fresh id, and the stamp mints
    // a double-id root the original thread never matches (#9940 review).
    expect(carriedFindingOf('**[Critical]** R1-2：the claim')).toEqual({
      id: 'R1-2',
      fixInduced: false,
    });
  });

  it('reads the id past leading head-slot tags — uniform with the ledger builder (#9940 review)', () => {
    // The ledger builder reads drafts through `readClaim`'s head-slot
    // tokeniser, which admits the axis and source tags BEFORE the id
    // (#10291); the ^-anchored pre-gate here refused exactly that shape,
    // so a tag-led carry rode the ledger while the matcher, the stamp
    // and the contradiction gate saw none of it — the re-post opened a
    // NEW thread under the id, a fixed ruling landed in unmatchedFixed,
    // and the stamp spliced a double-id body (#9940 review, round 12).
    expect(
      carriedFindingOf('**[Critical]** [fails-closed] R1-2: the claim'),
    ).toEqual({ id: 'R1-2', fixInduced: false });
    expect(
      carriedFindingOf(
        '**[Critical]** [fails-closed] [new-surface] R3-4: (fix-induced) the hole',
      ),
    ).toEqual({ id: 'R3-4', fixInduced: true });
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

  it('joins a carried or fixed id to its thread by the canonical spelling — `R01-2` names R1-2 (#9940 review, round 27)', () => {
    const carry = planThreadActions(
      [thread({ rootBody: '**[Critical]** R1-2: the guard' })],
      'qwen-bot',
      [{ index: 0, id: 'R01-2' }],
      [],
    );
    expect(carry.replies).toEqual([{ index: 0, id: 'R01-2', commentId: 1001 }]);
    const rule = planThreadActions(
      [thread({ rootBody: '**[Critical]** R01-2: the guard' })],
      'qwen-bot',
      [],
      [{ id: 'R1-2' }],
    );
    expect(rule.resolves).toMatchObject([{ id: 'R1-2', commentId: 1001 }]);
    expect(rule.unmatchedFixed).toEqual([]);
    // The ruling's own spelling is joined canonically too (the compose
    // refuses this spelling upstream; the join does not rely on it).
    const zeroRule = planThreadActions(
      [thread({ rootBody: '**[Critical]** R1-2: the guard' })],
      'qwen-bot',
      [],
      [{ id: 'R01-2' }],
    );
    expect(zeroRule.resolves).toMatchObject([{ commentId: 1001 }]);
    expect(zeroRule.unmatchedFixed).toEqual([]);
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

  it('prefers an OLDER (fix-induced) root over a NEWER unmarked thread — marked wins regardless of age (#9940 review, round 14)', () => {
    // The reachable arrangement: a duplicate-re-post round replies one
    // draft into the live marked thread and leaves the second inline
    // with its carried id kept, opening an unmarked thread NEWER than
    // the marked one. The marked tier must still lead — an
    // age-conditional comparator would pair every later still-standing
    // reply with the newer unmarked thread and the marked one would
    // never be answered again.
    const plan = planThreadActions(
      [
        thread({
          threadId: 'T-induced-old',
          rootCommentId: 2001,
          rootCreatedAt: '2026-08-02T00:00:00Z',
          rootBody:
            '**[Critical]** R1-2: (fix-induced) the fix opened a new hole',
        }),
        thread({
          threadId: 'T-unmarked-new',
          rootCommentId: 1001,
          rootCreatedAt: '2026-08-05T00:00:00Z',
        }),
      ],
      'qwen-bot',
      [{ index: 0, id: 'R1-2' }],
      [],
    );
    expect(plan.replies).toEqual([{ index: 0, id: 'R1-2', commentId: 2001 }]);
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

  it('leaves a tag-led carried body verbatim — no double-id re-mint (#9940 review)', () => {
    // The already-carries early return reads through the same uniform
    // readback: a tag-led carry the anchored pre-gate missed got a fresh
    // id spliced before the tag, posting `R2-1: [fails-closed] R1-2: …`
    // — two ids on one claim, neither matching the original thread
    // (#9940 review, round 12).
    const body = '**[Critical]** [fails-closed] R1-2: the claim';
    expect(stampCarriedId(body, 'R2-1')).toBe(body);
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

  it('stamps a backtick run whose info string carries a backtick — no fence opens there (#9940 review, round 25)', () => {
    // CommonMark never opens a BACKTICK fence whose info string contains a
    // backtick, and the pipeline's line model (`scanLines`) agrees: the
    // line is ordinary text a line-1 stamp cannot break. The delimiter-only
    // test over-skipped it, and the root posted id-less behind a disclosure
    // naming a fence that did not exist.
    const stamped = stampCarriedId(
      '**[Critical]** ```ts `X` is banned\nthe claim',
      'R3-1',
    );
    expect(stamped).toBe('**[Critical]** R3-1: ```ts `X` is banned\nthe claim');
    expect(carriedFindingOf(stamped)).toEqual({
      id: 'R3-1',
      fixInduced: false,
    });
    // A TILDE fence may carry a backtick in its info string — still a
    // fence, still skipped; and a backtick fence with a plain info string
    // keeps its skip.
    for (const draft of [
      '**[Critical]** ~~~ts `X`\ncode\n~~~\nthe claim',
      '**[Critical]** ```ts\ncode\n```\nthe claim',
    ]) {
      expect(stampCarriedId(draft, 'R3-1')).toBe(draft);
    }
  });

  it('leaves every other line-leading construct un-stamped — blockquote, heading, list, thematic break, raw-HTML opener (#9940 review, round 26)', () => {
    // Text before any of these demotes it to paragraph text under the
    // attribution-off post — the same flip the fence and HTML-block arms
    // prevent; the guard covered only those two.
    for (const draft of [
      '**[Critical]** > quoted line\nmore text',
      '**[Critical]** - item one\nmore text',
      '**[Critical]** * item one\nmore text',
      '**[Critical]** 1. first item\nmore text',
      '**[Critical]** # Heading\nmore text',
      '**[Critical]** ---\nmore text',
      '**[Critical]** * * *\nmore text',
      '**[Critical]** <?php x ?> the claim',
      '**[Critical]** <!DOCTYPE html> the claim',
      '**[Critical]** <![CDATA[x]]> the claim',
    ]) {
      expect(stampCarriedId(draft, 'R5-3')).toBe(draft);
    }
    // Look-alikes that open nothing keep their stamp: no space after the
    // hash, a negative number, a dash inside a word, a construct on line
    // 2 that CAN interrupt a paragraph.
    for (const [draft, stamped] of [
      ['**[Critical]** #hashtag claim', '**[Critical]** R5-3: #hashtag claim'],
      ['**[Critical]** -1 is returned', '**[Critical]** R5-3: -1 is returned'],
      [
        '**[Critical]** re-check the guard',
        '**[Critical]** R5-3: re-check the guard',
      ],
      [
        '**[Critical]** the claim\n> quoted',
        '**[Critical]** R5-3: the claim\n> quoted',
      ],
      ['**[Critical]**\n- item one', '**[Critical]** R5-3: \n- item one'],
      ['**[Critical]**\n# Heading', '**[Critical]** R5-3: \n# Heading'],
    ]) {
      expect(stampCarriedId(draft, 'R5-3')).toBe(stamped);
    }
  });

  it('leaves a non-interrupting block directly under the marker un-stamped — indented code, a non-1 ordered list (#9940 review, round 26)', () => {
    // Behind the empty attribution-off first line these were blocks of
    // their own; the `R<n>-<k>:` paragraph the stamp writes above them
    // cannot be interrupted by them, so they became its continuation
    // text. A blank line in between ends that paragraph first.
    for (const draft of [
      '**[Critical]**\n2. second item\nthe claim',
      '**[Critical]**\n   7) seventh\nthe claim',
    ]) {
      expect(stampCarriedId(draft, 'R5-4')).toBe(draft);
    }
    // Indented text under ONE break is a lazy continuation of the marker's
    // paragraph (indented code cannot interrupt a paragraph — CommonMark
    // 4.4), so the stamp folds it onto the line: the same paragraph, now
    // carrying its id (audit 5).
    for (const [draft, stamped] of [
      [
        '**[Critical]**\n    const x = leaked();\n\nthe claim',
        '**[Critical]** R5-4: const x = leaked();\n\nthe claim',
      ],
      [
        '**[Critical]**\n\tconst x = leaked();\n\nthe claim',
        '**[Critical]** R5-4: const x = leaked();\n\nthe claim',
      ],
      [
        '**[Critical]**\r\n    const x = leaked();\r\n\r\nthe claim',
        '**[Critical]** R5-4: const x = leaked();\r\n\r\nthe claim',
      ],
    ]) {
      expect(stampCarriedId(draft, 'R5-4')).toBe(stamped);
    }
    for (const [draft, stamped] of [
      // A blank line ends the id paragraph — the block survives.
      [
        '**[Critical]**\n\n    const x = leaked();\n\nthe claim',
        '**[Critical]** R5-4: \n\n    const x = leaked();\n\nthe claim',
      ],
      // `1.` CAN interrupt a paragraph, so can a bullet and a fence.
      ['**[Critical]**\n1. first item', '**[Critical]** R5-4: \n1. first item'],
      ['**[Critical]**\n- item', '**[Critical]** R5-4: \n- item'],
      [
        '**[Critical]**\n```diff\n-old\n+new\n```\nthe claim',
        '**[Critical]** R5-4: \n```diff\n-old\n+new\n```\nthe claim',
      ],
      // Same-line content before the block: the block was already
      // continuation text pre-stamp — nothing to protect.
      [
        '**[Critical]** the claim\n    code',
        '**[Critical]** R5-4: the claim\n    code',
      ],
    ]) {
      expect(stampCarriedId(draft, 'R5-4')).toBe(stamped);
    }
  });

  it('strips a (fix-induced) prose token from a FRESH claim the stamp would promote into a marking (#9940 review, round 26)', () => {
    // On a draft with no id the token is prose (the head-slot contract);
    // spliced behind the minted id it read back as a genuine marking, and
    // a later still-standing carry would have paired with this
    // mislabelled root ahead of the true original.
    for (const [draft, stamped] of [
      [
        '**[Critical]** (fix-induced) the guard drops a valid case',
        '**[Critical]** R1-5: the guard drops a valid case',
      ],
      [
        '**[Critical]** ( FIX-INDUCED ): the guard drops a valid case',
        '**[Critical]** R1-5: the guard drops a valid case',
      ],
      // Past a leading axis tag — the tokeniser reads the marking anywhere
      // in the slot, so the strip follows the readback, not position 0.
      [
        '**[Critical]** [fails-closed] (fix-induced) the guard drops a valid case',
        '**[Critical]** R1-5: [fails-closed] the guard drops a valid case',
      ],
    ]) {
      const out = stampCarriedId(draft, 'R1-5');
      expect(out).toBe(stamped);
      expect(carriedFindingOf(out)).toEqual({ id: 'R1-5', fixInduced: false });
    }
    // The token past the head slot is prose the readback never reads —
    // left alone.
    expect(
      stampCarriedId(
        '**[Critical]** the claim (fix-induced) by the fix',
        'R1-5',
      ),
    ).toBe('**[Critical]** R1-5: the claim (fix-induced) by the fix');
    // A genuine carry keeps its marking verbatim (the early return).
    const carry = '**[Critical]** R1-2: (fix-induced) the new hole';
    expect(stampCarriedId(carry, 'R3-1')).toBe(carry);
  });

  it('leaves a setext underline, an empty list item, a link reference definition or a lone tag directly under the marker un-stamped (#9940 review, audit)', () => {
    // None of these can interrupt a paragraph, so under the `R<n>-<k>:`
    // line the stamp writes they stop being blocks: `---` right under a
    // paragraph line is that paragraph's setext UNDERLINE (the stamped id
    // line would render as an <h2> and the <hr> vanish), an empty item
    // and a definition become continuation text, a lone tag no longer
    // opens its type-7 block.
    for (const draft of [
      '**[Critical]**\n---\nthe claim',
      '**[Critical]**\n-\nthe claim',
      '**[Critical]**\n===\nthe claim',
      '**[Critical]**\r\n---\r\nthe claim',
      '**[Critical]**\n   ---\nthe claim',
      '**[Critical]**\n1.\nthe claim',
      '**[Critical]**\n*\nthe claim',
      '**[Critical]**\n[spec]: https://spec.commonmark.org\nsee [spec]',
      '**[Critical]**\n<span>\nfoo\n\nthe claim',
      '**[Critical]**\n</span>\nfoo\n\nthe claim',
    ]) {
      expect(stampCarriedId(draft, 'R5-5')).toBe(draft);
    }
    // Interrupting constructs on line 2 keep their stamp: `01.` starts at
    // one, a comment LINE between is itself a block boundary, a blank
    // line ends the id paragraph before the underline.
    for (const [draft, stamped] of [
      ['**[Critical]**\n01. item', '**[Critical]** R5-5: \n01. item'],
      ['**[Critical]**\n1) item', '**[Critical]** R5-5: \n1) item'],
      [
        '**[Critical]**\n<!-- c -->\n    code',
        '**[Critical]** R5-5: \n<!-- c -->\n    code',
      ],
      [
        '**[Critical]**\n\n---\nthe claim',
        '**[Critical]** R5-5: \n\n---\nthe claim',
      ],
    ]) {
      expect(stampCarriedId(draft, 'R5-5')).toBe(stamped);
    }
    // A zero-width-space line between is NOT a boundary (it is a
    // paragraph line), so the block under it is still absorbed — skip.
    expect(stampCarriedId('**[Critical]**\n\u200b\n    code', 'R5-5')).toBe(
      '**[Critical]** R5-5: code',
    );
    // A comment whose own newlines precede a fence on the marker's line
    // keeps the same-line skip: breaks inside comments are not rendered
    // breaks.
    expect(
      stampCarriedId(
        '**[Critical]**<!--\nx\n-->```js\ncode\n```\nclaim',
        'R5-5',
      ),
    ).toBe('**[Critical]**<!--\nx\n-->```js\ncode\n```\nclaim');
  });

  it('reads no carried id off an indented code block — a fresh finding is not a carry of the id its code starts with (#9940 review, audit)', () => {
    // The readback used to strip the residue after the marker, indentation
    // included, and read `R1-2:` inside the code block as the claim: the
    // stamp early-returned ("carries an id already") and the lifecycle
    // replied the FRESH finding into R1-2's thread. The line model reads
    // that line as `code`; so do both readback legs now.
    const draft =
      '**[Critical]**\n\n    R1-2: the guard drops a valid case\n\nthe round-1 claim above was ruled fixed, but the fix only moved it';
    expect(carriedFindingOf(draft)).toBeNull();
    expect(
      carriedFindingOf(
        '**[Critical]**\n\n\tR1-2: (fix-induced) the guard drops a valid case',
      ),
    ).toBeNull();
    // The attribution-off posted shape of the same body (bare leg).
    expect(
      carriedFindingOf(
        '\n\n    R1-2: the guard drops a valid case\n\n<!-- qwen-review critical -->',
      ),
    ).toBeNull();
    expect(
      carriedFindingOf('    R1-2: the guard\n\n<!-- qwen-review critical -->'),
    ).toBeNull();
    // Stamped as the fresh finding it is, the block survives behind the
    // blank line and the root leads with the minted id.
    const stamped = stampCarriedId(draft, 'R9-1');
    expect(stamped).toBe(
      '**[Critical]** R9-1: \n\n    R1-2: the guard drops a valid case\n\nthe round-1 claim above was ruled fixed, but the fix only moved it',
    );
    expect(carriedFindingOf(stamped)).toEqual({
      id: 'R9-1',
      fixInduced: false,
    });
    // A quoted id and a fenced id were already not carries.
    expect(carriedFindingOf('**[Critical]**\n> R1-2: quoted')).toBeNull();
    expect(carriedFindingOf('**[Critical]**\n```\nR1-2: x\n```')).toBeNull();
  });

  it('re-attaches a line break the separator strip swallowed — a block after the colon keeps its structure under attribution on (#9940 review, audit)', () => {
    // `:` + blank line + indented code: the strip's residue-after-colon
    // arm consumed the newlines and the indentation, and the canonical
    // `MARKER id: claim` re-serialization flattened the block into the
    // claim line (it also deleted a `(fix-induced)` inside the block as
    // machine grammar). The break run is re-attached, so the block keeps
    // its line and the line-2 arm judges it where it sits.
    for (const [draft, stamped] of [
      [
        '**[Critical]**:\n\n    leaked()\n\nthe claim',
        '**[Critical]** R1-5: \n\n    leaked()\n\nthe claim',
      ],
      [
        '**[Critical]**：\n\n    (fix-induced) x\n\nthe claim',
        '**[Critical]** R1-5: \n\n    (fix-induced) x\n\nthe claim',
      ],
      ['**[Critical]**:\n\n> quote', '**[Critical]** R1-5: \n\n> quote'],
      ['**[Critical]**:\n> quote', '**[Critical]** R1-5: \n> quote'],
      ['**[Critical]**:\n\nthe claim', '**[Critical]** R1-5: \n\nthe claim'],
      // A same-line separator stays normalized (the round-10 pin).
      ['**[Critical]**: the claim', '**[Critical]** R1-5: the claim'],
      // A comment's inner newlines are not rendered breaks — normalized.
      [
        '**[Critical]** : <!--\nx\n--> the claim',
        '**[Critical]** R1-5: the claim',
      ],
    ]) {
      expect(stampCarriedId(draft, 'R1-5')).toBe(stamped);
    }
    // Code right under the colon with NO blank line was never a block
    // (the marker line absorbs it either way) — the id-less degradation.
    // One break and four columns is a lazy continuation of the marker's
    // paragraph, not a block — stamped on the line (audit 4).
    expect(stampCarriedId('**[Critical]**:\n    leaked()', 'R1-5')).toBe(
      '**[Critical]** R1-5: leaked()',
    );
  });

  it('reads a bare CR as a line break on the marked leg too — the two legs agree (#9940 review, audit)', () => {
    // The marked leg split on `\n` only; the id grammar's trailing `\s*`
    // crossed a bare `\r` and read a second-line `(fix-induced)` into the
    // head slot, while the bare leg (and the stamp) split on `\r` — the
    // same draft was a fix-induced re-report under attribution on and a
    // plain carry under attribution off.
    expect(
      carriedFindingOf('**[Critical]** R1-2:\r(fix-induced) the new hole'),
    ).toEqual({ id: 'R1-2', fixInduced: false });
    const stamped = stampCarriedId(
      '**[Critical]**\r(fix-induced) the claim',
      'R1-5',
    );
    // The CR is a soft break; folded, the token reaches the head slot and
    // is removed like any fresh claim's (audit 5).
    expect(stamped).toBe('**[Critical]** R1-5: the claim');
    expect(carriedFindingOf(stamped)).toEqual({
      id: 'R1-5',
      fixInduced: false,
    });
  });

  it('a leader behind a format character, a no-break space or a comment is text — stamped (#9940 review, audit)', () => {
    // CommonMark reads `\u200B# Heading` as a paragraph: only spaces and tabs
    // may precede a construct on its line. Skipping there lost the id
    // for nothing and disclosed a construct that did not exist.
    for (const [draft, stamped] of [
      [
        '**[Critical]** \u200B# Heading\nmore',
        '**[Critical]** R5-6: \u200B# Heading\nmore',
      ],
      ['**[Critical]** \u00A0- item', '**[Critical]** R5-6: \u00A0- item'],
      [
        '**[Critical]** <!-- x -->- item',
        '**[Critical]** R5-6: <!-- x -->- item',
      ],
      ['**[Critical]** \uFEFF> quoted', '**[Critical]** R5-6: \uFEFF> quoted'],
    ]) {
      expect(stampCarriedId(draft, 'R5-6')).toBe(stamped);
    }
    // The fence and HTML-block arms keep their residue tolerance (the
    // round-8 and round-11 pins).
    expect(
      stampCarriedId('**[Critical]** <!-- x -->```diff\n-a\n```', 'R5-6'),
    ).toBe('**[Critical]** <!-- x -->```diff\n-a\n```');
  });

  it('leaves a GFM table header and a link reference definition on the first line un-stamped (#9940 review, audit)', () => {
    for (const draft of [
      '**[Critical]** | a | b |\n|---|---|\n| 1 | 2 |',
      '**[Critical]** | a | b |\n| :-- | --: |\n| 1 | 2 |',
      '**[Critical]** [spec]: https://spec.commonmark.org\nsee [spec]',
    ]) {
      expect(stampCarriedId(draft, 'R5-7')).toBe(draft);
    }
    // A pipe-led line over anything but a delimiter row is text.
    expect(stampCarriedId('**[Critical]** | a | b |\nthe claim', 'R5-7')).toBe(
      '**[Critical]** R5-7: | a | b |\nthe claim',
    );
    // Without the leading pipe the id becomes the first header cell —
    // the table survives, so the stamp applies.
    expect(stampCarriedId('**[Critical]** a | b\n---|---\n1 | 2', 'R5-7')).toBe(
      '**[Critical]** R5-7: a | b\n---|---\n1 | 2',
    );
  });

  it('strips every head-slot marking in one pass, in bounded time (#9940 review, audit)', () => {
    const draft = `**[Critical]** ${'(fix-induced) '.repeat(4000)}the claim`;
    const t0 = performance.now();
    const stamped = stampCarriedId(draft, 'R1-5');
    expect(performance.now() - t0).toBeLessThan(500);
    expect(stamped).toBe('**[Critical]** R1-5: the claim');
    expect(carriedFindingOf(stamped)).toEqual({
      id: 'R1-5',
      fixInduced: false,
    });
  });

  it('classifies a long unclosed tag on the first line in bounded time (#9940 review, audit)', () => {
    // `HTML_BLOCK_OPEN_RE` re-split trailing spaces between two classes:
    // 60,000 spaces after `<a` cost 1.7 s per call.
    const draft = `**[Critical]** <a${' '.repeat(60000)}>x`;
    const t0 = performance.now();
    stampCarriedId(draft, 'R1-5');
    expect(performance.now() - t0).toBeLessThan(200);
  });

  it('reads a non-canonical id spelling back as the canonical id — one spelling for every join (#9940 review, audit)', () => {
    expect(carriedFindingOf('**[Critical]** R02-3: the guard')).toEqual({
      id: 'R2-3',
      fixInduced: false,
    });
    expect(
      carriedFindingOf('R007-010: the guard\n\n<!-- qwen-review critical -->'),
    ).toEqual({
      id: 'R7-10',
      fixInduced: false,
    });
    // A body carrying a variant is still a carry — left verbatim, and the
    // matcher pairs it with the canonical thread.
    const carry = '**[Critical]** R02-3: still stands';
    expect(stampCarriedId(carry, 'R9-1')).toBe(carry);
    const plan = planThreadActions(
      [thread({ rootBody: '**[Critical]** R2-3: the guard' })],
      'qwen-bot',
      [{ index: 0, id: 'R2-3' }],
      [],
    );
    expect(plan.replies).toEqual([{ index: 0, id: 'R2-3', commentId: 1001 }]);
  });

  it('reads no carried id off an indented code block behind a separator colon either — the marked leg keeps the block like the stamp does (#9940 review, audit 2)', () => {
    for (const draft of [
      '**[Critical]**:\n\n    R1-2: the guard drops a valid case\n\nfresh claim',
      '**[Critical]** :\n\n    R1-2: the guard drops a valid case',
      '**[Critical]**\uff1a\n\n\tR1-2: the guard drops a valid case',
      '**[Critical]**\n:\n\n    R1-2: the guard drops a valid case',
    ]) {
      expect(carriedFindingOf(draft)).toBeNull();
    }
    // One break after the colon is no boundary: the indented line
    // continues the paragraph (audit 3), so the claim is read.
    expect(
      carriedFindingOf(
        '**[Critical]**\n:\n    R1-2: the guard drops a valid case',
      ),
    ).toEqual({ id: 'R1-2', fixInduced: false });
    expect(
      stampCarriedId(
        '**[Critical]**:\n\n    R1-2: the guard drops a valid case\n\nfresh claim',
        'R9-1',
      ),
    ).toBe(
      '**[Critical]** R9-1: \n\n    R1-2: the guard drops a valid case\n\nfresh claim',
    );
    // A colon quoted inside a comment is not the separator colon — neither
    // when the real colon follows on the same line, nor when the code
    // block sits behind the real colon (an unmasked search took the quoted
    // colon, saw prose after it, and read the block as the claim).
    expect(
      carriedFindingOf('**[Critical]** <!-- : -->R1-2: the claim'),
    ).toEqual({
      id: 'R1-2',
      fixInduced: false,
    });
    expect(
      carriedFindingOf(
        '**[Critical]** <!-- note: x -->:\n\n    R1-2: not a claim',
      ),
    ).toBeNull();
    // …and a comment whose inner newline is followed by four spaces is not
    // an indented code block behind the quoted colon: the claim after the
    // real colon is read (an unmasked search took the quoted colon and
    // the comment's own line for code, and read no id).
    expect(
      carriedFindingOf('**[Critical]** <!-- a:\n    -->: R1-2: the claim'),
    ).toEqual({ id: 'R1-2', fixInduced: false });
  });

  it('fixedRulingLine — the reply line degrades a marker-carrying clause to a by-less ruling (#9940 review, audit 2)', () => {
    expect(fixedRulingLine('R1-2', 'the guard now fails closed')).toBe(
      'R1-2 fixed by the guard now fails closed',
    );
    expect(fixedRulingLine('R1-2', '')).toBe('R1-2 fixed');
    expect(fixedRulingLine('R1-2', 'x <!-- qwen-review critical -->')).toBe(
      'R1-2 fixed',
    );
    expect(fixedRulingLine('R1-2', 'x <!--qwen-review')).toBe('R1-2 fixed');
  });

  it('finds the LAST marker with comments masked — a marker quoted in the separator comment is comment content (#9940 review, audit 2)', () => {
    // An unmasked search took the quoted marker, and the comment's inner
    // blank line for the content's own structure — re-attaching it posted
    // the comment's tail (`-->`) as visible text.
    expect(
      stampCarriedId(
        '**[Critical]**: <!-- **[Suggestion]**:\n\n --> content',
        'R1-5',
      ),
    ).toBe('**[Critical]** R1-5: content');
    // …and the separator colon likewise: a colon quoted in a comment
    // before the real one is not where the content's breaks start.
    expect(
      stampCarriedId('**[Critical]** <!-- a:\n\n --> : content', 'R1-5'),
    ).toBe('**[Critical]** R1-5: content');
  });

  it('a colon, ONE line break and four columns is a lazy continuation, not code — both legs read the claim (#9940 review, audit 3)', () => {
    // Indented code cannot interrupt a paragraph: without a blank line (or
    // a comment line) between, the indented line continues the marker's
    // paragraph on GitHub, and the attribution-off exit posts it as the
    // first line. The marked leg used to read null here while the bare leg
    // read R1-2.
    for (const draft of [
      '**[Critical]**:\n    R1-2: the guard drops a valid case',
      '**[Critical]**:\r    R1-2: the guard drops a valid case',
      '**[Critical]**: <!-- c -->\n    R1-2: the guard drops a valid case',
      '**[Critical]**:\n  \t R1-2: the guard drops a valid case',
      '**[Critical]**:\n   R1-2: the guard drops a valid case',
    ]) {
      expect(carriedFindingOf(draft)).toEqual({
        id: 'R1-2',
        fixInduced: false,
      });
      expect(carriedFindingOf(stripForUnattributedPost(draft))).toEqual({
        id: 'R1-2',
        fixInduced: false,
      });
    }
    // With the boundary the block is code on EVERY projection: the
    // attribution-off strip keeps the indentation instead of posting the
    // block's first line as prose.
    expect(stripSeverityPrefix('**[Critical]**:\n\n    R1-2: the guard')).toBe(
      '    R1-2: the guard',
    );
    expect(
      stripSeverityPrefix('**[Critical]**:\n<!-- c -->\n    R1-2: the guard'),
    ).toBe('    R1-2: the guard');
    expect(
      stripSeverityPrefix('**[Critical]** <!-- : -->:\n\n    R1-2: the guard'),
    ).toBe('    R1-2: the guard');
    expect(
      stripSeverityPrefix('**[Critical]**\n:\n\n    R1-2: the guard'),
    ).toBe('    R1-2: the guard');
    expect(
      carriedFindingOf(
        stripForUnattributedPost('**[Critical]**:\n\n    R1-2: the guard'),
      ),
    ).toBeNull();
    // A marker inside the kept code block is content, not a second marker.
    expect(
      stripSeverityPrefix('**[Critical]**:\n\n    **[Suggestion]** x'),
    ).toBe('    **[Suggestion]** x');
    expect(stripSeverityPrefix('**[Critical]**:\n    R1-2: the guard')).toBe(
      'R1-2: the guard',
    );
  });

  it('a marker inside an indented code block is code on every projection — strip, readback and stamp agree (#9940 review, audit 4)', () => {
    // An earlier comment quoted as an indented code block under the marker.
    const quoted =
      '**[Critical]**\n\n    **[Critical]** R1-2: the guard drops a valid case\n\nprose';
    expect(stripSeverityPrefix(quoted)).toBe(
      '    **[Critical]** R1-2: the guard drops a valid case\n\nprose',
    );
    expect(carriedFindingOf(quoted)).toBeNull();
    expect(carriedFindingOf(stripForUnattributedPost(quoted))).toBeNull();
    expect(stampCarriedId(quoted, 'R3-7')).toBe(
      '**[Critical]** R3-7: \n\n    **[Critical]** R1-2: the guard drops a valid case\n\nprose',
    );
    // Behind the colon, and through the attribution-off fixpoint.
    const colon =
      '**[Critical]**:\n\n    **[Critical]** R1-2: quoted old claim';
    expect(stripForUnattributedPost(colon)).toBe(
      '    **[Critical]** R1-2: quoted old claim',
    );
    expect(carriedFindingOf(stripForUnattributedPost(colon))).toBeNull();
    // A body that opens on the code line carries no marker to strip or stamp.
    const code = '    **[Critical]** R1-2: quoted old claim';
    expect(stripSeverityPrefix(code)).toBe(code);
    expect(carriedFindingOf(code)).toBeNull();
    expect(stampCarriedId(code, 'R3-7')).toBe(code);
  });

  it('severityOf reads no marker off an indented code line — the one predicate every strip, readback and stamp consult (#9940 review, audit 5)', () => {
    for (const body of [
      '    **[Critical]** the guard',
      '\t**[Critical]** the guard',
      '  \t**[Critical]** the guard',
      '\n    **[Critical]** the guard',
      '\r\n    **[Critical]** the guard',
    ]) {
      expect(severityOf({ body })).toBeNull();
      expect(stripSeverityPrefix(body)).toBe(body);
      expect(stampCarriedId(body, 'R3-7')).toBe(body);
    }
    // Three spaces, or NBSPs, indent nothing.
    expect(severityOf({ body: '   **[Critical]** x' })).toBe('critical');
    expect(
      severityOf({ body: '\u00a0\u00a0\u00a0\u00a0**[Critical]** x' }),
    ).toBe('critical');
  });

  it('a break and four columns with NO colon is a lazy continuation too — folded on every projection (#9940 review, audit 5)', () => {
    const draft =
      '**[Critical]**\n    the guard drops a valid case\n\nWhen `x` is null the branch is skipped.';
    expect(stripSeverityPrefix(draft)).toBe(
      'the guard drops a valid case\n\nWhen `x` is null the branch is skipped.',
    );
    expect(carriedFindingOf('**[Critical]**\n    R1-2: the guard')).toEqual({
      id: 'R1-2',
      fixInduced: false,
    });
    expect(
      carriedFindingOf(
        stripForUnattributedPost('**[Critical]**\n    R1-2: the guard'),
      ),
    ).toEqual({ id: 'R1-2', fixInduced: false });
    expect(stampCarriedId(draft, 'R3-7')).toBe(
      '**[Critical]** R3-7: the guard drops a valid case\n\nWhen `x` is null the branch is skipped.',
    );
    // Behind a boundary the block is code and stays one.
    expect(stampCarriedId('**[Critical]**\n\n    the guard', 'R3-7')).toBe(
      '**[Critical]** R3-7: \n\n    the guard',
    );
    expect(stripSeverityPrefix('**[Critical]**\n\n    the guard')).toBe(
      '    the guard',
    );
  });

  it('a colon-led indented code block behind a boundary is code, not the separator colon (#9940 review, audit 5)', () => {
    for (const [draft, stamped] of [
      [
        '**[Critical]**\n\n    : colon-led\n\nprose',
        '**[Critical]** R3-7: \n\n    : colon-led\n\nprose',
      ],
      [
        '**[Critical]**\n\n\t：full-width\n\nprose',
        '**[Critical]** R3-7: \n\n\t：full-width\n\nprose',
      ],
    ]) {
      expect(stampCarriedId(draft, 'R3-7')).toBe(stamped);
      expect(carriedFindingOf(draft)).toBeNull();
    }
    expect(
      stripSeverityPrefix('**[Critical]**\n\n    : colon-led\n\nprose'),
    ).toBe('    : colon-led\n\nprose');
  });

  it('a marker line that is itself an HTML block keeps the content on its own line (#9940 review, audit 5)', () => {
    for (const [draft, stamped] of [
      [
        '<!-- c -->**[Critical]**:\nthe **claim** drops `x`',
        '<!-- c -->**[Critical]** R3-7: \nthe **claim** drops `x`',
      ],
      [
        '<!-- c -->**[Critical]**\nthe claim',
        '<!-- c -->**[Critical]** R3-7: \nthe claim',
      ],
      // Four columns in, the comment line is code — not an HTML block.
      ['**[Critical]**:\nthe claim', '**[Critical]** R3-7: the claim'],
    ]) {
      expect(stampCarriedId(draft, 'R3-7')).toBe(stamped);
      expect(carriedFindingOf(stamped)).toEqual({
        id: 'R3-7',
        fixInduced: false,
      });
    }
  });

  it('a comment-led content line is a type-2 HTML block — it keeps its line (#9940 review, audit 6)', () => {
    for (const [draft, stamped] of [
      [
        '**[Critical]**\n<!-- c -->claim',
        '**[Critical]** R9-9: \n<!-- c -->claim',
      ],
      [
        '**[Critical]**:\n <!-- c -->**bold** claim',
        '**[Critical]** R9-9: \n <!-- c -->**bold** claim',
      ],
    ]) {
      expect(stampCarriedId(draft, 'R9-9')).toBe(stamped);
      expect(carriedFindingOf(stamped)).toEqual({
        id: 'R9-9',
        fixInduced: false,
      });
      expect(carriedFindingOf(stripForUnattributedPost(stamped))).toEqual({
        id: 'R9-9',
        fixInduced: false,
      });
    }
  });

  it('a four-column line under an HTML-block marker line takes the id-less degradation — no shape serves both projections (#9940 review, audit 6)', () => {
    for (const draft of [
      '<!-- c -->**[Critical]**\n    _— x via Qwen Code /review_ claim',
      '<!-- c -->**[Critical]**\n\t**[Suggestion]** other\nclaim',
    ]) {
      expect(stampCarriedId(draft, 'R9-9')).toBe(draft);
    }
    // With a boundary the block is code on both projections — stamped.
    expect(stampCarriedId('<!-- c -->**[Critical]**\n\n    code', 'R9-9')).toBe(
      '<!-- c -->**[Critical]** R9-9: \n\n    code',
    );
  });

  it('a four-column comment line behind a boundary is visible code — the attribution-off strip keeps it (#9940 review, audit 6)', () => {
    expect(stripSeverityPrefix('**[Critical]**\n\n    <!-- c -->\nclaim')).toBe(
      '    <!-- c -->\nclaim',
    );
    expect(stripSeverityPrefix('**[Critical]**:\n\n    <!-- c -->')).toBe(
      '    <!-- c -->',
    );
    expect(
      carriedFindingOf('**[Critical]**\n\n    <!-- c -->\nR1-2: x'),
    ).toBeNull();
    expect(
      stampCarriedId('**[Critical]**\n\n    <!-- c -->\nclaim', 'R9-9'),
    ).toBe('**[Critical]** R9-9: \n\n    <!-- c -->\nclaim');
    // A comment line up to three columns in is a boundary, not code.
    expect(stripSeverityPrefix('**[Critical]**\n\n   <!-- c -->\nclaim')).toBe(
      'claim',
    );
  });

  it('a one-column table needs a `|` in the delimiter row only — the header keeps its line (#9940 review, audit 5)', () => {
    expect(stampCarriedId('**[Critical]**:\nthe claim\n|---|', 'R3-7')).toBe(
      '**[Critical]** R3-7: \nthe claim\n|---|',
    );
    // `---` under the paragraph is a setext underline of the WHOLE
    // paragraph on both sides of the stamp — a heading either way.
    expect(stampCarriedId('**[Critical]**:\nthe claim\n---', 'R3-7')).toBe(
      '**[Critical]** R3-7: the claim\n---',
    );
  });

  it('a format character or NBSP leading the content line stays — it shields the construct it precedes (#9940 review, audit 5)', () => {
    expect(stripSeverityPrefix('**[Critical]**:\n\n\u200b# heading')).toBe(
      '\u200b# heading',
    );
    expect(stripSeverityPrefix('**[Critical]**\n\u00a0> quote')).toBe(
      '\u00a0> quote',
    );
    expect(stampCarriedId('**[Critical]**:\n\n\u200b# heading', 'R3-7')).toBe(
      '**[Critical]** R3-7: \n\n\u200b# heading',
    );
    // Spaces and tabs on that line are separator grammar still.
    expect(stripSeverityPrefix('**[Critical]**:\n  the claim')).toBe(
      'the claim',
    );
  });

  it('a `(fix-induced)` marking only the attribution-off exit reveals on a model-carried id reads on both legs (#9940 review, audit 5)', () => {
    const body =
      '**[Critical]** R1-2: _— foo\nbar via Qwen Code /review_ (fix-induced) the claim';
    expect(carriedFindingOf(body)).toEqual({ id: 'R1-2', fixInduced: true });
    expect(carriedFindingOf(stripForUnattributedPost(body))).toEqual({
      id: 'R1-2',
      fixInduced: true,
    });
    expect(carriedFindingOf('**[Critical]** R1-2: the claim')).toEqual({
      id: 'R1-2',
      fixInduced: false,
    });
  });

  it('a colon, one break and four columns is a lazy continuation for the stamp too — stamped on the marker line (#9940 review, audit 4)', () => {
    for (const [draft, stamped] of [
      ['**[Critical]**:\n    the claim', '**[Critical]** R3-7: the claim'],
      ['**[Critical]**: \n\tthe claim', '**[Critical]** R3-7: the claim'],
      ['**[Critical]**:\r    the claim', '**[Critical]** R3-7: the claim'],
      // A comment line four columns in is code, not a boundary.
      [
        '**[Critical]**:\n    <!-- c -->\n    the claim',
        '**[Critical]** R3-7: the claim',
      ],
    ]) {
      expect(stampCarriedId(draft, 'R3-7')).toBe(stamped);
    }
    // With the boundary the block is code and keeps its lines.
    expect(stampCarriedId('**[Critical]**:\n\n    the claim', 'R3-7')).toBe(
      '**[Critical]** R3-7: \n\n    the claim',
    );
  });

  it('stripSeverityPrefix — empty-at-fixpoint keeps its contract and stays linear on stacked markers (#9940 review, audit 3)', () => {
    expect(stripSeverityPrefix('**[Critical]** **[Suggestion]** ')).toBe('');
    expect(stripSeverityPrefix('**[Critical]** <!-- c --> ​')).toBe('');
    // A marker-less invisible body is not "nothing but markers".
    expect(stripSeverityPrefix('​')).toBe('​');
    const t0 = performance.now();
    expect(stripSeverityPrefix(`${'**[Critical]** '.repeat(20000)}foo`)).toBe(
      'foo',
    );
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('a pipe-less table header under the colon keeps its line — GFM needs no leading `|` (#9940 review, audit 3)', () => {
    expect(stampCarriedId('**[Critical]**:\na | b\n---|---', 'R7-9')).toBe(
      '**[Critical]** R7-9: \na | b\n---|---',
    );
    expect(stampCarriedId('**[Critical]**:\na|b\n-|-', 'R7-9')).toBe(
      '**[Critical]** R7-9: \na|b\n-|-',
    );
    // On the marker's own line a pipe-less header takes the id into its
    // first cell and stays a table (a `|`-led one would not — skipped).
    expect(stampCarriedId('**[Critical]** a | b\n---|---', 'R7-9')).toBe(
      '**[Critical]** R7-9: a | b\n---|---',
    );
    expect(stampCarriedId('**[Critical]** | a | b |\n|---|---|', 'R7-9')).toBe(
      '**[Critical]** | a | b |\n|---|---|',
    );
    // A `|` line over a non-delimiter is prose — folded onto the line.
    expect(
      stampCarriedId('**[Critical]**:\na | b\nnot a delimiter', 'R7-9'),
    ).toBe('**[Critical]** R7-9: a | b\nnot a delimiter');
  });

  it('a `(fix-induced)` token behind a soft-wrapped footer span is a marking on the bare leg — the stamp degrades rather than post it (#9940 review, audit 3)', () => {
    const draft =
      '**[Critical]** _— x via Qwen\nCode /review_ (fix-induced) foo';
    expect(stampCarriedId(draft, 'R7-9')).toBe(draft);
    // Many tokens strip in one pass — the loop is not a pass per token.
    const many = `**[Critical]** _— x via Qwen Code /review_ ${'(fix-induced) '.repeat(4000)}foo`;
    const t0 = performance.now();
    const out = stampCarriedId(many, 'R7-9');
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(carriedFindingOf(out)?.fixInduced).not.toBe(true);
    expect(
      carriedFindingOf(stripForUnattributedPost(out))?.fixInduced,
    ).not.toBe(true);
  });

  it('a type-7 tag whose name only starts with a block-level one, or whose attribute quotes `<`, is a lone tag — skipped (#9940 review, audit 3)', () => {
    for (const draft of [
      '**[Critical]**\n<div-x>',
      '**[Critical]**\n<a title="x<y">',
      "**[Critical]**\n<a title='x>y'>",
    ]) {
      expect(stampCarriedId(draft, 'R7-9')).toBe(draft);
    }
    expect(stampCarriedId('**[Critical]**\n<div>', 'R7-9')).toBe(
      '**[Critical]** R7-9: \n<div>',
    );
  });

  it('a link reference definition whose destination sits on the next line, or whose label escapes `]`, is skipped (#9940 review, audit 3)', () => {
    for (const draft of [
      '**[Critical]**\n[ref]:\n/url',
      '**[Critical]**\n[a\\]b]: /url',
      '**[Critical]** [ref]:\n/url',
    ]) {
      expect(stampCarriedId(draft, 'R7-9')).toBe(draft);
    }
  });

  it('counts indentation in columns — a tab-mixed indent is code on both legs and for the stamp (#9940 review, audit 2)', () => {
    expect(
      carriedFindingOf('**[Critical]**\n\n  \tR1-2: the guard'),
    ).toBeNull();
    expect(carriedFindingOf('**[Critical]**\n\n \tR1-2: the guard')).toBeNull();
    expect(
      carriedFindingOf('  \tR1-2: the guard\n\n<!-- qwen-review critical -->'),
    ).toBeNull();
    // Under one break the indented line is a lazy continuation — folded
    // onto the marker line (audit 5).
    expect(stampCarriedId('**[Critical]**\n  \tcode', 'R1-5')).toBe(
      '**[Critical]** R1-5: code',
    );
    // Three spaces are not code — stamped, and still a carry when it leads
    // with an id.
    expect(stampCarriedId('**[Critical]**\n   the claim', 'R1-5')).toBe(
      '**[Critical]** R1-5: the claim',
    );
    expect(carriedFindingOf('**[Critical]**\n\n   R1-2: the guard')).toEqual({
      id: 'R1-2',
      fixInduced: false,
    });
  });

  it('a block-level tag directly under the marker CAN interrupt the id paragraph — stamped; a type-7 lone tag cannot — skipped (#9940 review, audit 2)', () => {
    for (const [draft, stamped] of [
      [
        '**[Critical]**\n<details>\nfoo\n\nthe claim',
        '**[Critical]** R5-5: \n<details>\nfoo\n\nthe claim',
      ],
      [
        '**[Critical]**\n<div>\nfoo\n</div>',
        '**[Critical]** R5-5: \n<div>\nfoo\n</div>',
      ],
      ['**[Critical]**\n</div>', '**[Critical]** R5-5: \n</div>'],
      [
        '**[Critical]**\n<pre>\nx\n</pre>',
        '**[Critical]** R5-5: \n<pre>\nx\n</pre>',
      ],
      [
        '**[Critical]**\n<summary>x</summary>',
        '**[Critical]** R5-5: \n<summary>x</summary>',
      ],
    ]) {
      expect(stampCarriedId(draft, 'R5-5')).toBe(stamped);
    }
    for (const draft of [
      '**[Critical]**\n<span>\nfoo\n\nthe claim',
      '**[Critical]**\n<custom-el class="x">\nfoo',
      '**[Critical]**\n</span>',
    ]) {
      expect(stampCarriedId(draft, 'R5-5')).toBe(draft);
    }
  });

  it('the lone-tag and table-delimiter tests stay linear on long whitespace runs (#9940 review, audit 2)', () => {
    // The quadratic forms took seconds on these inputs; the bound is loose
    // enough for a loaded CI runner (a 150 ms bound tripped at 534 ms under
    // load 50) and the best of two runs discounts JIT warm-up.
    const bestOfTwo = (body: string): number => {
      let best = Infinity;
      for (let i = 0; i < 2; i++) {
        const t0 = performance.now();
        stampCarriedId(body, 'R1-5');
        best = Math.min(best, performance.now() - t0);
      }
      return best;
    };
    expect(bestOfTwo(`**[Critical]**\n<a${' '.repeat(60000)}x`)).toBeLessThan(
      2000,
    );
    expect(
      bestOfTwo(`**[Critical]** | a |\n|---${' '.repeat(60000)}x`),
    ).toBeLessThan(2000);
    expect(
      bestOfTwo(`**[Critical]**${'<!---->\n'.repeat(8000)}the claim`),
    ).toBeLessThan(2000);
  });

  it('a marker string quoted inside a separator comment is comment content, not the last marker (#9940 review, audit 2)', () => {
    expect(
      stampCarriedId(
        '**[Critical]**: <!-- **[Suggestion]**\n--> the claim',
        'R1-5',
      ),
    ).toBe('**[Critical]** R1-5: the claim');
    expect(
      stampCarriedId(
        '**[Critical]** <!-- **[Critical]**\n-->: the claim',
        'R1-5',
      ),
    ).toBe('**[Critical]** R1-5: the claim');
  });

  it('strips a marking the slot read did not reach behind a forged footer span — the readback stays the arbiter (#9940 review, audit 2)', () => {
    const out = stampCarriedId(
      '**[Critical]** _— x via Qwen Code /review_ (fix-induced) the claim',
      'R1-5',
    );
    expect(out).not.toContain('(fix-induced)');
    expect(carriedFindingOf(out)).toEqual({ id: 'R1-5', fixInduced: false });
  });

  it('an indented comment line between the marker and a code block is code, not a block boundary — skipped (#9940 review, audit 2)', () => {
    expect(
      stampCarriedId('**[Critical]**\n    <!-- c -->\n    code', 'R1-5'),
    ).toBe('**[Critical]** R1-5: code');
    expect(
      stampCarriedId('**[Critical]**\n   <!-- c -->\n    code', 'R1-5'),
    ).toBe('**[Critical]** R1-5: \n   <!-- c -->\n    code');
  });

  it('a `[label]:` followed by prose is not a link reference definition — stamped; a real definition is skipped (#9940 review, audit 2)', () => {
    for (const [draft, stamped] of [
      [
        '**[Critical]** [probe]: the guard drops a valid case',
        '**[Critical]** R5-7: [probe]: the guard drops a valid case',
      ],
      [
        '**[Critical]** [src/foo.ts]: null deref on the empty branch',
        '**[Critical]** R5-7: [src/foo.ts]: null deref on the empty branch',
      ],
      [
        '**[Critical]**\n[probe]: the guard drops a valid case',
        '**[Critical]** R5-7: [probe]: the guard drops a valid case',
      ],
    ]) {
      expect(stampCarriedId(draft, 'R5-7')).toBe(stamped);
    }
    for (const draft of [
      '**[Critical]** [spec]: https://spec.commonmark.org\nsee [spec]',
      '**[Critical]** [spec]: <https://spec.commonmark.org> "CommonMark"\nsee [spec]',
      '**[Critical]**\n[spec]: https://spec.commonmark.org\nsee [spec]',
    ]) {
      expect(stampCarriedId(draft, 'R5-7')).toBe(draft);
    }
  });

  it('a header row over a delimiter row with a different cell count is text — stamped (#9940 review, audit 2)', () => {
    expect(stampCarriedId('**[Critical]** | a | b |\n|---|\nx', 'R5-7')).toBe(
      '**[Critical]** R5-7: | a | b |\n|---|\nx',
    );
    expect(
      stampCarriedId('**[Critical]** | a | b |\n|---|---|\nx', 'R5-7'),
    ).toBe('**[Critical]** | a | b |\n|---|---|\nx');
  });

  it('re-attaches only the breaks after the colon, and only for a block or a blank line — prose under one break stays canonical (#9940 review, audit 2)', () => {
    for (const [draft, stamped] of [
      // A break BEFORE the colon is separator grammar — normalized.
      ['**[Critical]**\n: the claim', '**[Critical]** R1-5: the claim'],
      // Prose under a single break — normalized, the claim keeps its tags.
      [
        '**[Critical]**:\n[probe] [fails-closed] the claim',
        '**[Critical]** R1-5: [probe] [fails-closed] the claim',
      ],
      // A construct under a single break keeps its line.
      ['**[Critical]**:\n> quote', '**[Critical]** R1-5: \n> quote'],
      ['**[Critical]**:\n# Heading', '**[Critical]** R1-5: \n# Heading'],
      ['**[Critical]**:\n<details>\nx', '**[Critical]** R1-5: \n<details>\nx'],
      // A blank line always keeps its structure.
      ['**[Critical]**:\n\nthe claim', '**[Critical]** R1-5: \n\nthe claim'],
    ]) {
      expect(stampCarriedId(draft, 'R1-5')).toBe(stamped);
    }
    // A cannot-interrupt construct under a single break after the colon
    // is re-attached and then, correctly, skipped.
    expect(stampCarriedId('**[Critical]**:\n---\nthe claim', 'R1-5')).toBe(
      '**[Critical]**:\n---\nthe claim',
    );
  });

  it('leaves the five round-27 drafts un-stamped — link reference definition, type-6 opener with trailing text, type-7 block under the marker, tab-stop code, setext underline (#9940 review, round 27)', () => {
    for (const draft of [
      '**[Critical]** [foo]: /url\nthe claim',
      '**[Critical]** <div class="x">foo',
      '**[Critical]**\n<span class="note">\nthe claim\n</span>',
      '**[Critical]**\n---\ncontent',
      '**[Critical]**\n===\ncontent',
      // The type-1 and type-6 start conditions end at the tag name.
      '**[Critical]** <pre>foo',
      '**[Critical]** <DIV>foo',
      '**[Critical]** <div/>foo',
      '**[Critical]** </div>foo',
      '**[Critical]** <textarea\nfoo',
    ]) {
      expect(stampCarriedId(draft, 'R5-3')).toBe(draft);
    }
    // Tab-stop indentation under ONE break is a lazy continuation of the
    // marker's paragraph (indented code cannot interrupt a paragraph) —
    // folded onto the line, the same paragraph (audit 5).
    expect(
      stampCarriedId('**[Critical]**\n \tconst x = leaked();', 'R5-3'),
    ).toBe('**[Critical]** R5-3: const x = leaked();');
    // A name that is not a block-level tag, or a type-7 tag with trailing
    // text, opens no HTML block — stamped.
    expect(stampCarriedId('**[Critical]** <divx>foo', 'R5-3')).toBe(
      '**[Critical]** R5-3: <divx>foo',
    );
    expect(stampCarriedId('**[Critical]** <span>foo', 'R5-3')).toBe(
      '**[Critical]** R5-3: <span>foo',
    );
  });

  it('the linear HTML-block opener test accepts and refuses the same lines as the overlapping form did (#9940 review, audit 2)', () => {
    for (const draft of [
      '**[Critical]** <a>  \nfoo',
      '**[Critical]** <a  \nfoo',
      '**[Critical]** <a href="x">\nfoo',
      '**[Critical]** </div>\nfoo',
    ]) {
      expect(stampCarriedId(draft, 'R5-8')).toBe(draft);
    }
    expect(stampCarriedId('**[Critical]** <a>x', 'R5-8')).toBe(
      '**[Critical]** R5-8: <a>x',
    );
  });

  it('leaves a quoted fence-opening body un-stamped — the stamp must not break the quote (#9940 review)', () => {
    // pr-context quotes every earlier comment containing code as
    // `> ``` …`; the skip classifies the marker's projected first line
    // through the blockquote prefix the pipeline's line model reads past,
    // or the insertion lands before the `>`, CommonMark parses neither
    // blockquote nor fence, and the finding posts as a garbled inline
    // code span instead of the quoted block the pre-stamp gate validated
    // (#9940 review, round 12).
    for (const draft of [
      '**[Critical]** > ```js\n> leaked()\n> ```\nthe claim',
      '**[Suggestion]** > ```diff\n> -old\n> +new\n> ```\n\nthe pin moved',
      '**[Critical]** > > ```js\n> > leaked()\n> > ```\nthe claim',
      // Render-nothing residue AFTER the quote prefix is invisible on
      // the quoted line, so the fence (or block opener) still opens it —
      // the ^-anchored opener tests read the raw comment bytes and
      // missed exactly this shape (#9940 review, round 17).
      '**[Critical]** > <!-- x -->```js\n> leaked()\n> ```\nthe claim',
      '**[Critical]** > <!-- x --><div>\n> foo\n\nthe claim',
    ]) {
      expect(stampCarriedId(draft, 'R3-1')).toBe(draft);
    }
    // A quoted fence that opens on line 2 is untouched by a line-1 stamp.
    expect(
      stampCarriedId(
        '**[Critical]** the claim\n> ```js\n> leaked()\n> ```',
        'R3-2',
      ),
    ).toBe('**[Critical]** R3-2: the claim\n> ```js\n> leaked()\n> ```');
  });

  it('leaves an HTML-block-opening body un-stamped — a stamp would break the opener (#9940 review)', () => {
    // The skip guards the marker's projected first line, and an
    // HTML-block opener (`<div>`, `</div>`, `<pre>`, …) is broken by the
    // insertion exactly like a fence delimiter: pre-stamp the opener
    // starts a blank-line-terminated HTML block that masks fence lines,
    // so the gate passes; the stamp demotes the opener to inline text,
    // the masked fence re-parses real and unclosed, and the appended
    // invisible marker posts inside it as visible code — the exact post
    // the gate's refusal message names. The exposure is attribution-off,
    // but the skip is attribution-blind like the fence one (#9940
    // review).
    for (const draft of [
      '**[Critical]** <div>\n```\nfoo\n</div>\nclaim',
      '**[Suggestion]** <details>\nthe log\n</details>',
    ]) {
      expect(stampCarriedId(draft, 'R5-3')).toBe(draft);
    }
    // An opener on line 2 is untouched by a line-1 stamp.
    expect(
      stampCarriedId('**[Critical]** the claim\n<div>\nfoo\n</div>', 'R5-4'),
    ).toBe('**[Critical]** R5-4: the claim\n<div>\nfoo\n</div>');
  });

  it('leaves a quoted HTML-block-opening body un-stamped (#9940 review)', () => {
    // The quote-prefixed sibling of the opener skip above: `> <div>`
    // demotes to inline raw HTML once the stamp lands before the `>` —
    // the same structural flip the bare-opener arm prevents (#9940
    // review, round 12).
    expect(
      stampCarriedId('**[Critical]** > <div>\n> foo\n\nthe claim', 'R5-3'),
    ).toBe('**[Critical]** > <div>\n> foo\n\nthe claim');
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

  it('stamps the bare-marker draft whose fence sits past a BARE CR (#9940 review)', () => {
    // The residue check models a line break the way the pipeline's line
    // model does — `scanLines`, the bare readback leg and the marker-less
    // presubmit readback all split on `/\r\n?|\n/` — so a bare CR
    // between marker and fence pushes the fence to rendered line 2
    // exactly like an LF, and the line-1 stamp cannot flip it. Testing
    // `\n` alone held the skip here: the draft posted un-stamped, its
    // root id-less and permanently unreachable — every later carry
    // opened a NEW thread, every `fixed` ruling resolved none of the
    // lineage (#9940 review).
    const draft = '**[Critical]**\r```diff\n-old\n+new\n```\nthe claim';
    const stamped = stampCarriedId(draft, 'R1-5');
    expect(stamped).toBe(
      '**[Critical]** R1-5: \r```diff\n-old\n+new\n```\nthe claim',
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
    // Real gh does not wrap the document once — it interleaves an SGR
    // pair around EVERY token of its pretty-printed JSON
    // (`ESC[1;38m{ESC[m ESC[1;34m"data"ESC[mESC[1;38m:ESC[m ...`), so
    // the fixture interleaves too: an anchored or wrapper-only strip
    // parses a wrapped document and still dies on the real shape
    // (#9940 review, round 14). Only the one global SGR sweep survives
    // this cell.
    const plain = page([node({})]);
    const coloured = plain.replace(
      /"(?:[^"\\]|\\.)*"|[{}[\],:]/g,
      (tok) => `\u001b[1;38m${tok}\u001b[m`,
    );
    ghMock.mockReturnValue(coloured);
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
      // The age sort's ONLY input — a mapping regressed to '' ties every
      // comparator and the newest-marked preference degenerates to array
      // order (#9940 review, round 14).
      rootCreatedAt: '2026-08-01T00:00:00Z',
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

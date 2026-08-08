/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_INLINE_ANGLES,
  MIN_INLINE_ANGLES,
  VERIFY_SHARD,
  budgetGapDisclosures,
  stripBudgetGapLines,
  launchToolBudget,
  reviewBudget,
} from './budget.js';

const budget = (srcDiffLines: number, diffLines = srcDiffLines) =>
  reviewBudget({ srcDiffLines, diffLines });

describe('reviewBudget — inline angles scale with what there is to see', () => {
  it('walks the floor of three on a trivial diff', () => {
    // The three that are always worth walking are defined by HOW they walk —
    // line-by-line, deleted lines, the language's own pitfalls — and each is
    // answerable on a diff of any size.
    expect(budget(9).inlineAngles).toBe(MIN_INLINE_ANGLES);
  });

  it('earns an angle per 60 source lines', () => {
    expect(budget(59).inlineAngles).toBe(3);
    expect(budget(60).inlineAngles).toBe(4);
    expect(budget(120).inlineAngles).toBe(5);
    expect(budget(180).inlineAngles).toBe(6);
  });

  it('caps at the six angles that exist', () => {
    // There is no seventh angle to unlock, so a huge diff must not ask for one.
    expect(budget(50_000).inlineAngles).toBe(MAX_INLINE_ANGLES);
  });

  it('counts source lines, not diff lines — tests must not buy angles', () => {
    // The same reasoning as the topology gate: a 40-line production change
    // shipping 900 lines of new tests is a small change.
    const mostlyTests = budget(40, 940);
    expect(mostlyTests.inlineAngles).toBe(4);
    expect(budget(940, 940).inlineAngles).toBe(MAX_INLINE_ANGLES);
  });

  it('still earns angles on a large all-prose diff, at a coarser rate', () => {
    // Prose carries less a reviewer can get wrong, not none — and three angles
    // over two thousand lines is the dilution this budget exists to avoid.
    expect(budget(0, 2000).inlineAngles).toBeGreaterThan(MIN_INLINE_ANGLES);
    // But a docs diff of the same size never reaches what its source-line
    // equivalent would.
    expect(budget(0, 2000).inlineAngles).toBeLessThanOrEqual(
      budget(2000, 2000).inlineAngles,
    );
  });
});

describe('reviewBudget — the sweep', () => {
  it('is skipped on a diff small enough to hold entirely in view', () => {
    expect(budget(10).sweep).toBe(false);
    expect(budget(24).sweep).toBe(false);
  });

  it('runs from 25 source lines up', () => {
    expect(budget(25).sweep).toBe(true);
    expect(budget(4000).sweep).toBe(true);
  });

  it('runs on a large diff that has no source lines at all', () => {
    expect(budget(0, 900).sweep).toBe(true);
  });
});

describe('reviewBudget — domain specialists', () => {
  it('are not available below the floor: 40 lines are usually all one thing', () => {
    // "One domain dominates the diff" is a judgement, and a judgement made about
    // forty lines finds a dominant domain every time.
    expect(budget(79).specialistCap).toBe(0);
  });

  it('are capped at two once the diff is big enough for dominance to mean something', () => {
    expect(budget(80).specialistCap).toBe(2);
    expect(budget(10_000).specialistCap).toBe(2);
  });

  it('read source lines only — a test-heavy diff does not unlock them', () => {
    expect(budget(20, 3000).specialistCap).toBe(0);
  });
});

describe('reviewBudget — the verify shard is flat', () => {
  it('does not move with diff size', () => {
    // It is a fact about how much a verifier can re-trace before its quality
    // collapses on the tail of its list — a property of the verifier, not of the
    // diff. It lives here so it has one home.
    expect(budget(5).verifyShard).toBe(VERIFY_SHARD);
    expect(budget(100_000).verifyShard).toBe(VERIFY_SHARD);
  });
});

describe('reviewBudget — garbled input fails toward the cheap end, never throws', () => {
  it.each([
    ['negative', -5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('treats a %s source count as zero', (_name, value) => {
    const b = reviewBudget({
      srcDiffLines: value,
      diffLines: value,
    });
    expect(b.inlineAngles).toBe(MIN_INLINE_ANGLES);
    expect(b.sweep).toBe(false);
    expect(b.specialistCap).toBe(0);
    // The floors are the MINIMUM work, not the maximum: a garbled input still
    // walks three angles and still verifies.
    expect(b.verifyShard).toBe(VERIFY_SHARD);
  });

  it('survives missing fields', () => {
    const b = reviewBudget({} as never);
    expect(b.inlineAngles).toBe(MIN_INLINE_ANGLES);
    expect(b.verifyShard).toBe(VERIFY_SHARD);
  });

  it('never returns a budget that reviews nothing', () => {
    for (const n of [0, 1, 7, 25, 80, 500, 5000]) {
      const b = budget(n);
      expect(b.inlineAngles).toBeGreaterThanOrEqual(MIN_INLINE_ANGLES);
      expect(b.verifyShard).toBeGreaterThan(0);
    }
  });
});

describe('reviewBudget — the agent tool budget', () => {
  it('floors at 30 on a small diff', () => {
    expect(
      reviewBudget({ srcDiffLines: 40, diffLines: 60 }).agentToolBudget,
    ).toBe(32);
    expect(
      reviewBudget({ srcDiffLines: 0, diffLines: 0 }).agentToolBudget,
    ).toBe(30);
  });

  it('earns a call per twenty effective lines', () => {
    expect(
      reviewBudget({ srcDiffLines: 300, diffLines: 400 }).agentToolBudget,
    ).toBe(45);
  });

  it('caps at 60 — a wanderer must not out-earn the ceiling', () => {
    expect(
      reviewBudget({ srcDiffLines: 5000, diffLines: 6000 }).agentToolBudget,
    ).toBe(60);
  });

  it('a large all-prose diff earns budget at the coarse effective rate', () => {
    // effective = max(src, total/8): prose still has lines to walk.
    expect(
      reviewBudget({ srcDiffLines: 0, diffLines: 3200 }).agentToolBudget,
    ).toBe(50);
  });
});

describe('launchToolBudget — the per-launch ceiling', () => {
  it('derives a scoped allowance from the territory, same rate and clamps', () => {
    expect(launchToolBudget(60, 0, 0)).toBe(30);
    expect(launchToolBudget(60, 217, 0)).toBe(40);
    expect(launchToolBudget(60, 5000, 0)).toBe(60);
  });

  it('never lets a territory raise a launch above the plan allowance', () => {
    // The plan's recorded number is the authority every launch answers to;
    // the scoped derivation may only lower it.
    expect(launchToolBudget(35, 5000, 0)).toBe(35);
    expect(launchToolBudget(42, 217, 0)).toBe(40);
  });

  it('a whole-diff launch (null territory) uses the plan allowance as-is', () => {
    expect(launchToolBudget(42, null, 0)).toBe(42);
  });

  it('clamps the plan value in both directions', () => {
    // A version-skewed or hand-edited plan carrying 0.5 or 100000 must not
    // become a three-call or a hundred-thousand-call brief.
    expect(launchToolBudget(0.5, null, 0)).toBe(30);
    expect(launchToolBudget(100_000, null, 0)).toBe(60);
    expect(launchToolBudget(100_000, 5000, 0)).toBe(60);
  });

  it('mandatory reads ride on top of the allowance, never inside it', () => {
    // The finding this pins: a whole-diff role on a 25,000-line diff is
    // ASSIGNED 63 chunk reads — a flat cap would be exhausted by the reading
    // list before any analysis began.
    expect(launchToolBudget(60, 25_000, 63)).toBe(60 + 63);
    expect(launchToolBudget(60, 100, 2)).toBe(35 + 2);
  });

  it('garbled inputs fail toward the floor, never throw', () => {
    expect(launchToolBudget(Number.NaN, Number.NaN, Number.NaN)).toBe(30);
    expect(launchToolBudget(-5, -40, -3)).toBe(30);
    expect(launchToolBudget(42, 100, Number.POSITIVE_INFINITY)).toBe(35);
  });

  it('caps the TOTAL — the reads term must not erase the clamped ceiling', () => {
    // The reads come from the same unchecked-cast plan as the allowance:
    // a garbled chars of 1e9 flowed through as a forty-thousand-call
    // brief while the same plan's inflated allowance was dutifully
    // clamped to 60. Legitimate reading lists stay untouched.
    expect(launchToolBudget(60, 400, 40_004)).toBe(200);
    expect(launchToolBudget(60, 25_000, 63)).toBe(123);
  });
});

describe('budgetGapDisclosures — the one parser of the disclosure format', () => {
  it('parses plain fixed-format lines', () => {
    expect(
      budgetGapDisclosures(
        'No issues found — walked it all.\n' +
          'Budget gap: callers of parseArgs outside packages/cli\n' +
          'Budget gap: the removed retry path',
      ),
    ).toEqual([
      'callers of parseArgs outside packages/cli',
      'the removed retry path',
    ]);
  });

  it('tolerates the markdown furniture an LLM writes its own lists in', () => {
    // A disclosure lost to a bullet point is unobservable: nothing
    // downstream can tell "no gaps" from "gaps we failed to parse". The
    // fullwidth colon is deliberate too — this skill's outputs are
    // bilingual, and Chinese prose uses `：`.
    for (const line of [
      '- Budget gap: the check',
      '* Budget gap: the check',
      '1. Budget gap: the check',
      '**Budget gap:** the check',
      '`Budget gap: the check`',
      'Budget gap：the check',
      // A zh-narrating agent's budget stop must be as visible as an
      // English one — the receipt regex next door accepts zh receipts.
      '预算缺口：the check',
      '预算不足: the check',
    ]) {
      expect(budgetGapDisclosures(line)).toEqual(['the check']);
    }
  });

  it('does not read a QUOTATION of the format as a use of it', () => {
    // This repo reviews its own PRs: an agent reviewing this very diff
    // quotes these strings out of the brief and the skill. Blockquotes,
    // fenced code and an unclosed code span are citations, not
    // disclosures — the same self-reference hazard transcripts.ts guards
    // for tool-call parsing.
    expect(
      budgetGapDisclosures('> Budget gap: the removed retry path in fetch-pr'),
    ).toEqual([]);
    expect(
      budgetGapDisclosures(
        '```\nBudget gap: inside a fence\n```\nafter the fence',
      ),
    ).toEqual([]);
    expect(
      budgetGapDisclosures(
        '- `Budget gap: <the check>`, which check-coverage parses out of the transcripts',
      ),
    ).toEqual([]);
  });

  it('requires the gap on the SAME line as its marker', () => {
    // A bare header used to capture the following line — turning an
    // explicit denial into a phantom disclosure and swallowing the first
    // item of a header-plus-list shape.
    expect(
      budgetGapDisclosures('Budget gap:\nNo further checks were cut short.'),
    ).toEqual([]);
    expect(
      budgetGapDisclosures('**Budget gap:**\n- item one\n- item two'),
    ).toEqual([]);
  });

  it('drops non-answers in any punctuation, not only bare tokens', () => {
    // `Budget gap: None.` is the agent saying it has nothing to disclose;
    // a phantom gap costs real rounds downstream (a chunk that never
    // retires, an Approve that discloses "None." under its LGTM).
    for (const line of [
      'Budget gap: <the check>',
      'Budget gap: none',
      'Budget gap: None.',
      'Budget gap: None (all checks completed)',
      'Budget gap: N/A - stayed under budget',
      'Budget gap: nothing skipped',
      'Budget gap: no gaps',
      'Budget gap:',
    ]) {
      expect(budgetGapDisclosures(line)).toEqual([]);
    }
  });

  it('folds duplicate disclosures into one gap', () => {
    // An agent commonly states its gap mid-return and restates it in the
    // closing summary — one gap, not two, and duplicates must not consume
    // the count cap either.
    expect(
      budgetGapDisclosures(
        'Budget gap: second-order callers\n' +
          'more prose\n' +
          'Budget gap: Second-order callers',
      ),
    ).toEqual(['second-order callers']);
  });

  it('sanitizes and caps what will reach a terminal and the posted body', () => {
    // C1 controls, the Unicode line separators and the bidi overrides are
    // as dangerous as C0 — and U+2028 must not silently truncate the gap.
    const laundered = budgetGapDisclosures(
      'Budget gap: first\u2028second \u009b\u202epart',
    )[0];
    expect(laundered).toBe('first second   part');
    const long = budgetGapDisclosures(`Budget gap: ${'a'.repeat(500)}`)[0];
    expect([...long].length).toBeLessThanOrEqual(161);
    const many = budgetGapDisclosures(
      Array.from({ length: 20 }, (_, i) => `Budget gap: check ${i}`).join('\n'),
    );
    expect(many).toHaveLength(8);
  });

  it('strips markdown wrappers only in pairs — never one side', () => {
    // A trailing-only strip turned balanced Markdown into an orphan
    // backtick that pairs with the next gap's on the joined line and
    // swallows the text between them.
    expect(budgetGapDisclosures('Budget gap: **trace the callers**')).toEqual([
      'trace the callers',
    ]);
    expect(budgetGapDisclosures('Budget gap: callers of `parseFoo`')).toEqual([
      'callers of `parseFoo`',
    ]);
  });

  it('stays linear on pathological inputs', () => {
    // The previous single multiline regex was measured at 5.8 s on 98 KB
    // of newlines — quadratic backtracking from every line start. The
    // line-based scan has no cross-line class to backtrack over.
    const pathological = '-\n'.repeat(49_000) + ' \n> - '.repeat(20_000);
    const t0 = performance.now();
    expect(budgetGapDisclosures(pathological)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe('stripBudgetGapLines — the receipt judged without its disclosures', () => {
  it('removes exactly the disclosure lines and keeps everything else', () => {
    expect(
      stripBudgetGapLines(
        'No new issues found — re-walked the territory.\n' +
          'Budget gap: the two remaining call-site traces\n' +
          'Everything else held.',
      ),
    ).toBe(
      'No new issues found — re-walked the territory.\nEverything else held.',
    );
  });

  it('leaves quotations of the format in place', () => {
    const text = '> Budget gap: quoted from the brief';
    expect(stripBudgetGapLines(text)).toBe(text);
  });
});

describe('reviewBudget — the budget survives the trip through the plan', () => {
  it('agentToolBudget is an enumerable field of the returned object', () => {
    // The plan is written with JSON.stringify(report); a field that were a
    // getter on a prototype, or added only under some inputs, would silently
    // vanish from the plan every consumer reads. Assert the runtime shape,
    // not just the type.
    const b = reviewBudget({ srcDiffLines: 10, diffLines: 10 });
    expect(Object.keys(b)).toContain('agentToolBudget');
    expect(
      (JSON.parse(JSON.stringify(b)) as Record<string, unknown>)[
        'agentToolBudget'
      ],
    ).toBe(30);
  });
});

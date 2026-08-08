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
  it('derives the allowance from the launch territory, same rate and clamps', () => {
    expect(launchToolBudget(0, 0)).toBe(30);
    expect(launchToolBudget(217, 0)).toBe(40);
    expect(launchToolBudget(5000, 0)).toBe(60);
  });

  it('mandatory reads ride on top of the allowance, never inside it', () => {
    // The finding this pins: a whole-diff role on a 25,000-line diff is
    // ASSIGNED 63 chunk reads — a flat cap would be exhausted by the reading
    // list before any analysis began.
    expect(launchToolBudget(25_000, 63)).toBe(60 + 63);
    expect(launchToolBudget(100, 2)).toBe(35 + 2);
  });

  it('garbled inputs fail toward the floor, never throw', () => {
    expect(launchToolBudget(Number.NaN, Number.NaN)).toBe(30);
    expect(launchToolBudget(-40, -3)).toBe(30);
    expect(launchToolBudget(100, Number.POSITIVE_INFINITY)).toBe(35);
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

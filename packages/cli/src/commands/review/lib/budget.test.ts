/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, expect, it } from 'vitest';
import {
  MAX_INLINE_ANGLES,
  MIN_INLINE_ANGLES,
  VERIFY_SHARD,
  budgetGapDisclosures,
  stripBudgetGapLines,
  launchToolBudget,
  reverseAuditRoundCap,
  reverseAuditRoundTier,
  cappedRoundTier,
  reviewBudget,
} from './budget.js';
import { expectWithinLatencyBudget } from '../../../test-utils/latency-budget.js';

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
    expect(budget(2999).specialistCap).toBe(2);
  });

  it('shed to zero on a huge diff — the marginal pass that tips it into a timeout', () => {
    // At/above the huge floor an Agent 8 whole-diff pass on top of the base
    // fan-out is what a too-big-to-finish review can least afford.
    expect(budget(3000).specialistCap).toBe(0);
    expect(budget(10_000).specialistCap).toBe(0);
  });

  it('read source lines only — a test-heavy diff does not unlock them', () => {
    expect(budget(20, 3000).specialistCap).toBe(0);
  });

  it('shed on a huge non-source diff — the gate keys on effective, not src', () => {
    // A docs/lockfile-dominated diff (small src, enormous total) is huge by the
    // effective measure, so Agent 8 sheds even though src alone clears the 80
    // floor. Pins `effective < HUGE_DIFF_FLOOR` against a slip back to `src`,
    // which would restore specialistCap: 2 in exactly the timeout band this
    // gate exists to shed it from.
    expect(
      reviewBudget({ srcDiffLines: 100, diffLines: 30_000 }).specialistCap,
    ).toBe(0);
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
      'Budget gap: (none — all planned checks completed)',
      'Budget gap: (None.)',
      'Budget gap: N/A - stayed under budget',
      'Budget gap: (N/A - stayed under budget)',
      'Budget gap: none — all planned checks completed',
      'Budget gap: nothing skipped',
      'Budget gap: no gaps',
      // The rest of the drop vocabulary, pinned — this regex is a live
      // edit site, and a narrowing that turns `no checks` into a phantom
      // gap must not ship green.
      'Budget gap: no checks',
      'Budget gap: nothing',
      'Budget gap: n/a',
      'Budget gap: none — planned checks completed',
      'Budget gap: none — every check covered',
      'Budget gap: none — everything completed',
      // The found / to-report non-answers, and inner paren padding.
      'Budget gap: none found',
      'Budget gap: nothing to report',
      'Budget gap: no gaps found',
      'Budget gap: none ( all checks completed)',
      'Budget gap:',
      // The trailing budget adverbial after the completion word — three of
      // these reached two posted bodies in one live round (2026-08-13,
      // PRs #9013/#9045) because the completion word was not final.
      'Budget gap: none — all checks above completed within budget.',
      'Budget gap: none — all checks I started were completed within budget.',
      'Budget gap: none — all checks my dimension defines were completed within budget.',
      'Budget gap: none — all planned checks done under the tool budget',
      'Budget gap: None (all checks completed within the tool-call budget)',
      // One vocabulary across the idiom family: `below` in the completion
      // tail, and the stayed idiom with the same qualifiers the tail takes —
      // including the space-separated `tool call` form the regex accepts.
      'Budget gap: none — all checks completed below budget.',
      'Budget gap: none — stayed inside budget.',
      'Budget gap: none — stayed under the tool budget',
      'Budget gap: none — stayed below the tool-call budget.',
      'Budget gap: none — all checks completed within the tool call budget.',
      'Budget gap: none — stayed within the tool call budget',
    ]) {
      expect(budgetGapDisclosures(line)).toEqual([]);
    }
  });

  it('drops the SAME non-answers written in Chinese', () => {
    // Measured on a live review of PR #9094 under `outputLanguage: 中文`: the
    // reverse-audit agent returned the first line below — "none — all checks
    // completed, the tool budget was NOT reached" — and the composed body
    // published `Not explored to full depth (tool budget reached)` quoting it.
    // The line DETECTOR was already bilingual; only this classifier was not.
    for (const line of [
      'Budget gap: 无 — 所有检查均完成，未触及工具预算上限。',
      '预算缺口：无 — 所有检查均完成，未触及工具预算上限。',
      'Budget gap: 无',
      'Budget gap: 无。',
      'Budget gap: 没有',
      'Budget gap: 不适用',
      'Budget gap: 暂无缺口',
      'Budget gap: 没有跳过的检查',
      'Budget gap: 无，所有计划内的检查均已完成',
      'Budget gap: 无 — 所有计划检查均已完成。',
      'Budget gap: (无 — 所有检查均完成)',
    ]) {
      expect(budgetGapDisclosures(line)).toEqual([]);
    }
  });

  it('keeps the REAL Chinese gaps the first cut of this branch swallowed', () => {
    // Probed on a live review of this very change (PR #9175, R1-1). Each line
    // is a real disclosure the unnarrowed branch classified as "nothing to
    // disclose", which is the direction that certifies depth nobody reached.
    for (const line of [
      // The lookbehinds see ONE character: the char before 完成 is 有.
      'Budget gap: 无 — 检查还没有完成',
      'Budget gap: 无 — 单元测试尚未完成',
      // A gap clause AFTER the completion word: the tail is a budget
      // adverbial, not forty free characters.
      'Budget gap: 无 — 安全检查完成，渗透测试未进行',
      'Budget gap: 无 — 所有单元测试完成，集成测试没有运行',
      // A gap clause BEFORE it: the completion clause must open with an
      // all-done head, exactly as the English branch requires.
      'Budget gap: 无 — 3 项未运行，其余完成',
      'Budget gap: 无 — 渗透测试失败，单元测试完成',
      'Budget gap: 无 — 除 Windows 矩阵外均已完成',
      'Budget gap: 无 — 所有检查均未完成',
    ]) {
      expect(budgetGapDisclosures(line)).toHaveLength(1);
    }
  });

  it('keeps every evasion two live review rounds found', () => {
    // Round 2 of the review on this change walked through the span-based
    // clause four different ways. The closed vocabulary answers all of them
    // structurally: a sentence carrying a gap is built from pieces the clause
    // does not contain, so it cannot match at all.
    for (const line of [
      // Inability modifiers the one-character lookbehind could not see.
      'Budget gap: 无 — 所有检查未能完成',
      'Budget gap: 无 — 所有检查没法完成',
      'Budget gap: 无 — 所有检查不能完成',
      'Budget gap: 无 — 所有检查难以完成',
      'Budget gap: 无 — 所有检查不曾完成',
      // A negation separated from the completion word by an adverbial.
      'Budget gap: 无 — 所有检查均未按时完成',
      // A hedged completion.
      'Budget gap: 无 — 所有检查基本完成',
      // The span sliding past a negated completion to a later affirmed one.
      'Budget gap: 无 — 集成测试未完成，单元测试完成',
      // A gap clause the span swallowed on either side of the completion word.
      'Budget gap: 无 — 3 项未运行，其余完成',
      'Budget gap: 无 — 安全检查完成，渗透测试未进行',
      'Budget gap: 无 — 所有单元测试完成，但集成测试没有运行',
      // A real gap that merely opens with the token's characters.
      'Budget gap: 无法验证 Windows 矩阵的集成测试',
      'Budget gap: 无障碍检查未运行',
      // "did not check" — a live gap the bare-noun token shape swallowed: the
      // brief mandates a Budget gap line ONLY when a check was cut short, so a
      // compliant agent writing these is asserting one.
      'Budget gap: 没有检查',
      'Budget gap: 无检查',
      'Budget gap: 暂无检查',
    ]) {
      expect(budgetGapDisclosures(line)).toHaveLength(1);
    }
  });

  it('still drops the real-world no-answer it was built for', () => {
    // The live sentence from PR #9094, plus the shapes a model actually
    // writes around it. These are the ONLY thing the clause may swallow.
    for (const line of [
      'Budget gap: 无 — 所有检查均完成，未触及工具预算上限。',
      'Budget gap: 无 —— 所有计划内的检查均已完成',
      'Budget gap: 无：全部检查均已完成',
      'Budget gap: 无，上述工作均已完成',
      'Budget gap: 暂无缺口',
      'Budget gap: 没有跳过的检查',
    ]) {
      expect(budgetGapDisclosures(line)).toEqual([]);
    }
  });

  it('strips full-width parens too — a CJK IME wraps the same no-answer', () => {
    // The strip knew only the ASCII pair, so `（无 — 所有检查均完成）`
    // survived as a phantom gap in exactly the output language the ZH
    // branch exists for — the #9094 incident shape, wearing the paren
    // form a Chinese keyboard produces by default.
    for (const line of [
      'Budget gap: （无 — 所有检查均完成）',
      'Budget gap: （无）',
      '预算缺口：（没有跳过的检查）',
    ]) {
      expect(budgetGapDisclosures(line)).toEqual([]);
    }
    // A wrapped placeholder's inner tail judges identically to the bare
    // form: bare `无？`/`无、` lose those tails to the fold-key strip before
    // the classifier sees them, so the wrapped forms drop too — identical
    // content cannot split bare-vs-wrapped.
    for (const line of ['Budget gap: （无？）', 'Budget gap: （无、）']) {
      expect(budgetGapDisclosures(line)).toEqual([]);
    }
    // Only a SYMMETRIC pair unwraps, and a real gap inside full-width
    // parens survives — over-disclosure is the safe direction.
    expect(
      budgetGapDisclosures('Budget gap: （无法验证 Windows 矩阵的集成测试）'),
    ).toEqual(['（无法验证 Windows 矩阵的集成测试）']);
  });

  it('closes the same split for ENGLISH no-answers wearing a CJK tail', () => {
    // The normalize strip (TRAILING_GAP_CHAR_RE) is bilingual, so bare
    // `none。` judges as `none` and drops — but a wrapped twin kept its
    // inner tail: the EN tail classes in PLACEHOLDER_GAP_RE are ASCII-only,
    // so `(none。)` survived as a phantom gap while its identical bare form
    // dropped. The exact bare-vs-wrapped split the test above closed for
    // the ZH branch, left open on the EN one — measured by the review on
    // this PR: under a CJK output language `Budget gap: (none。)` spends a
    // MAX_GAPS_PER_AGENT slot and an orchestrator ruling on a no-answer.
    // The inner text must judge character-for-character as its bare twin,
    // so the wrapped forms drop too — in both paren shapes.
    for (const line of [
      'Budget gap: none。',
      'Budget gap: (none。)',
      'Budget gap: （none。）',
      'Budget gap: none - stayed under budget。',
      'Budget gap: (none - stayed under budget。)',
      'Budget gap: (N/A - stayed under budget。)',
      'Budget gap: (none — all checks completed。)',
    ]) {
      expect(budgetGapDisclosures(line)).toEqual([]);
    }
    // A REAL gap keeps its CJK tail in both forms — the strip equalizes
    // judgment, never swallows.
    expect(budgetGapDisclosures('Budget gap: (渗透测试未进行。)')).toEqual([
      '(渗透测试未进行。)',
    ]);
  });

  it('folds a Chinese gap restated with and without a trailing full stop', () => {
    // The fold key promises one disclosure per gap; a key that stripped only
    // ASCII trailing punctuation kept `渗透测试未进行。` and `渗透测试未进行`
    // as two, double-spending MAX_GAPS_PER_AGENT slots.
    const text = [
      'Budget gap: 渗透测试未进行。',
      'some other line',
      'Budget gap: 渗透测试未进行',
    ].join('\n');
    expect(budgetGapDisclosures(text)).toEqual(['渗透测试未进行。']);

    // Both CJK full stops — 。(U+3002) and ．(U+FF0E) — are ZH_TAIL
    // characters, and the fold key must strip both: covering only one left
    // the double-spend open for the other.
    const ff0e = [
      'Budget gap: 渗透测试未进行．',
      'some other line',
      'Budget gap: 渗透测试未进行',
    ].join('\n');
    expect(budgetGapDisclosures(ff0e)).toEqual(['渗透测试未进行．']);
  });

  it('keeps a REAL Chinese gap — 无法 is a prefix of the token, not the token', () => {
    // Chinese has no word boundary, so a token is only a token when
    // punctuation, whitespace or end-of-text follows it. `无法验证…`
    // ("unable to verify…") is the exact failure this guard exists for:
    // dropping it would certify work that never happened.
    expect(
      budgetGapDisclosures('Budget gap: 无法验证 Windows 矩阵的集成测试'),
    ).toEqual(['无法验证 Windows 矩阵的集成测试']);
    // A completion clause that is negated, or that carves out an exception,
    // is a real gap in either language.
    expect(budgetGapDisclosures('Budget gap: 无 — 所有检查均未完成')).toEqual([
      '无 — 所有检查均未完成',
    ]);
    expect(
      budgetGapDisclosures('Budget gap: 无 — 除 Windows 矩阵外均已完成'),
    ).toEqual(['无 — 除 Windows 矩阵外均已完成']);
    expect(budgetGapDisclosures('Budget gap: 无障碍检查未运行')).toEqual([
      '无障碍检查未运行',
    ]);
  });

  it('keeps a REAL gap in parentheses — the paren strip fires only for placeholders', () => {
    // The strip exists for `(none — all planned checks completed)`; a
    // genuine parenthesized disclosure must survive it …
    expect(budgetGapDisclosures('Budget gap: (chunk 2 unfetchable)')).toEqual([
      '(chunk 2 unfetchable)',
    ]);
    // … including the ones that merely START with a placeholder token: the
    // greedy leading-token class swallows them otherwise, certifying work
    // that never happened.
    for (const gap of [
      '(none of the chunk-2 checks ran — the runner died)',
      '(N/A — the Windows runner was unavailable)',
      '(no checks ran on Windows — runner unavailable)',
    ]) {
      expect(budgetGapDisclosures(`Budget gap: ${gap}`)).toEqual([gap]);
    }
    // A completion HEAD is not a completion: these merely continue with
    // an "all done" word. Dropping them certifies work that never
    // happened — the exact failure the paren strip exists to kill.
    for (const gap of [
      '(no checks — all deferred to follow-up)',
      '(nothing — every check crashed)',
      '(none — all 5 Windows checks failed to start)',
      '(none — all planned checks completed except the Windows matrix)',
    ]) {
      expect(budgetGapDisclosures(`Budget gap: ${gap}`)).toEqual([gap]);
    }
    // … and inner text merely STARTING with the template/dash shapes is
    // not a template or a dash run — the classifier is anchored, never
    // prefix-matching.
    for (const gap of [
      '(<integration tests on Windows> runner unavailable)',
      '(- second-order callers untested)',
      '(* flaky reruns pending)',
    ]) {
      expect(budgetGapDisclosures(`Budget gap: ${gap}`)).toEqual([gap]);
    }
  });

  it('keeps a REAL gap bare too — one strict judgment for both forms', () => {
    // The identical gaps without parentheses are the brief's canonical
    // form; they must survive the same strict shapes, not fall to a
    // greedier bare-path class.
    for (const gap of [
      'none of the chunk-2 checks ran — the runner died',
      'N/A — the Windows runner was unavailable',
      'no checks ran on Windows — runner unavailable',
      'no checks — all deferred to follow-up',
      'nothing — every check crashed',
      'none — all 5 Windows checks failed to start',
      'none — all planned checks completed except the Windows matrix',
      // The budget adverbial is end-anchored like its siblings: a clause
      // continuing past it discloses skipped work — in both branch forms.
      'none — all checks completed within budget, but the Windows matrix never ran',
      'None (all checks completed within the tool-call budget, but the Windows matrix never ran)',
      '<integration tests on Windows> runner unavailable',
    ]) {
      expect(budgetGapDisclosures(`Budget gap: ${gap}`)).toEqual([gap]);
    }
  });

  it('keeps the stayed / negated-completion / exception shapes — real gaps that brush the idioms', () => {
    for (const gap of [
      // The stayed idiom is end-anchored: text continuing past `budget`
      // discloses skipped work, and `stayed` heading somewhere else
      // entirely is no completion at all.
      'N/A - stayed under budget, but the Windows matrix never ran',
      'no checks — stayed queued behind the runner outage',
      'none — stayed under budget but skipped the Windows matrix',
      // A completion word that is NEGATED is a failure report ending in
      // "completed", not completion.
      'none — all checks crashed, none completed',
      'no checks — all deferred, nothing finished',
      // An exception quantifier between head and completion word restricts
      // the claim — `all but X completed` names the X that was not.
      'none — all but the Windows checks completed',
      'none — all but one check completed',
    ]) {
      expect(budgetGapDisclosures(`Budget gap: ${gap}`)).toEqual([gap]);
      expect(budgetGapDisclosures(`Budget gap: (${gap})`)).toEqual([
        `(${gap})`,
      ]);
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
    // … whether or not the restatement wraps the gap in parentheses …
    expect(
      budgetGapDisclosures(
        'Budget gap: auth flow untested\n' + 'Budget gap: (auth flow untested)',
      ),
    ).toEqual(['auth flow untested']);
    // … and the fold survives sentence punctuation INSIDE the parens —
    // a parenthesized sentence naturally ends in a period.
    expect(
      budgetGapDisclosures(
        'Budget gap: (auth flow untested.)\n' +
          'Budget gap: auth flow untested',
      ),
    ).toEqual(['(auth flow untested.)']);
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
    const pathological =
      '-\n'.repeat(49_000) + ' \n> - '.repeat(20_000) + ' '.repeat(40_000);
    const t0 = performance.now();
    expect(budgetGapDisclosures(pathological)).toEqual([]);
    expectWithinLatencyBudget(performance.now() - t0, 1000, {
      poolMultiplier: 20,
    });
    // The placeholder classifier's own hazard shape — a token followed by
    // a long whitespace run — must stay linear too; it was measured
    // quadratic (seconds at 40k spaces) when its quantifiers overlapped.
    const spaced = `Budget gap: (none${' '.repeat(160_000)}x)`;
    const t1 = performance.now();
    expect(budgetGapDisclosures(spaced)).toHaveLength(1);
    expectWithinLatencyBudget(performance.now() - t1, 1000, {
      poolMultiplier: 20,
    });
    // The line matcher's own hazard shape — a long indentation run on a
    // line that is NOT a disclosure. The pre-rewrite matcher's overlapping
    // `[ \t]*` pair backtracked quadratically here (seconds at 40k tabs);
    // the disclosure on the line above pins that a real gap still parses
    // out of the same text.
    const indented = `Budget gap: ok\n${'\t'.repeat(40_000)}not a gap line`;
    const t2 = performance.now();
    expect(budgetGapDisclosures(indented)).toEqual(['ok']);
    expectWithinLatencyBudget(performance.now() - t2, 1000, {
      poolMultiplier: 20,
    });
    // The Chinese clause's own hazard shape: a token, a separator, then a long
    // run that never reaches a completion word. Its first cut chained four
    // optional groups across `\s*` — the overlapping shape this test exists
    // for — and this input is what walks it.
    const zhPathological = `Budget gap: 无 — ${'检查 '.repeat(20_000)}`;
    const t3 = performance.now();
    expect(budgetGapDisclosures(zhPathological)).toHaveLength(1);
    expectWithinLatencyBudget(performance.now() - t3, 1000, {
      poolMultiplier: 20,
    });
    // And a deep-indented bullet disclosure still matches — the leading
    // whitespace lives inside the optional bullet group, not beside it.
    expect(
      budgetGapDisclosures(`${'\t'.repeat(4000)}- Budget gap: the check`),
    ).toEqual(['the check']);
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

describe('reviewBudget — the reverse-audit round cap', () => {
  it('gives each topology its own cap: ten on 3A, five on 3B, three when huge (with a clock)', () => {
    // The cap prices a ROUND, and a round costs two orders of magnitude more
    // in one topology than another: one auditor on 3A, one per non-retired
    // chunk on 3B, ~90 min on a huge PR (five of which cannot finish the PRs
    // that timed out to zero). Hence three tiers rather than one number —
    // ten on 3A because the marginal round there is a single agent on a diff
    // small enough to hold in one context, three when huge because that is
    // one audit round above the convergence floor of two (the all-dry
    // rounds-1-and-2 shape converges under any cap of two or more).
    expect(
      reviewBudget({ srcDiffLines: 100, diffLines: 100 }).reverseAuditRounds,
    ).toBe(10);
    expect(
      reviewBudget({ srcDiffLines: 2999, diffLines: 2999 }).reverseAuditRounds,
    ).toBe(5);
    expect(
      reviewBudget(
        { srcDiffLines: 3000, diffLines: 3000 },
        { hasDeadline: true },
      ).reverseAuditRounds,
    ).toBe(3);
    expect(
      reviewBudget(
        { srcDiffLines: 10_000, diffLines: 12_000 },
        { hasDeadline: true },
      ).reverseAuditRounds,
    ).toBe(3);
  });

  it('switches tiers on the topology gate, not on a second set of numbers', () => {
    // The 3A/3B boundary is `isTerritoryFanOut`'s — src ≤ 500 AND total ≤
    // 3200 — and this is what pins that the cap reads that predicate rather
    // than a copy of its constants that could drift from it. Both clauses:
    // either one crossing moves the plan to the 3B cap.
    expect(
      reviewBudget({ srcDiffLines: 500, diffLines: 3200 }).reverseAuditRounds,
    ).toBe(10);
    expect(
      reviewBudget({ srcDiffLines: 501, diffLines: 3200 }).reverseAuditRounds,
    ).toBe(5);
    expect(
      reviewBudget({ srcDiffLines: 500, diffLines: 3201 }).reverseAuditRounds,
    ).toBe(5);
    // …and the huge floor wins over the topology gate: a 3B diff at 3000
    // effective lines caps at three, not five.
    expect(
      reviewBudget(
        { srcDiffLines: 3000, diffLines: 3200 },
        { hasDeadline: true },
      ).reverseAuditRounds,
    ).toBe(3);
  });

  it('keys on effective lines, not raw source — a huge lockfile diff caps too', () => {
    // effective = max(src, floor(total/8)); a mostly-generated 30,000-line
    // diff with little source still costs a huge reverse audit to re-read.
    // Pins the `effective`-vs-`src` dependence the mutation `effective` →
    // `src` would otherwise survive.
    expect(
      reviewBudget(
        { srcDiffLines: 100, diffLines: 30_000 },
        { hasDeadline: true },
      ).reverseAuditRounds,
    ).toBe(3);
    expect(reviewBudget({ srcDiffLines: 100, diffLines: 30_000 }).sweep).toBe(
      true,
    );
  });

  it('never drops below the convergence minimum', () => {
    for (const n of [0, 1, 50, 3000, 100_000]) {
      expect(
        reviewBudget({ srcDiffLines: n, diffLines: n }).reverseAuditRounds,
      ).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('reverseAuditRoundCap — the one reader of the plan field', () => {
  const SMALL = { srcDiffLines: 100, diffLines: 100 };
  const LARGE = { srcDiffLines: 600, diffLines: 1000 };
  const HUGE = { srcDiffLines: 5000, diffLines: 5000 };

  it('passes a value the plan owns through, at every tier', () => {
    expect(
      reverseAuditRoundCap(
        { ...SMALL, budget: { reverseAuditRounds: 10 } },
        true,
      ),
    ).toBe(10);
    expect(
      reverseAuditRoundCap(
        { ...LARGE, budget: { reverseAuditRounds: 5 } },
        true,
      ),
    ).toBe(5);
    expect(
      reverseAuditRoundCap(
        { ...HUGE, budget: { reverseAuditRounds: 3 } },
        true,
      ),
    ).toBe(3);
    // Below its tier but in band is honoured — nothing here inflates a cap
    // the plan itself wrote smaller.
    expect(
      reverseAuditRoundCap(
        { ...SMALL, budget: { reverseAuditRounds: 5 } },
        true,
      ),
    ).toBe(5);
  });

  it('honours a stored value in the INTERIOR of the tier-relative band', () => {
    // Every other case here sits on a boundary — at the floor, at the tier, or
    // outside — and a boundary-only suite cannot tell a tier-relative bound
    // from a constant one: mutating `v <= tier` to `v <= LARGE_…ROUNDS` passed
    // all 57 tests before these three. The interior is where the two differ.
    expect(
      reverseAuditRoundCap(
        { ...SMALL, budget: { reverseAuditRounds: 7 } },
        true,
      ),
    ).toBe(7);
    expect(
      reverseAuditRoundCap(
        { ...LARGE, budget: { reverseAuditRounds: 4 } },
        true,
      ),
    ).toBe(4);
    // The same mutation read from the other side: a constant bound of five
    // would hand a HUGE plan the four rounds it stores, past the finishability
    // tier that is the whole reason that tier exists.
    expect(
      reverseAuditRoundCap(
        { ...HUGE, budget: { reverseAuditRounds: 4 } },
        true,
      ),
    ).toBe(3);
  });

  it('clamps to the plan’s own tier, so a hand edit cannot cross topologies', () => {
    // The field is CLI-written and nothing here is the caller's to override.
    // The first two are what distinguish a tier clamp from a single global
    // bound of ten, which would have honoured both; the third (11 on a SMALL
    // plan) is clamped either way and is here for the upper edge, not for the
    // comparison.
    expect(
      reverseAuditRoundCap(
        { ...HUGE, budget: { reverseAuditRounds: 10 } },
        true,
      ),
    ).toBe(3);
    expect(
      reverseAuditRoundCap(
        { ...LARGE, budget: { reverseAuditRounds: 10 } },
        true,
      ),
    ).toBe(5);
    expect(
      reverseAuditRoundCap(
        { ...SMALL, budget: { reverseAuditRounds: 11 } },
        true,
      ),
    ).toBe(10);
  });

  it('reads absent, out-of-band and garbled values as the tier', () => {
    // The range is floored at HUGE_REVERSE_AUDIT_ROUNDS (3) — the smallest
    // cap the CLI writes — so 1 and 2 read as the tier, not as themselves.
    // Not because either always forces a non-converged stop: an all-dry loop
    // DOES converge under a cap of two, since the convergence check runs
    // before the cap gate. One cannot converge at all (it refuses the pair's
    // second member), and two leaves no round for a loop that reports
    // anything — so neither buys a cheaper review, only a capped verdict.
    for (const bad of [0, 1, 2, 2.5, '1', null] as unknown[]) {
      expect(
        reverseAuditRoundCap(
          { ...SMALL, budget: { reverseAuditRounds: bad } },
          true,
        ),
      ).toBe(10);
      expect(
        reverseAuditRoundCap(
          { ...HUGE, budget: { reverseAuditRounds: bad } },
          true,
        ),
      ).toBe(3);
    }
    // A plan with no `reverseAuditRounds` at all reads as its tier. A plan
    // that HAS one in band keeps it — see the legacy-value test below.
    expect(reverseAuditRoundCap(SMALL, true)).toBe(10);
    expect(reverseAuditRoundCap({ ...SMALL, budget: {} }, true)).toBe(10);
    expect(reverseAuditRoundCap(HUGE, true)).toBe(3);
  });

  it('rejects an in-band NON-INTEGER — the only guard that can catch it', () => {
    // 2.5 above is rejected by the integer guard itself (the chain tests
    // `Number.isInteger` before the `>= 3` floor), so it says nothing about
    // what the floor would have caught on its own: delete the integer guard
    // and 2.5 still falls to the floor, leaving the suite green while
    // `reverseAuditRounds: 3.5` becomes a cap of 3.5. These values sit inside
    // every tier's band and above the floor, so the integer check is the ONLY
    // thing between them and a fractional round cap.
    expect(
      reverseAuditRoundCap(
        { ...SMALL, budget: { reverseAuditRounds: 3.5 } },
        true,
      ),
    ).toBe(10);
    expect(
      reverseAuditRoundCap(
        { ...LARGE, budget: { reverseAuditRounds: 4.5 } },
        true,
      ),
    ).toBe(5);
  });

  it('honours a legacy in-band value instead of migrating it to the tier', () => {
    // A CLI that predates tiering wrote 5, and 5 is inside a 3A plan's [3, 10]
    // band. The plan states a number; a reader of a CLI-written field does not
    // get to override it. Only an absent or out-of-band value reaches the tier
    // — pinning the claim the doc comment used to get wrong in the other
    // direction ("a legacy 3A plan gets the ten rounds its topology earns").
    expect(
      reverseAuditRoundCap(
        { ...SMALL, budget: { reverseAuditRounds: 5 } },
        true,
      ),
    ).toBe(5);
    expect(
      reverseAuditRoundCap(
        { ...SMALL, budget: { reverseAuditRounds: 3 } },
        true,
      ),
    ).toBe(3);
  });

  it('treats a COERCIBLE garbage size as unsized, not as a zero-line diff', () => {
    // `Number()` turns each of these into a finite number, so a coerce-then-
    // isFinite check calls them all usable and sizes the plan from a value it
    // never received. `null`, `''`, `false` and `[]` coerce to 0 and land on
    // the SMALL tier — ten rounds, the most expensive cap — for a plan whose
    // size is not known; `-5` lands there too once floored; `'1'` and
    // `'3000'` coerce to real counts and are sized as though a string were a
    // line count, `'3000'` reaching the HUGE tier rather than the fallback.
    // `JSON.stringify` writes a NaN line count as `null`, so the first shape
    // is the one a corrupted plan actually arrives in.
    for (const bad of [null, '', false, [], -5, '1', '3000'] as unknown[]) {
      expect(
        reverseAuditRoundCap({ srcDiffLines: bad, diffLines: bad }, true),
      ).toBe(5);
      // …including when only ONE of the pair is garbage.
      expect(
        reverseAuditRoundCap({ srcDiffLines: 100, diffLines: bad }, true),
      ).toBe(5);
      expect(
        reverseAuditRoundCap({ srcDiffLines: bad, diffLines: 100 }, true),
      ).toBe(5);
    }
    // A numeric-string size must not buy a tier a hand edit could not: "1"
    // would otherwise coerce a 5,800-line plan into the SMALL tier through
    // the very clamp that exists to stop it.
    expect(
      reverseAuditRoundCap(
        {
          srcDiffLines: '1',
          diffLines: '1',
          budget: { reverseAuditRounds: 10 },
        },
        true,
      ),
    ).toBe(5);
    // Zero is a real size — an empty diff is a small diff, not an unsized one.
    expect(reverseAuditRoundCap({ srcDiffLines: 0, diffLines: 0 }, true)).toBe(
      10,
    );
  });

  it('does not let reviewBudget RECORD a tier for a size it never received', () => {
    // The write path is the other half: `sane()` launders garbage into 0, and
    // 0 is a perfectly good small diff, so sizing the tier from the saned pair
    // persisted ten rounds into the plan where the flat cap persisted five.
    for (const bad of [Number.NaN, -5, Number.POSITIVE_INFINITY]) {
      expect(
        reviewBudget({ srcDiffLines: bad, diffLines: bad }).reverseAuditRounds,
      ).toBe(5);
    }
    expect(reviewBudget({} as never).reverseAuditRounds).toBe(5);
    // …while a genuinely empty diff still records the small tier.
    expect(
      reviewBudget({ srcDiffLines: 0, diffLines: 0 }).reverseAuditRounds,
    ).toBe(10);
  });

  it('reads a plan with no usable size as the large tier — today’s value', () => {
    // The skew case cannot be sized, and an unsized plan could be the
    // 5,800-line one. Falling back to the large tier means such a plan is
    // never handed MORE rounds than every plan already runs with.
    expect(reverseAuditRoundCap(undefined, true)).toBe(5);
    expect(reverseAuditRoundCap({}, true)).toBe(5);
    expect(
      reverseAuditRoundCap({ budget: { reverseAuditRounds: 10 } }, true),
    ).toBe(5);
    expect(
      reverseAuditRoundCap(
        {
          srcDiffLines: 'x',
          diffLines: 10,
          budget: { reverseAuditRounds: 10 },
        },
        true,
      ),
    ).toBe(5);
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
    expect(Object.keys(b)).toContain('reverseAuditRounds');
    expect(
      (JSON.parse(JSON.stringify(b)) as Record<string, unknown>)[
        'agentToolBudget'
      ],
    ).toBe(30);
  });
});

describe('cappedRoundTier — the operator ceiling may only lower a tier', () => {
  const SMALL = { srcDiffLines: 100, diffLines: 100 };
  const LARGE = { srcDiffLines: 600, diffLines: 1000 };
  const HUGE = { srcDiffLines: 5000, diffLines: 5000 };

  it('lowers each tier to what the operator asked for', () => {
    expect(cappedRoundTier(SMALL, 4, true)).toBe(4);
    expect(cappedRoundTier(SMALL, 3, true)).toBe(3);
    expect(cappedRoundTier(LARGE, 3, true)).toBe(3);
    expect(cappedRoundTier(SMALL, 9, true)).toBe(9);
  });

  it('REFUSES to raise any tier — the asymmetry is the whole knob', () => {
    // A single operator-chosen count is what tiering removed: it is wrong for
    // at least one topology, and most wrong for the one whose cap exists to
    // stop six-hour reviews that post nothing. 20 buys nothing anywhere.
    expect(cappedRoundTier(HUGE, 5, true)).toBe(3);
    expect(cappedRoundTier(HUGE, 20, true)).toBe(3);
    expect(cappedRoundTier(LARGE, 10, true)).toBe(5);
    expect(cappedRoundTier(SMALL, 20, true)).toBe(10);
    // Equal to the tier is not a lowering either — it changes nothing, and
    // reading it as "honoured" would make a later tier change silently pinned
    // to a number the operator picked against a different tier.
    expect(cappedRoundTier(SMALL, 10, true)).toBe(10);
  });

  it('refuses a ceiling below the convergence minimum', () => {
    // Neither one nor two buys a cheaper review, though not for the same
    // reason: one refuses the convergence pair's second member so the loop can
    // never reach two dry audits, while two lets an all-dry loop converge (the
    // convergence check runs before the cap gate) but leaves no round for a
    // loop that reports anything. Both end in a capped verdict.
    for (const bad of [0, 1, 2, -3]) {
      expect(cappedRoundTier(SMALL, bad, true)).toBe(10);
      expect(cappedRoundTier(HUGE, bad, true)).toBe(3);
    }
  });

  it('ignores a ceiling that is not a whole number', () => {
    for (const bad of [3.5, Number.NaN, Number.POSITIVE_INFINITY] as number[]) {
      expect(cappedRoundTier(SMALL, bad, true)).toBe(10);
    }
    expect(cappedRoundTier(SMALL, undefined, true)).toBe(10);
  });

  it('lowers what reviewBudget RECORDS, so every reader sees one number', () => {
    // The setting has to reach the plan, not the gate: `reverseAuditRoundCap`
    // clamps a stored value into the tier band, and a lowered value is inside
    // it, so the reader honours it with no knowledge of the setting at all.
    const b = reviewBudget(
      { srcDiffLines: 100, diffLines: 100 },
      { operatorRoundCap: 4 },
    );
    expect(b.reverseAuditRounds).toBe(4);
    expect(reverseAuditRoundCap({ ...SMALL, budget: b }, true)).toBe(4);
    // …and an unset ceiling records the tier, exactly as before this setting.
    expect(
      reviewBudget({ srcDiffLines: 100, diffLines: 100 }).reverseAuditRounds,
    ).toBe(10);
  });

  it('does not let the ceiling touch any other budget field', () => {
    const plain = reviewBudget({ srcDiffLines: 900, diffLines: 900 });
    const capped = reviewBudget(
      { srcDiffLines: 900, diffLines: 900 },
      { operatorRoundCap: 3 },
    );
    expect({ ...capped, reverseAuditRounds: 0 }).toEqual({
      ...plain,
      reverseAuditRounds: 0,
    });
  });
});

describe('the huge reduction applies only where there is a wall to fit inside', () => {
  const HUGE = { srcDiffLines: 5000, diffLines: 5000 };
  const LARGE = { srcDiffLines: 900, diffLines: 900 };
  const SMALL = { srcDiffLines: 100, diffLines: 100 };

  it('a huge diff with no deadline is just a large 3B diff', () => {
    // Three is not a claim that a huge diff converges sooner — it has more
    // defects and more territory, and on recall it deserves MORE rounds. It is
    // a claim that five ~90-minute rounds do not fit a six-hour ceiling. With
    // no ceiling the premise is absent, and trading recall away to fit a wall
    // that is not there is a pure loss on exactly the tier where recall
    // matters most.
    expect(reverseAuditRoundTier(HUGE, false)).toBe(5);
    expect(reverseAuditRoundTier(HUGE, true)).toBe(3);
    expect(reviewBudget(HUGE, { hasDeadline: false }).reverseAuditRounds).toBe(
      5,
    );
    expect(reviewBudget(HUGE).reverseAuditRounds).toBe(5); // absent === no clock
  });

  it('changes nothing for any other topology — this is the huge tier’s rule alone', () => {
    for (const clock of [true, false]) {
      expect(reverseAuditRoundTier(SMALL, clock)).toBe(10);
      expect(reverseAuditRoundTier(LARGE, clock)).toBe(5);
    }
    // …including the unsized fallback, which is the large tier either way.
    expect(reverseAuditRoundTier({}, true)).toBe(5);
    expect(reverseAuditRoundTier({}, false)).toBe(5);
  });

  it('the operator ceiling still only lowers, on both sides of the clock', () => {
    // Without a clock the huge tier is 5, so an operator asking for 4 now gets
    // it — the ceiling composes with the wider tier rather than being masked
    // by the reduction.
    expect(cappedRoundTier(HUGE, 4, false)).toBe(4);
    expect(cappedRoundTier(HUGE, 4, true)).toBe(3); // 4 >= tier 3: no raise
    expect(cappedRoundTier(HUGE, 20, false)).toBe(5);
    expect(cappedRoundTier(HUGE, 2, false)).toBe(5); // below the floor
  });

  it('the reader clamps a recorded value against the tier IT sees', () => {
    // The four clock combinations across capture and gate, all safe. A plan
    // captured without a clock records 5; read under a clock the band is
    // [3, 3] and it is cut to 3 — conservative, which is the right direction
    // when a wall turns out to exist after all.
    const noClock = { ...HUGE, budget: { reverseAuditRounds: 5 } };
    expect(reverseAuditRoundCap(noClock, false)).toBe(5);
    expect(reverseAuditRoundCap(noClock, true)).toBe(3);
    const withClock = { ...HUGE, budget: { reverseAuditRounds: 3 } };
    expect(reverseAuditRoundCap(withClock, true)).toBe(3);
    expect(reverseAuditRoundCap(withClock, false)).toBe(3); // in [3,5], honoured
  });
});

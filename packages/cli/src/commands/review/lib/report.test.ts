/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { buildDiffPlan } from './diff-plan.js';
import { buildPlanReport, stringifyPlanReport } from './report.js';
import { makeDiff } from './test-utils.js';

/** A diff that edits an existing file: `ctx` context lines then `add` new ones. */
function editFile(path: string, ctx: number, add: number): string {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${ctx} +1,${ctx + add} @@`,
    ...Array.from({ length: ctx }, (_, i) => ` old ${i}`),
    ...Array.from({ length: add }, (_, i) => `+new ${i}`),
    '',
  ].join('\n');
}

/**
 * Plan and report over ONE diff text.
 *
 * `buildPlanReport` now records what its plan was computed from (see
 * lib/selection.ts), so the text has to reach both halves. Threading it through
 * a single parameter is what keeps these tests unable to describe a plan with
 * another plan's identity — the confusion the recorded identity exists to catch
 * in production.
 */
function planReportOf(
  diff: string,
  postImageLines: ((p: string) => number) | null,
) {
  return buildPlanReport(buildDiffPlan(diff, 400), postImageLines, {}, diff);
}

describe('buildPlanReport', () => {
  it('resolves the post-image through the injected dependency', () => {
    const asked: string[] = [];
    const report = planReportOf(editFile('src/a.ts', 3, 2), (p) => {
      asked.push(p);
      return 1000;
    });
    expect(asked).toEqual(['src/a.ts']);
    expect(report.files[0].fileLines).toBe(1000);
    // pre = post - added + removed
    expect(report.files[0].preLines).toBe(998);
  });

  it('flags a heavy file, using the injected line count', () => {
    // 900 added lines into a file that ends up 1 000 long: it existed at 100
    // lines, so it is not "large enough before" — not heavy.
    const diff = editFile('src/a.ts', 3, 900);
    expect(planReportOf(diff, () => 1000).files[0].heavy).toBe(false);
    // Same change into a file that ends up 6 000 long: it existed at 5 100,
    // and 900 changed lines clears the volume threshold.
    expect(planReportOf(diff, () => 6000).files[0].heavy).toBe(true);
  });

  it('treats a null resolver as "no tree to read", so nothing is heavy', () => {
    // `plan-diff` has a bare diff file and no ref. It must not guess.
    const report = planReportOf(makeDiff('src/big.ts', 2000), null);
    expect(report.files[0].fileLines).toBe(0);
    expect(report.files[0].preLines).toBe(0);
    expect(report.files[0].heavy).toBe(false);
    expect(report.files[0].addedRanges).toBeUndefined();
  });

  it('never asks the resolver about a binary file', () => {
    const diff = [
      'diff --git a/logo.png b/logo.png',
      'index 1111111..2222222 100644',
      'Binary files a/logo.png and b/logo.png differ',
    ].join('\n');
    const asked: string[] = [];
    const report = planReportOf(diff, (p) => {
      asked.push(p);
      return 500;
    });
    expect(asked).toEqual([]);
    expect(report.files[0].binary).toBe(true);
    expect(report.files[0].heavy).toBe(false);
  });

  it('carries the wrapper signal through — the 1e roster gate reads the report, not the diff', () => {
    // All three capture commands spread `buildPlanReport`, so the field the
    // diff parser computed rides into every plan the roster can read.
    expect(planReportOf(editFile('src/a.ts', 3, 2), null).wrapperSignal).toBe(
      false,
    );
    expect(
      planReportOf(makeDiff('src/caching-layer.ts', 20), null).wrapperSignal,
    ).toBe(true);
  });

  it('emits addedRanges only on heavy files', () => {
    const diff =
      editFile('src/heavy.ts', 3, 900) + makeDiff('src/light.ts', 20);
    const report = planReportOf(diff, (p) =>
      p === 'src/heavy.ts' ? 6000 : 30,
    );
    const heavy = report.files.find((f) => f.path === 'src/heavy.ts')!;
    const light = report.files.find((f) => f.path === 'src/light.ts')!;
    expect(heavy.heavy).toBe(true);
    expect(heavy.addedRanges).toBeDefined();
    expect(light.heavy).toBe(false);
    expect(light.addedRanges).toBeUndefined();
  });

  it('omits pure-deletion hunks from the anchorable ranges', () => {
    // Nothing can be anchored on the right side of a `+N,0` hunk; offering it
    // to Step 7 earns a 422 that sinks the whole review.
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,2 @@',
      ' keep',
      '+added',
      '@@ -10,2 +11,0 @@',
      '-gone1',
      '-gone2',
      '',
    ].join('\n');
    const report = planReportOf(diff, () => 100);
    expect(report.files[0].hunks).toEqual([{ newStart: 1, newEnd: 2 }]);
  });

  it('gives a heavy file its own diff range, so deletions are visible', () => {
    // An invariant agent reads the post-change file, where a removed
    // `clearTimeout()` leaves nothing behind. This range points it at the `-`
    // lines that are the only evidence the call ever existed.
    const diff = editFile('src/heavy.ts', 3, 900);
    const report = planReportOf(diff, () => 6000);
    const f = report.files[0];
    expect(f.heavy).toBe(true);
    expect(f.diffRange).toEqual({
      startLine: 1,
      endLine: diff.trimEnd().split('\n').length,
    });
  });

  it('withholds the diff range from files no invariant agent will read', () => {
    const report = planReportOf(makeDiff('src/a.ts', 20), () => 30);
    expect(report.files[0].heavy).toBe(false);
    expect(report.files[0].diffRange).toBeUndefined();
  });

  it('carries the per-kind topology counts through unchanged', () => {
    const diff =
      makeDiff('src/a.ts', 10) +
      makeDiff('src/a.test.ts', 20) +
      makeDiff('docs/g.md', 30) +
      makeDiff('package-lock.json', 40);
    const plan = buildDiffPlan(diff, 400);
    // Called directly, not through `planReportOf`: the last assertion is a
    // REFERENCE check — the report must pass the plan's own `chunks` array
    // through rather than copy it — and a helper that builds its own plan
    // would compare two equal-but-distinct arrays and always fail.
    const report = buildPlanReport(plan, () => 100, {}, diff);
    expect(report.srcDiffLines).toBe(plan.srcDiffLines);
    expect(report.testDiffLines).toBe(plan.testDiffLines);
    expect(report.docsDiffLines).toBe(plan.docsDiffLines);
    expect(report.generatedDiffLines).toBe(plan.generatedDiffLines);
    expect(report.chunks).toBe(plan.chunks);
  });

  it('records the diff text digest as the source-artifact identity', () => {
    // The write side of the drift check: `selectionDrift` re-hashes the diff
    // on disk and compares it to this field, so the field must be the digest
    // of the VERY text the plan was chunked from. Wiring
    // `buildSelectionIdentity` to any other input compiles fine and would
    // surface only as drift false-positives on every real run.
    const diff = editFile('src/a.ts', 3, 2);
    const report = planReportOf(diff, () => 1000);
    expect(report.selection.sourceArtifactSha256).toBe(
      createHash('sha256').update(diff, 'utf8').digest('hex'),
    );
  });
});

describe('stringifyPlanReport', () => {
  it('round-trips: the collapsed text parses back to the same object', () => {
    const diff =
      editFile('src/heavy.ts', 3, 900) + makeDiff('src/light.ts', 20);
    const report = planReportOf(diff, (p) =>
      p === 'src/heavy.ts' ? 6000 : 30,
    );
    expect(JSON.parse(stringifyPlanReport(report))).toEqual(report);
  });

  it('keeps every range on one line, and stays pageable', () => {
    const report = planReportOf(editFile('src/heavy.ts', 3, 900), () => 6000);
    const text = stringifyPlanReport(report);
    // Not one giant line: `read_file` pages at line boundaries, so a compact
    // one-line report could never be paged at all.
    expect(text.split('\n').length).toBeGreaterThan(10);
    // No range is split across lines.
    expect(text).not.toMatch(/\{\s*\n\s*"start":/);
    expect(text).not.toMatch(/\{\s*\n\s*"newStart":/);
    expect(text).toMatch(/\{ "start": \d+, "end": \d+ \}/);
    expect(text).toMatch(/\{ "newStart": \d+, "newEnd": \d+ \}/);
  });

  it('is smaller than the indenting serializer it replaced', () => {
    const report = planReportOf(editFile('src/heavy.ts', 3, 900), () => 6000);
    const collapsed = stringifyPlanReport(report).length;
    const indented = JSON.stringify(report, null, 2).length + 1;
    expect(collapsed).toBeLessThan(indented);
  });

  it('never mistakes a path for a range', () => {
    // A path that spells a range. JSON escapes its quotes, so the collapse
    // patterns — which require unescaped quotes — cannot touch it.
    const weird = 'src/{ "newStart": 1, "newEnd": 2 }.ts';
    const diff = [
      `diff --git "a/${weird}" "b/${weird}"`,
      '--- /dev/null',
      `+++ "b/${weird}"`,
      '@@ -0,0 +1,1 @@',
      '+x',
      '',
    ].join('\n');
    const report = planReportOf(diff, () => 1);
    const parsed = JSON.parse(stringifyPlanReport(report)) as typeof report;
    expect(parsed.files[0].path).toBe(weird);
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildDiffPlan } from './diff-plan.js';
import { buildPlanReport } from './report.js';

/** A diff adding `n` lines to `path`, shaped so the planner can cut it. */
function addFile(path: string, n: number): string {
  const body: string[] = [];
  while (body.length < n) {
    body.push(`+function f${body.length}() {`);
    for (let k = 0; k < 8 && body.length < n; k++) {
      body.push(`+  const x = ${k};`);
    }
    body.push('+}');
    body.push('+');
  }
  body.length = n;
  return [
    `diff --git a/${path} b/${path}`,
    '--- /dev/null',
    `+++ b/${path}`,
    `@@ -0,0 +1,${n} @@`,
    ...body,
    '',
  ].join('\n');
}

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

describe('buildPlanReport', () => {
  it('resolves the post-image through the injected dependency', () => {
    const plan = buildDiffPlan(editFile('src/a.ts', 3, 2), 400);
    const asked: string[] = [];
    const report = buildPlanReport(plan, (p) => {
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
    const plan = buildDiffPlan(editFile('src/a.ts', 3, 900), 400);
    expect(buildPlanReport(plan, () => 1000).files[0].heavy).toBe(false);
    // Same change into a file that ends up 6 000 long: it existed at 5 100,
    // and 900 changed lines clears the volume threshold.
    expect(buildPlanReport(plan, () => 6000).files[0].heavy).toBe(true);
  });

  it('treats a null resolver as "no tree to read", so nothing is heavy', () => {
    // `plan-diff` has a bare diff file and no ref. It must not guess.
    const plan = buildDiffPlan(addFile('src/big.ts', 2000), 400);
    const report = buildPlanReport(plan, null);
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
    const report = buildPlanReport(buildDiffPlan(diff, 400), (p) => {
      asked.push(p);
      return 500;
    });
    expect(asked).toEqual([]);
    expect(report.files[0].binary).toBe(true);
    expect(report.files[0].heavy).toBe(false);
  });

  it('emits addedRanges only on heavy files', () => {
    const diff = editFile('src/heavy.ts', 3, 900) + addFile('src/light.ts', 20);
    const report = buildPlanReport(buildDiffPlan(diff, 400), (p) =>
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
    const report = buildPlanReport(buildDiffPlan(diff, 400), () => 100);
    expect(report.files[0].hunks).toEqual([{ newStart: 1, newEnd: 2 }]);
  });

  it('gives a heavy file its own diff range, so deletions are visible', () => {
    // An invariant agent reads the post-change file, where a removed
    // `clearTimeout()` leaves nothing behind. This range points it at the `-`
    // lines that are the only evidence the call ever existed.
    const diff = editFile('src/heavy.ts', 3, 900);
    const report = buildPlanReport(buildDiffPlan(diff, 400), () => 6000);
    const f = report.files[0];
    expect(f.heavy).toBe(true);
    expect(f.diffRange).toEqual({
      startLine: 1,
      endLine: diff.trimEnd().split('\n').length,
    });
  });

  it('withholds the diff range from files no invariant agent will read', () => {
    const report = buildPlanReport(
      buildDiffPlan(addFile('src/a.ts', 20), 400),
      () => 30,
    );
    expect(report.files[0].heavy).toBe(false);
    expect(report.files[0].diffRange).toBeUndefined();
  });

  it('carries the per-kind topology counts through unchanged', () => {
    const diff =
      addFile('src/a.ts', 10) +
      addFile('src/a.test.ts', 20) +
      addFile('docs/g.md', 30) +
      addFile('package-lock.json', 40);
    const plan = buildDiffPlan(diff, 400);
    const report = buildPlanReport(plan, () => 100);
    expect(report.srcDiffLines).toBe(plan.srcDiffLines);
    expect(report.testDiffLines).toBe(plan.testDiffLines);
    expect(report.docsDiffLines).toBe(plan.docsDiffLines);
    expect(report.generatedDiffLines).toBe(plan.generatedDiffLines);
    expect(report.chunks).toBe(plan.chunks);
  });
});

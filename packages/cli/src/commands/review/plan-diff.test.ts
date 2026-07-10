/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planDiffCommand } from './plan-diff.js';
import { chunksCoverDiff } from './lib/diff-plan.js';

let dir: string;
const run = (diffPath: string, out: string, maxChunkLines = 400) =>
  (planDiffCommand.handler as (a: unknown) => void)({
    diff_path: diffPath,
    out,
    maxChunkLines,
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'plan-diff-'));
});
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/**
 * A diff adding `n` lines to a new file, shaped like real source: top-level
 * declarations separated by blank lines, so the planner has somewhere to cut.
 */
function makeDiff(path: string, n: number): string {
  const body: string[] = [];
  while (body.length < n) {
    body.push(`+function f${body.length}() {`);
    for (let k = 0; k < 8 && body.length < n; k++)
      body.push(`+  const x = ${k};`);
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

describe('plan-diff', () => {
  it('emits the same chunk plan a fetch report carries', () => {
    // This is what makes Step 3B reachable for a local-diff review: the
    // territory fan-out needs a `chunks[]` list, and only `fetch-pr` used to
    // produce one.
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 1200));
    run(diffPath, out);

    const plan = JSON.parse(readFileSync(out, 'utf8'));
    expect(plan.diffPathAbsolute).toBe(diffPath);
    expect(plan.chunks.length).toBeGreaterThan(1);
    expect(chunksCoverDiff(plan.chunks, plan.diffLines)).toBe(true);
    expect(plan.srcDiffLines).toBe(plan.diffLines);
    expect(plan.files[0].path).toBe('src/a.ts');
    expect(plan.files[0].kind).toBe('source');
  });

  it('cannot decide heaviness without a tree, and says so by omission', () => {
    // A bare diff file has no ref to resolve a post-image against, so no file
    // is heavy and no `addedRanges` are emitted. Chunk coverage still holds.
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/big.ts', 2000));
    run(diffPath, out);

    const plan = JSON.parse(readFileSync(out, 'utf8'));
    expect(plan.files.every((f: { heavy: boolean }) => !f.heavy)).toBe(true);
    expect(plan.files[0].addedRanges).toBeUndefined();
    expect(plan.files[0].fileLines).toBe(0);
  });

  it('carries the topology numbers a local review needs', () => {
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(
      diffPath,
      makeDiff('src/a.ts', 10) +
        makeDiff('src/a.test.ts', 20) +
        makeDiff('docs/guide.md', 30) +
        makeDiff('package-lock.json', 40),
    );
    run(diffPath, out);

    const plan = JSON.parse(readFileSync(out, 'utf8'));
    expect(plan.srcDiffLines).toBe(14); // 4 header lines + 10 body
    expect(plan.testDiffLines).toBe(24);
    expect(plan.docsDiffLines).toBe(34);
    expect(plan.generatedDiffLines).toBe(44);
  });

  it('emits addedRanges only where they are consumed', () => {
    // The report is read with `read_file` and truncates at the same ~25 000
    // chars a chunk does. Only heavy files feed invariant agents, so only they
    // carry the ranges — and a bare diff has no heavy files at all.
    const diffPath = join(dir, 'local.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, makeDiff('src/a.ts', 50));
    run(diffPath, out);
    const raw = readFileSync(out, 'utf8');
    expect(raw).not.toContain('addedRanges');
    expect(raw).toContain('"hunks"'); // anchors still need these
  });

  it('refuses a diff whose chunks would not tile it', () => {
    // `buildDiffPlan` asserts the tiling invariant. `plan-diff` has no worktree
    // to protect, so it fails loudly rather than degrading.
    const diffPath = join(dir, 'junk.diff');
    const out = join(dir, 'plan.json');
    writeFileSync(diffPath, 'this is not a diff\nnot at all\n');
    expect(() => run(diffPath, out)).toThrow(/do not tile the diff/);
  });

  it('reports a missing diff file by name', () => {
    expect(() => run(join(dir, 'absent.diff'), join(dir, 'p.json'))).toThrow(
      /Cannot read diff file/,
    );
  });
});

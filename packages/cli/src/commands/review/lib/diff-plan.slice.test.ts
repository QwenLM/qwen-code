/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// `sliceDiffByLines` carries two contracts nothing else in the review can
// re-establish: the bytes it keeps are byte-identical to the input's (a
// decode/re-encode rewrites every hunk of a non-UTF-8 file), and the ranges
// it is given are `parseDiff`'s own per-file ranges — so a round-trip through
// parse → slice → parse must reproduce the selected sections exactly.

import { describe, it, expect } from 'vitest';
import { parseDiff, sliceDiffByLines } from './diff-plan.js';

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  'index 111..222 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,1 +1,1 @@',
  '-const a = 1;',
  '+const a = 2;',
  'diff --git a/b.ts b/b.ts',
  'index 333..444 100644',
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -1,1 +1,1 @@',
  '-const b = 1;',
  '+const b = 2;',
  '',
].join('\n');

describe('sliceDiffByLines', () => {
  it('keeps exactly the selected file sections, parseable on their own', () => {
    const parsed = parseDiff(DIFF);
    const keep = parsed.files
      .filter((f) => f.path === 'b.ts')
      .map((f) => ({ startLine: f.diffStart, endLine: f.diffEnd }));
    const out = sliceDiffByLines(Buffer.from(DIFF, 'utf8'), keep);
    const text = out.toString('utf8');
    expect(text).toContain('b/b.ts');
    expect(text).not.toContain('a.ts');
    expect(parseDiff(text).files.map((f) => f.path)).toEqual(['b.ts']);
  });

  it('is byte-exact: invalid UTF-8 and lone CR survive verbatim', () => {
    const raw = Buffer.concat([
      Buffer.from('keep '),
      Buffer.from([0x80, 0x0d, 0x81]),
      Buffer.from('\ndrop\n'),
    ]);
    const out = sliceDiffByLines(raw, [{ startLine: 1, endLine: 1 }]);
    expect([...out]).toEqual([...raw.subarray(0, raw.indexOf(0x0a) + 1)]);
  });

  it('re-orders ranges by line and clamps past the last line', () => {
    const buf = Buffer.from('l1\nl2\nl3\n', 'utf8');
    expect(
      sliceDiffByLines(buf, [
        { startLine: 3, endLine: 9 },
        { startLine: 1, endLine: 1 },
      ]).toString('utf8'),
    ).toBe('l1\nl3\n');
  });
});

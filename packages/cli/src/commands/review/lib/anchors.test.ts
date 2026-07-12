/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseDiff } from './diff-plan.js';
import {
  collectNewSideLines,
  resolveAnchor,
  resolveAnchors,
} from './anchors.js';

/**
 * A diff of `src/pay.ts` whose single hunk starts at new-side line 10.
 *
 * Line numbering, so the expectations below are checkable by eye:
 *   10  ` function pay(amt) {`      context
 *   11  `+  if (amt < 0) return;`   added
 *   12  `+  charge(amt);`           added
 *   13  ` }`                        context
 */
const PAY_DIFF = [
  'diff --git a/src/pay.ts b/src/pay.ts',
  'index 1111111..2222222 100644',
  '--- a/src/pay.ts',
  '+++ b/src/pay.ts',
  '@@ -10,3 +10,4 @@',
  ' function pay(amt) {',
  '-  charge(amt);',
  '+  if (amt < 0) return;',
  '+  charge(amt);',
  ' }',
  '',
].join('\n');

function lines(diff: string, path: string) {
  const file = parseDiff(diff).files.find((f) => f.path === path)!;
  return collectNewSideLines(diff, file);
}

describe('collectNewSideLines', () => {
  it('numbers added and context lines, and skips removed ones', () => {
    expect(lines(PAY_DIFF, 'src/pay.ts')).toEqual([
      { newLine: 10, text: 'function pay(amt) {', added: false },
      { newLine: 11, text: '  if (amt < 0) return;', added: true },
      { newLine: 12, text: '  charge(amt);', added: true },
      { newLine: 13, text: '}', added: false },
    ]);
  });

  it('yields nothing for a pure-deletion hunk', () => {
    // `@@ -3,2 +2,0 @@` occupies no new-side line. GitHub 422s any right-side
    // comment anchored in one, so there must be nothing here to match.
    const diff = [
      'diff --git a/d.ts b/d.ts',
      '--- a/d.ts',
      '+++ b/d.ts',
      '@@ -3,2 +2,0 @@',
      '-const gone = 1;',
      '-const alsoGone = 2;',
      '',
    ].join('\n');
    expect(lines(diff, 'd.ts')).toEqual([]);
  });

  it('yields nothing for a `+N,0` hunk even when its body is malformed', () => {
    // The test above passes whether or not the `newCount === 0` guard exists —
    // a body of pure `-` lines produces nothing either way. This one actually
    // exercises the guard.
    //
    // The diff under review is untrusted input: it is whatever the PR author
    // wrote. A hunk header claiming no new-side lines whose body nonetheless
    // carries a context line is not something git emits, but it is something a
    // diff can *contain*. Walking it would mint a new-side line number inside a
    // hunk GitHub believes has no right side — and GitHub answers that anchor
    // with a 422 that takes the entire review down, Criticals included.
    const diff = [
      'diff --git a/d.ts b/d.ts',
      '--- a/d.ts',
      '+++ b/d.ts',
      '@@ -3,2 +2,0 @@',
      '-const gone = 1;',
      ' stillHere();',
      '',
    ].join('\n');
    expect(lines(diff, 'd.ts')).toEqual([]);
  });

  it('does not let `\\ No newline at end of file` advance the cursor', () => {
    const diff = [
      'diff --git a/n.ts b/n.ts',
      '--- a/n.ts',
      '+++ b/n.ts',
      '@@ -1,1 +1,2 @@',
      ' first',
      '+second',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    expect(lines(diff, 'n.ts')).toEqual([
      { newLine: 1, text: 'first', added: false },
      { newLine: 2, text: 'second', added: true },
    ]);
  });
});

describe('resolveAnchor', () => {
  const hay = () => lines(PAY_DIFF, 'src/pay.ts');

  it('resolves a single added line to its real number', () => {
    const r = resolveAnchor(hay(), '  if (amt < 0) return;');
    expect(r).toMatchObject({
      status: 'resolved',
      line: 11,
      startLine: 11,
      tier: 'exact-added',
      matchCount: 1,
      ambiguous: false,
    });
  });

  it("corrects the agent's line number instead of trusting it", () => {
    // The whole point. The agent read the diff, miscounted, and said 42.
    const r = resolveAnchor(hay(), '  if (amt < 0) return;', 42);
    expect(r.status).toBe('resolved');
    expect(r.line).toBe(11);
    expect(r.drift).toBe(31);
  });

  it('scores a correctly-counted multi-line anchor as zero drift', () => {
    // `drift` is measured against `startLine`, not `line`. An agent names the
    // FIRST line of the code it is talking about; `line` is the LAST line of
    // the match, because that is where GitHub hangs a multi-line comment.
    // Comparing the claim to `line` scores a perfectly-counted three-line
    // anchor as "off by two" — and a dogfood run on PR #6754 duly reported 8 of
    // 12 findings as "corrected" when every one of the agents had been exactly
    // right. The metric was wrong, not the agents.
    const r = resolveAnchor(
      hay(),
      '  if (amt < 0) return;\n  charge(amt);',
      11, // the agent said 11, and 11 is where the snippet starts
    );
    expect(r).toMatchObject({ startLine: 11, line: 12 });
    expect(r.drift).toBe(0);
  });

  it('spans a multi-line snippet, anchoring on its last line', () => {
    // GitHub hangs an inline comment off the END of a range.
    const r = resolveAnchor(hay(), '  if (amt < 0) return;\n  charge(amt);');
    expect(r).toMatchObject({ status: 'resolved', startLine: 11, line: 12 });
  });

  it('accepts a snippet copied with its `+` markers', () => {
    const r = resolveAnchor(hay(), '+  if (amt < 0) return;\n+  charge(amt);');
    expect(r).toMatchObject({ status: 'resolved', startLine: 11, line: 12 });
  });

  it('does not strip a leading `+` that is real code', () => {
    // `+x` as a line of code must not be read as a diff marker. Only a snippet
    // whose every line carries one gets the marker-stripped reading.
    const diff = [
      'diff --git a/m.ts b/m.ts',
      '--- a/m.ts',
      '+++ b/m.ts',
      '@@ -1,0 +1,2 @@',
      '++value;',
      '+normal();',
      '',
    ].join('\n');
    const r = resolveAnchor(lines(diff, 'm.ts'), '+value;');
    expect(r).toMatchObject({
      status: 'resolved',
      line: 1,
      tier: 'exact-added',
    });
  });

  it('falls back to indentation-insensitive matching, and says so', () => {
    const r = resolveAnchor(hay(), 'if (amt < 0) return;');
    expect(r).toMatchObject({
      status: 'resolved',
      line: 11,
      tier: 'loose-added',
    });
  });

  it('matches a context line when the anchor quotes unchanged code', () => {
    const r = resolveAnchor(hay(), 'function pay(amt) {');
    expect(r).toMatchObject({
      status: 'resolved',
      line: 10,
      tier: 'exact-context',
    });
  });

  it('prefers an exact added match over an exact context match', () => {
    // The same text on both a context line (earlier) and an added line. An
    // anchor is meant to quote added code, so the added hit must win even
    // though the context one comes first in the file.
    const diff = [
      'diff --git a/p.ts b/p.ts',
      '--- a/p.ts',
      '+++ b/p.ts',
      '@@ -1,2 +1,3 @@',
      ' dup();',
      ' other();',
      '+dup();',
      '',
    ].join('\n');
    const r = resolveAnchor(lines(diff, 'p.ts'), 'dup();');
    expect(r).toMatchObject({ line: 3, tier: 'exact-added' });
  });

  it("breaks a tie with the agent's claimed line", () => {
    const diff = [
      'diff --git a/r.ts b/r.ts',
      '--- a/r.ts',
      '+++ b/r.ts',
      '@@ -1,0 +1,5 @@',
      '+await tick();',
      '+a();',
      '+b();',
      '+await tick();',
      '+c();',
      '',
    ].join('\n');
    const hayR = lines(diff, 'r.ts');

    // `await tick();` is at lines 1 and 4. The agent said "around 5".
    const near = resolveAnchor(hayR, 'await tick();', 5);
    expect(near).toMatchObject({ line: 4, matchCount: 2, ambiguous: true });

    // With no claim to steer by, first-wins — and it admits the ambiguity.
    const blind = resolveAnchor(hayR, 'await tick();');
    expect(blind).toMatchObject({ line: 1, matchCount: 2, ambiguous: true });
  });

  it('will not join two lines that are not consecutive in the file', () => {
    // Adjacent in the collected array (they are both added), but separated by a
    // hunk gap in the actual file. A snippet is a contiguous run of source, and
    // matching across the gap would anchor a comment on code that never sat
    // together.
    const diff = [
      'diff --git a/g.ts b/g.ts',
      '--- a/g.ts',
      '+++ b/g.ts',
      '@@ -1,0 +1,1 @@',
      '+const first = 1;',
      '@@ -50,0 +60,1 @@',
      '+const second = 2;',
      '',
    ].join('\n');
    const hayG = lines(diff, 'g.ts');
    expect(hayG.map((l) => l.newLine)).toEqual([1, 60]);

    expect(
      resolveAnchor(hayG, 'const first = 1;\nconst second = 2;').status,
    ).toBe('unmatched');
    // Each on its own still resolves.
    expect(resolveAnchor(hayG, 'const second = 2;')).toMatchObject({
      line: 60,
    });
  });

  it('refuses a snippet quoting a REMOVED line', () => {
    // Deleted code has no line on the right-hand side of the diff, which is the
    // only side GitHub anchors on. Better unmatched than anchored on a
    // neighbour that happens to sit where the deletion used to be.
    const r = resolveAnchor(hay(), '  charge(amt);\n}'); // `-  charge(amt);` + `}`
    // The `+  charge(amt);` line is real, and it IS followed by `}` — so this
    // one legitimately resolves against the added copy, at 12-13.
    expect(r).toMatchObject({ status: 'resolved', startLine: 12, line: 13 });

    // A line that exists ONLY on the removed side has nowhere to go.
    const removedOnly = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,2 +1,1 @@',
      '-const removed = true;',
      ' kept();',
      '',
    ].join('\n');
    expect(
      resolveAnchor(lines(removedOnly, 'x.ts'), 'const removed = true;').status,
    ).toBe('unmatched');
  });

  it('rejects an empty anchor', () => {
    expect(resolveAnchor(hay(), '   \n  ')).toMatchObject({
      status: 'unmatched',
      reason: 'anchor is empty',
    });
  });
});

describe('resolveAnchors (batch)', () => {
  it('resolves against the right file and reports one that is not in the diff', () => {
    const out = resolveAnchors(PAY_DIFF, [
      { id: 'a', path: 'src/pay.ts', anchor: '  charge(amt);', line: 99 },
      { id: 'b', path: 'src/ghost.ts', anchor: 'anything()' },
    ]);

    expect(out[0]).toMatchObject({
      id: 'a',
      status: 'resolved',
      line: 12,
      claimedLine: 99,
      drift: 87,
    });
    expect(out[1]).toMatchObject({ id: 'b', status: 'unmatched' });
    expect(out[1].reason).toContain('not in the diff');
  });

  it("keeps the agent's claim and the computed line as separate numbers", () => {
    // They are two different facts, and the correction is only visible while
    // both survive. An earlier draft spread them onto the same key and the
    // claim vanished.
    const [r] = resolveAnchors(PAY_DIFF, [
      { id: 'a', path: 'src/pay.ts', anchor: '  charge(amt);', line: 3 },
    ]);
    expect(r.claimedLine).toBe(3);
    expect(r.line).toBe(12);
  });

  it('never resolves to a line outside a hunk — the 422 guarantee', () => {
    // GitHub rejects the entire review with a 422 if any comment's line falls
    // outside every hunk of its file. Every candidate line is collected from
    // inside a hunk, so this holds by construction; assert it anyway, because
    // it is the property the whole design is for.
    const file = parseDiff(PAY_DIFF).files[0];
    const anchors = ['function pay(amt) {', '  if (amt < 0) return;', '}'];

    for (const anchor of anchors) {
      const r = resolveAnchor(lines(PAY_DIFF, 'src/pay.ts'), anchor);
      expect(r.status).toBe('resolved');
      const inSomeHunk = file.hunks.some(
        (h) => h.newCount > 0 && r.line! >= h.newStart && r.line! <= h.newEnd,
      );
      expect(inSomeHunk).toBe(true);
    }
  });
});

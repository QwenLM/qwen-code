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

  it('accepts a whole hunk region copied verbatim, markers and all', () => {
    // "Copy VERBATIM from the diff" invites an agent to bring the marker column
    // with it — `+` lines interleaved with ` ` context and `-` deletions. That
    // is not an all-`+` snippet, so the marker-stripped reading above did not
    // fire, and the raw one cannot match because the markers survive even the
    // loose trim. The region used to resolve as unmatched.
    //
    // The new side of a diff region IS its `+` and ` ` lines with the marker
    // column dropped and the `-` lines removed, and those are consecutive in the
    // post-change file — so this is an exact reconstruction, not a fuzzy one.
    const r = resolveAnchor(
      hay(),
      ' function pay(amt) {\n-  charge(amt);\n+  if (amt < 0) return;\n+  charge(amt);',
    );
    expect(r).toMatchObject({
      status: 'resolved',
      startLine: 10, // ` function pay(amt) {`
      line: 12, // `+  charge(amt);`
    });
  });

  it('does not eat the first character of ordinary indented code', () => {
    // Every line of indented code begins with a space, which is also a diff
    // marker. The hunk-region reading must not fire on it — requiring at least
    // one `+` line is what keeps `  const a = 1;` from becoming ` const a = 1;`.
    const r = resolveAnchor(hay(), '  if (amt < 0) return;\n  charge(amt);');
    expect(r).toMatchObject({
      status: 'resolved',
      startLine: 11,
      tier: 'exact-added',
    });
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

  it('sees a context twin of an added line instead of hiding it', () => {
    // Searching added lines first and returning on the first hit reported
    // `matchCount: 1, ambiguous: false` for a snippet that also sits on a
    // context line — a tie the resolver never saw rather than a tie it broke.
    // When the agent's claim points at the context copy, that "unambiguous"
    // answer is the wrong line, delivered with full confidence.
    const diff = [
      'diff --git a/t.ts b/t.ts',
      '--- a/t.ts',
      '+++ b/t.ts',
      '@@ -10,2 +10,3 @@',
      ' flush();', // context, line 10
      ' other();', // context, line 11
      '+flush();', // added,   line 12
      '',
    ].join('\n');
    const hayT = lines(diff, 't.ts');

    // The agent said 10 — it means the context copy, and gets it.
    expect(resolveAnchor(hayT, 'flush();', 10)).toMatchObject({
      line: 10,
      matchCount: 2,
      ambiguous: true,
      tier: 'exact-context',
    });
    // It said 12 — it means the added copy.
    expect(resolveAnchor(hayT, 'flush();', 12)).toMatchObject({
      line: 12,
      matchCount: 2,
      tier: 'exact-added',
    });
  });

  it('prefers the candidate that touches the change, not the one made only of it', () => {
    // `run.every(added)` asked "is this run ENTIRELY new code?" — and a two-line
    // anchor spanning a context line and the added line under it is not, so it
    // was classed as "context", indistinguishable from a wholly-unchanged
    // duplicate elsewhere in the file. The added-preference then could not tell
    // them apart and gave up. What matters is which candidate *touches* the diff.
    const diff = [
      'diff --git a/m.ts b/m.ts',
      '--- a/m.ts',
      '+++ b/m.ts',
      '@@ -10,4 +10,5 @@',
      ' guard();', // 10  ┐ construct A — wholly unchanged
      ' run();', //     11  ┘
      ' other();', // 12
      ' guard();', // 13  ┐ construct B — contains the changed line
      '+run();', //     14  ┘
      '',
    ].join('\n');

    const r = resolveAnchor(lines(diff, 'm.ts'), 'guard();\nrun();');
    expect(r).toMatchObject({
      status: 'resolved',
      startLine: 13,
      line: 14,
      matchCount: 2,
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

    // With no claim to steer by, there is nothing left to choose with — and
    // first-wins is not a choice, it is a coin flip with a confident face. It
    // used to return line 1 as `resolved`. Refuse instead: an unmatched finding
    // is loud and recoverable (a Critical still reaches the body), while a
    // comment posted on the wrong one of two identical lines is neither.
    const blind = resolveAnchor(hayR, 'await tick();');
    expect(blind.status).toBe('unmatched');
    expect(blind.reason).toContain('more than one place');
  });

  it('refuses when the claim lands exactly between two candidates', () => {
    // A `reduce` that keeps the incumbent on a tie silently prefers the earlier
    // match — and "earlier" is not a reason. With matches at 10 and 12 and a
    // claim of 11, nothing distinguishes them, and answering 10 with a straight
    // face attaches a blocker to whichever occurrence happened to come first.
    const diff = [
      'diff --git a/e.ts b/e.ts',
      '--- a/e.ts',
      '+++ b/e.ts',
      '@@ -10,0 +10,3 @@',
      '+flush();', // 10
      '+other();',
      '+flush();', // 12
      '',
    ].join('\n');
    const hayE = lines(diff, 'e.ts');

    const tie = resolveAnchor(hayE, 'flush();', 11);
    expect(tie.status).toBe('unmatched');
    expect(tie.reason).toContain('more than one place');

    // One step nearer either way and the claim does distinguish them.
    expect(resolveAnchor(hayE, 'flush();', 10)).toMatchObject({ line: 10 });
    expect(resolveAnchor(hayE, 'flush();', 12)).toMatchObject({ line: 12 });
  });

  it('does not let a weaker reading rescue an ambiguous faithful one', () => {
    // The worst shape this resolver can take: most confident exactly where it is
    // most wrong. Two added lines whose code is `+value;` make the faithful
    // reading of the anchor `+value;` ambiguous — and the marker-stripped reading
    // then matches the unrelated `value;` *uniquely*, returning it as
    // `matchCount: 1, ambiguous: false`. A blocker lands on a line the finding
    // has nothing to do with, with every signal saying it is certain.
    //
    // A stronger interpretation that is undecided outranks a weaker one that is
    // sure.
    const diff = [
      'diff --git a/v.ts b/v.ts',
      '--- a/v.ts',
      '+++ b/v.ts',
      '@@ -1,0 +1,3 @@',
      '++value;', // line 1, code: `+value;`
      '++value;', // line 2, code: `+value;`  → faithful match is ambiguous
      '+value;', // line 3, code: `value;`   → the marker-stripped guess
      '',
    ].join('\n');

    const r = resolveAnchor(lines(diff, 'v.ts'), '+value;');
    expect(r.status).toBe('unmatched');
    expect(r.line).toBeUndefined();
  });

  it('will not choose between two indentation-stripped candidates', () => {
    // Loose matching exists so a mangled indent does not lose a finding. It must
    // not become a way to *choose* an indent: in Python or YAML the nesting level
    // IS the semantics, and picking one of several stripped candidates is picking
    // which block the finding is about.
    //
    // A claimed line does NOT rescue this, which is why the refusal is its own
    // guard rather than a consequence of having nothing to tie-break with. For an
    // *exact* snippet the claim is a second independent signal and is trusted
    // (see the tie-break test above). For a loose one the snippet has already
    // been shown not to be verbatim, so the claim would be the only signal left —
    // and it would be deciding a semantic question it has no view of. Quote more
    // lines instead.
    const diff = [
      'diff --git a/y.py b/y.py',
      '--- a/y.py',
      '+++ b/y.py',
      '@@ -10,0 +10,4 @@',
      '+    if a:',
      '+        log()', // line 11
      '+    else:',
      '+        log()', // line 13
      '',
    ].join('\n');
    const hayY = lines(diff, 'y.py');

    const blind = resolveAnchor(hayY, 'log()');
    expect(blind.status).toBe('unmatched');
    expect(blind.reason).toContain('more than one place');

    // And with a claim landing exactly on one of them — still refused.
    const claimed = resolveAnchor(hayY, 'log()', 11);
    expect(claimed.status).toBe('unmatched');
    expect(claimed.reason).toContain('more than one place');
  });

  it('does not let a marker guess also be an indentation guess', () => {
    // Stripping a `+` column is already an inference about what the agent meant
    // to type. Allowing that inference to *then* match loosely stacks two
    // guesses, and the result looks exactly like a confident answer. A snippet
    // that is neither verbatim nor correctly marked is not resolvable; say so.
    const diff = [
      'diff --git a/z.ts b/z.ts',
      '--- a/z.ts',
      '+++ b/z.ts',
      '@@ -1,0 +1,2 @@',
      '+    const deep = compute();',
      '+    return deep;',
      '',
    ].join('\n');
    // Markers copied, AND the indentation mangled. Either alone resolves; both
    // together must not.
    const r = resolveAnchor(lines(diff, 'z.ts'), '+const deep = compute();');
    expect(r.status).toBe('unmatched');

    // The same snippet with its real indentation resolves through the marker
    // reading, which is what keeps that reading worth having.
    const ok = resolveAnchor(
      lines(diff, 'z.ts'),
      '+    const deep = compute();',
    );
    expect(ok).toMatchObject({ status: 'resolved', line: 1 });
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

describe('resolveAnchor — the substring fallback (KB-long lines)', () => {
  // A file whose paragraphs are single multi-KB lines — SKILL.md is one —
  // defeats every whole-line tier: the quote IS in the diff, inside a line.
  // The natural anchor there is a mid-line fragment, and containment is what
  // places it, at the containing line.
  const PARAGRAPH =
    'The resolver turns each quoted snippet into a line number, because a ' +
    'line number the model counted out by hand is not something the pipeline ' +
    'can trust, and a derived number is strictly better evidence than an ' +
    'asserted one. A mid-line fragment is the natural anchor shape here.';

  const diff = [
    'diff --git a/SKILL.md b/SKILL.md',
    '--- a/SKILL.md',
    '+++ b/SKILL.md',
    '@@ -1,0 +1,2 @@',
    '+# Heading',
    `+${PARAGRAPH}`,
    '',
  ].join('\n');
  const hay = () => lines(diff, 'SKILL.md');

  it('resolves a mid-line fragment to the containing added line', () => {
    const r = resolveAnchor(
      hay(),
      'a derived number is strictly better evidence than an asserted one',
    );
    expect(r).toMatchObject({
      status: 'resolved',
      line: 2,
      startLine: 2,
      tier: 'substring-added',
      matchCount: 1,
      ambiguous: false,
    });
  });

  it('reports the containing line when it is a context line', () => {
    const contextDiff = [
      'diff --git a/SKILL.md b/SKILL.md',
      '--- a/SKILL.md',
      '+++ b/SKILL.md',
      '@@ -1,2 +1,2 @@',
      ' # Heading',
      ` ${PARAGRAPH}`,
      '',
    ].join('\n');
    const r = resolveAnchor(
      lines(contextDiff, 'SKILL.md'),
      'the natural anchor shape here',
    );
    expect(r).toMatchObject({
      status: 'resolved',
      line: 2,
      tier: 'substring-context',
    });
  });

  it('keeps a whole-line quote exact — the fallback is the LAST tier', () => {
    const r = resolveAnchor(hay(), PARAGRAPH);
    expect(r).toMatchObject({
      status: 'resolved',
      line: 2,
      tier: 'exact-added',
    });
  });

  it('leaves a short fragment unmatched — too little text to place a line', () => {
    // Below MIN_SUBSTRING_LENGTH a fragment sits inside half the lines a diff
    // renders; matching it would be noise with a confident face. The probes
    // sit on the boundary so the floor's value is the value under test: an
    // 11-char contained fragment refuses, the 12-char one resolves.
    expect(resolveAnchor(hay(), 'strictly')).toMatchObject({
      status: 'unmatched',
    });
    expect(resolveAnchor(hay(), 'strictly be')).toMatchObject({
      status: 'unmatched',
    });
    expect(resolveAnchor(hay(), 'strictly bet')).toMatchObject({
      status: 'resolved',
      line: 2,
      tier: 'substring-added',
    });
  });

  it('says a too-short fragment sits inside a hunk line when it does', () => {
    // The generic absence reason claims the quote appears nowhere — false for
    // an accurate fragment refused only for its length — and Step 7 keys its
    // recovery to re-attribution, when the only remedy is a longer quote.
    const r = resolveAnchor(hay(), 'strictly be');
    expect(r.status).toBe('unmatched');
    expect(r.reason).toContain('too short to place a line');
    expect(r.reason).toContain('longer');

    // A snippet that genuinely appears nowhere keeps the absence reason.
    const absent = resolveAnchor(hay(), 'quoted from some other file entirely');
    expect(absent.status).toBe('unmatched');
    expect(absent.reason).toContain('does not appear in any hunk');
    // …and names the fragment tier it now covers. The pre-PR wording lacked
    // this clause, so a revert to it stays green on the assertion above
    // alone — pin the distinguishing part, or a reason that never mentions
    // the fragment shape misdirects Step 7's recovery back to re-attribution.
    expect(absent.reason).toContain('nor as a fragment inside one');
  });

  it('does not fall back for a multi-line snippet', () => {
    // A fragment of the paragraph plus the heading cannot sit inside one
    // line, and the marker readings get no containment guess stacked on them.
    const r = resolveAnchor(hay(), '# Heading\nThe resolver turns each');
    expect(r.status).toBe('unmatched');
  });

  it('refuses a fragment contained in several lines, unless a claim decides', () => {
    const phrase = 'the same repeated phrase appears in this review twice';
    const repeatDiff = [
      'diff --git a/d.md b/d.md',
      '--- a/d.md',
      '+++ b/d.md',
      '@@ -1,0 +1,3 @@',
      `+first line that carries ${phrase} in it`,
      '+an unrelated line',
      `+second line that carries ${phrase} in it`,
      '',
    ].join('\n');
    const hayR = lines(repeatDiff, 'd.md');

    const blind = resolveAnchor(hayR, phrase);
    expect(blind.status).toBe('unmatched');
    expect(blind.reason).toContain('more than one hunk line');
    // The prefix above is shared with the whitespace-collapse refusal; Step 7
    // string-matches the clause that distinguishes this shape to pick its
    // recovery, so pin that clause too — a rewording must turn this red.
    expect(blind.reason).toContain('nothing distinguishes them');

    const claimed = resolveAnchor(hayR, phrase, 3);
    expect(claimed).toMatchObject({
      status: 'resolved',
      line: 3,
      matchCount: 2,
      ambiguous: true,
    });
  });

  it('counts one line once even when the fragment repeats inside it', () => {
    // The fragment appears twice in the SAME line; that is one place the
    // comment can hang, not an ambiguity.
    const repeatDiff = [
      'diff --git a/r.md b/r.md',
      '--- a/r.md',
      '+++ b/r.md',
      '@@ -1,0 +1,1 @@',
      '+review the charge(amt) call; then review the charge(amt) call again',
      '',
    ].join('\n');
    const r = resolveAnchor(
      lines(repeatDiff, 'r.md'),
      'review the charge(amt) call',
    );
    expect(r).toMatchObject({
      status: 'resolved',
      line: 1,
      matchCount: 1,
      ambiguous: false,
    });
  });

  it('matches after whitespace collapse, but only when that is the only place', () => {
    const r = resolveAnchor(hay(), 'a  derived   number is strictly better');
    expect(r).toMatchObject({
      status: 'resolved',
      line: 2,
      tier: 'substring-added',
    });
  });

  it('refuses a fragment contained in several lines only after whitespace collapse', () => {
    // Two-sided mirror of the loose-tier guard: the collapsed reading earns
    // its place only when it is the ONLY place. The same phrase once with a
    // double space, once with a triple — realistic inside KB-long Markdown
    // lines — is two candidates after collapse, and choosing between
    // whitespace variants would be a guess posted as a normal resolution.
    const wsDiff = [
      'diff --git a/w.md b/w.md',
      '--- a/w.md',
      '+++ b/w.md',
      '@@ -1,0 +1,2 @@',
      '+one  two three four five six',
      '+one   two three four five six',
      '',
    ].join('\n');
    const hayW = lines(wsDiff, 'w.md');

    const blind = resolveAnchor(hayW, 'one two three four five');
    expect(blind.status).toBe('unmatched');
    expect(blind.reason).toContain('whitespace is normalised');

    // A claim landing exactly on one of them does not rescue the guess.
    const claimed = resolveAnchor(hayW, 'one two three four five', 2);
    expect(claimed.status).toBe('unmatched');
    expect(claimed.reason).toContain('whitespace is normalised');
  });

  it('carries the drift measurement like any other tier', () => {
    const r = resolveAnchor(
      hay(),
      'the natural anchor shape here',
      9, // the agent miscounted; the fragment is on line 2
    );
    expect(r).toMatchObject({ status: 'resolved', line: 2, drift: 7 });
  });

  it('forgives a copied `+` marker on a mid-line fragment', () => {
    // The whole-line tiers forgive the marker column ("not a mistake worth
    // failing over"); the containment tier must too, for the exact shape it
    // was built for — the opening clause of an added KB-long line quoted as
    // it renders in the diff, marker included.
    const r = resolveAnchor(hay(), '+The resolver turns each quoted snippet');
    expect(r).toMatchObject({
      status: 'resolved',
      line: 2,
      tier: 'substring-added',
    });
  });

  it('does not let the marker retry also be an indentation guess', () => {
    // The retry is mid-line containment only: a marker-stripped fragment
    // whose containing line equals it modulo surrounding whitespace is an
    // indentation guess stacked on a marker guess — the stack the whole-line
    // tiers refuse, and containment of `x` inside ` x` IS containment
    // functioning as that guess.
    const indented = [
      'diff --git a/z2.ts b/z2.ts',
      '--- a/z2.ts',
      '+++ b/z2.ts',
      '@@ -1,0 +1,1 @@',
      '+    const deep = compute();',
      '',
    ].join('\n');
    const r = resolveAnchor(
      lines(indented, 'z2.ts'),
      '+const deep = compute();',
    );
    expect(r.status).toBe('unmatched');
    // The refusal is right; the REASON must be too. The quote IS in the hunk
    // — refused by policy, not absent — and Step 7 keys its recovery to the
    // reason: the generic absence one would re-attribute the file when the
    // remedy is to quote the line verbatim, with its indentation.
    expect(r.reason).toContain('indentation is normalised');
    expect(r.reason).toContain('verbatim');
    expect(r.reason).not.toContain('does not appear in any hunk');
  });

  it('refuses the marker retry when a policy-dropped equal line coexists with a containment line', () => {
    // The diff adds a line that EQUALS the marker-stripped fragment modulo
    // whitespace and an unrelated line that merely CONTAINS it. Before the
    // refusal, the retry dropped the equal line as a lineGuess and resolved
    // the fragment to the containment line at `matchCount: 1, ambiguous:
    // false` — a confidently posted misplacement where the old contract was a
    // loud unmatched. The equal-line reading stays alive, so refuse.
    const stacked = [
      'diff --git a/x.ts b/x.ts',
      '--- a/x.ts',
      '+++ b/x.ts',
      '@@ -1,0 +1,2 @@',
      '+ const x = 1;',
      '+review const x = 1; here',
      '',
    ].join('\n');
    const hayX = lines(stacked, 'x.ts');
    const blind = resolveAnchor(hayX, '+const x = 1;');
    expect(blind.status).toBe('unmatched');
    expect(blind.reason).toContain('verbatim');
    // A claim on the equal line does not rescue the containment reading.
    const claimed = resolveAnchor(hayX, '+const x = 1;', 1);
    expect(claimed.status).toBe('unmatched');
    expect(claimed.reason).toContain('verbatim');
  });

  it('does not prescribe a longer stretch of a whole line the marker retry guessed at', () => {
    // `+return x;` for actual ` return x;` — the stacked marker+indentation
    // guess under 12 characters. The containment check used to report the
    // fragment as sitting inside a hunk line and prescribe a longer stretch,
    // but the whole line IS 10 characters: there is no longer stretch, and
    // quotes that DO place the line exist. The shape must refuse the same
    // way at every length.
    const shortDiff = [
      'diff --git a/s.ts b/s.ts',
      '--- a/s.ts',
      '+++ b/s.ts',
      '@@ -1,0 +1,1 @@',
      '+ return x;',
      '',
    ].join('\n');
    const hayS = lines(shortDiff, 's.ts');
    const r = resolveAnchor(hayS, '+return x;');
    expect(r.status).toBe('unmatched');
    expect(r.reason).not.toContain('longer stretch');
    expect(r.reason).toContain('verbatim');

    // The quotes that DO place the line.
    expect(resolveAnchor(hayS, ' return x;')).toMatchObject({
      status: 'resolved',
      tier: 'exact-added',
    });
    expect(resolveAnchor(hayS, 'return x;')).toMatchObject({
      status: 'resolved',
      tier: 'loose-added',
    });
  });

  it('measures the substring floor on the collapsed needle, not its padding', () => {
    // The collapsed matching pass abstracts away the very whitespace the
    // floor counts: `a  b  c  d  e` is 13 characters as quoted, but its
    // collapsed core `a b c d e` is 9 — below the floor the plainly-quoted
    // core is refused for. The same core must not be noise or a posted
    // anchor depending only on its internal padding.
    const paddedDiff = [
      'diff --git a/p.md b/p.md',
      '--- a/p.md',
      '+++ b/p.md',
      '@@ -1,0 +1,1 @@',
      '+x a b c d e y',
      '',
    ].join('\n');
    const hayP = lines(paddedDiff, 'p.md');
    const padded = resolveAnchor(hayP, 'a  b  c  d  e');
    expect(padded.status).toBe('unmatched');
    expect(padded.reason).toContain('too short to place a line');
    expect(resolveAnchor(hayP, 'a b c d e').status).toBe('unmatched');
  });

  it('does not let an empty marker-stripped reading sit inside every line', () => {
    // A bare `+` is an added blank line quoted with its marker. The
    // marker-stripped reading reduces to the empty string, and
    // `''.includes('')` is true of every line — containment would claim
    // presence in this file and prescribe a longer stretch of a line the
    // snippet does not sit in. The honest absence reason — possibly the
    // wrong file — is the only productive recovery.
    const r = resolveAnchor(hay(), '+');
    expect(r.status).toBe('unmatched');
    expect(r.reason).toContain('does not appear in any hunk');
  });
});

it('does not throw on a candidate set past the argument-spread limit', () => {
  // `Math.min(...cands.map(dist))` turns every candidate into a function
  // argument; a diff with enough repeated lines crosses the engine limit and
  // throws a RangeError that takes the whole batch down. 200 000 identical
  // added lines, one claim: a loop must survive it.
  const N = 200_000;
  const body = Array.from({ length: N }, () => '+dup();').join('\n');
  const diff = [
    'diff --git a/big.ts b/big.ts',
    '--- a/big.ts',
    '+++ b/big.ts',
    `@@ -1,0 +1,${N} @@`,
    body,
    '',
  ].join('\n');
  const hay = lines(diff, 'big.ts');
  // A claim in the middle: many candidates are equidistant, so it resolves to
  // `unmatched` — but it must get there without a RangeError.
  expect(() => resolveAnchor(hay, 'dup();', N / 2)).not.toThrow();
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

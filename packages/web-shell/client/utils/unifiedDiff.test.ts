import { describe, expect, it } from 'vitest';
import {
  buildContextBoundedDiff,
  buildUnifiedDiff,
  diffPreviewText,
  DIFF_CRLF_MIXED_MARKER,
  DIFF_CRLF_UNIFORM_MARKER,
  DIFF_OMITTED_MARKER,
  DIFF_TRAILING_NEWLINE_ADDED_MARKER,
  DIFF_TRAILING_NEWLINE_REMOVED_MARKER,
  localizeDiffNotice,
  parseUnifiedDiff,
} from './unifiedDiff';

// The builder must emit an ASCII-safe marker, not a user-facing sentence: this
// module imports no translator, so the `t()` catalog can only reach the notice
// at the render boundary. Asserting through a stub translator means
// re-hardcoding an English literal into the builder turns these cases red.
const stubT = (key: string) => `[${key}]`;

describe('buildContextBoundedDiff', () => {
  it('reports distant edits that exceed the trimmed LCS budget without a coarse hunk', () => {
    const oldLines = Array.from({ length: 2_000 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[1] = 'first change';
    newLines[1_998] = 'last change';
    const diff = buildContextBoundedDiff(
      oldLines.join('\n'),
      newLines.join('\n'),
    );
    expect(diff).toBe(DIFF_OMITTED_MARKER);
    expect(localizeDiffNotice(diff, stubT)).toBe('[approval.diffOmitted]');
    expect(diff).not.toContain('@@');
    expect(parseUnifiedDiff(diff)).toMatchObject({
      additions: 0,
      deletions: 0,
    });
    expect(diff.split('\n')).toHaveLength(1);
  });

  it('limits rendered rows for a large insertion with no LCS product', () => {
    const diff = buildContextBoundedDiff('', 'line\n'.repeat(2_000));
    expect(localizeDiffNotice(diff, stubT)).toBe('[approval.diffOmitted]');
    expect(diff).not.toContain('@@');
    expect(parseUnifiedDiff(diff).lines).toMatchObject([{ type: 'header' }]);
  });

  it('omits raw payloads over the character budget before trimming', () => {
    const oldLines = Array.from(
      { length: 40_000 },
      (_, i) => `payload_line_${i}`,
    );
    const newLines = [...oldLines];
    newLines[20_000] = 'changed';
    const oldText = oldLines.join('\n');
    const newText = newLines.join('\n');
    expect(oldText.length + newText.length).toBeGreaterThan(100_000);

    const diff = buildContextBoundedDiff(oldText, newText);
    expect(localizeDiffNotice(diff, stubT)).toBe('[approval.diffOmitted]');
    expect(parseUnifiedDiff(diff).lines).toMatchObject([{ type: 'header' }]);
  });

  it('omits rendered output over the character budget with few rows', () => {
    const oldText = 'a'.repeat(49_997);
    const newText = 'b'.repeat(49_997);
    expect(oldText.length + newText.length).toBeLessThanOrEqual(100_000);

    const diff = buildContextBoundedDiff(oldText, newText);
    expect(localizeDiffNotice(diff, stubT)).toBe('[approval.diffOmitted]');
    expect(parseUnifiedDiff(diff).lines).toMatchObject([{ type: 'header' }]);
  });

  it.each([
    ['#!/bin/sh\nexit 0\n', '#!/bin/sh\nexit 0', 'trailingNewlineRemoved'],
    ['#!/bin/sh\nexit 0', '#!/bin/sh\nexit 0\n', 'trailingNewlineAdded'],
    [
      '#!/bin/sh\r\nexit 0\r\n',
      '#!/bin/sh\r\nexit 0',
      'trailingNewlineRemoved',
    ],
    ['#!/bin/sh\r\nexit 0', '#!/bin/sh\r\nexit 0\r\n', 'trailingNewlineAdded'],
  ])('shows a trailing-newline-only change', (oldText, newText, key) => {
    const diff = buildContextBoundedDiff(oldText, newText);
    expect(localizeDiffNotice(diff, stubT)).toBe(`[approval.${key}]`);
    expect(parseUnifiedDiff(diff)).toMatchObject({
      additions: 0,
      deletions: 0,
      lines: [{ type: 'header' }],
    });
  });

  it('shows a CRLF-to-CR terminator change instead of reporting no changes', () => {
    // `'a\r\n'` vs `'a\r'` is what a step that drops a single trailing LF from
    // CRLF content produces (`content.replace(/\n$/,'')`). The old strip only
    // matched `\r?\n`, so one side kept a dangling `\r`, the sides compared
    // unequal, and the prefix scan below found identical line arrays and
    // returned `''` — "no changes" for a pending edit that does change the
    // file, while the same edit rendered rows once completed.
    const diff = buildContextBoundedDiff('a\r\n', 'a\r');
    expect(diff).toBe(DIFF_TRAILING_NEWLINE_REMOVED_MARKER);
    expect(localizeDiffNotice(diff, stubT)).toBe(
      '[approval.trailingNewlineRemoved]',
    );
    expect(buildContextBoundedDiff('a\r\nb\r\n', 'a\r\nb\r')).toBe(
      DIFF_TRAILING_NEWLINE_REMOVED_MARKER,
    );
    // Contrast: a real content change on the last line still renders rows.
    expect(buildContextBoundedDiff('a\r\n', 'b\r')).toContain('-a');
  });

  it('shows a middle edit with three context lines and original line numbers', () => {
    const oldLines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[99] = 'updated line 100';
    const parsed = parseUnifiedDiff(
      buildContextBoundedDiff(oldLines.join('\n'), newLines.join('\n')),
    );
    expect(parsed).toMatchObject({ additions: 1, deletions: 1 });
    expect(parsed.lines).toHaveLength(9);
    expect(parsed.lines[0].content).toBe('@@ -97,7 +97,7 @@');
    expect(parsed.lines[1]).toMatchObject({ content: 'line 97', oldLine: 97 });
    expect(parsed.lines[4]).toMatchObject({
      type: 'del',
      content: 'line 100',
      oldLine: 100,
    });
    expect(parsed.lines[5]).toMatchObject({
      type: 'add',
      content: 'updated line 100',
      newLine: 100,
    });
    expect(parsed.lines.at(-1)).toMatchObject({ content: 'line 103' });
  });

  it('separates distant changes and preserves shifted line numbers', () => {
    const oldLines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines.splice(24, 1);
    newLines.splice(4, 0, 'inserted');
    const parsed = parseUnifiedDiff(
      buildContextBoundedDiff(oldLines.join('\n'), newLines.join('\n')),
    );
    expect(parsed).toMatchObject({ additions: 1, deletions: 1 });
    expect(parsed.lines.filter((line) => line.type === 'header')).toHaveLength(
      2,
    );
    expect(parsed.lines.find((line) => line.type === 'add')).toMatchObject({
      content: 'inserted',
      newLine: 5,
    });
    expect(parsed.lines.find((line) => line.type === 'del')).toMatchObject({
      content: 'line 25',
      oldLine: 25,
    });
    expect(parsed.lines.map((line) => line.content)).not.toContain('line 15');
    expect(parsed.lines.at(-1)).toMatchObject({
      content: 'line 28',
      oldLine: 28,
      newLine: 28,
    });
  });

  it('merges overlapping context windows without duplicating changes', () => {
    const oldLines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[5] = 'first change';
    newLines[9] = 'second change';
    const parsed = parseUnifiedDiff(
      buildContextBoundedDiff(oldLines.join('\n'), newLines.join('\n')),
    );
    expect(parsed).toMatchObject({ additions: 2, deletions: 2 });
    expect(parsed.lines.filter((line) => line.type === 'header')).toHaveLength(
      1,
    );
    expect(
      parsed.lines.filter((line) => line.content === 'line 8'),
    ).toHaveLength(1);
  });

  it('trims common ends before applying the LCS memory cap', () => {
    const oldLines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`);
    const newLines = [...oldLines];
    newLines[299] = 'updated';
    const parsed = parseUnifiedDiff(
      buildContextBoundedDiff(oldLines.join('\n'), newLines.join('\n')),
    );
    expect(parsed).toMatchObject({ additions: 1, deletions: 1 });
    expect(parsed.lines).toHaveLength(9);
    expect(parsed.lines[0].content).toBe('@@ -297,7 +297,7 @@');
  });

  it('preserves blank content and zero-length hunk coordinates', () => {
    expect(buildContextBoundedDiff('', 'created\n')).toBe(
      '@@ -0,0 +1,1 @@\n+created',
    );
    expect(buildContextBoundedDiff('removed\n', '')).toBe(
      '@@ -1,1 +0,0 @@\n-removed',
    );
    expect(
      parseUnifiedDiff(buildContextBoundedDiff('a\n\n', 'a\n')),
    ).toMatchObject({
      additions: 0,
      deletions: 1,
      lines: [
        { type: 'header' },
        { type: 'context', content: 'a', oldLine: 1, newLine: 1 },
        { type: 'del', content: '', oldLine: 2 },
      ],
    });
    expect(buildContextBoundedDiff('a\n', 'a\n')).toBe('');
  });
});

describe('parseUnifiedDiff', () => {
  it('tracks hunks without confusing file-like content for headers', () => {
    const parsed = parseUnifiedDiff(
      [
        '--- a/query.sql',
        '+++ b/query.sql',
        '@@ -10,2 +10,2 @@',
        '--- drop table',
        '+++ create table',
        ' keep',
        '@@ -20 +20 @@',
        '-old',
        '\\ No newline at end of file',
        '+new',
      ].join('\n'),
    );

    expect(parsed).toMatchObject({ additions: 2, deletions: 2 });
    expect(parsed.lines[3]).toMatchObject({
      type: 'del',
      content: '-- drop table',
      oldLine: 10,
    });
    expect(parsed.lines[4]).toMatchObject({
      type: 'add',
      content: '++ create table',
      newLine: 10,
    });
    expect(
      parsed.lines.map(({ type, oldLine, newLine }) => ({
        type,
        oldLine,
        newLine,
      })),
    ).toEqual([
      { type: 'header', oldLine: undefined, newLine: undefined },
      { type: 'header', oldLine: undefined, newLine: undefined },
      { type: 'header', oldLine: undefined, newLine: undefined },
      { type: 'del', oldLine: 10, newLine: undefined },
      { type: 'add', oldLine: undefined, newLine: 10 },
      { type: 'context', oldLine: 11, newLine: 11 },
      { type: 'header', oldLine: undefined, newLine: undefined },
      { type: 'del', oldLine: 20, newLine: undefined },
      { type: 'header', oldLine: undefined, newLine: undefined },
      { type: 'add', oldLine: undefined, newLine: 20 },
    ]);
  });

  it('does not add phantom lines for empty content', () => {
    expect(buildUnifiedDiff('', 'new')).toBe('+new');
    expect(buildUnifiedDiff('old', '')).toBe('-old');
  });

  it('falls back to a coarse remove/add strip when the LCS table would allocate too much memory', () => {
    // 600 lines per side ⇒ n*m = 360_000, which exceeds MAX_DIFF_PRODUCT, so
    // the LCS is skipped and the output is a plain concatenation of `-old…`
    // then `+new…`. Total line and char budgets are the caller's concern
    // (approval cards gate on those).
    //
    // The two sides must share lines. A fully disjoint pair has an empty LCS,
    // so the backtrack emits every removal followed by every addition — the
    // exact string the coarse branch concatenates — and the test would still
    // pass with MAX_DIFF_PRODUCT disabled. Every tenth line differing gives
    // the LCS path 540 context rows to emit, which the coarse path cannot.
    const oldText = Array.from({ length: 600 }, (_, i) => `L${i}`).join('\n');
    const newText = Array.from({ length: 600 }, (_, i) =>
      i % 10 === 0 ? `X${i}` : `L${i}`,
    ).join('\n');
    const rows = buildUnifiedDiff(oldText, newText).split('\n');
    expect(rows).toHaveLength(1_200);
    expect(rows.filter((row) => row.startsWith(' '))).toHaveLength(0);
    expect(rows.filter((row) => row.startsWith('-'))).toHaveLength(600);
    expect(rows.filter((row) => row.startsWith('+'))).toHaveLength(600);
    expect(rows[0]).toBe('-L0');
    expect(rows[600]).toBe('+X0');
    expect(rows[1_199]).toBe('+L599');
  });

  it('does not count a trailing newline as an extra line', () => {
    // Real file bodies end with '\n', and `permissionUtils` sends new files as
    // `oldText: ''`. Splitting without dropping the trailing empty segment
    // counted it as a second addition: a one-line new file rendered `+2/-0`
    // with a phantom blank row instead of `+1/-0`.
    expect(buildUnifiedDiff('', 'created line\n')).toBe('+created line');
    expect(buildUnifiedDiff('removed line\n', '')).toBe('-removed line');
    expect(buildUnifiedDiff('a\n', 'a\nb\n')).toBe(' a\n+b');
    // A blank line that is real content still counts.
    expect(buildUnifiedDiff('a\n\n', 'a\n')).toBe(' a\n-');
  });

  it('keeps supporting headerless generated diffs', () => {
    expect(parseUnifiedDiff('-old\n+new\n same')).toMatchObject({
      additions: 1,
      deletions: 1,
      lines: [
        { type: 'del', content: 'old', oldLine: 0 },
        { type: 'add', content: 'new', newLine: 0 },
        { type: 'context', content: 'same', oldLine: 1, newLine: 1 },
      ],
    });
  });
});

describe('CRLF uniformity is decided at the source layer', () => {
  it('stamps the marker when both sides are uniform CRLF, and the parser reports it', () => {
    const diff = buildUnifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n');
    expect(diff.split('\n')[0]).toBe(DIFF_CRLF_UNIFORM_MARKER);
    expect(parseUnifiedDiff(diff).crlfUniform).toBe(true);
  });

  it('allows one unterminated final line per side', () => {
    const diff = buildUnifiedDiff('a\r\nb', 'a\r\nc');
    expect(parseUnifiedDiff(diff).crlfUniform).toBe(true);
  });

  it('refuses the marker when a bare-LF line hides inside a CRLF file', () => {
    // The render boundary cannot distinguish "unterminated final line" from
    // "an LF-terminated line in a mixed-ending file" — the source text can,
    // which is exactly why the decision lives here.
    const diff = buildUnifiedDiff('a\r\nb\nc\r\n', 'a\r\nb\nd\r\n');
    expect(parseUnifiedDiff(diff).crlfUniform).toBe(false);
    expect(diff).not.toContain(DIFF_CRLF_UNIFORM_MARKER);
  });

  it('refuses the marker when a final line is terminated by a bare LF', () => {
    const diff = buildUnifiedDiff('a\r\nb\n', 'a\r\nc\n');
    expect(parseUnifiedDiff(diff).crlfUniform).toBe(false);
  });

  it('refuses the marker when the last blank line is terminated by a bare LF', () => {
    // `'a\r\n\n'` is a CRLF line followed by an empty line closed with a bare
    // `\n`. The interior loop skips that terminator — it is the trailing
    // newline itself — so certifying it stamped uniform-CRLF over a file whose
    // last line-ending is LF, and the renderer then stripped a `\r` that was
    // content.
    expect(
      parseUnifiedDiff(buildUnifiedDiff('a\r\n\n', 'a\r\n\r\n')).crlfUniform,
    ).toBe(false);
    expect(parseUnifiedDiff(buildUnifiedDiff('\n', '\r\n')).crlfUniform).toBe(
      false,
    );
  });

  it('does not stamp the marker for LF files', () => {
    expect(
      parseUnifiedDiff(buildUnifiedDiff('a\n', 'a\nb\n')).crlfUniform,
    ).toBe(false);
  });

  it('reports a terminator-only edit as the trailing-newline notice', () => {
    // Both sides satisfy `isUniformCrlf`'s one-unterminated-final-line
    // allowance, so this pair certified uniform and the strip then deleted the
    // `\r` from both rows: `-y` and `+y` rendered byte-identical under a
    // `+1/-1` badge — a view asserting a change it could not show, and
    // disagreeing with the bounded builder, which answers this exact shape
    // with the notice.
    expect(buildUnifiedDiff('x\r\ny', 'x\r\ny\r\n')).toBe(
      DIFF_TRAILING_NEWLINE_ADDED_MARKER,
    );
    expect(buildUnifiedDiff('x\r\ny\r\n', 'x\r\ny')).toBe(
      DIFF_TRAILING_NEWLINE_REMOVED_MARKER,
    );
  });

  it('reports a CR-only difference as a terminator notice, not as "no change"', () => {
    // `'a\r\n'` and `'a\r'` split to the same line array `['a\r']` — the `\n`
    // was a terminator, the surviving `\r` is content — so the LCS had nothing
    // to mark and emitted a context-only patch: a completed edit card read as
    // "nothing changed" for a file that lost its newline. Rows cannot express
    // the difference, so the builder answers with the notice the bounded
    // builder already returns for this pair.
    expect(buildUnifiedDiff('a\r\n', 'a\r')).toBe(
      DIFF_TRAILING_NEWLINE_REMOVED_MARKER,
    );
    expect(buildUnifiedDiff('a\r', 'a\r\n')).toBe(
      DIFF_TRAILING_NEWLINE_ADDED_MARKER,
    );
    // A pair that differs in its rows is untouched: the notice is for the
    // shapes rows cannot show, not a shortcut for every CR-bearing edit.
    expect(buildUnifiedDiff('a\r\nb\r\n', 'a\r\nc\r\n')).toContain('-b\r\n+c');
  });

  it('keeps an insertion preview of a sole blank line as a content row', () => {
    // The terminator gate needs both sides non-empty. `extractDiff` builds
    // insertion previews from `('', newText)`, and
    // `''.replace(/\r?\n$/, '')` equals `'\n'.replace(/\r?\n$/, '')`, so a
    // guard-less gate would answer the whole edit with a notice about a
    // newline instead of showing the line it adds.
    expect(buildUnifiedDiff('', '\n')).toBe('+');
    expect(parseUnifiedDiff(buildUnifiedDiff('', '\r\n'))).toMatchObject({
      additions: 1,
      deletions: 0,
    });
  });

  it('stamps a negative verdict instead of leaving the renderer to guess', () => {
    // A builder that refused to certify uniformity used to say nothing, and
    // silence was indistinguishable from "no builder ran" — so the renderer
    // voted on the rows the patch happened to show. Here the source layer says
    // "mixed" and the renderer must not overturn it.
    const diff = buildContextBoundedDiff('a\r\n', 'a\n');
    expect(diff.split('\n')[0]).toBe(DIFF_CRLF_MIXED_MARKER);
    expect(parseUnifiedDiff(diff).crlfUniform).toBe(false);
  });

  it('does not let a context window certify a whole file', () => {
    // A partial `core.autocrlf` conversion: the only bare-LF line sits outside
    // the ±3 row window around the change, so every row the patch shows is
    // `\r`-terminated. The rows are honest and the conclusion is not — the
    // window cannot speak for line 1. The verdict can.
    const oldText = 'bare\nc1\r\nc2\r\nc3\r\nz\r';
    const diff = buildContextBoundedDiff(
      oldText,
      'bare\nc1\r\nc2\r\nc3\r\nw\r',
    );
    expect(diff).not.toContain('bare');
    expect(parseUnifiedDiff(diff).crlfUniform).toBe(false);
  });

  it('keeps the marker out of the bounded hunk arithmetic', () => {
    const oldLines = Array.from({ length: 10 }, (_, i) => `L${i}`);
    const newLines = [...oldLines];
    newLines[5] = 'X5';
    // Every line is `\r\n`-terminated, the last one included: a text that ends
    // at a bare `\r` has no terminator there, and that byte is content rather
    // than a line ending (see the bare-CR cases above).
    const oldText = oldLines.map((line) => `${line}\r\n`).join('');
    const newText = newLines.map((line) => `${line}\r\n`).join('');
    const diff = buildContextBoundedDiff(oldText, newText);
    const parsed = parseUnifiedDiff(diff);
    expect(parsed.crlfUniform).toBe(true);
    // One changed row in a 10-line CRLF file: the @@ header counts the hunk
    // rows only (3 context + 1 changed + 3 context per side = 7). Had the
    // marker row leaked into the arithmetic, the counts would read 8/8
    // instead of 7/7.
    const header = parsed.lines.find(
      (line) => line.type === 'header' && line.content.startsWith('@@'),
    );
    expect(header?.content).toBe('@@ -3,7 +3,7 @@');
    expect(
      parsed.lines.filter(
        (line) => line.type === 'header' && line.content.startsWith('\\diff'),
      ),
    ).toHaveLength(1);
  });
});

describe('localizeDiffNotice', () => {
  it('passes real diff content and git notices through untouched', () => {
    // Only the markers `buildContextBoundedDiff` owns are translated; git's own
    // backslash notice, hunk headers and ordinary rows must survive verbatim or
    // the diff would be rewritten on the way to the screen.
    for (const line of [
      '@@ -1,1 +1,1 @@',
      '\\ No newline at end of file',
      '\\diff-something-else',
      'const answer = 42;',
      '',
    ]) {
      expect(localizeDiffNotice(line, stubT)).toBe(line);
    }
  });
});

it.each([
  ['a\n', 'a\r\n'],
  ['a\r\n', 'a\n'],
])(
  'keeps a single-line ending conversion as content rows',
  (oldText, newText) => {
    const diff = buildContextBoundedDiff(oldText, newText);
    expect(parseUnifiedDiff(diff)).toMatchObject({
      additions: 1,
      deletions: 1,
    });
    expect(localizeDiffNotice(diff, stubT)).toBe(diff);
  },
);

it.each([
  ['', '\n', 1, 0],
  ['\n', '', 0, 1],
  ['', '\r\n', 1, 0],
  ['\r\n', '', 0, 1],
])(
  'keeps a sole blank line as a real added or removed row',
  (oldText, newText, additions, deletions) => {
    const diff = buildContextBoundedDiff(oldText, newText);
    expect(parseUnifiedDiff(diff)).toMatchObject({ additions, deletions });
    expect(localizeDiffNotice(diff, stubT)).toBe(diff);
  },
);

describe('a bare final CR is content, not a terminator', () => {
  it('does not certify a pair whose texts end in a bare CR', () => {
    // `isUniformCrlf` allowed a file whose last line has no terminator, and it
    // read `a\r` as such a line — but that `\r` was never followed by `\n`, so
    // it is a byte of content. Certifying it let the renderer strip the byte,
    // leaving a `+1/-1` badge over two rows that then rendered identically.
    const diff = buildUnifiedDiff('a\r', 'b\r');
    expect(diff).not.toContain(DIFF_CRLF_UNIFORM_MARKER);
    expect(parseUnifiedDiff(diff).crlfUniform).toBe(false);
  });

  it('still certifies a pair whose lines end in CRLF', () => {
    const diff = buildUnifiedDiff('a\r\n', 'b\r\n');
    expect(diff).toContain(DIFF_CRLF_UNIFORM_MARKER);
    expect(parseUnifiedDiff(diff).crlfUniform).toBe(true);
  });
});

// Raw patches reach the renderer through `getRawFileDiff` and never pass
// through `buildUnifiedDiff` / `buildContextBoundedDiff`, so no builder saw
// their source text and none of them carries a verdict marker. Their rows
// cannot stand in for the missing answer: a patch shows a context window, not
// the file, and a row cannot distinguish an unterminated final line from an LF
// line inside a mixed file. Voting on them certified whole-file uniformity
// from one-sided evidence, so the answer stays "unknown" and the `\r` stays
// visible as an escape chip.
describe('raw patches are never certified from their own rows', () => {
  const rawPatch = (rows: string[], terminator = '\n') =>
    [
      'Index: notes.txt',
      '===================================================================',
      '--- notes.txt',
      '+++ notes.txt',
      '@@ -1,2 +1,2 @@',
      ...rows,
      '',
    ].join(terminator);

  it('does not certify a patch whose content rows all keep their \\r', () => {
    const patch = rawPatch([' a\r', '-b\r', '+c\r']);
    expect(patch).not.toContain(DIFF_CRLF_UNIFORM_MARKER);
    expect(parseUnifiedDiff(patch).crlfUniform).toBe(false);
  });

  it('does not certify a mixed directory line-ending', () => {
    const patch = rawPatch([' a\r', '-b', '+c\r']);
    expect(parseUnifiedDiff(patch).crlfUniform).toBe(false);
  });

  it('does not certify a bare-LF patch', () => {
    expect(parseUnifiedDiff(rawPatch([' a', '-b', '+c'])).crlfUniform).toBe(
      false,
    );
  });

  it('does not let the unterminated-final-line notice certify', () => {
    // The notice says one row really is a file's unterminated last line, which
    // is what `isUniformCrlf` allows for; it says nothing about the rest of the
    // file, which the patch cannot show. Reading it as a licence to certify is
    // the same one-sided inference in a friendlier costume.
    const patch = rawPatch([
      ' a\r',
      '-b\r',
      '-c',
      '\\ No newline at end of file',
      '+c\r',
    ]);
    expect(parseUnifiedDiff(patch).crlfUniform).toBe(false);
  });

  it('does not certify a single row that kept its terminator', () => {
    // A one-row patch is the thinnest possible evidence: it proves one row had
    // a `\r`, not that the file is uniformly CRLF.
    expect(parseUnifiedDiff('@@ -0,0 +1,1 @@\n+a\r').crlfUniform).toBe(false);
    expect(parseUnifiedDiff('@@ -0,0 +1,1 @@\n+a\r\n').crlfUniform).toBe(false);
  });

  it('does not certify a row truncated by maxLength slicing', () => {
    const patch = rawPatch([' a\r', '-b\r', '+c\r', ' d\r']);
    const truncated = patch.slice(0, patch.indexOf('+c\r') + 2);
    expect(truncated.endsWith('\n')).toBe(false);
    expect(parseUnifiedDiff(truncated).crlfUniform).toBe(false);
  });

  it('still honours the marker when a builder supplied one', () => {
    const patch = `${DIFF_CRLF_UNIFORM_MARKER}\n@@ -1,1 +1,1 @@\n-a\n+b\n`;
    expect(parseUnifiedDiff(patch).crlfUniform).toBe(true);
  });
});

describe('diffPreviewText', () => {
  it('localizes a marker-only preview instead of leaking the token', () => {
    // The pane resolves the notice at its render boundary; Copy reads the same
    // preview, so it has to resolve it too or it hands over `\diff-omitted`.
    expect(diffPreviewText(DIFF_OMITTED_MARKER, stubT)).toBe(
      '[approval.diffOmitted]',
    );
    expect(diffPreviewText(DIFF_TRAILING_NEWLINE_REMOVED_MARKER, stubT)).toBe(
      '[approval.trailingNewlineRemoved]',
    );
  });

  it('drops the verdict row and the CR the pane hides', () => {
    const diff = `${DIFF_CRLF_UNIFORM_MARKER}\n@@ -1,1 +1,1 @@\n-a\r\n+b\r\n`;
    expect(diffPreviewText(diff, stubT)).toBe('@@ -1,1 +1,1 @@\n-a\n+b\n');
  });

  it('keeps the verdict row when it was never certified, and copies the CR', () => {
    const diff = `${DIFF_CRLF_MIXED_MARKER}\n@@ -1,1 +1,1 @@\n-a\r\n+b\r\n`;
    // Mixed file: the pane keeps the verdict row and paints each row's `\r` as
    // text, because there it is content. Copy reads the same preview, so it has
    // to hand over the characters that were painted.
    expect(diffPreviewText(diff, stubT)).toBe(
      '@@ -1,1 +1,1 @@\n-a\\r\n+b\\r\n',
    );
  });

  it('escapes an invisible character into the form the pane paints', () => {
    // `DiffView` renders every row through the invisible-character escape and
    // shows `\u202e` inside an "Invisible character" span. A copier that wrote
    // the live byte would re-arm the override in whatever the paste lands in —
    // the exact payload this preview exists to defuse.
    const diff = '@@ -1,2 +1,2 @@\n-safe\u202elooking\n+safe\u202elooking\n';
    expect(diffPreviewText(diff, stubT)).toBe(
      '@@ -1,2 +1,2 @@\n-safe\\u202elooking\n+safe\\u202elooking\n',
    );
  });

  it('repeats the marker column the pane draws', () => {
    const diff = '@@ -1,2 +1,2 @@\n a\n-b\n+c\n';
    expect(diffPreviewText(diff, stubT)).toBe('@@ -1,2 +1,2 @@\n a\n-b\n+c\n');
  });

  it('bounds the copied text the same way the pane does', () => {
    // `maxLength` cuts the payload, exactly as `DiffView` slices the preview
    // it renders, so even a cut mid-row copies as the pane drew it.
    const diff = '@@ -1,1 +1,1 @@\n-abcdef\n+ghijkl\n';
    expect(diffPreviewText(diff, stubT, 20)).toBe('@@ -1,1 +1,1 @@\n-abc');
  });
});

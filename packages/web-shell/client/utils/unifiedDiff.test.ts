import { describe, expect, it } from 'vitest';
import {
  buildContextBoundedDiff,
  buildUnifiedDiff,
  parseUnifiedDiff,
} from './unifiedDiff';

describe('buildContextBoundedDiff', () => {
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

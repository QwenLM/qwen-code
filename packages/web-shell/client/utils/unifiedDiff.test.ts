import { describe, expect, it } from 'vitest';
import { buildUnifiedDiff, parseUnifiedDiff } from './unifiedDiff';

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
    // 1000 unique deletions vs 1000 unique additions ⇒ n*m = 1_000_000
    // which exceeds MAX_DIFF_PRODUCT, so the LCS is skipped and the output
    // is a simple concatenation of `-old…` then `+new…`. Total lines and
    // char budgets are the caller's concern (approval cards gate on those).
    const oldText = Array.from({ length: 1_000 }, (_, i) => `old-${i}`).join(
      '\n',
    );
    const newText = Array.from({ length: 1_000 }, (_, i) => `new-${i}`).join(
      '\n',
    );
    const result = buildUnifiedDiff(oldText, newText);
    expect(result.startsWith('-old-0\n')).toBe(true);
    expect(result).toContain('\n+new-0\n');
    expect(result.endsWith('+new-999')).toBe(true);
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

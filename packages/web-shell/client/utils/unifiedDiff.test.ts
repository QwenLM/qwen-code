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

  it('omits oversized diffs before constructing their full output', () => {
    expect(buildUnifiedDiff('line\n'.repeat(1_000), '')).toContain(
      'Diff omitted because it is too large to display safely.',
    );
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

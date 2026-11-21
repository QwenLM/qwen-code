import { describe, expect, it } from 'vitest';
import {
  buildComposerPrompt,
  buildComposerPromptWithInlineTagPlacements,
  computeCaretTarget,
  getComposerTagDisplay,
  getComposerTagLabel,
  getComposerTagValue,
  getFollowupCompletion,
  replaceInlineTagPlacements,
  serializeComposerTag,
} from './useComposerCore';

describe('touch editing-key caret targets', () => {
  it('moves right one character and clamps at the document end', () => {
    expect(computeCaretTarget('abc', 1, 1, 'right')).toBe(2);
    expect(computeCaretTarget('abc', 3, 3, 'right')).toBe(3);
  });

  it('collapses a selection to its end when moving right', () => {
    expect(computeCaretTarget('abc', 0, 2, 'right')).toBe(2);
  });

  it('keeps the column across lines and clamps to shorter lines', () => {
    expect(computeCaretTarget('aa\nbbb\ncc', 6, 6, 'up')).toBe(2);
    expect(computeCaretTarget('aaaa\nbb\ncccc', 10, 10, 'up')).toBe(7);
    expect(computeCaretTarget('aa\nbbb', 1, 1, 'down')).toBe(4);
  });

  it('clamps to the document edges when leaving the first or last line', () => {
    expect(computeCaretTarget('aa\nbb', 1, 1, 'up')).toBe(0);
    expect(computeCaretTarget('aa\nbb', 4, 4, 'down')).toBe(5);
  });

  it('lands on empty lines with a zero column', () => {
    expect(computeCaretTarget('a\n\nb', 3, 3, 'up')).toBe(2);
  });

  it('moves from the forward selection head (end), not its anchor', () => {
    expect(computeCaretTarget('aa\nbbb\ncc', 1, 5, 'up')).toBe(2);
    expect(computeCaretTarget('aa\nbbb\ncc', 1, 5, 'down')).toBe(9);
  });

  it('uses the active start of a backward selection for vertical moves', () => {
    expect(
      computeCaretTarget(
        'aa\nbbb\ncc',
        1,
        5,
        'up',
        undefined,
        undefined,
        'backward',
      ),
    ).toBe(0);
    expect(
      computeCaretTarget(
        'aa\nbbb\ncc',
        1,
        5,
        'down',
        undefined,
        undefined,
        'backward',
      ),
    ).toBe(4);
  });

  it('steps a whole grapheme so inserting never splits a surrogate pair', () => {
    const caret = computeCaretTarget('A😀B', 1, 1, 'right');
    expect(caret).toBe(3);
    const next = 'A😀B'.slice(0, caret) + '/' + 'A😀B'.slice(caret);
    expect(next).toBe('A😀/B');
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(next)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(next)).toBe(false);
    expect(computeCaretTarget('A😀B', 3, 3, 'right')).toBe(4);

    const family = '👨‍👩‍👧‍👦';
    const draft = `A${family}B`;
    const familyCaret = computeCaretTarget(draft, 1, 1, 'right');
    expect(familyCaret).toBe(12);
    expect(draft.slice(0, familyCaret) + '/' + draft.slice(familyCaret)).toBe(
      `A${family}/B`,
    );
    expect(computeCaretTarget('Ae\u0301B', 1, 1, 'right')).toBe(3);
  });

  it('clamps vertical moves to grapheme boundaries on astral lines', () => {
    expect(computeCaretTarget('a\n😀b', 1, 1, 'down')).toBe(4);
    expect(computeCaretTarget('😀b\na', 2, 2, 'down')).toBe(5);
    expect(computeCaretTarget('a\n😀b', 4, 4, 'up')).toBe(1);
  });

  it('holds the preferred column across a vertical run', () => {
    const text = 'aaaa\nbb\ncccc';
    const first = computeCaretTarget(text, 12, 12, 'up');
    expect(first).toBe(7);
    expect(computeCaretTarget(text, first, first, 'up', undefined, 4)).toBe(4);
    expect(computeCaretTarget(text, 7, 7, 'up')).toBe(2);
  });

  it('moves between the supplied displayed lines, not only newlines', () => {
    expect(computeCaretTarget('aaaaaa', 4, 4, 'up', [0, 3])).toBe(1);
    expect(computeCaretTarget('aaaaaa', 1, 1, 'down', [0, 3])).toBe(4);
    expect(computeCaretTarget('aaaaaa', 4, 4, 'down', [0, 3])).toBe(6);
  });

  it('clamps up-moves to the whole last grapheme of a wrapped line', () => {
    const text = '😀' + 'a'.repeat(60);
    // Soft-wrap after the emoji: the line end is the wrap boundary itself,
    // not boundary-1, or the emoji's last surrogate unit would be chopped.
    const caret = computeCaretTarget(text, 6, 6, 'up', [0, 2]);
    expect(caret).toBe(2);
    const next = text.slice(0, caret) + '/' + text.slice(caret);
    expect(next.startsWith('😀/')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(next)).toBe(false);
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(next)).toBe(false);
    // An explicit newline keeps the historical skip-the-'\n' behavior.
    expect(computeCaretTarget('😀\naa', 4, 4, 'up')).toBe(2);
  });
});

describe('follow-up completion helpers', () => {
  it('uses the full suggestion when the editor is empty', () => {
    expect(getFollowupCompletion('', 'show me tests')).toBe('show me tests');
  });

  it('keeps a suggestion available while the user types a matching prefix', () => {
    expect(getFollowupCompletion('show', 'show me tests')).toBe(
      'show me tests',
    );
  });

  it('ignores suggestions that no longer match the editor text', () => {
    expect(getFollowupCompletion('run', 'show me tests')).toBeNull();
  });
});

describe('composer tag serialization', () => {
  it('prefers value, then label, then id', () => {
    expect(
      serializeComposerTag({
        id: 'file',
        label: ' File ',
        value: ' src/a.ts ',
      }),
    ).toBe('src/a.ts');
    expect(
      serializeComposerTag({
        id: 'ext',
        label: 'Extension',
        value: 'clickhouse',
        serialized: '@ext:clickhouse',
      }),
    ).toBe('@ext:clickhouse');
    expect(serializeComposerTag({ id: 'mode', label: ' Plan ' })).toBe('Plan');
    expect(serializeComposerTag({ id: 'plain' })).toBe('plain');
  });

  it('returns trimmed label, value, and display text', () => {
    const tag = { id: 'file', label: ' File ', value: ' src/a.ts ' };

    expect(getComposerTagLabel(tag)).toBe('File');
    expect(getComposerTagValue(tag)).toBe('src/a.ts');
    expect(getComposerTagDisplay(tag)).toBe('src/a.ts');
    expect(getComposerTagDisplay({ id: 'goal', label: ' Goal ' })).toBe('Goal');
  });

  it('builds prompts with tags before user text', () => {
    expect(
      buildComposerPrompt('do it', [
        { id: 'file', label: 'File', value: 'src/a.ts' },
        { id: 'goal', label: 'Goal' },
      ]),
    ).toBe('src/a.ts\nGoal\n\ndo it');
    expect(buildComposerPrompt('', [{ id: 'file', value: 'src/a.ts' }])).toBe(
      'src/a.ts',
    );
    expect(buildComposerPrompt('do it', [])).toBe('do it');
  });

  it('keeps inline tags at their editor positions', () => {
    expect(
      buildComposerPromptWithInlineTagPlacements(
        'explain @orders now',
        [{ id: 'top', serialized: '<top />' }],
        [
          {
            start: 8,
            end: 15,
            tag: { id: 'table', value: 'orders', serialized: '<table />' },
          },
        ],
      ),
    ).toBe('<top />\n\nexplain <table /> now');
  });

  it('ignores invalid and overlapping inline tag placements', () => {
    expect(
      replaceInlineTagPlacements('a @one and @two', [
        {
          start: -1,
          end: 2,
          tag: { id: 'negative', serialized: '<negative />' },
        },
        {
          start: 2,
          end: 6,
          tag: { id: 'one', serialized: '<one />' },
        },
        {
          start: 4,
          end: 12,
          tag: { id: 'overlap', serialized: '<overlap />' },
        },
        {
          start: 11,
          end: 15,
          tag: { id: 'two', serialized: '<two />' },
        },
        {
          start: 14,
          end: 99,
          tag: { id: 'beyond', serialized: '<beyond />' },
        },
      ]),
    ).toBe('a <one /> and <two />');
  });
});

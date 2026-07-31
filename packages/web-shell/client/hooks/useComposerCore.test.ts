import { describe, expect, it } from 'vitest';
import {
  buildComposerPrompt,
  buildComposerPromptWithInlineTagPlacements,
  getComposerTagDisplay,
  getComposerTagLabel,
  getComposerTagValue,
  getFollowupCompletion,
  replaceInlineTagPlacements,
  serializeComposerTag,
} from './useComposerCore';

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

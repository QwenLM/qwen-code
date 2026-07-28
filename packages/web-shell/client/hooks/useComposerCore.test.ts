import { describe, expect, it } from 'vitest';
import {
  buildComposerPrompt,
  buildComposerPromptWithInlineTagPlacements,
  createLargePastePlaceholder,
  expandLargePastePlaceholders,
  getComposerTagDisplay,
  getComposerTagLabel,
  getComposerTagValue,
  getFollowupCompletion,
  isLargePaste,
  normalizePastedText,
  prunePendingPastes,
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

describe('large paste helpers', () => {
  it('normalizes CRLF and CR line endings to LF', () => {
    expect(normalizePastedText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  it('treats pastes over 1000 chars or 10 lines as large', () => {
    expect(isLargePaste('a'.repeat(1000))).toBe(false);
    expect(isLargePaste('a'.repeat(1001))).toBe(true);
    // 10 lines => 9 newlines => split length 10, not large.
    expect(isLargePaste('a\n'.repeat(9) + 'a')).toBe(false);
    // 11 lines => split length 11, large.
    expect(isLargePaste('a\n'.repeat(10) + 'a')).toBe(true);
  });

  it('counts code points, not UTF-16 units, for the char threshold', () => {
    // 1001 emoji are 1001 code points but 2002 UTF-16 units.
    expect(isLargePaste('😀'.repeat(1001))).toBe(true);
    expect(isLargePaste('😀'.repeat(1000))).toBe(false);
  });

  it('creates incrementing placeholders keyed by code-point count', () => {
    const pending = new Map<string, string>();
    const first = createLargePastePlaceholder(pending, 1, 'hello');
    expect(first.placeholderText).toBe('[Pasted Content 5 chars]');
    expect(first.nextPasteId).toBe(2);
    const second = createLargePastePlaceholder(
      pending,
      first.nextPasteId,
      'hi',
    );
    expect(second.placeholderText).toBe('[Pasted Content 2 chars] #2');
    expect(second.nextPasteId).toBe(3);
    expect(pending.get('[Pasted Content 5 chars]')).toBe('hello');
    expect(pending.get('[Pasted Content 2 chars] #2')).toBe('hi');
  });

  it('prunes placeholders absent from the doc and resets the id when empty', () => {
    const pending = new Map<string, string>([
      ['[Pasted Content 5 chars]', 'hello'],
      ['[Pasted Content 2 chars] #2', 'hi'],
    ]);
    // Only the first placeholder remains in the doc.
    expect(
      prunePendingPastes(pending, 'x [Pasted Content 5 chars] y'),
    ).toBeNull();
    expect(pending.size).toBe(1);
    expect(pending.has('[Pasted Content 2 chars] #2')).toBe(false);
    // Removing the last placeholder resets the next id to 1.
    expect(prunePendingPastes(pending, 'no placeholders here')).toBe(1);
    expect(pending.size).toBe(0);
  });

  it('prunes by exact placeholder match, not substring', () => {
    const pending = new Map<string, string>([
      ['[Pasted Content 5 chars]', 'aaaaa'],
      ['[Pasted Content 5 chars] #2', 'bbbbb'],
    ]);
    // Only the longer placeholder is in the doc; the shorter one must be
    // pruned even though it is a substring of the longer one.
    expect(
      prunePendingPastes(pending, '[Pasted Content 5 chars] #2'),
    ).toBeNull();
    expect(pending.size).toBe(1);
    expect(pending.has('[Pasted Content 5 chars]')).toBe(false);
    expect(pending.has('[Pasted Content 5 chars] #2')).toBe(true);
  });

  it('expands placeholders back to their pasted content', () => {
    const pending = new Map<string, string>([
      ['[Pasted Content 5 chars]', 'hello'],
    ]);
    expect(
      expandLargePastePlaceholders(pending, 'a [Pasted Content 5 chars] b'),
    ).toBe('a hello b');
    expect(expandLargePastePlaceholders(pending, 'no placeholder')).toBe(
      'no placeholder',
    );
    expect(
      expandLargePastePlaceholders(new Map(), '[Pasted Content 5 chars]'),
    ).toBe('[Pasted Content 5 chars]');
  });

  it('replaces a placeholder that is a substring of another', () => {
    // "[Pasted Content 5 chars]" is a prefix of "[Pasted Content 5 chars] #2";
    // the longer placeholder must win regardless of map insertion order.
    const pending = new Map<string, string>([
      ['[Pasted Content 5 chars]', 'aaaaa'],
      ['[Pasted Content 5 chars] #2', 'bbbbb'],
    ]);
    expect(
      expandLargePastePlaceholders(pending, '[Pasted Content 5 chars] #2'),
    ).toBe('bbbbb');
    expect(
      expandLargePastePlaceholders(
        pending,
        '[Pasted Content 5 chars] and [Pasted Content 5 chars] #2',
      ),
    ).toBe('aaaaa and bbbbb');
  });
});

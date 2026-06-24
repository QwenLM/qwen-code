import { describe, expect, it } from 'vitest';
import {
  buildComposerPrompt,
  createLargePastePlaceholder,
  expandLargePastePlaceholders,
  getComposerTagDisplay,
  getComposerTagLabel,
  getComposerTagValue,
  isLargePaste,
  normalizePastedText,
  prunePendingPastes,
  serializeComposerTag,
} from './useComposerCore';

describe('composer paste helpers', () => {
  it('normalizes CRLF and CR newlines', () => {
    expect(normalizePastedText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('treats short text as a normal paste', () => {
    expect(isLargePaste('hello\nworld')).toBe(false);
  });

  it('treats long text as a large paste', () => {
    expect(isLargePaste('x'.repeat(1001))).toBe(true);
  });

  it('treats many lines as a large paste', () => {
    expect(isLargePaste(Array.from({ length: 11 }, () => 'x').join('\n'))).toBe(
      true,
    );
  });
});

describe('large paste placeholders', () => {
  it('creates stable placeholders and increments duplicate labels', () => {
    const pending = new Map<string, string>();

    const first = createLargePastePlaceholder(pending, 1, 'abc');
    const second = createLargePastePlaceholder(
      pending,
      first.nextPasteId,
      'def',
    );

    expect(first).toEqual({
      placeholderText: '[Pasted Content 3 chars]',
      nextPasteId: 2,
    });
    expect(second).toEqual({
      placeholderText: '[Pasted Content 3 chars] #2',
      nextPasteId: 3,
    });
    expect(pending.get(first.placeholderText)).toBe('abc');
    expect(pending.get(second.placeholderText)).toBe('def');
  });

  it('expands longer placeholder names before shorter prefixes', () => {
    const pending = new Map<string, string>([
      ['[Pasted Content 3 chars]', 'first'],
      ['[Pasted Content 3 chars] #2', 'second'],
    ]);

    expect(
      expandLargePastePlaceholders(
        pending,
        '[Pasted Content 3 chars] #2\n[Pasted Content 3 chars]',
      ),
    ).toBe('second\nfirst');
  });

  it('prunes placeholders missing from the current editor text', () => {
    const pending = new Map<string, string>([
      ['[Pasted Content 3 chars]', 'first'],
      ['[Pasted Content 4 chars]', 'next'],
    ]);

    expect(prunePendingPastes(pending, '[Pasted Content 4 chars]')).toBeNull();
    expect([...pending.keys()]).toEqual(['[Pasted Content 4 chars]']);
    expect(prunePendingPastes(pending, '')).toBe(1);
    expect(pending.size).toBe(0);
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
});

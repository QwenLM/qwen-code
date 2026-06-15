import { describe, expect, it } from 'vitest';
import {
  createLargePastePlaceholder,
  expandLargePastePlaceholders,
  isLargePaste,
  normalizePastedText,
  prunePendingPastes,
} from './Editor';

describe('Editor large paste helpers', () => {
  it('normalizes pasted newlines before threshold checks', () => {
    const pasted = 'a\r\nb\rc';

    expect(normalizePastedText(pasted)).toBe('a\nb\nc');
  });

  it('treats long or multi-line pasted text as a large paste', () => {
    expect(isLargePaste('x'.repeat(1001))).toBe(true);
    expect(isLargePaste(Array.from({ length: 11 }, () => 'x').join('\n'))).toBe(
      true,
    );
    expect(isLargePaste('short\ntext')).toBe(false);
  });

  it('creates stable placeholders and expands them on submit', () => {
    const pendingPastes = new Map<string, string>();
    const firstPaste = 'first pasted block';
    const secondPaste = 'second pasted block';

    const first = createLargePastePlaceholder(pendingPastes, 1, firstPaste);
    const second = createLargePastePlaceholder(
      pendingPastes,
      first.nextPasteId,
      secondPaste,
    );

    expect(first.placeholderText).toBe('[Pasted Content 18 chars]');
    expect(second.placeholderText).toBe('[Pasted Content 19 chars] #2');
    expect(second.nextPasteId).toBe(3);
    expect(
      expandLargePastePlaceholders(
        pendingPastes,
        `before ${first.placeholderText} middle ${second.placeholderText} after`,
      ),
    ).toBe(`before ${firstPaste} middle ${secondPaste} after`);
  });

  it('removes deleted placeholders and resets the counter once none remain', () => {
    const pendingPastes = new Map<string, string>();
    const first = createLargePastePlaceholder(pendingPastes, 1, 'first');
    const second = createLargePastePlaceholder(
      pendingPastes,
      first.nextPasteId,
      'second',
    );

    expect(
      prunePendingPastes(pendingPastes, second.placeholderText),
    ).toBeNull();
    expect([...pendingPastes.keys()]).toEqual([second.placeholderText]);
    expect(prunePendingPastes(pendingPastes, '')).toBe(1);
    expect(pendingPastes.size).toBe(0);
  });

  it('leaves unknown placeholder-shaped text unchanged', () => {
    expect(
      expandLargePastePlaceholders(
        new Map(),
        'keep [Pasted Content 10 chars] as text',
      ),
    ).toBe('keep [Pasted Content 10 chars] as text');
  });
});

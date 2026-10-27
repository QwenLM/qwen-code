import { describe, expect, it, vi } from 'vitest';
import {
  createInputAnnotationsFromComposerTags,
  splitComposerTagContentByAnnotations,
} from './composerTag';
import {
  QUOTE_REFERENCE_MAX_CHARS,
  buildQuoteReferenceTag,
  flattenQuoteText,
  insertQuoteIntoComposer,
  isQuotableText,
  quoteReferenceInsertText,
} from './quoteReference';

describe('flattenQuoteText', () => {
  it('strips bidirectional control characters', () => {
    expect(flattenQuoteText('a\u202Eb\u2066c')).toBe('abc');
  });

  it('strips every Bidi_Control character, including the Arabic letter mark', () => {
    expect(flattenQuoteText('a\u061Cb\u200Ec\u2069d')).toBe('abcd');
  });

  it('keeps zero-width joiners inside emoji sequences', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}';
    expect(flattenQuoteText(`team ${family}`)).toBe(`team ${family}`);
  });

  it('collapses newlines and repeated spaces into one space', () => {
    expect(flattenQuoteText('  line one\n\nline\ttwo   ')).toBe(
      'line one line two',
    );
  });

  it('returns an empty string for blank selections', () => {
    expect(flattenQuoteText(' \n\t ')).toBe('');
  });

  it('caps the fragment at the documented length', () => {
    const long = 'x'.repeat(QUOTE_REFERENCE_MAX_CHARS + 50);
    const flattened = flattenQuoteText(long);
    expect(flattened).toHaveLength(QUOTE_REFERENCE_MAX_CHARS + 1);
    expect(flattened.endsWith('…')).toBe(true);
  });

  it('never cuts a surrogate pair at the length cap', () => {
    const long = `${'x'.repeat(QUOTE_REFERENCE_MAX_CHARS - 1)}\u{1F600}tail`;
    const flattened = flattenQuoteText(long);
    expect(flattened).toBe(`${'x'.repeat(QUOTE_REFERENCE_MAX_CHARS - 1)}…`);
  });
});

describe('isQuotableText', () => {
  it('rejects selections with nothing left after normalization', () => {
    expect(isQuotableText('\u061C\u200F \n')).toBe(false);
    expect(isQuotableText(' ok ')).toBe(true);
  });
});

describe('quoteReferenceInsertText', () => {
  it('prefixes the markdown blockquote marker', () => {
    expect(quoteReferenceInsertText('quoted text')).toBe('> quoted text');
  });
});

describe('buildQuoteReferenceTag', () => {
  it('returns null when nothing quotable remains', () => {
    expect(buildQuoteReferenceTag(' \n\t ')).toBeNull();
  });

  it('builds a quote tag with its own id per insertion', () => {
    const first = buildQuoteReferenceTag('same text');
    const second = buildQuoteReferenceTag('same text');
    for (const tag of [first, second]) {
      expect(tag).toMatchObject({
        kind: 'quote',
        value: 'same text',
        serialized: '> same text',
      });
      expect(tag?.id).toMatch(/^quote:[0-9a-f]{8}-[0-9a-z]+$/);
    }
    // Two quotes of one fragment are independent chips: removing one by id
    // must not remove the other.
    expect(first?.id).not.toBe(second?.id);
  });

  it('uses distinct ids for distinct fragments', () => {
    const a = buildQuoteReferenceTag('fragment a');
    const b = buildQuoteReferenceTag('fragment b');
    expect(a?.id).not.toBe(b?.id);
  });
});

describe('insertQuoteIntoComposer', () => {
  it('hands the composer a quote tag and reports the outcome', () => {
    const insertQuote = vi.fn(() => true);
    expect(insertQuoteIntoComposer({ insertQuote }, ' quoted\ntext ')).toBe(
      true,
    );
    expect(insertQuote).toHaveBeenCalledTimes(1);
    expect(insertQuote.mock.calls[0]![0]).toMatchObject({
      kind: 'quote',
      serialized: '> quoted text',
    });
  });

  it('reports a declined insertion', () => {
    expect(insertQuoteIntoComposer({ insertQuote: () => false }, 'x')).toBe(
      false,
    );
  });

  it('does nothing without a composer or quotable text', () => {
    const insertQuote = vi.fn(() => true);
    expect(insertQuoteIntoComposer(null, 'text')).toBe(false);
    expect(insertQuoteIntoComposer({}, 'text')).toBe(false);
    expect(insertQuoteIntoComposer({ insertQuote }, ' \u200F ')).toBe(false);
    expect(insertQuote).not.toHaveBeenCalled();
  });
});

describe('quote tag through the composer annotations', () => {
  it('survives the submit annotation round trip', () => {
    const tag = buildQuoteReferenceTag('first line\nsecond  line');
    if (!tag) throw new Error('expected a quote tag');
    const content = `Fix the quoted part: ${tag.serialized}`;
    const annotations = createInputAnnotationsFromComposerTags(content, [tag]);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.type).toBe('reference');
    expect(annotations[0]?.reference?.kind).toBe('quote');
    const segments = splitComposerTagContentByAnnotations(content, annotations);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({
      type: 'text',
      text: 'Fix the quoted part: ',
    });
    expect(segments[1]).toEqual({
      type: 'reference',
      tag: {
        id: tag.id,
        kind: 'quote',
        value: 'first line second line',
        serialized: '> first line second line',
      },
    });
  });
});

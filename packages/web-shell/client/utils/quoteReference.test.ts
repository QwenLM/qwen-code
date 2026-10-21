import { describe, expect, it } from 'vitest';
import {
  createInputAnnotationsFromComposerTags,
  splitComposerTagContentByAnnotations,
} from './composerTag';
import {
  QUOTE_REFERENCE_MAX_CHARS,
  buildQuoteReferenceTag,
  flattenQuoteText,
  quoteReferenceInsertText,
} from './quoteReference';

describe('flattenQuoteText', () => {
  it('strips bidirectional control characters', () => {
    expect(flattenQuoteText('a\u202Eb\u2066c')).toBe('abc');
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

  it('builds a deterministic quote tag', () => {
    const first = buildQuoteReferenceTag('same text');
    const second = buildQuoteReferenceTag('same text');
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: 'quote',
      value: 'same text',
      serialized: '> same text',
    });
    expect(first?.id).toMatch(/^quote:[0-9a-f]{8}$/);
  });

  it('uses distinct ids for distinct fragments', () => {
    const a = buildQuoteReferenceTag('fragment a');
    const b = buildQuoteReferenceTag('fragment b');
    expect(a?.id).not.toBe(b?.id);
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

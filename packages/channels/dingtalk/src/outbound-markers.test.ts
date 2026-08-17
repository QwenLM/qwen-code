import { describe, expect, it } from 'vitest';
import {
  findOutboundMediaMarkers,
  stripPartialOutboundMediaMarker,
  truncateOutboundMediaText,
} from './outbound-markers.js';

const TRUNCATION_MARKER = '[Earlier output truncated]\n';

describe('stripPartialOutboundMediaMarker', () => {
  // Both backward `[` walks used `lastIndexOf('[', open - 1)`, which clamps a
  // negative fromIndex to 0 and so returns 0 forever on text starting with `[`.
  // Every outbound message passes through here, so the hang froze the channel.
  it.each([
    ['a bracketed prefix', '[1] hello'],
    ['the adapter own failure notice', '[File delivery failed: report.txt]'],
    ['a progress prefix', '[Step 1] working'],
  ])('terminates on %s', (_label, text) => {
    expect(stripPartialOutboundMediaMarker(text, 'FILE', '')).toBe(text);
  });

  it('strips at the earliest unclosed marker, not the latest', () => {
    // A max-tokens cutoff mid-second-marker leaves two unclosed markers. A
    // backward walk that returns on its first hit keeps the earlier one — and
    // its absolute path — as literal text in the delivered card.
    expect(
      stripPartialOutboundMediaMarker(
        'see [IMAGE: /Users/ben/a.png [IMAGE: /Users/ben/b.png',
        'IMAGE',
        '[Image pending]',
      ),
    ).toBe('see [Image pending]');
  });

  it('leaves text with no partial marker alone', () => {
    expect(stripPartialOutboundMediaMarker('plain answer', 'FILE', '')).toBe(
      'plain answer',
    );
  });
});

describe('findOutboundMediaMarkers', () => {
  it('requires the whole marker on one line', () => {
    // `\s*` after the colon would match a newline, letting a marker span lines
    // — a shape the truncation guard cannot model, since it only ever looks for
    // a same-line close.
    expect(
      findOutboundMediaMarkers('[FILE:\n/tmp/report.txt]', 'FILE'),
    ).toEqual([]);
    expect(findOutboundMediaMarkers('[FILE: /tmp/report.txt]', 'FILE')).toEqual(
      [{ start: 0, end: 23, path: '/tmp/report.txt' }],
    );
  });

  it('ignores markers inside fenced code', () => {
    expect(
      findOutboundMediaMarkers('```\n[FILE: /tmp/report.txt]\n```', 'FILE'),
    ).toEqual([]);
  });
});

describe('truncateOutboundMediaText', () => {
  it('terminates on text starting with an unclosed bracket', () => {
    const text = `[${'a'.repeat(500)}`;
    expect(truncateOutboundMediaText(text, 100, '...')).toHaveLength(100);
  });

  it('does not collapse the retained window on a bare bracket at the cut', () => {
    // Returning `text.length` when the candidate has no same-line close
    // discarded everything: a 28k answer became the truncation marker alone.
    const text = `${'a'.repeat(114)}[${'b'.repeat(53)}`;
    const truncated = truncateOutboundMediaText(text, 80, TRUNCATION_MARKER);
    expect(truncated.length).toBeGreaterThan(TRUNCATION_MARKER.length);
    expect(truncated.endsWith('b')).toBe(true);
  });

  it('advances the cut past a marker split immediately after its bracket', () => {
    // The empty candidate between `[` and `FILE:` is a valid prefix of every
    // marker name. Skipping the check left the tail starting `FILE: /path]`,
    // a fragment with no opening bracket for any downstream sanitizer to catch.
    const path = '/Users/ben/private/report.pdf';
    const text = `${'a'.repeat(200)}[FILE: ${path}] trailing`;
    const truncated = truncateOutboundMediaText(
      text,
      `FILE: ${path}] trailing`.length + TRUNCATION_MARKER.length,
      TRUNCATION_MARKER,
    );
    expect(truncated).not.toContain(path);
    expect(truncated).not.toContain('FILE:');
  });

  it('re-opens a fence the cut landed inside', () => {
    // Without the re-opener the retained tail has inverted fence parity: the
    // block's CLOSING fence reads as an opening one, so the code masker stops
    // masking real code and a genuine marker outside the block survives.
    const text = `${'a'.repeat(50)}\n\`\`\`\n${'code\n'.repeat(20)}\`\`\`\nafter [FILE: /tmp/x.txt]`;
    const truncated = truncateOutboundMediaText(text, 120, TRUNCATION_MARKER);
    expect(truncated.startsWith(`${TRUNCATION_MARKER}\`\`\`\n`)).toBe(true);
    expect(findOutboundMediaMarkers(truncated, 'FILE')).toHaveLength(1);
  });

  it('leaves text within the limit untouched', () => {
    expect(truncateOutboundMediaText('short', 100, TRUNCATION_MARKER)).toBe(
      'short',
    );
  });
});

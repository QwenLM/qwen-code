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

describe('R1 round-1 Critical regressions', () => {
  const PRIVATE = '/Users/ben/private/report.pdf';

  // R1-5: the backward walk broke at the first newline, so only a marker on
  // the FINAL line could be stripped — an abandoned marker with output after
  // it survived every sanitizer and put the absolute path on the card.
  it('strips an abandoned marker that is not on the last line', () => {
    const text = `[FILE: ${PRIVATE}\nDone. Summary follows.`;
    const stripped = stripPartialOutboundMediaMarker(text, 'FILE', '');
    expect(stripped).not.toContain(PRIVATE);
    expect(stripped).toContain('Done. Summary follows.');
  });

  // R1-4: a marker whose path starts on the next line was detected by no
  // layer — the same-line grammar misses it and the stripper broke on the
  // newline — so it shipped verbatim.
  it('strips a marker whose close sits on a later line', () => {
    const text = `Here you go:\n[IMAGE:\n/etc/passwd]\ndone`;
    const stripped = stripPartialOutboundMediaMarker(text, 'IMAGE', '');
    expect(stripped).not.toContain('/etc/passwd');
  });

  // R1-10: the path class admitted `[`, so an outer marker consumed the inner
  // marker's closing bracket and left a bracket-less path no sanitizer could
  // find. The inner marker must match first.
  it('matches the inner marker when they nest', () => {
    const markers = findOutboundMediaMarkers(
      'x [FILE: [FILE: /a]/secret/key.pdf] y',
      'FILE',
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]!.path).toBe('/a');
  });

  // R1-8: blanking every indented line hid markers on list-continuation
  // lines, which CommonMark does not treat as code.
  it('finds a marker on a list-continuation line', () => {
    const markers = findOutboundMediaMarkers(
      `- step one\n- step two\n    [FILE: ${PRIVATE}]`,
      'FILE',
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]!.path).toBe(PRIVATE);
  });

  it('still masks a genuine indented code block', () => {
    expect(
      findOutboundMediaMarkers(`prose\n\n    [FILE: ${PRIVATE}]`, 'FILE'),
    ).toHaveLength(0);
  });

  // R1-9: a short backtick run spanning lines masked a genuine marker from
  // every layer.
  it('finds a marker masked by a cross-line inline span', () => {
    const markers = findOutboundMediaMarkers(
      `Here's the config:\n\`key = value\n[IMAGE: ${PRIVATE}]\``,
      'IMAGE',
    );
    expect(markers).toHaveLength(1);
  });

  it('still masks a same-line inline span', () => {
    expect(
      findOutboundMediaMarkers(`see \`[FILE: ${PRIVATE}]\` here`, 'FILE'),
    ).toHaveLength(0);
  });

  // R1-7: the guard returned the raw cut, dropping the opening `[` and
  // leaving a bare path fragment no sanitizer recognises.
  it('does not leave a bracket-less path when the cut splits an unclosed marker', () => {
    // The worst case is a cut one character past the `[`: the whole path is
    // then in the retained window, and dropping the bracket leaves a bare
    // `FILE: /abs/path` fragment that no sanitizer can recognise. A short
    // truncation marker is what makes the cut land that early — with the real
    // 27-char one, `start` is always at least 28.
    const text = `[FILE: ${PRIVATE}` + 'Z'.repeat(65);
    expect(text).toHaveLength(101);
    const truncated = truncateOutboundMediaText(text, 100, '…');
    expect(truncated).not.toContain('/Users/ben/private');
    expect(truncated).not.toContain('FILE:');
  });

  // R1-11: a prose bracket prefix-matches too, and jumping to the next `]`
  // swallowed an intact marker that was fully inside the retained window.
  it('keeps an intact marker when the cut lands in a prose bracket', () => {
    // A short truncation marker is what puts the cut inside the prose token
    // `[IMAGE`: with the real 27-char marker the cut can never land that early
    // in a text short enough to still need truncating.
    const text = `[IMAGE [FILE: /tmp/report.txt]${' tail'.repeat(20)}`;
    const truncated = truncateOutboundMediaText(text, 128, '…');
    expect(truncated).toContain('[FILE: /tmp/report.txt]');
  });

  // R1-3: the fence re-opener was prepended ON TOP of a tail already sized to
  // the whole budget, so the result ran over the limit every consumer assumes.
  it.each([3, 60])(
    'keeps the result within the limit with a %s-backtick fence',
    (fenceLength) => {
      const text = '`'.repeat(fenceLength) + '\n' + 'a'.repeat(20_010);
      const truncated = truncateOutboundMediaText(
        text,
        20_000,
        TRUNCATION_MARKER,
      );
      expect(truncated.length).toBeLessThanOrEqual(20_000);
    },
  );
});

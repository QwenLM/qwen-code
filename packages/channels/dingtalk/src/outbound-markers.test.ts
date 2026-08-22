import { describe, expect, it } from 'vitest';
import {
  findOutboundMediaMarkers,
  stripPartialOutboundMediaMarker,
  truncateOutboundMediaText,
} from './outbound-markers.js';
import {
  sanitizeFileMarkersToFixedPoint,
  sanitizeStreamingFileMarkers,
} from './outbound-file.js';
import { sanitizeStreamingImageMarkers } from './outbound-image.js';

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
    expect(stripped).toContain('done');
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

describe('R2 round-2 Critical regressions', () => {
  const PRIVATE = '/Users/ben/private/report.pdf';

  // rc:3804493271 / R2-3: the splice removed only the EARLIEST unclosed
  // marker and the IMAGE display callers invoke the stripper exactly once, so
  // a second unclosed marker on a later line shipped its absolute path. Both
  // must go in a single call.
  it('strips every unclosed marker in one pass, not just the earliest', () => {
    expect(
      stripPartialOutboundMediaMarker(
        '[IMAGE: /secret/a.png\n\nsome text\n\n[IMAGE: /secret/b.png',
        'IMAGE',
        '[Image pending]',
      ),
    ).toBe('[Image pending]\n\nsome text\n\n');
    expect(
      stripPartialOutboundMediaMarker(
        '[IMAGE: decoy\n\n[IMAGE: /secret/real.png',
        'IMAGE',
        '[Image pending]',
      ),
    ).not.toContain('/secret/real.png');
  });

  // rc:3804493311: the stripper hunted residue in maskCode(text), so an
  // abandoned marker inside a masked code construct was invisible to every
  // layer and the absolute path reached the card. Residue must be stripped
  // from the RAW text; a COMPLETE marker quoted in code keeps its `]` and is
  // never touched by this pass.
  it('strips an abandoned marker inside a fenced code block', () => {
    const stripped = stripPartialOutboundMediaMarker(
      '```\n[FILE: /Users/ben/private/report.pdf\n```\ndone',
      'FILE',
      '',
    );
    expect(stripped).not.toContain(PRIVATE);
    expect(stripped).toContain('done');
  });

  it('strips an abandoned marker inside an inline span', () => {
    // Fail-closed: the residue runs from the opening `[` to end of line, so
    // whatever followed the abandoned marker on that line goes with it — the
    // same extent the unmasked control strips to. The path must not survive.
    const stripped = stripPartialOutboundMediaMarker(
      'see `[FILE: /Users/ben/private/report.pdf` ok',
      'FILE',
      '',
    );
    expect(stripped).not.toContain(PRIVATE);
    expect(stripped).toBe('see `');
  });

  it('still leaves a complete marker inside code untouched', () => {
    const text = '```text\n[FILE: /Users/ben/fenced.pdf]\n```';
    expect(stripPartialOutboundMediaMarker(text, 'FILE', '')).toBe(text);
  });

  // rc:3804493313: the cross-line extension treated ANY bare `]` on a later
  // line as the abandoned marker's close and deleted the prose in between.
  // Only a single whitespace-free path token may extend the strip.
  it('keeps prose carrying a later bracket when extending cross-line', () => {
    const stripped = stripPartialOutboundMediaMarker(
      `[FILE: ${PRIVATE}\nAnalysis complete ]`,
      'FILE',
      '',
    );
    expect(stripped).not.toContain(PRIVATE);
    expect(stripped).toContain('Analysis complete ]');
  });

  it('still strips the cross-line single-token path shape', () => {
    const stripped = stripPartialOutboundMediaMarker(
      'Here you go:\n[IMAGE:\n/etc/passwd]\ndone',
      'IMAGE',
      '',
    );
    expect(stripped).not.toContain('/etc/passwd');
    expect(stripped).toContain('done');
  });

  // rc:3804660649 / R2-8: the cross-line bracket veto ran on the MASKED text,
  // so a `[` inside an inline span was blanked and could not stop the
  // extension — user content was silently deleted. The veto must see the
  // original text.
  it('does not swallow content past a bracket hidden in an inline span', () => {
    const stripped = stripPartialOutboundMediaMarker(
      '[FILE: /tmp/x\nsee `arr[i]` ] done',
      'FILE',
      '',
    );
    expect(stripped).not.toContain('/tmp/x');
    expect(stripped).toContain('arr[i]');
    expect(stripped).toContain('done');
  });

  // rc:3804493327: when the cut lands between the keyword and a BRACKETED
  // path, the strict completed-marker regex fails and the guard returned the
  // raw cut — retaining a bracket-less path no sanitizer recognises. A span
  // that genuinely opens a marker must advance the cut past its same-line
  // extent; only prose brackets keep the raw cut.
  it('does not retain a bracketed marker path when the cut splits it', () => {
    const text = `${'a'.repeat(10)}[FILE: /etc/passwd [b] c]${'y'.repeat(50)}`;
    // limit chosen so the naive cut lands right after `[FILE: `.
    const truncated = truncateOutboundMediaText(text, 69, '…');
    expect(truncated).not.toContain('/etc/passwd');
    // R3-8: the advance targets the span's balanced bracket extent, not
    // end-of-line — the content after the bracketed marker must survive.
    expect(truncated).toContain('y'.repeat(50));
  });

  it('keeps the raw cut for a prose bracket that merely prefix-matches', () => {
    // `[FILE-x` prefix-matches `FILE:` but is not a marker (no colon); the
    // retained window must not be collapsed for it. limit lands the cut inside
    // the bracket so the guard's opensMarker check is what keeps the raw cut.
    const text = `${'a'.repeat(10)}[FILE-x]${'y'.repeat(50)}`;
    const truncated = truncateOutboundMediaText(text, 57, '…');
    expect(truncated).toContain('ILE-x');
    expect(truncated.length).toBeLessThanOrEqual(57);
  });

  // rc:3804493280: the fence re-open loop broke on `budget <= 0` with the
  // re-opener still set, prepending an unreserved fence on top of a tail
  // already sized to the whole budget and breaking the `<= limit` guarantee.
  it('keeps the result within the limit when the fence exhausts the budget', () => {
    const text = '`'.repeat(200) + '\n' + 'a'.repeat(500);
    const truncated = truncateOutboundMediaText(text, 200, '…(truncated)');
    expect(truncated.length).toBeLessThanOrEqual(200);
  });
});

describe('R3 round-3 Critical regressions', () => {
  // R3-1: a bracketed path matches NO grammar layer — the finder's path class
  // excludes brackets and the stripper used to skip every candidate with a
  // same-line `]` — so a bracketed FILE/IMAGE marker shipped its absolute
  // path on every display surface and was never delivered. After the replace
  // pass every well-formed marker is gone, so any surviving opening that
  // prefix-matches a marker name is ill-formed residue: strip it regardless
  // of inner brackets. Prose brackets like `[note]` never prefix-match.
  it('strips bracketed marker openings the finder cannot deliver', () => {
    expect(
      sanitizeFileMarkersToFixedPoint('[FILE: /workspace/report [draft].pdf]'),
    ).toBe('');
    expect(
      sanitizeStreamingImageMarkers('[IMAGE: /workspace/Screenshot [1].png]'),
    ).toBe('[Image pending]');
    expect(
      stripPartialOutboundMediaMarker(
        'x [FILE: /etc/passwd [IMAGE: /tmp/a.png]',
        'FILE',
        '',
      ),
    ).not.toContain('/etc/passwd');
    // A spaced opening matches no delivery grammar either.
    expect(sanitizeFileMarkersToFixedPoint('[ FILE: /etc/passwd]')).toBe('');
    // The delivery grammar is unchanged: bracketed paths are never delivered.
    expect(
      findOutboundMediaMarkers('[FILE: /workspace/report [draft].pdf]', 'FILE'),
    ).toEqual([]);
  });

  it('still leaves a well-formed complete marker alone for the stripper', () => {
    // Only ILL-FORMED openings are stripped fail-closed; a well-formed marker
    // quoted in code keeps the pinned leave-alone behaviour.
    const text = '```text\n[FILE: /Users/ben/fenced.pdf]\n```';
    expect(stripPartialOutboundMediaMarker(text, 'FILE', '')).toBe(text);
  });

  // R3-4: the cross-line extension used to demand a whitespace-free next-line
  // token and vetoed any `[` on the marker's OWN line, so a spaced path and a
  // marker-line bracket both leaked the path line.
  it('extends the strip to a spaced path on the next line', () => {
    const stripped = stripPartialOutboundMediaMarker(
      '[FILE:\n/workspace/quarterly report.pdf] done',
      'FILE',
      '',
    );
    expect(stripped).not.toContain('/workspace/quarterly report.pdf');
    expect(stripped).toContain('done');
  });

  it('extends the strip past a bracketed fragment on the marker line', () => {
    const stripped = stripPartialOutboundMediaMarker(
      '[FILE: [draft\n/Users/ben/private/report.pdf]',
      'FILE',
      '',
    );
    expect(stripped).not.toContain('/Users/ben/private/report.pdf');
  });

  // R2-6: with no closing `]` anywhere, only the `[NAME:` line was replaced
  // and the bare path line shipped. Cover the following bracket-free line.
  it('covers the path line when the marker never closes', () => {
    const stripped = stripPartialOutboundMediaMarker(
      '[IMAGE:\n/Users/ben/x\nmore text',
      'IMAGE',
      '[Image pending]',
    );
    expect(stripped).not.toContain('/Users/ben/x');
    expect(stripped).toContain('more text');
  });

  // R3-9: a bare name prefix is prose, not residue — the IMAGE caller minted
  // an `[Image pending]` claim the delivery path could never honour.
  it('keeps bare name prefixes as prose', () => {
    expect(
      stripPartialOutboundMediaMarker('array[i', 'IMAGE', '[Image pending]'),
    ).toBe('array[i');
    expect(
      stripPartialOutboundMediaMarker('[i', 'IMAGE', '[Image pending]'),
    ).toBe('[i');
    expect(stripPartialOutboundMediaMarker('array[i', 'FILE', '')).toBe(
      'array[i',
    );
    // A genuine opening still strips.
    expect(
      stripPartialOutboundMediaMarker(
        'see [IMAGE: /tmp/pic.png',
        'IMAGE',
        '[Image pending]',
      ),
    ).toBe('see [Image pending]');
  });

  // R2-7: the guard advanced only to the marker's first line end for a
  // cross-line marker, depositing a bare path line (or fragment) at the head
  // of the retained tail that no sanitizer recognises.
  it('advances the cut past a cross-line marker like the stripper', () => {
    const text = `${'a'.repeat(30)}[FILE:\n/secret/deep/path.pdf] tail text here`;
    const open = 30;
    for (const offset of [3, 5, 8, 15, 22]) {
      const limit = text.length - (open + offset) + TRUNCATION_MARKER.length;
      const truncated = truncateOutboundMediaText(
        text,
        limit,
        TRUNCATION_MARKER,
      );
      expect(truncated).not.toContain('/secret/deep/path.pdf');
      expect(truncated).toContain('tail text here');
    }
  });

  // R3-8: the R2-12 advance to end-of-line collapsed the ENTIRE retained
  // window to the truncation marker when a bracketed marker sat on the final
  // line — a ~20k answer became the 27-char marker.
  it('keeps the retained window when a bracketed marker ends the text', () => {
    const marker = '[FILE: /workspace/quarterly-report-final-version [v2].pdf]';
    for (const total of [20_001, 20_015, 20_025]) {
      const text = marker + 'a'.repeat(total - marker.length);
      const truncated = truncateOutboundMediaText(
        text,
        20_000,
        TRUNCATION_MARKER,
      );
      expect(truncated.length).toBeGreaterThan(TRUNCATION_MARKER.length + 1000);
      expect(truncated).not.toContain(
        '/workspace/quarterly-report-final-version',
      );
      expect(truncated.endsWith('a')).toBe(true);
      expect(truncated.length).toBeLessThanOrEqual(20_000);
    }
  });

  // R3-10: a cut dropping the prose prefix of a mid-line backtick run turns
  // it into a line-start fence opener; every downstream sanitizer then masks
  // the tail to end-of-text and real markers ship as literal text.
  it('neutralizes a fence opener created by the cut', () => {
    const path = '/workspace/secret-report.pdf';
    const runLine = 'prose some ```draft notes here';
    const markerLine = `[FILE: ${path}]`;
    for (const drop of [10, 11]) {
      const midLen =
        20_000 -
        TRUNCATION_MARKER.length +
        drop -
        runLine.length -
        1 -
        markerLine.length;
      const text =
        'a'.repeat(100) + runLine + 'b'.repeat(midLen) + '\n' + markerLine;
      const truncated = truncateOutboundMediaText(
        text,
        20_000,
        TRUNCATION_MARKER,
      );
      // The marker survives the tail and is still deliverable.
      expect(findOutboundMediaMarkers(truncated, 'FILE')).toHaveLength(1);
      const sanitized = sanitizeStreamingFileMarkers(truncated);
      expect(sanitized).not.toContain(path);
      expect(truncated.length).toBeLessThanOrEqual(20_000);
    }
  });

  // R1-2: openFenceAt matched fences on the RAW line while maskCode strips
  // blockquote prefixes first, so a cut inside a QUOTED fence emitted no
  // re-opener and the tail's quoted closing fence masked every later marker.
  it('re-opens a blockquoted fence the cut landed inside', () => {
    const path = '/workspace/secret-report.pdf';
    const lines: string[] = ['before prose', '> ```'];
    for (let i = 0; i < 40; i++) lines.push(`> code line ${i}`);
    lines.push('> ```', `after prose [FILE: ${path}]`);
    const text = lines.join('\n') + 'a'.repeat(900);
    const fenceLineStart = text.indexOf('> code line 5');
    // A spread of cuts landing inside the quoted fence.
    for (const offset of [0, 4, 9]) {
      const start = fenceLineStart + offset;
      const limit = text.length - start + TRUNCATION_MARKER.length;
      const truncated = truncateOutboundMediaText(
        text,
        limit,
        TRUNCATION_MARKER,
      );
      const sanitized = sanitizeStreamingFileMarkers(truncated);
      // The marker after the block stays visible to the finder, so the
      // sanitizer removes it instead of shipping it as literal text.
      expect(sanitized).not.toContain(path);
      expect(truncated).toContain(path);
    }
  });

  it('keeps the limit when the cut is past a cross-line marker own line', () => {
    // The residue stops at the marker's own line when it carries a path;
    // the guard must not move the cut BACKWARDS to it — that would break the
    // `<= limit` guarantee the budget arithmetic depends on.
    const text = `${'a'.repeat(30)}[FILE: /secret/deep/path.pdf\nprose line two here${' tail'.repeat(20)}`;
    const limit = text.length - 65 + TRUNCATION_MARKER.length;
    const truncated = truncateOutboundMediaText(text, limit, TRUNCATION_MARKER);
    expect(truncated.length).toBeLessThanOrEqual(limit);
    expect(truncated).not.toContain('/secret/deep/path.pdf');
    expect(truncated).toContain('line two here');
  });

  // The guard recognises spaced openings too: keeping the raw cut inside one
  // can leave ` FILE: /abs/path]` — no leading bracket to sanitise.
  it('skips a spaced opening the cut splits', () => {
    const text = `${'a'.repeat(40)}[ FILE: /etc/passwd]${'y'.repeat(40)}`;
    // limit lands the cut inside the spaced opening's name.
    const limit = text.length - 42 + TRUNCATION_MARKER.length;
    const truncated = truncateOutboundMediaText(text, limit, TRUNCATION_MARKER);
    expect(truncated).not.toContain('/etc/passwd');
    expect(truncated).toContain('y'.repeat(40));
  });
});

describe('R5 round-5 Critical regressions', () => {
  // R5-2/R5-3: the guard's marker pre-filter folds case with `toUpperCase`
  // (`ı` -> `I`, `ﬁ` -> `FI`) while its confirming gates used an `iu`-flagged
  // regex, which folds neither (`/I/iu.test('ı')` is `false`). Those shapes
  // entered the marker branch, failed both gates, and fell back to the raw
  // cut — dropping the opening `[` and leaving a bracket-less absolute path
  // that `stripPartialOutboundMediaMarker`, which walks backward from a `[`,
  // can never recognise. The path then shipped to the card as literal text.
  const FOLDED_NAMES = ['FıLE', 'ﬁle', 'IMAGE'.replace('I', 'ı')];

  it.each(FOLDED_NAMES)(
    'advances past a closed `[%s: …]` opening the stripper would strip',
    (name) => {
      const path = '/abs/secret/key.pdf';
      const text = `${'x'.repeat(100)}[${name}: ${path}] tail prose kept`;
      const truncated = truncateOutboundMediaText(text, 44, '[…]');
      expect(truncated).not.toContain(path);
      expect(truncated).toContain('tail prose kept');
      // Whatever survives must also survive the display sanitizer unchanged —
      // a leaked fragment is one no later layer can clean up.
      expect(stripPartialOutboundMediaMarker(truncated, 'FILE', '')).toBe(
        truncated,
      );
      expect(stripPartialOutboundMediaMarker(truncated, 'IMAGE', '')).toBe(
        truncated,
      );
    },
  );

  it.each(FOLDED_NAMES)(
    'advances past an unclosed streaming `[%s: …` opening',
    (name) => {
      const path = '/abs/secret/key.pdf';
      const text = `${'x'.repeat(100)}[${name}: ${path}`;
      // Cut inside the marker name, where the raw cut used to drop the `[`.
      const limit = path.length + name.length + 4;
      const truncated = truncateOutboundMediaText(text, limit, '[…]');
      expect(truncated).not.toContain(path);
    },
  );
});

describe('R6 round-6 Critical regressions', () => {
  // R6-2: the residue-extension gate stripped the marker name with an
  // `iu`-flagged regex while every recognition gate around it folds case via
  // `toUpperCase`. `'ı'.toUpperCase()` is `'I'` and `'ﬁ'.toUpperCase()` is
  // `'FI'`, but `/I/iu.test('ı')` is `false`, so for `[FıLE:` the opening was
  // recognised while the name survived in `pathPart` — `pathCouldContinue`
  // went false and the residue stopped at the marker's own line, leaving the
  // bare path line below it. That line carries no `[`, so no backward walk
  // can ever find it and the absolute path shipped through every sanitizer.
  const FOLDED_NAMES: Array<['IMAGE' | 'FILE', string]> = [
    ['FILE', 'FıLE'],
    ['FILE', 'ﬁle'],
    ['IMAGE', 'IMAGE'.replace('I', 'ı')],
    ['IMAGE', 'IMAGE'.replace('IMA', 'ıMA')],
  ];

  it.each(FOLDED_NAMES)(
    'strips the next-line path of a closed `[%s`/`[%s:` opening',
    (markerName, name) => {
      const path = '/etc/passwd';
      const text = `intro\n[${name}:\n${path}]\ntail prose kept`;
      const stripped = stripPartialOutboundMediaMarker(text, markerName, '');
      expect(stripped).not.toContain(path);
      expect(stripped).toContain('tail prose kept');
    },
  );

  it.each(FOLDED_NAMES)(
    'strips an unclosed `[%s`/`[%s:` opening whose path sits alone below it',
    (markerName, name) => {
      const path = '/abs/secret/key.pdf';
      const text = `intro\n[${name}:\n${path}\ntail prose kept`;
      const stripped = stripPartialOutboundMediaMarker(text, markerName, '');
      expect(stripped).not.toContain(path);
      expect(stripped).toContain('tail prose kept');
    },
  );

  // The ASCII twin already behaved; it pins that the fold did not regress it.
  it('still strips the next-line path of an ASCII `[FILE:` opening', () => {
    const text = 'intro\n[FILE:\n/etc/passwd]\ntail prose kept';
    const stripped = stripPartialOutboundMediaMarker(text, 'FILE', '');
    expect(stripped).not.toContain('/etc/passwd');
    expect(stripped).toContain('tail prose kept');
  });

  // A real same-line path must still stop the residue at its own line, or the
  // strip eats the prose that follows an abandoned marker.
  it('keeps a same-line path from extending the residue past its line', () => {
    const text = '[FILE: /tmp/a.txt\nplain prose line]\ntail';
    const stripped = stripPartialOutboundMediaMarker(text, 'FILE', '');
    expect(stripped).toContain('plain prose line]');
    expect(stripped).toContain('tail');
  });

  // R6-6: the stripper rated completeness on the RAW text while
  // `findOutboundMediaMarkers` rates deliverability on `maskCode(text)`. A
  // marker whose body is visible prose but whose closing `]` sits inside an
  // inline code span is masked at the `]`, so the finder matches nothing and
  // never replaces it, while the raw `completedPattern` called it complete
  // and left it alone. The absolute path then shipped through every display
  // surface, and the truncation guard's raw pattern kept it through cuts too.
  it.each([
    ['FILE', '/Users/ben/private/report.pdf'],
    ['IMAGE', '/Users/ben/private/shot.png'],
  ] as Array<['IMAGE' | 'FILE', string]>)(
    'strips a `%s` marker whose closing bracket alone is inside code',
    (markerName, path) => {
      const text = `Report ready: [${markerName}: ${path}\`]\` done`;
      expect(findOutboundMediaMarkers(text, markerName)).toHaveLength(0);
      const stripped = stripPartialOutboundMediaMarker(text, markerName, '');
      expect(stripped).not.toContain(path);
    },
  );

  // The pinned trade: a marker quoted in code WHOLE stays untouched, because
  // its own `[` is masked too. Only mixed visibility is residue.
  it.each([
    ['an inline span', '`[FILE: /Users/ben/private/report.pdf]`'],
    ['a fenced block', '```\n[FILE: /Users/ben/private/report.pdf]\n```'],
  ])('leaves a marker quoted whole in %s alone', (_label, text) => {
    expect(stripPartialOutboundMediaMarker(text, 'FILE', '')).toBe(text);
  });

  // A deliverable marker in plain prose is the finder's to replace, so the
  // stripper must keep leaving it in place.
  it('leaves a deliverable plain-prose marker alone', () => {
    const text = 'Report ready: [FILE: /tmp/report.pdf] done';
    expect(findOutboundMediaMarkers(text, 'FILE')).toHaveLength(1);
    expect(stripPartialOutboundMediaMarker(text, 'FILE', '')).toBe(text);
  });
});

describe('R7 round-7 Critical regressions', () => {
  // R4-4: the R2-12 branch advanced only to the balanced-bracket extent —
  // for `[FILE: /a [b]] /secret/c.pdf]` that is the EARLY close of a nested
  // extent, and the bracket-less path fragment after it survived every
  // sanitizer (the stripper strips the identical opening to end-of-line).
  // A dangling `]` after the balanced close now means the residue continues:
  // advance exactly as far as the stripper strips.
  it('does not retain the residue after an early balanced close', () => {
    const marker = '[FILE: /a [b]] /secret/c.pdf]';
    const text = 'a'.repeat(85) + marker + 'b'.repeat(19946);
    // Land the cut inside `[FILE: /a [b`, as CONTENT_LIMIT does mid-stream.
    const cutAt = 85 + '[FILE: /a [b'.length;
    const limit = text.length - cutAt + TRUNCATION_MARKER.length;
    const truncated = truncateOutboundMediaText(text, limit, TRUNCATION_MARKER);
    expect(truncated).not.toContain('/secret/c.pdf');
    // The residue runs to the end of the marker's (only) line — the advance
    // consumes it whole; nothing bracket-less survives into the tail.
    expect(truncated).toBe(TRUNCATION_MARKER);
  });

  // R4-5: the backward bracket walk was gated on `open > lastClose` — a
  // nested `]` anywhere before the cut stopped it entirely, so cuts inside
  // the outer bracketed marker returned the raw cut and retained a
  // bracket-less absolute-path fragment.
  it('walks past a nested close to the enclosing marker', () => {
    const filler = 'a'.repeat(20000);
    const marker = '[FILE: /workspace/report [draft].pdf see /etc/shadow]';
    const text = filler + marker + 'zzz';
    for (let delta = 1; delta <= marker.length; delta++) {
      const start = filler.length + delta;
      const limit = text.length - start + TRUNCATION_MARKER.length;
      if (limit <= TRUNCATION_MARKER.length) continue;
      const truncated = truncateOutboundMediaText(
        text,
        limit,
        TRUNCATION_MARKER,
      );
      expect(
        sanitizeFileMarkersToFixedPoint(
          stripPartialOutboundMediaMarker(truncated, 'FILE', ''),
        ),
      ).not.toContain('/etc/shadow');
    }
  });

  // R4-6: a cut exactly one character after a NESTED `[` terminated the walk
  // at that inner bracket — the empty candidate vacuously prefix-matched, the
  // span failed the marker test, and the walk never reached the enclosing
  // `[FILE:` opening. Non-marker spans keep the walk moving left instead.
  it('reaches the enclosing marker from a cut after a nested bracket', () => {
    const filler = 'a'.repeat(20000);
    const marker = '[FILE: /workspace/report [draft].pdf see /etc/shadow]';
    const text = filler + marker + 'zzz';
    const cutAt = text.indexOf('[draft') + 1;
    const limit = text.length - cutAt + TRUNCATION_MARKER.length;
    const truncated = truncateOutboundMediaText(text, limit, TRUNCATION_MARKER);
    expect(truncated).toBe(TRUNCATION_MARKER + 'zzz');
  });

  // R4-7: the created-fence-opener advance jumped to the NEXT NEWLINE — on a
  // long or newline-free line that discarded the entire rest of the line and
  // collapsed the retained window to the bare truncation marker. The advance
  // now covers the created run itself, keeping the line.
  it('keeps the line when advancing past a created fence opener', () => {
    const runStart = 10000;
    const text = 'a'.repeat(runStart) + '```' + 'b'.repeat(10009);
    // The budget cut lands exactly on the mid-line run, turning it into a
    // line-start fence opener in the retained tail.
    const limit = text.length - runStart + TRUNCATION_MARKER.length;
    const truncated = truncateOutboundMediaText(text, limit, TRUNCATION_MARKER);
    expect(truncated.length).toBeGreaterThan(TRUNCATION_MARKER.length + 5000);
    expect(truncated.length).toBeLessThanOrEqual(limit);
    expect(truncated).toContain('bbb');
  });
});

describe('deep blockquote nesting (R14-1)', () => {
  // `marked.lexer` recurses per blockquote-nesting level; a few thousand
  // levels overflow the stack from a few thousand characters — well inside
  // CONTENT_LIMIT and reachable by ordinary (or prompt-injected) model
  // output. The lexer is guarded: the finder keeps markers VISIBLE (the
  // R1-9 fail-safe direction — delivered, never shipped as a literal path)
  // and truncation falls back to the raw cut, instead of the throw taking
  // down the card flush or the final-answer preparation.
  const deep = '> '.repeat(4000) + 'x';

  it('keeps markers visible to the finder instead of throwing', () => {
    const text = `${deep}\n[FILE: /workspace/a.pdf]`;
    expect(findOutboundMediaMarkers(text, 'FILE')).toEqual([
      {
        start: deep.length + 1,
        end: deep.length + 1 + '[FILE: /workspace/a.pdf]'.length,
        path: '/workspace/a.pdf',
      },
    ]);
  });

  it('strips a cutoff marker after the nesting instead of throwing', () => {
    const sanitized = sanitizeFileMarkersToFixedPoint(
      `${deep}\n[FILE: /workspace/a.pdf`,
    );
    expect(sanitized).not.toContain('/workspace/a.pdf');
  });

  it('truncates over the nesting instead of throwing', () => {
    // The retained-window budget puts the cut DEEP enough into the nesting
    // (prefix depth ~2500) that the prefix lex itself overflows the stack.
    const text = `${deep}\n${'y'.repeat(17000)}`;
    const truncated = truncateOutboundMediaText(text, 20000, TRUNCATION_MARKER);
    expect(truncated.startsWith(TRUNCATION_MARKER)).toBe(true);
    expect(truncated.length).toBeLessThanOrEqual(20000);
  });
});

describe('R16 round-16 Critical regressions', () => {
  // R16-3: `markerSafeTruncationStart` paid a slice + uppercase copy of the
  // retained window PER BRACKET still unclosed at the cut, plus a fresh
  // close scan each — quadratic on a single-line run of unclosed brackets,
  // reachable through `boundContent` on prompt-injected/echoed content
  // (round-16 probe: 15,000 brackets / 80k → ~1.4 s synchronous CPU). The
  // shape probe now walks the ORIGINAL text by index with a name-length
  // cap, and the cut-to-close probes hoist out of the per-bracket loop.
  it('truncates a run of unclosed brackets in bounded time', () => {
    const text = '[a '.repeat(30000) + 'x'.repeat(70000);
    // R14-2 convention: assert CPU, not wall time — wall-clock budgets flake
    // under parallel full-suite load on shared CI hardware. 800 ms stays an
    // order of magnitude under the measured pre-fix cost at this size
    // (~2.5 s and superlinear) while clearing hardware variance.
    const startedCpu = process.cpuUsage();
    const truncated = truncateOutboundMediaText(text, 20000, TRUNCATION_MARKER);
    const elapsedCpu = process.cpuUsage(startedCpu);
    expect((elapsedCpu.user + elapsedCpu.system) / 1000).toBeLessThan(800);
    expect(truncated.length).toBeLessThanOrEqual(20000);
    expect(truncated.startsWith(TRUNCATION_MARKER)).toBe(true);
  });
});

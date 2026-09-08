/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  carriedClaimLine,
  countInlineFindings,
  markerStrippedBody,
  severityOf,
  stripSeverityPrefix,
  unmarkedComments,
  readClaimHead,
  codeBlockStartIn,
  separatorColonAt,
  separatorStrip,
  markerLineOpensHtmlBlock,
  bareClaimLine,
} from './inline-counts.js';
import { stripForUnattributedPost } from './review-footer.js';
import {
  FINDING_BASELINES,
  FINDING_DIRECTIONS,
} from '@qwen-code/qwen-code-core';

describe('stripSeverityPrefix — the attribution-off posted shape', () => {
  it('strips both markers, with the whitespace the counter tolerates', () => {
    expect(stripSeverityPrefix('**[Critical]** broken')).toBe('broken');
    expect(stripSeverityPrefix('**[Suggestion]** tidy')).toBe('tidy');
    // `severityOf` trims before matching; the strip sees the same body.
    expect(stripSeverityPrefix('  **[Critical]** broken')).toBe('broken');
    // The ledger's title extraction tolerates a colon after the marker.
    expect(stripSeverityPrefix('**[Critical]**: broken')).toBe('broken');
    // The full-width colon is the same looping/truncated marker shape in a
    // Chinese-context draft — every sibling parser admits both widths.
    expect(stripSeverityPrefix('**[Critical]**： broken')).toBe('broken');
  });

  it('leaves an unmarked body alone', () => {
    expect(stripSeverityPrefix('just prose')).toBe('just prose');
    // A marker that does not OPEN the body is prose, not a marker.
    expect(stripSeverityPrefix('see **[Critical]** above')).toBe(
      'see **[Critical]** above',
    );
  });

  it('strips stacked markers iteratively — a looping model drafts them', () => {
    expect(stripSeverityPrefix('**[Critical]** **[Suggestion]** broken')).toBe(
      'broken',
    );
    expect(
      stripSeverityPrefix('**[Critical]****[Critical]****[Critical]** x'),
    ).toBe('x');
  });

  it('skips render-nothing residue between stacked markers', () => {
    // An HTML comment or a Cf run between two markers is invisible on the
    // rendered post; the iteration must not converge with the second marker
    // intact because the residue hides it from the classifier.
    expect(
      stripSeverityPrefix('**[Critical]**<!-- x -->**[Suggestion]** text'),
    ).toBe('text');
    expect(
      stripSeverityPrefix('**[Critical]**\u200B**[Suggestion]** text'),
    ).toBe('text');
    expect(stripSeverityPrefix('<!-- x -->**[Critical]** text')).toBe('text');
  });

  it('consumes the residue-and-colon separator the readback consumes — the fixpoints agree (#9940 review)', () => {
    // The readback projection (markerStrippedBody) strips residue before
    // its \s-wide colon; the post-time strip's [ \t] colon stopped at the
    // newline, so a newline-then-colon stacked draft read back as
    // carrying the id — the ledger carried it, the stamp stayed off —
    // while its attribution-off post led with `\n:\n…`: a root no later
    // carry or fixed ruling could ever reach (#9940 review).
    const stacked = '**[Critical]**\n:\n**[Suggestion]** R1-2: claim';
    expect(stripSeverityPrefix(stacked)).toBe('R1-2: claim');
    expect(stripSeverityPrefix(stacked)).toBe(markerStrippedBody(stacked));
    expect(carriedClaimLine(stacked)).toBe(stripSeverityPrefix(stacked));
    // Residue around the separator colon is the same machine grammar.
    const residue = '**[Critical]** <!-- x -->: R1-2: claim';
    expect(stripSeverityPrefix(residue)).toBe('R1-2: claim');
    expect(stripSeverityPrefix(residue)).toBe(markerStrippedBody(residue));
    expect(carriedClaimLine(residue)).toBe(stripSeverityPrefix(residue));
  });

  it('consumes a MULTI-line residue after the separator colon — the fixpoints still agree (#9940 review)', () => {
    // The separator's residue arm spans newlines and whole comments, but
    // the readback stripped residue only BEFORE its separator step and
    // then split on the newline: a multi-line comment between the colon
    // and the carried id truncated the claim line to `<!--` while the
    // attribution-off post exposed the id — the draft re-minted a fresh
    // id while the post led with the carried one, unreachable by the
    // ^-anchored ledger readback: one finding, two names, and the
    // original thread orphaned (#9940 review, round 10).
    const residueAfter = '**[Critical]** : <!--\nx\n--> R1-2: claim';
    expect(stripSeverityPrefix(residueAfter)).toBe('R1-2: claim');
    expect(markerStrippedBody(residueAfter)).toBe('R1-2: claim');
    expect(carriedClaimLine(residueAfter)).toBe(
      stripSeverityPrefix(residueAfter),
    );
  });

  it('a residue-led draft with NO colon strips in bounded time — the separator regex stays linear (#9940 review, round 14)', () => {
    // The separator's residue-before-colon arm used a lazy comment token
    // that could stretch across the comments after it, giving a run of N
    // comments 2^N decompositions; with no colon to find, the engine
    // explored them all — ~30 leading comments hung a submit for minutes
    // (this runs on EVERY GitHub submit via stampCarriedId and every
    // attribution-off post). The unambiguous comment token keeps the
    // whole match linear; residue before plain content is still model
    // text the post keeps.
    const body = '**[Critical]** ' + '<!-- x -->'.repeat(64) + ' claim';
    const t0 = performance.now();
    const stripped = stripSeverityPrefix(body);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(stripped).toBe('<!-- x -->'.repeat(64) + ' claim');
  });

  it('a Cf-led draft with NO colon strips in bounded time too — the residue class is unambiguous (#9940 review, round 18)', () => {
    // The sibling ambiguity of the cell above, in the character half of
    // the token: `\s` and `\p{Cf}` both match U+FEFF (the only codepoint
    // in both), so as two ALTERNATIVES a FEFF run had the same 2^N
    // decompositions and the colon-less draft wedged the submit — the
    // R14-1 cell exercises comment runs only and stayed green. One
    // merged class matches each character exactly one way; the accepted
    // codepoint set is unchanged, so a FEFF run is still residue.
    const body = '**[Critical]** ' + '\uFEFF'.repeat(64) + ' claim';
    const t0 = performance.now();
    const stripped = stripSeverityPrefix(body);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(stripped).toBe('\uFEFF'.repeat(64) + ' claim');
    // Still residue everywhere else the shared token is read: leading
    // FEFF must not defeat the carried-id anchor, and the two
    // marker-strip fixpoints must keep agreeing on it.
    const carried = '**[Critical]**\uFEFF:\uFEFFR1-2: claim';
    expect(stripSeverityPrefix(carried)).toBe('R1-2: claim');
    expect(stripSeverityPrefix(carried)).toBe(markerStrippedBody(carried));
    expect(severityOf({ body: '\uFEFF**[Critical]** x' })).toBe('critical');
  });

  it('a marker-only body strips to the empty string — the submit gate refuses it first', () => {
    expect(stripSeverityPrefix('**[Critical]**')).toBe('');
    expect(stripSeverityPrefix('**[Suggestion]**\n')).toBe('');
    expect(stripSeverityPrefix('**[Critical]** **[Suggestion]**')).toBe('');
    // Trailing render-nothing residue is still marker-only: `.trim()` sees
    // neither Cf characters nor HTML comments.
    expect(stripSeverityPrefix('**[Critical]**\u200B')).toBe('');
    expect(stripSeverityPrefix('**[Critical]**<!-- x -->')).toBe('');
    expect(stripSeverityPrefix('**[Critical]** <!-- x --> \u200B')).toBe('');
  });
});

describe('carriedClaimLine — the shared readback strip', () => {
  it('the boundary state is the state since the last paragraph line — a text line between boundary and indent is seen (#9940 review, round 28)', () => {
    expect(codeBlockStartIn('\n\n\u200b\n    ')).toBe(-1);
    expect(codeBlockStartIn('\n\n    ')).toBe(2);
    // The colon's own index — after the NBSP line the indent is a lazy
    // continuation, so the colon is the separator.
    expect(separatorColonAt('\n\n\u00a0\n    :')).toBe(8);
    expect(separatorColonAt('\n\n    :')).toBe(-1);
    // The marker line's own HTML-block-ness reaches the colon search.
    expect(stripSeverityPrefix('<!-- c -->**[Critical]**\n    : x')).toBe(
      '    : x',
    );
    expect(stripSeverityPrefix('<!-- c -->**[Critical]**\n    x')).toBe(
      '    x',
    );
    expect(
      carriedClaimLine('<!-- c -->**[Critical]**\n    : R3-4: the guard'),
    ).toBe('');
    expect(
      carriedClaimLine('**[Critical]**\n\n\u00a0\n    : R1-2: the guard'),
    ).toBe('R1-2: the guard');
  });

  it('the post and readback fixpoints agree on a stacked marker under a comment-led line (#9940 review, round 28)', () => {
    const body = '**[Critical]**\n<!-- c -->**[Suggestion]**\n    R1-2: claim';
    expect(stripSeverityPrefix(body)).toBe('    R1-2: claim');
    expect(markerStrippedBody(body)).toBe(stripSeverityPrefix(body));
    expect(carriedClaimLine(body)).toBe('');
    // A same-line comment before the claim is still read past.
    expect(
      markerStrippedBody('**[Critical]** <!-- x --> R1-2: the claim'),
    ).toBe('R1-2: the claim');
  });

  it("the post-colon walk is seeded from the colon's own line, not the marker line (#9940 review, round 29)", () => {
    // A comment-led marker line is an HTML block, but a colon on the NEXT
    // line is a paragraph line of its own: the indented claim under it is
    // that paragraph's lazy continuation, and the carry must read it.
    const body = '<!-- c -->**[Critical]**\n:\n    R1-2: the claim';
    expect(stripSeverityPrefix(body)).toBe('R1-2: the claim');
    expect(markerStrippedBody(body)).toBe(stripSeverityPrefix(body));
    expect(carriedClaimLine(body)).toBe('R1-2: the claim');
    expect(separatorStrip('\n:\n    ', true)).toEqual({
      strip: 7,
      codeKept: false,
    });
    // The marker line's state still seeds a run that STARTS on it …
    expect(separatorStrip(':\n    ', true)).toEqual({
      strip: 2,
      codeKept: true,
    });
    expect(carriedClaimLine('<!-- c -->**[Critical]**:\n    R1-2: code')).toBe(
      '',
    );
    // … a blank line under the colon is a boundary of its own …
    expect(
      carriedClaimLine('<!-- c -->**[Critical]**\n:\n\n    R1-2: code'),
    ).toBe('');
    // … and a comment-led colon line is an HTML block that ends on the line
    // carrying its `-->`, so the indented line under it is code.
    expect(
      carriedClaimLine('<!-- c -->**[Critical]**\n<!-- x -->:\n    R1-2: code'),
    ).toBe('');
    expect(separatorStrip('\n<!-- x -->:\n    ', true)).toEqual({
      strip: 13,
      codeKept: true,
    });
    // The attribution-off post of the round-29 shape reads the same id.
    expect(readClaimHead(stripForUnattributedPost(body)).id).toBe('R1-2');
    // A plain marker line, then a comment-led colon line: the HTML block
    // interrupts the paragraph and ends on its line — the indented line
    // under it is code (it read as a claim before the seed moved).
    expect(
      carriedClaimLine('**[Critical]**\n<!-- x -->:\n    R1-2: code'),
    ).toBe('');
    expect(separatorStrip('\n<!-- x -->:\n    ', false)).toEqual({
      strip: 13,
      codeKept: true,
    });
    expect(
      carriedClaimLine('<!-- c -->**[Critical]**\r\n:\r\n    R1-2: the claim'),
    ).toBe('R1-2: the claim');
  });

  it('a comment that opens mid-line hides no line break — the lines it runs on are lines of their own (#9940 review, round 29 audit)', () => {
    // A comment-led line's HTML block ends on the first line containing
    // `-->` (CommonMark 4.6, type 2). A second comment opening later on that
    // line spans into a NEW line, which is a paragraph line — and the
    // indented line under it a lazy continuation, not code.
    for (const body of [
      '**[Critical]**\n<!-- a --><!-- b\n-->:\n    R1-2: the claim',
      '**[Critical]**\n<!-- a -->:<!-- b\nc -->\n    R1-2: the claim',
      '<!-- c -->**[Critical]**<!-- a\nb -->:\n    R1-2: the claim',
      '<!-- c -->**[Critical]**:<!-- b\nc -->\n    R1-2: the claim',
      '<!-- a --><!-- b\n-->**[Critical]**\n    R1-2: the claim',
    ]) {
      expect(carriedClaimLine(body)).toBe('R1-2: the claim');
      expect(markerStrippedBody(body)).toBe(stripSeverityPrefix(body));
      expect(readClaimHead(stripForUnattributedPost(body)).id).toBe('R1-2');
    }
    // A comment-led line's block DOES run to the line carrying its `-->`,
    // the marker's own line included, and the line after it is code …
    expect(
      carriedClaimLine('**[Critical]**\n<!-- a\nb -->:\n    R1-2: code'),
    ).toBe('');
    expect(
      carriedClaimLine('<!-- a\nb -->**[Critical]**\n    R1-2: code'),
    ).toBe('');
    expect(codeBlockStartIn('\n<!-- a\n    b -->\n    ')).toBe(18);
    // … a blank line inside a mid-line comment still ends the paragraph,
    // so the comment's own closing line is code …
    expect(
      carriedClaimLine('**[Critical]** <!-- a\n\n    b -->:\n    R1-2: code'),
    ).toBe('');
    // … and a comment opening after the colon on an HTML-block line
    // spans into a paragraph line.
    expect(codeBlockStartIn('<!-- b\nc -->\n    ', true)).toBe(-1);
    expect(separatorStrip('\n<!-- a --><!-- b\n-->:\n    ', false)).toEqual({
      strip: 27,
      codeKept: false,
    });
    expect(markerLineOpensHtmlBlock('<!-- a\nb -->')).toBe(true);
    expect(markerLineOpensHtmlBlock('<!-- a --><!-- b\n-->')).toBe(false);
    expect(markerLineOpensHtmlBlock('x\n<!-- c -->')).toBe(true);
    expect(markerLineOpensHtmlBlock('')).toBe(false);
  });

  it('blank is spaces and tabs only, and the bare leg reads no claim past a code line in its lead (#9940 review, round 29 audit)', () => {
    // An indented line of an NBSP under a boundary is indented code
    // (`trim()` would have eaten the NBSP and called the line blank).
    expect(
      carriedClaimLine('**[Critical]**\n\n\t\u00a0\n    R1-2: the claim'),
    ).toBe('');
    expect(codeBlockStartIn('\n\n\t\u00a0\n    ')).toBe(2);
    // The bare leg — the attribution-off post read back — agrees with the
    // marked leg on a code line inside the leading residue …
    expect(bareClaimLine('\t\u200b\nR1-2: the claim')).toBeNull();
    expect(bareClaimLine('    <!-- x -->\nR1-2: the claim')).toBeNull();
    // … and on a lazy continuation under a format-character line.
    expect(bareClaimLine('\u200b\n    R1-2: the claim')).toBe(
      'R1-2: the claim',
    );
    expect(bareClaimLine('    R1-2: code')).toBeNull();
    // The marker-line guard asks whether the MARKER's line is code: not
    // after a code line it ends, not as a lazy continuation, yes inside a
    // code block that runs on to it, yes under a boundary.
    expect(severityOf({ body: '    <!-- x -->\n**[Critical]** x' })).toBe(
      'critical',
    );
    expect(severityOf({ body: '\u200b\n    **[Critical]** x' })).toBe(
      'critical',
    );
    expect(
      severityOf({ body: '    <!-- x -->\n    **[Critical]** x' }),
    ).toBeNull();
    expect(severityOf({ body: '\n    **[Critical]** x' })).toBeNull();
  });

  it('same-line residue is same-line physically — a comment spanning a break after the marker goes with the run (#9940 review, round 29 audit)', () => {
    // Kept, the residue would lead the attribution-off post's first line as
    // an HTML block that ends on that line, and the indented `-->` line
    // under it would be code: the claim vanished from the bare readback.
    const body = '**[Critical]**<!-- x --><!-- x\n\t-->R1-2: the claim';
    expect(stripSeverityPrefix(body)).toBe('R1-2: the claim');
    expect(markerStrippedBody(body)).toBe('R1-2: the claim');
    expect(bareClaimLine(stripForUnattributedPost(body))).toBe(
      'R1-2: the claim',
    );
    // A comment that closes on the marker's line stays model text.
    expect(
      stripSeverityPrefix('**[Critical]** <!-- x --> R1-2: the claim'),
    ).toBe('<!-- x --> R1-2: the claim');
  });

  it('reads no claim off an indented code block, and a canonical id off a variant spelling (#9940 review, audit)', () => {
    expect(carriedClaimLine('**[Critical]**\n\n    R1-2: code')).toBe('');
    // One break and a tab is a lazy continuation, not code (audit 5).
    expect(carriedClaimLine('**[Critical]**\n\tR1-2: code')).toBe('R1-2: code');
    expect(carriedClaimLine('**[Critical]**\n\n\tR1-2: code')).toBe('');
    expect(carriedClaimLine('**[Critical]**\n  R1-2: not code')).toBe(
      'R1-2: not code',
    );
    expect(carriedClaimLine('**[Critical]** R1-2: x\rsecond')).toBe('R1-2: x');
    // `[regression](url)` is a LINK, not an axis tag: read as one, its
    // text left both the claim and the ledger title, which then opened
    // with a bare URL in parens (#9940 review, round 30).
    const link = readClaimHead(
      'R1-2: [regression](https://ci.test/run/9) shows the bug',
    );
    expect(link.id).toBe('R1-2');
    expect(link.claim).toBe(
      '[regression](https://ci.test/run/9) shows the bug',
    );
    expect(link.axes).toEqual([]);
    expect(readClaimHead('R1-2: [probe](https://x.test) ran').source).toBe(
      undefined,
    );
    // A real tag, with no `(` after it, still reads.
    expect(readClaimHead('R1-2: [regression] the guard').axes).toEqual([
      'regression',
    ]);
    expect(readClaimHead('R02-3: the guard').id).toBe('R2-3');
    expect(readClaimHead('[probe] R007-010: the guard').id).toBe('R7-10');
    expect(readClaimHead('R0-1: the guard').id).toBe('R0-1');
  });

  it('reads the claim through every shape the classifier admits', () => {
    // Leading residue: severityOf classifies through it, so the slice
    // must too — slicing the raw bytes cut mid-marker and garbled the
    // claim ('* R1-3: …' for the zwsp-led body).
    expect(carriedClaimLine('\u200B**[Critical]** R1-3: zwsp residue')).toBe(
      'R1-3: zwsp residue',
    );
    expect(carriedClaimLine('<!-- x -->**[Suggestion]** the claim')).toBe(
      'the claim',
    );
    // Residue BETWEEN the marker and the carried id.
    expect(carriedClaimLine('**[Critical]** <!-- x --> R1-2: the claim')).toBe(
      'R1-2: the claim',
    );
    // The full-width colon the prefix strip admits ('[:：]') — the
    // ASCII-only separator nulled the readback on this shape.
    expect(carriedClaimLine('**[Critical]**：R2-3: the claim')).toBe(
      'R2-3: the claim',
    );
    // The ASCII colon and the plain shapes keep their existing readback.
    expect(carriedClaimLine('**[Critical]**: R4-1: the claim')).toBe(
      'R4-1: the claim',
    );
    expect(carriedClaimLine('**[Suggestion]** plain')).toBe('plain');
    expect(carriedClaimLine('**[Critical]** first\nsecond')).toBe('first');
    expect(carriedClaimLine('no marker')).toBe(null);
  });

  it('strips the WHOLE stacked marker run — the readback and the post-time strip agree (#9940 review)', () => {
    // A looping model drafts stacked markers, and the strips that decide
    // what POSTS iterate them to a fixpoint; a readback that stopped at
    // the first marker hid a carried id behind the second — the gate saw
    // no re-post while the relocate leg carried the id standing.
    expect(
      carriedClaimLine('**[Critical]** **[Suggestion]** R1-2: still stands'),
    ).toBe('R1-2: still stands');
    expect(
      carriedClaimLine('**[Suggestion]** **[Critical]** R3-4: the claim'),
    ).toBe('R3-4: the claim');
    expect(
      carriedClaimLine('**[Critical]**<!-- x -->**[Suggestion]** R1-2: claim'),
    ).toBe('R1-2: claim');
  });
});

describe('severityOf — one acceptance set with the strip', () => {
  it('classifies through the leading residue the strip skips', () => {
    // The gates and the counter accept exactly the drafts the strip is
    // written and tested to remove — a body opening with render-nothing
    // residue before its marker is MARKED, not an unmarked refusal that
    // forces a pointless re-compose.
    expect(severityOf({ body: '<!-- x -->**[Critical]** text' })).toBe(
      'critical',
    );
    expect(severityOf({ body: '\u200B**[Suggestion]** text' })).toBe(
      'suggestion',
    );
    expect(
      countInlineFindings([{ body: '<!-- x -->**[Critical]** text' }]),
    ).toEqual({ criticalsInline: 1, suggestionsInline: 0 });
    expect(
      unmarkedComments([{ body: '<!-- x -->**[Critical]** text' }]),
    ).toEqual([]);
  });

  it('still refuses a body with no marker after the residue', () => {
    expect(severityOf({ body: '<!-- x -->prose' })).toBe(null);
    expect(unmarkedComments([{ body: '<!-- x -->prose' }])).toEqual([0]);
  });
});

describe('readClaimHead — the claim head slot (#10291)', () => {
  it('tokenises every axis word the core lists define, before or after the id', () => {
    // Built from the core vocabulary, so a value added there cannot stop
    // the head scan at an unknown bracket and hide the id behind it.
    for (const word of [...FINDING_DIRECTIONS, ...FINDING_BASELINES]) {
      expect(readClaimHead(`[${word}] R1-2: x`).id).toBe('R1-2');
      expect(readClaimHead(`R1-2: [${word}] x`)).toMatchObject({
        id: 'R1-2',
        axes: [word],
        title: 'x',
        stripped: 'R1-2: x',
      });
    }
    // An unknown bracket is where the slot ends: it is prose.
    expect(readClaimHead('[new-direction] R7-2: title')).toMatchObject({
      axes: [],
      title: '[new-direction] R7-2: title',
    });
  });

  it('reads the marking anywhere in the slot past the id, and only past an id', () => {
    const between = readClaimHead(
      'R3-2: [probe] (fix-induced) the fix opened a gap',
    );
    expect(between).toMatchObject({
      id: 'R3-2',
      fixInduced: true,
      source: 'probe',
      title: 'the fix opened a gap',
      claim: '[probe] the fix opened a gap',
    });
    expect(readClaimHead('(fix-induced) no id here').fixInduced).toBe(false);
    expect(readClaimHead('R3-2: (fix-induced) x').claim).toBe('x');
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  carriedClaimLine,
  countInlineFindings,
  severityOf,
  stripSeverityPrefix,
  unmarkedComments,
} from './inline-counts.js';

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

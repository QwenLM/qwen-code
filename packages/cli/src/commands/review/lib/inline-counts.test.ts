/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
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

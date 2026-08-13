/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { stripSeverityPrefix } from './inline-counts.js';

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

  it('a marker-only body strips to the empty string — the submit gate refuses it first', () => {
    expect(stripSeverityPrefix('**[Critical]**')).toBe('');
    expect(stripSeverityPrefix('**[Suggestion]**\n')).toBe('');
    expect(stripSeverityPrefix('**[Critical]** **[Suggestion]**')).toBe('');
  });
});

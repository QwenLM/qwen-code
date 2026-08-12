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

  it('keeps a marker-only body — stripping it would post an empty comment', () => {
    expect(stripSeverityPrefix('**[Critical]**')).toBe('**[Critical]**');
    expect(stripSeverityPrefix('**[Suggestion]**\n')).toBe(
      '**[Suggestion]**\n',
    );
  });
});

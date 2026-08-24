/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { assertReleaseHighlights } from '../check-whats-new-release.js';

const highlights = {
  '1.2.3': ['First highlight.', 'Second highlight.', 'Third highlight.'],
};

describe('release Whats New highlights', () => {
  it('requires highlights for stable and preview releases', () => {
    expect(() => assertReleaseHighlights('1.2.3', highlights)).not.toThrow();
    expect(() =>
      assertReleaseHighlights('1.2.3-preview.0', highlights),
    ).not.toThrow();
    expect(() => assertReleaseHighlights('1.2.4', highlights)).toThrow(
      'release version 1.2.4',
    );
  });

  it('does not require a curated entry for nightly releases', () => {
    expect(() =>
      assertReleaseHighlights('1.2.4-nightly.20260723.abcdef0', highlights),
    ).not.toThrow();
  });

  it('rejects empty, incomplete, or oversized entries', () => {
    expect(() =>
      assertReleaseHighlights('1.2.3', {
        '1.2.3': ['First highlight.', '', 'Third highlight.'],
      }),
    ).toThrow('Expected 3-5 curated');
    expect(() =>
      assertReleaseHighlights('1.2.3', {
        '1.2.3': [
          'First highlight.',
          'Second highlight.',
          'Third highlight.',
          'Fourth highlight.',
          'Fifth highlight.',
          'Sixth highlight.',
        ],
      }),
    ).toThrow('Expected 3-5 curated');
  });
});

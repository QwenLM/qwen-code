/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { ifNoneMatchSatisfied } from '../routes/commands.js';

const REV = 'a1b2c3d4e5f6';

describe('ifNoneMatchSatisfied', () => {
  it('returns false when the header is absent', () => {
    expect(ifNoneMatchSatisfied(undefined, REV)).toBe(false);
  });

  it('returns false for an empty-string header', () => {
    expect(ifNoneMatchSatisfied('', REV)).toBe(false);
  });

  it('matches the bare hex revision', () => {
    expect(ifNoneMatchSatisfied(REV, REV)).toBe(true);
  });

  it('matches a double-quoted revision (the spec scenario form)', () => {
    expect(ifNoneMatchSatisfied(`"${REV}"`, REV)).toBe(true);
  });

  it('matches a weak validator W/"<rev>"', () => {
    expect(ifNoneMatchSatisfied(`W/"${REV}"`, REV)).toBe(true);
  });

  it('does not match a different revision', () => {
    expect(ifNoneMatchSatisfied('"deadbeef"', REV)).toBe(false);
  });

  it('matches when the revision appears in a comma-separated list', () => {
    expect(ifNoneMatchSatisfied(`"deadbeef", "${REV}"`, REV)).toBe(true);
  });

  it('does NOT honor the wildcard *', () => {
    expect(ifNoneMatchSatisfied('*', REV)).toBe(false);
  });

  it('joins an array-valued header before comparing', () => {
    expect(ifNoneMatchSatisfied(['"deadbeef"', `"${REV}"`], REV)).toBe(true);
  });

  it('never matches the empty revision against a quote-only tag', () => {
    // A degenerate `""` strips to '' which must not match an empty revision
    // path (revision is always a non-empty hex digest in practice).
    expect(ifNoneMatchSatisfied('""', '')).toBe(false);
  });
});

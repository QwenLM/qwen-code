/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { withoutDeletedRule } from './permission-rule-label.js';

describe('withoutDeletedRule', () => {
  it('removes the entry that trims to the row', () => {
    expect(withoutDeletedRule(['  Bash(git *)  '], 'Bash(git *)')).toEqual([]);
  });

  it('returns null when no entry trims to the row', () => {
    expect(withoutDeletedRule(['Bash(git *)'], 'Bash(docker *)')).toBeNull();
  });

  it('removes one entry, not every entry that trims to the row', () => {
    // The add path dedupes with an exact `includes`, so a padded entry written
    // by hand and an exact one added later can both be stored and both list as
    // the same trimmed row. One delete removes the row it was asked for.
    expect(
      withoutDeletedRule([' Bash(git *) ', 'Bash(git *)'], 'Bash(git *)'),
    ).toEqual(['Bash(git *)']);
  });

  it('keeps non-string entries instead of calling a method on them', () => {
    // Settings loading does not validate element types, and `parseRules` drops
    // falsy entries, so a `null` can sit in the stored list while the session
    // runs normally.
    expect(
      withoutDeletedRule([' Bash(git *) ', null] as unknown[], 'Bash(git *)'),
    ).toEqual([null]);
  });
});

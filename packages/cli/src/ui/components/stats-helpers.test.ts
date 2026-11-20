/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { fmtTokens } from './stats-helpers.js';

describe('fmtTokens', () => {
  it('formats token counts compactly', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1200)).toBe('1.2k');
    expect(fmtTokens(2_400_000)).toBe('2.4m');
  });

  it('moves to the next unit when rounding reaches it', () => {
    expect(fmtTokens(999_949)).toBe('999.9k');
    expect(fmtTokens(999_950)).toBe('1.0m');
    expect(fmtTokens(999_999)).toBe('1.0m');
  });
});

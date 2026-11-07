/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { shouldShowBtwTip } from './btw-tip.js';

describe('shouldShowBtwTip', () => {
  it('shows on long turns until /btw has been used', () => {
    expect(
      shouldShowBtwTip({ tipHistory: { btwUseCount: 0 }, elapsedTime: 30 }),
    ).toBe(true);
    expect(
      shouldShowBtwTip({ tipHistory: { btwUseCount: 0 }, elapsedTime: 29.9 }),
    ).toBe(false);
    expect(
      shouldShowBtwTip({ tipHistory: { btwUseCount: 1 }, elapsedTime: 60 }),
    ).toBe(false);
  });

  it('stays hidden when tips are disabled', () => {
    expect(shouldShowBtwTip({ tipHistory: null, elapsedTime: 60 })).toBe(false);
  });
});

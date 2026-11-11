/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { BTW_TIP_MIN_ELAPSED_SECONDS, shouldShowBtwTip } from './btwTip.js';

describe('shouldShowBtwTip', () => {
  const longTurn = BTW_TIP_MIN_ELAPSED_SECONDS;

  it('shows once a turn runs long and /btw was never used', () => {
    expect(
      shouldShowBtwTip({
        showTips: true,
        elapsedSeconds: longTurn,
        useCount: undefined,
      }),
    ).toBe(true);
    expect(
      shouldShowBtwTip({ showTips: true, elapsedSeconds: longTurn, useCount: 0 }),
    ).toBe(true);
  });

  it('waits for the turn to run long enough', () => {
    expect(
      shouldShowBtwTip({
        showTips: true,
        elapsedSeconds: longTurn - 1,
        useCount: 0,
      }),
    ).toBe(false);
  });

  it('stops after the first use', () => {
    expect(
      shouldShowBtwTip({ showTips: true, elapsedSeconds: longTurn, useCount: 1 }),
    ).toBe(false);
  });

  it('respects the tips setting', () => {
    expect(
      shouldShowBtwTip({
        showTips: false,
        elapsedSeconds: longTurn,
        useCount: 0,
      }),
    ).toBe(false);
  });
});

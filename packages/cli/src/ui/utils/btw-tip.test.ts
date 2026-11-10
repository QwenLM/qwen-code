/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { shouldShowBtwTip } from './btw-tip.js';
import { StreamingState } from '../types.js';

describe('shouldShowBtwTip', () => {
  it('shows on long turns until /btw has been used', () => {
    expect(
      shouldShowBtwTip({
        tipHistory: { btwUseCount: 0 },
        elapsedTime: 30,
        streamingState: StreamingState.Responding,
      }),
    ).toBe(true);
    expect(
      shouldShowBtwTip({
        tipHistory: { btwUseCount: 0 },
        elapsedTime: 29.9,
        streamingState: StreamingState.Responding,
      }),
    ).toBe(false);
    expect(
      shouldShowBtwTip({
        tipHistory: { btwUseCount: 1 },
        elapsedTime: 60,
        streamingState: StreamingState.Responding,
      }),
    ).toBe(false);
  });

  it('stays hidden when tips are disabled', () => {
    expect(
      shouldShowBtwTip({
        tipHistory: null,
        elapsedTime: 60,
        streamingState: StreamingState.Responding,
      }),
    ).toBe(false);
  });

  it('stays hidden while waiting for user confirmation', () => {
    expect(
      shouldShowBtwTip({
        tipHistory: { btwUseCount: 0 },
        elapsedTime: 60,
        streamingState: StreamingState.WaitingForConfirmation,
      }),
    ).toBe(false);
    expect(
      shouldShowBtwTip({
        tipHistory: { btwUseCount: 0 },
        elapsedTime: 0,
        streamingState: StreamingState.Idle,
      }),
    ).toBe(false);
  });
});

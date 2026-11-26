/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { StreamingState } from '../types.js';
import { shouldShowLoadingIndicator } from './streamingUtils.js';

describe('shouldShowLoadingIndicator', () => {
  it('does not treat local processing or tool execution as model activity', () => {
    expect(
      shouldShowLoadingIndicator(
        StreamingState.Responding,
        false,
        false,
        false,
      ),
    ).toBe(false);
  });

  it('shows throughout an active model turn without a pending action', () => {
    expect(
      shouldShowLoadingIndicator(
        StreamingState.Responding,
        true,
        false,
        false,
      ),
    ).toBe(true);
    expect(
      shouldShowLoadingIndicator(
        StreamingState.Responding,
        true,
        false,
        true,
      ),
    ).toBe(false);
    expect(
      shouldShowLoadingIndicator(
        StreamingState.Idle,
        true,
        false,
        false,
      ),
    ).toBe(false);
  });

  it('preserves explicit local-command progress without inventing model activity', () => {
    expect(
      shouldShowLoadingIndicator(
        StreamingState.Responding,
        false,
        true,
        false,
      ),
    ).toBe(true);
  });
});

/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it } from 'vitest';
import { getColorForDisplay, shouldShowColor } from './utils.js';

describe('agent color display compatibility', () => {
  it.each([
    ['blue', '#3b82f6'],
    ['Blue', '#3b82f6'],
    ['green', '#10b981'],
    ['Green', '#10b981'],
  ] as const)('paints %s with its existing color', (value, expected) => {
    expect(getColorForDisplay(value)).toBe(expected);
    expect(shouldShowColor(value)).toBe(true);
  });
  it.each([undefined, 'auto'])('keeps automatic color %s implicit', (value) => {
    expect(getColorForDisplay(value)).toBeUndefined();
    expect(shouldShowColor(value)).toBe(false);
  });
});

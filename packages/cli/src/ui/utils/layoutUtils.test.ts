/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  calculatePromptWidths,
  clampDialogHeight,
  getDialogMaxHeight,
  STATIC_EXTRA_HEIGHT,
} from './layoutUtils.js';

describe('layoutUtils', () => {
  it('calculates prompt widths', () => {
    expect(calculatePromptWidths(100)).toEqual({
      inputWidth: 84,
      containerWidth: 90,
      suggestionsWidth: 100,
      frameOverhead: 6,
    });
  });

  it('reserves static chrome and a bottom safety margin for dialog height', () => {
    expect(getDialogMaxHeight(24, STATIC_EXTRA_HEIGHT)).toBe(19);
  });

  it('gives both renderers the same popup budget from one constant', () => {
    // The OpenTUI shell's dialog region and ink's AppContainer both subtract
    // this value; a second copy of the literal would let the two legs drift.
    expect(STATIC_EXTRA_HEIGHT).toBe(3);
    expect(getDialogMaxHeight(40, STATIC_EXTRA_HEIGHT)).toBe(35);
  });

  it('keeps at least one row for dialog height', () => {
    expect(getDialogMaxHeight(4, 10)).toBe(1);
  });

  it('clamps optional dialog heights to whole positive rows', () => {
    expect(clampDialogHeight(undefined)).toBeUndefined();
    expect(clampDialogHeight(12.8)).toBe(12);
    expect(clampDialogHeight(0)).toBe(1);
    expect(clampDialogHeight(-4)).toBe(1);
  });
});

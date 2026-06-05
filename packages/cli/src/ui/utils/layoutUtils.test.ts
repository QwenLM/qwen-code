/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { calculatePromptWidths, getDialogMaxHeight } from './layoutUtils.js';

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
    expect(getDialogMaxHeight(24, 3)).toBe(19);
  });

  it('keeps at least one row for dialog height', () => {
    expect(getDialogMaxHeight(4, 10)).toBe(1);
  });
});

/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getColorForDisplay, shouldShowColor } from './utils.js';

describe('persisted subagent display colors', () => {
  it('renders canonical ids and historical display labels with the same color', () => {
    expect(getColorForDisplay('blue')).toBe('#3b82f6');
    expect(getColorForDisplay('Blue')).toBe('#3b82f6');
  });

  it('leaves automatic and unknown colors to the caller default', () => {
    expect(getColorForDisplay('auto')).toBeUndefined();
    expect(getColorForDisplay()).toBeUndefined();
    expect(getColorForDisplay('unknown-color')).toBeUndefined();
    expect(shouldShowColor('auto')).toBe(false);
    expect(shouldShowColor('blue')).toBe(true);
  });
});

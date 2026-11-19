/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { openTuiScrollbarOptions } from './scrollbar-visibility.js';

describe('openTuiScrollbarOptions', () => {
  it('hides the bar unless the setting is explicitly true', () => {
    expect(openTuiScrollbarOptions(undefined)).toEqual({ visible: false });
    expect(openTuiScrollbarOptions(false)).toEqual({ visible: false });
  });

  it('leaves the bar to OpenTUI auto-hide when enabled', () => {
    expect(openTuiScrollbarOptions(true)).toBeUndefined();
  });
});

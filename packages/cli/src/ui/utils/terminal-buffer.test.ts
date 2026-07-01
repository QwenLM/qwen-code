/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { shouldUseVirtualViewport } from './terminal-buffer.js';

describe('shouldUseVirtualViewport', () => {
  it('defaults to virtual viewport when the setting is unset', () => {
    expect(shouldUseVirtualViewport(undefined, false)).toBe(true);
  });

  it('respects explicit terminal buffer settings', () => {
    expect(shouldUseVirtualViewport(true, false)).toBe(true);
    expect(shouldUseVirtualViewport(false, false)).toBe(false);
  });

  it('keeps screen-reader mode off the virtual viewport path', () => {
    expect(shouldUseVirtualViewport(undefined, true)).toBe(false);
    expect(shouldUseVirtualViewport(true, true)).toBe(false);
    expect(shouldUseVirtualViewport(false, true)).toBe(false);
  });
});

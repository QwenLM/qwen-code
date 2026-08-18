/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the disabled-skipping radio navigation used by the editor dialog
 * (ink BaseSelectionList parity): arrows clamp at the edges and walk past
 * disabled entries.
 */

import { describe, it, expect, vi } from 'vitest';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import { nextEnabledIndex } from './dialogs-misc.js';

describe('nextEnabledIndex (ink BaseSelectionList parity)', () => {
  const items = [
    { disabled: false },
    { disabled: true },
    { disabled: false },
    { disabled: false },
  ];

  it('moves to the next enabled entry, skipping disabled ones', () => {
    expect(nextEnabledIndex(items, 0, 1)).toBe(2);
    expect(nextEnabledIndex(items, 2, -1)).toBe(0);
  });

  it('clamps at the edges', () => {
    expect(nextEnabledIndex(items, 0, -1)).toBe(0);
    expect(nextEnabledIndex(items, 3, 1)).toBe(3);
  });

  it('stays put when only disabled entries remain in that direction', () => {
    const tail = [{ disabled: false }, { disabled: true }, { disabled: true }];
    expect(nextEnabledIndex(tail, 0, 1)).toBe(0);
  });
});

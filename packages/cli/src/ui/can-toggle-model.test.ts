/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { canToggleModel } from './can-toggle-model.js';
import type { Key } from './hooks/useKeypress.js';

const ctrlF: Key = {
  name: 'f',
  ctrl: true,
  meta: false,
  shift: false,
  paste: false,
  sequence: '\x06',
};
const ALL_OK = {
  toggleModelConfigured: true,
  isToggling: false,
  isIdle: true,
  hasActivePty: false,
  embeddedShellFocused: false,
  agentViewHasActiveShellPty: false,
  dialogsVisible: false,
};

describe('canToggleModel guard conditions', () => {
  it('returns true when all conditions pass', () => {
    expect(canToggleModel(ctrlF, ALL_OK)).toBe(true);
  });

  it('returns false when key is not Ctrl+F', () => {
    expect(canToggleModel({ ...ctrlF, name: 'g', ctrl: true }, ALL_OK)).toBe(
      false,
    );
  });

  it('returns false when Ctrl+F with shift', () => {
    expect(canToggleModel({ ...ctrlF, shift: true }, ALL_OK)).toBe(false);
  });

  it('returns false when toggleModel is not configured', () => {
    expect(
      canToggleModel(ctrlF, { ...ALL_OK, toggleModelConfigured: false }),
    ).toBe(false);
  });

  it('returns false when isToggling', () => {
    expect(canToggleModel(ctrlF, { ...ALL_OK, isToggling: true })).toBe(false);
  });

  it('returns false when streaming (not idle)', () => {
    expect(canToggleModel(ctrlF, { ...ALL_OK, isIdle: false })).toBe(false);
  });

  it('returns false when main chat has active PTY', () => {
    expect(canToggleModel(ctrlF, { ...ALL_OK, hasActivePty: true })).toBe(
      false,
    );
  });

  it('returns false when embedded shell is focused', () => {
    expect(
      canToggleModel(ctrlF, { ...ALL_OK, embeddedShellFocused: true }),
    ).toBe(false);
  });

  it('returns false when agent view has active shell PTY', () => {
    expect(
      canToggleModel(ctrlF, { ...ALL_OK, agentViewHasActiveShellPty: true }),
    ).toBe(false);
  });

  it('returns false when a dialog is visible', () => {
    expect(canToggleModel(ctrlF, { ...ALL_OK, dialogsVisible: true })).toBe(
      false,
    );
  });

  it('returns false on bare "f" (no ctrl)', () => {
    expect(canToggleModel({ ...ctrlF, ctrl: false }, ALL_OK)).toBe(false);
  });
});

describe('vimHandleInput cursor-right suppression', () => {
  // vimHandleInput wrapper in AppContainer:
  //   if (canToggleModel(key)) return true; // block cursor-right
  //   return vimHandleInput(key);
  //
  // When canToggleModel is true, the wrapper returns true (handled).
  // When false, it delegates to vimHandleInput — we can't test that
  // here since it requires actual vim context, but we verify the guard.

  it('blocks cursor-right (returns true) when canToggleModel passes', () => {
    // Simulate the vimHandleInput wrapper: when canToggleModel is true,
    // it returns true (consumed) and does NOT forward to vim cursor-right.
    const vimHandleInputWrapper = (key: Key): boolean => {
      if (canToggleModel(key, ALL_OK)) return true;
      return false; // would be vimHandleInput(key)
    };
    expect(vimHandleInputWrapper(ctrlF)).toBe(true);
  });

  it('passes through (returns false) when canToggleModel fails', () => {
    const vimHandleInputWrapper = (key: Key): boolean => {
      if (canToggleModel(key, { ...ALL_OK, toggleModelConfigured: false }))
        return true;
      return false; // would be vimHandleInput(key)
    };
    expect(vimHandleInputWrapper(ctrlF)).toBe(false);
  });
});

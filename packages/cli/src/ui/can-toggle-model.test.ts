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
  inputPromptInTransientMode: false,
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

  it('returns false when InputPrompt is in a transient sub-mode', () => {
    expect(
      canToggleModel(ctrlF, { ...ALL_OK, inputPromptInTransientMode: true }),
    ).toBe(false);
  });

  it('returns false on bare "f" (no ctrl)', () => {
    expect(canToggleModel({ ...ctrlF, ctrl: false }, ALL_OK)).toBe(false);
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  shellFocusReducer,
  initialShellFocusState,
  type ShellFocusState,
  type ShellFocusAction,
} from './shellReducer.js';

describe('shellFocusReducer', () => {
  it('should return the initial state for unknown action', () => {
    // @ts-expect-error - testing default case
    expect(shellFocusReducer(initialShellFocusState, { type: 'UNKNOWN' })).toEqual(
      initialShellFocusState,
    );
  });

  it('should handle SET_ACTIVE_SHELL', () => {
    const action: ShellFocusAction = { type: 'SET_ACTIVE_SHELL', pid: 12345 };
    const state = shellFocusReducer(initialShellFocusState, action);
    expect(state.activeShellId).toBe(12345);
  });

  it('should handle SET_ACTIVE_SHELL with null', () => {
    const initial: ShellFocusState = { ...initialShellFocusState, activeShellId: 123 };
    const action: ShellFocusAction = { type: 'SET_ACTIVE_SHELL', pid: null };
    const state = shellFocusReducer(initial, action);
    expect(state.activeShellId).toBeNull();
  });

  it('should handle SET_OUTPUT_TIME', () => {
    const now = Date.now();
    const action: ShellFocusAction = { type: 'SET_OUTPUT_TIME', time: now };
    const state = shellFocusReducer(initialShellFocusState, action);
    expect(state.lastShellOutputTime).toBe(now);
  });
});

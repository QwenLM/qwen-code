/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal reducer for foreground shell focus state.
 * Background task tracking has been moved to the unified TaskRegistry system.
 */

export interface ShellFocusState {
  activeShellId: number | null;
  lastShellOutputTime: number;
}

export type ShellFocusAction =
  | { type: 'SET_ACTIVE_SHELL'; pid: number | null }
  | { type: 'SET_OUTPUT_TIME'; time: number };

export const initialShellFocusState: ShellFocusState = {
  activeShellId: null,
  lastShellOutputTime: 0,
};

export function shellFocusReducer(
  state: ShellFocusState,
  action: ShellFocusAction,
): ShellFocusState {
  switch (action.type) {
    case 'SET_ACTIVE_SHELL':
      return { ...state, activeShellId: action.pid };
    case 'SET_OUTPUT_TIME':
      return { ...state, lastShellOutputTime: action.time };
    default:
      return state;
  }
}

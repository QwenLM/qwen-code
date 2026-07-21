/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { keyMatchers, Command } from './keyMatchers.js';
import type { Key } from './hooks/useKeypress.js';

/**
 * Conditions that gate the model-toggle hotkey.
 *
 * The toggle fires when ALL of these hold:
 * - `toggleModelConfigured` is true (user has a toggle model set)
 * - `isToggling` is false (no toggle in flight)
 * - `isIdle` is true (no agent running)
 * - `hasActivePty` is false (no shell PTY open)
 * - `embeddedShellFocused` is false (embedded shell not focused)
 * - `agentViewHasActiveShellPty` is false (agent shell not active)
 * - `dialogsVisible` is false (no dialog open)
 */
export interface ToggleModelGuards {
  toggleModelConfigured: boolean;
  isToggling: boolean;
  isIdle: boolean;
  hasActivePty: boolean;
  embeddedShellFocused: boolean;
  agentViewHasActiveShellPty: boolean;
  dialogsVisible: boolean;
}

/**
 * Pure guard check for whether the Ctrl+F keypress should trigger the model
 * toggle. All guard values are passed explicitly so the function is testable
 * without mocking refs or React hooks.
 */
export function canToggleModel(key: Key, guards: ToggleModelGuards): boolean {
  return (
    keyMatchers[Command.TOGGLE_MODEL](key) &&
    guards.toggleModelConfigured &&
    !guards.isToggling &&
    guards.isIdle &&
    !guards.hasActivePty &&
    !guards.embeddedShellFocused &&
    !guards.agentViewHasActiveShellPty &&
    !guards.dialogsVisible
  );
}

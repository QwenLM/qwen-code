/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keyboard parity layer for the OpenTUI renderer (PR1 slice 1).
 *
 * The original ink TUI drives every shortcut from the data-driven
 * `defaultKeyBindings` table (packages/cli/src/config/keyBindings.ts) via the
 * matchers in `ui/keyMatchers.ts`. Instead of re-implementing those tables,
 * this module translates an OpenTUI `KeyEvent` into the original `Key` shape
 * and runs it through the ORIGINAL matchers, so the OpenTUI TUI registers the
 * exact same key behavior (Enter/Shift+Enter/Ctrl+J, history ↑↓/Ctrl+P/N,
 * Ctrl+O/Ctrl+T/Ctrl+S, Ctrl+C/D, Esc, Ctrl+L, ...) as the ink TUI — any
 * future keybinding change in the original table is picked up automatically.
 *
 * Pure + unit-testable; no renderer imports.
 */

import { Command, keyMatchers } from '../keyMatchers.js';
import type { KeyMatchers } from '../keyMatchers.js';
import type { Key } from '../contexts/KeypressContext.js';

export { Command };

/** The subset of an OpenTUI `KeyEvent` that key matching needs. */
export interface OpenTuiKeyInput {
  name: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  /** macOS Option flag reported by the kitty protocol parser. */
  option?: boolean;
  sequence?: string;
  /** Bracketed-paste delivery (OpenTUI routes pastes via a separate event). */
  paste?: boolean;
}

/**
 * Maps an OpenTUI key event onto the original qwen-code `Key` shape consumed
 * by `ui/keyMatchers.ts`. OpenTUI already emits the same key names the
 * original readline parser uses ('return', 'escape', 'up', 'backspace', ...),
 * so only modifier normalization is needed: the original single `meta` flag
 * covers Alt/Option (and the `command` binding column), so Option folds into
 * `meta` exactly like the original KeypressContext does for terminals.
 */
export function toOriginalKey(input: OpenTuiKeyInput): Key {
  return {
    name: input.name,
    ctrl: !!input.ctrl,
    meta: !!(input.meta || input.option),
    shift: !!input.shift,
    paste: !!input.paste,
    sequence: input.sequence ?? '',
  };
}

/** Whether the key matches one specific original command binding. */
export function matchesCommand(
  command: Command,
  input: OpenTuiKeyInput,
  matchers: KeyMatchers = keyMatchers,
): boolean {
  return matchers[command](toOriginalKey(input));
}

/**
 * Commands the OpenTUI TUI handles in slice 1, in the priority the original
 * app evaluates them (AppContainer global keys first, then InputPrompt).
 * The first match wins, mirroring the original short-circuit order.
 */
export const OPENTUI_COMMAND_PRIORITY: readonly Command[] = [
  Command.QUIT,
  Command.EXIT,
  Command.ESCAPE,
  Command.TOGGLE_THINKING_EXPANDED,
  Command.TOGGLE_TOOL_DESCRIPTIONS,
  Command.TOGGLE_IDE_CONTEXT_DETAIL,
  Command.SHOW_MORE_LINES,
  Command.CLEAR_SCREEN,
  Command.CLEAR_INPUT,
  Command.QUEUE_MESSAGE,
  Command.RETRY_LAST,
  Command.HISTORY_UP,
  Command.HISTORY_DOWN,
  Command.NAVIGATION_UP,
  Command.NAVIGATION_DOWN,
  Command.SUBMIT,
  Command.NEWLINE,
];

/**
 * Resolves the highest-priority original command a key triggers, or
 * `undefined` when the key is plain text input (or unbound in slice 1).
 */
export function resolveCommand(
  input: OpenTuiKeyInput,
  matchers: KeyMatchers = keyMatchers,
): Command | undefined {
  const key = toOriginalKey(input);
  for (const command of OPENTUI_COMMAND_PRIORITY) {
    if (matchers[command](key)) {
      return command;
    }
  }
  return undefined;
}

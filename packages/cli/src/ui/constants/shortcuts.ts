/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isAppleTerminal } from '../utils/terminalUtils.js';
import { terminalCapabilityManager } from '../utils/terminalCapabilityManager.js';
import { isNativeModifierDetectionAvailable } from '../utils/nativeModifierDetector.js';
import { env } from '../../ink/stubs/env.js';
import { gte } from '../../ink/stubs/semver.js';

// ---------------------------------------------------------------------------
// VT mode detection (Windows shift+tab fix)
// ---------------------------------------------------------------------------
// Modifier-only chords (like shift+tab) may fail on Windows Terminal without VT mode.
// See: https://github.com/microsoft/terminal/issues/879#issuecomment-618801651
// Node enabled VT mode in 24.2.0 / 22.17.0: https://github.com/nodejs/node/pull/58358
export const SUPPORTS_TERMINAL_VT_MODE =
  env.platform !== 'win32' ||
  (env.isRunningWithBun()
    ? gte(process.versions['bun'] ?? '0.0.0', '1.2.23')
    : (() => {
        const v = process.versions.node;
        // >=22.17.0 <23.0.0 || >=24.2.0
        return (gte(v, '22.17.0') && !gte(v, '23.0.0')) || gte(v, '24.2.0');
      })());

/**
 * Platform-specific key pattern for shift+tab.
 * On Windows without VT mode, falls back to alt+q (shift+tab doesn't work reliably).
 */
export const SHIFT_TAB_KEY = SUPPORTS_TERMINAL_VT_MODE ? 'shift+tab' : 'alt+q';

/**
 * Platform-aware display name for the shift+tab key.
 * On Windows without VT mode, this shows 'Alt+Q' (the fallback binding).
 */
export const SHIFT_TAB_DISPLAY = SUPPORTS_TERMINAL_VT_MODE
  ? 'Shift+Tab'
  : 'Alt+Q';

/**
 * Centralized keyboard shortcut hint text.
 *
 * All interactive components should reference these constants so that
 * shortcut descriptions stay consistent across the entire CLI.
 * This also makes future i18n or wording changes a single-file edit.
 *
 * Convention: "{key} {action}" format. Add new entries as needed
 * by command pages — never hand-write hint strings in components.
 */
export const SHORTCUT_HINTS = {
  // Navigation — tab/arrow switching
  TAB_SWITCH: 'Tab/←→ switch',
  TAB_ONLY_SWITCH: 'Tab switch',
  ARROW_SWITCH: '←→ switch',
  ARROW_CYCLE: '←→ cycle',
  TAB_SWITCH_FOCUS: 'Tab switch focus',
  TAB_SWITCH_MODE: 'Tab switch mode',

  // Navigation — list / scroll
  NAVIGATE: '↑↓ navigate',
  SCROLL: '↑↓ scroll',

  // Confirm / submit actions
  SELECT: 'Enter select',
  CONFIRM: 'Enter confirm',
  SUBMIT: 'Enter submit',
  ENTER_CLOSE: 'Enter close',
  ENTER_OPEN: 'Enter open in browser',
  ENTER_DETAILS: 'Enter details',
  ENTER_VIEW_DIFF: 'Enter view diff',
  ENTER_EDIT: 'Enter edit',
  ENTER_OUTPUT: 'Enter output',
  ENTER_TOGGLE: 'Enter toggle',
  ENTER_TO_LIST: 'Enter to list',
  ENTER_CHOOSE: 'Enter choose',
  ENTER_SAVE: 'Enter save',
  ENTER_RETRY: 'Enter retry',
  ENTER_FILES_AND_CONVERSATION: 'Enter files and conversation',
  ENTER_NEXT_CONFIRM: 'Enter next/confirm',

  // Escape / cancel actions
  CANCEL: 'Esc cancel',
  CLOSE: 'Esc close',
  GO_BACK: 'Esc back',
  ESC_CANCEL_SEARCH: 'Esc cancel search',

  // Single-key shortcuts
  TOGGLE: 'c toggle',
  DELETE: 'd delete',
  S_SESSION_ONLY: 's session only',
  X_DELETE: 'x delete',
  SEARCH: '/ search',
  RESET: 'Ctrl+L reset',
  BACKSPACE_RESET: 'Backspace reset',
  Y_CONFIRM: 'Y confirm',
  N_CANCEL: 'N cancel',
  N_ESC_CANCEL: 'n / Esc cancel',
  SPACE_TOGGLE: '␣ toggle',
  R_RESTART: 'r restart',
  R_REFRESH: 'r refresh',
  CTRL_A_SHOW_ALL_PROJECTS: 'Ctrl+A show all projects',
  CTRL_A_SHOW_CURRENT_REPO: 'Ctrl+A only show current repo',
  CTRL_B_SHOW_CURRENT_BRANCH: 'Ctrl+B only show current branch',
  CTRL_B_SHOW_ALL_BRANCHES: 'Ctrl+B show all branches',
  CTRL_W_SHOW_ALL_WORKTREES: 'Ctrl+W show all worktrees',
  CTRL_W_SHOW_CURRENT_WORKTREE: 'Ctrl+W show current worktree',
  SPACE_PREVIEW: 'Space preview',
  ENTER_RESUME: 'Enter resume',
  ARROW_REORDER: '←/→ reorder',
  S_SORT_R_REVERSE: 's sort · r reverse',
  G_FIRST_LAST: 'g/G first/last',
  U_D_HALF_PAGE: 'u/d half-page',
  SPACE_TOGGLE_MCP: 'Space toggle',
  QUICK_SELECT: '1-9 quick select',
  C_CONVERSATION_ONLY: 'c conversation only',
  F_FILES_ONLY: 'f files only',
  K_KILL: 'k kill',

  // Action labels — Enter-based contextual actions
  ENTER_DELETE_ITEM: 'Enter delete',
  ENTER_AUTHENTICATE: 'Enter authenticate',
  ENTER_VIEW_TOOLS: 'Enter view tools',
  ENTER_INSTALL: 'Enter install',
  ENTER_VERIFY: 'Enter verify',
  ENTER_RUN: 'Enter run',

  // Instruction / contextual hints
  TAB_TOGGLE: 'Tab toggle',
  SHIFT_TAB_UNFOCUS: `${SHIFT_TAB_DISPLAY} to unfocus`,
  CTRL_O_KEY: 'Ctrl+O',
  CTRL_C_EXIT: 'Ctrl+C exit',
  CTRL_D_EXIT: 'Ctrl+D exit',
  PAGE_UP_DOWN_SCROLL: 'PgUp/PgDn scroll',
  R_EXIT_APPLY: 'r exit and apply',
  TAB_TWICE_MORE: 'press tab twice for more',
  QUESTION_SHORTCUTS: '? for shortcuts',
  QUESTION_HIDE_SHORTCUTS: '? hide shortcuts',
  ESC_NORMAL_MODE: 'Esc for NORMAL mode',
  I_INSERT_MODE: 'i for INSERT mode',
  CTRL_S_SELECTION: 'Ctrl-S to enter selection mode to copy text',
  VIEW_TASKS: '/tasks to view',
} as const;

/**
 * Joins multiple shortcut hints with a centered dot separator.
 *
 * @example
 * formatShortcutHint('TAB_SWITCH', 'NAVIGATE', 'SELECT', 'CLOSE')
 * // => "Tab/←→ switch · ↑↓ navigate · Enter select · Esc close"
 */
export function formatShortcutHint(
  ...keys: Array<keyof typeof SHORTCUT_HINTS>
): string {
  return keys.map((k) => SHORTCUT_HINTS[k]).join(' \u00b7 ');
}

/**
 * Returns the most reliable newline shortcut hint for the current terminal.
 *
 * The hint adapts based on terminal capabilities:
 *
 * 1. **Kitty / modifyOtherKeys terminals** (iTerm2, WezTerm, Ghostty, etc.):
 *    All modifier+Enter combos work reliably via escape sequences.
 *    Show "Shift+Enter for newline" (most intuitive).
 *
 * 2. **Apple Terminal on macOS**: Shift+Enter sends the same byte as Enter,
 *    but the bundled native binding can detect the physical Shift key.
 *    Show "Shift+⏎ or Ctrl+J for newline" — Shift+Enter is primary since
 *    it's the most intuitive, Ctrl+J as reliable fallback.
 *
 * 3. **Other terminals without modifier support** (e.g. basic Linux console):
 *    Only Ctrl+J (sends 0x0a) and backslash+Enter are guaranteed to work.
 *    Show "Ctrl+J or \+Enter for newline".
 *
 * @returns A user-facing string describing how to insert a newline.
 */
export function getNewlineShortcut(): string {
  const isMac = process.platform === 'darwin';

  // Best case: terminal can distinguish modifier+Enter natively via
  // Kitty keyboard protocol or modifyOtherKeys
  if (terminalCapabilityManager.canDistinguishModifiedEnter()) {
    return isMac ? 'Shift+⏎' : 'Shift+Enter';
  }

  // Apple Terminal: only advertise Shift+Enter when the bundled native binding
  // is loadable. Ctrl+J remains available as the protocol-level fallback.
  if (isMac && isAppleTerminal() && isNativeModifierDetectionAvailable()) {
    return 'Shift+⏎ or Ctrl+J';
  }

  // Fallback: Ctrl+J always works (it sends 0x0a = line feed)
  // Also mention backslash+Enter as a visual fallback
  return isMac ? 'Ctrl+J or \\⏎' : 'Ctrl+J or \\+Enter';
}

export function getNewlineInstructions(): string {
  return `${getNewlineShortcut()} for newline`;
}

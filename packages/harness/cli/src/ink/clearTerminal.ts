/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Part of the vendored fork of @jrichman/ink v6.6.7, ported to TypeScript
 * with modifications by the Qwen Team. Original work Copyright (c) Vadym
 * Demedes <vadimdemedes@hey.com> (github.com/vadimdemedes), licensed MIT.
 * See packages/cli/src/ink/LICENSE for the full MIT text.
 */

/**
 * Cross-platform terminal clearing with scrollback support.
 * Detects modern terminals that support ESC[3J for clearing scrollback.
 */

import {
  CURSOR_HOME,
  csi,
  cursorDown,
  ERASE_LINE,
  ERASE_SCREEN,
  ERASE_SCROLLBACK,
} from './termio/csi.js';
import { LINK_END } from './termio/osc.js';

// HVP (Horizontal Vertical Position) - legacy Windows cursor home
const CURSOR_HOME_WINDOWS = csi(0, 'f');

function isWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env['WT_SESSION'];
}

function isMintty(): boolean {
  // mintty 3.1.5+ sets TERM_PROGRAM to 'mintty'
  if (process.env['TERM_PROGRAM'] === 'mintty') {
    return true;
  }
  // GitBash/MSYS2/MINGW use mintty and set MSYSTEM
  if (process.platform === 'win32' && process.env['MSYSTEM']) {
    return true;
  }
  return false;
}

function isModernWindowsTerminal(): boolean {
  // Windows Terminal sets WT_SESSION environment variable
  if (isWindowsTerminal()) {
    return true;
  }

  // VS Code integrated terminal on Windows with ConPTY support
  if (
    process.platform === 'win32' &&
    process.env['TERM_PROGRAM'] === 'vscode' &&
    process.env['TERM_PROGRAM_VERSION']
  ) {
    return true;
  }

  // mintty (GitBash/MSYS2/Cygwin) supports modern escape sequences
  if (isMintty()) {
    return true;
  }

  return false;
}

/**
 * Returns the ANSI escape sequence to clear the terminal including scrollback.
 * Automatically detects terminal capabilities.
 */
export function getClearTerminalSequence(): string {
  if (process.platform === 'win32') {
    if (isModernWindowsTerminal()) {
      return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME;
    } else {
      // Legacy Windows console - can't clear scrollback
      return ERASE_SCREEN + CURSOR_HOME_WINDOWS;
    }
  }
  return ERASE_SCREEN + ERASE_SCROLLBACK + CURSOR_HOME;
}

/**
 * Erase the active viewport without changing native scrollback row identity.
 * Cursor movement deliberately uses CUD rather than LF so the erase cannot
 * create new scrollback rows at the bottom margin.
 */
export function getEraseViewportSequence(rows: number): string {
  const viewportRows = Math.max(0, Math.floor(rows));
  let sequence = LINK_END + '\x1b[0m' + CURSOR_HOME;

  for (let row = 0; row < viewportRows; row++) {
    sequence += ERASE_LINE;
    if (row + 1 < viewportRows) {
      sequence += cursorDown(1);
    }
  }

  return sequence + CURSOR_HOME;
}

/**
 * Clears the terminal screen. On supported terminals, also clears scrollback.
 */
export const clearTerminal = getClearTerminalSequence();

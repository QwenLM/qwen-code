/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { sanitizeForOsc } from '../ui/utils/osc8.js';

export const DEFAULT_WINDOW_TITLE = 'qwen';

const MULTIPLEXER_ENV_KEYS = ['TMUX', 'STY', 'ZELLIJ', 'DVTM'] as const;

/** Strip control characters and BiDi/line-separator controls. */
export function sanitizeWindowTitle(title: string): string {
  return sanitizeForOsc(title);
}

/**
 * Computes the window title for the Qwen Code application.
 *
 * Priority chain:
 *  1. CLI_TITLE environment variable (if set)
 *  2. folderName — typically the basename of the workspace directory
 *  3. DEFAULT_WINDOW_TITLE ('qwen')
 *
 * @param folderName - Optional workspace folder name for project identification.
 * @returns The computed window title.
 */
export function computeWindowTitle(folderName?: string): string {
  return sanitizeWindowTitle(
    process.env['CLI_TITLE'] || `Qwen - ${folderName || DEFAULT_WINDOW_TITLE}`,
  );
}

/**
 * Writes the terminal window title escape sequences.
 *
 * Pads the title to 80 characters to prevent taskbar / dock icon resizing
 * when the title length changes between updates.
 *
 * On Windows, also sets `process.title` so the title appears in Task Manager.
 *
 * In terminal multiplexers (tmux, screen), only OSC 2 (window title) is
 * written to avoid cluttering the multiplexer's window list with padded
 * titles. Outside multiplexers, both OSC 0 (icon name + window title)
 * and OSC 2 are written for full terminal integration.
 */
export function writeTerminalTitle(
  write: (value: string) => void,
  title: string,
): void {
  const clean = sanitizeWindowTitle(title);
  if (process.platform === 'win32') {
    process.title = clean;
  }
  const inMultiplexer = MULTIPLEXER_ENV_KEYS.some((k) => !!process.env[k]);
  if (clean.length === 0) {
    if (inMultiplexer) {
      write('\x1b]2;\x07');
    } else {
      write('\x1b]0;\x07\x1b]2;\x07');
    }
    return;
  }
  if (inMultiplexer) {
    write(`\x1b]2;${clean}\x07`);
  } else {
    const padded = clean.substring(0, 80).padEnd(80, ' ');
    write(`\x1b]0;${padded}\x07\x1b]2;${padded}\x07`);
  }
}

/**
 * Formats the terminal window title based on session name and fallback.
 *
 * Priority:
 *  1. CLI_TITLE environment variable (if set) — multi-role launcher identity
 *  2. sessionName — from /rename, auto-title, or --resume
 *  3. computeWindowTitle(folderName) — project folder, or default
 *
 * CLI_TITLE takes highest priority so that when multiple qwen-code sessions
 * run in parallel terminal tabs (e.g. one per AI agent role sharing one
 * workspace), the launcher-set role name (g-glm, ap-glm, dx-glm, invest-glm)
 * always identifies the tab regardless of session auto-naming.
 *
 * @param sessionName - Current session name, or null if not set.
 * @param folderName - Optional workspace folder name for the fallback chain.
 * @returns The formatted title string with control characters removed.
 */
export function formatSessionWindowTitle(
  sessionName: string | null,
  folderName?: string,
): string {
  if (process.env['CLI_TITLE']) {
    return computeWindowTitle(folderName);
  }
  return sessionName
    ? sanitizeWindowTitle(sessionName)
    : computeWindowTitle(folderName);
}

/**
 * Re-applies the window title directly to process.stdout.
 *
 * After a child process (e.g. cmd.exe spawned by shell command execution)
 * overwrites the console window title, the title-setting useEffect in
 * AppContainer does NOT re-fire because its dependency array
 * (sessionName, hideWindowTitle, showStatusInTitle, config) is unchanged.
 * This helper bridges that gap by re-emitting the OSC escape sequences.
 */
export function restoreWindowTitle(
  sessionName: string | null = null,
  folderName?: string,
): void {
  const title = formatSessionWindowTitle(sessionName, folderName);
  try {
    writeTerminalTitle((value) => process.stdout.write(value), title);
  } catch {
    // EPIPE or broken stdout — best effort, don't crash callers.
    // In particular, shellCommandProcessor calls this in a .finally()
    // block where a throw would prevent resolve() from firing.
  }
}

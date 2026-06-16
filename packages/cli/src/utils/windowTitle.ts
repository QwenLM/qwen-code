/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export const DEFAULT_WINDOW_TITLE = 'qwen';

/**
 * Strip control characters that could break out of a terminal title payload.
 * Removes C0 controls (0x00-0x1F), DEL (0x7F), and C1 controls (0x80-0x9F)
 * that terminals may interpret as sequence boundaries.
 * Preserves printable Unicode and common whitespace.
 */
function sanitizeWindowTitle(title: string): string {
  return title.replace(
    // eslint-disable-next-line no-control-regex
    /[\x00-\x1F\x7F\x80-\x9F]/g,
    '',
  );
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
 */
export function writeTerminalTitle(
  write: (value: string) => void,
  title: string,
): void {
  const clean = sanitizeWindowTitle(title);
  const padded = clean.padEnd(80, ' ');
  if (process.platform === 'win32') {
    process.title = clean;
  }
  write(`\x1b]0;${padded}\x07\x1b]2;${padded}\x07`);
}

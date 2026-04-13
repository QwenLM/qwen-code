/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import process from 'node:process';
import { createDebugLogger } from '@qwen-code/qwen-code-core';

const debugLogger = createDebugLogger('THEME_DETECT');

export type DetectedTheme = 'dark' | 'light';

/**
 * Detects whether the terminal is using a dark or light theme.
 *
 * Detection order:
 * 1. macOS system appearance (AppleInterfaceStyle)
 * 2. COLORFGBG environment variable
 *
 * Returns 'dark' as the default if detection fails.
 */
export function detectTerminalTheme(): DetectedTheme {
  const macResult = detectMacOSTheme();
  if (macResult) {
    debugLogger.info(
      `Detected theme from macOS system appearance: ${macResult}`,
    );
    return macResult;
  }

  const colorFgBgResult = detectFromColorFgBg();
  if (colorFgBgResult) {
    debugLogger.info(`Detected theme from COLORFGBG: ${colorFgBgResult}`);
    return colorFgBgResult;
  }

  debugLogger.info('Could not detect terminal theme, defaulting to dark');
  return 'dark';
}

/**
 * Detects the macOS system appearance using `defaults read -g AppleInterfaceStyle`.
 * Returns 'dark' if Dark Mode is active, 'light' if it's not (command fails means light mode).
 * Returns undefined on non-macOS platforms.
 */
export function detectMacOSTheme(): DetectedTheme | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }

  try {
    const result = execSync('defaults read -g AppleInterfaceStyle', {
      encoding: 'utf-8',
      timeout: 3000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();

    // If the command succeeds and returns "Dark", the system is in dark mode.
    // Any other value is treated as light mode.
    return result.toLowerCase() === 'dark' ? 'dark' : 'light';
  } catch {
    // On macOS, if the key doesn't exist, the command fails — this means Light Mode.
    return 'light';
  }
}

/**
 * Detects theme from the COLORFGBG environment variable.
 *
 * COLORFGBG is set by some terminals (e.g., rxvt, xterm, iTerm2, Konsole)
 * in the format "foreground;background" where values are ANSI color indices (0-15).
 *
 * ANSI color indices:
 * - 0-6: dark colors (black, red, green, yellow, blue, magenta, cyan)
 * - 7: light gray (considered light)
 * - 8: dark gray (considered dark)
 * - 9-14: bright colors
 * - 15: white (considered light)
 *
 * A light background (7, 9-15) suggests a light theme.
 * A dark background (0-6, 8) suggests a dark theme.
 */
export function detectFromColorFgBg(): DetectedTheme | undefined {
  const colorFgBg = process.env['COLORFGBG'];
  if (!colorFgBg) {
    return undefined;
  }

  // The format is "fg;bg" or sometimes "fg;extra;bg"
  const parts = colorFgBg.split(';');
  const bgStr = parts[parts.length - 1];
  if (bgStr === undefined) {
    return undefined;
  }

  const bg = parseInt(bgStr, 10);
  if (isNaN(bg)) {
    return undefined;
  }

  // Background color index:
  // 0-6 = dark colors, 8 = dark gray → dark theme
  // 7 = light gray, 9-15 = bright colors → light theme
  if (bg === 7 || (bg >= 9 && bg <= 15)) {
    return 'light';
  }

  return 'dark';
}

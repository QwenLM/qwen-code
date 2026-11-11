/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';
import { getTuiEnvironment } from './tuiEnvironment.js';

function isGnuScreenCompatibilityLayer(): boolean {
  if (process.env['STY']) {
    return true;
  }

  // tmux often reports TERM=screen-256color, but it has separate passthrough
  // behavior and is handled by the tmux-specific color clamp.
  if (process.env['TMUX']) {
    return false;
  }

  const term = process.env['TERM'] ?? '';
  const termcap = process.env['TERMCAP'] ?? '';
  return (
    term === 'screen' ||
    term.startsWith('screen-') ||
    termcap.startsWith('SC|screen|')
  );
}

function shouldTrustGnuScreenTrueColor(): boolean {
  return getTuiEnvironment().trueColor === true;
}

function shouldUseGnuScreenColorFallback(): boolean {
  return isGnuScreenCompatibilityLayer() && !shouldTrustGnuScreenTrueColor();
}

/**
 * Returns the color depth of the current terminal.
 * Returns 24 (TrueColor) if unknown or not a TTY.
 *
 * process.stdout.getColorDepth() can underreport in alternate-screen / CC Ink
 * environments because the WriteStream may not recognize COLORTERM or TERM
 * environment variables. We check those explicitly as overrides.
 */
export function getColorDepth(): number {
  const useGnuScreenColorFallback = shouldUseGnuScreenColorFallback();

  // COLORTERM=truecolor is the de-facto standard signal for 24-bit support.
  // Many terminals set this (iTerm2, GNOME Terminal, VS Code, etc.).
  if (
    !useGnuScreenColorFallback &&
    (process.env['COLORTERM'] === 'truecolor' ||
      process.env['COLORTERM'] === '24bit')
  ) {
    return 24;
  }
  // TERM containing 256color signals at least 8-bit (256-color) support.
  const term = process.env['TERM'] ?? '';
  if (term.includes('256color')) {
    if (useGnuScreenColorFallback) {
      return 8;
    }
    // 256-color is 8-bit, but most 256-color terminals also support truecolor.
    // Return 24 to avoid falsely triggering low-color fallbacks.
    return 24;
  }
  const stdoutDepth = process.stdout.getColorDepth
    ? process.stdout.getColorDepth()
    : 24;
  return useGnuScreenColorFallback ? Math.min(stdoutDepth, 8) : stdoutDepth;
}

/**
 * Returns true if the terminal has low color depth (less than 24-bit).
 */
export function isLowColorDepth(): boolean {
  return getColorDepth() < 24;
}

let cachedIsAppleTerminal: boolean | undefined;

/**
 * Returns true if the current terminal is macOS Terminal.app.
 * Used for terminal-specific keyboard modifier handling.
 */
export function isAppleTerminal(): boolean {
  if (cachedIsAppleTerminal !== undefined) {
    return cachedIsAppleTerminal;
  }
  cachedIsAppleTerminal = process.env['TERM_PROGRAM'] === 'Apple_Terminal';
  return cachedIsAppleTerminal;
}

/**
 * Resets the cached Apple Terminal detection value.
 * Primarily used for testing.
 */
export function resetAppleTerminalCache(): void {
  cachedIsAppleTerminal = undefined;
}

let cachedIsSSH: boolean | undefined;

/**
 * Returns true if the current session is running over SSH.
 * SSH sessions often have limited terminal protocol support — e.g. Alt+Enter
 * may produce a bare \r instead of the expected escape sequence, and modifier
 * keys on Enter may not be distinguishable.
 */
export function isSSH(): boolean {
  if (cachedIsSSH !== undefined) {
    return cachedIsSSH;
  }
  cachedIsSSH = Boolean(
    process.env['SSH_TTY'] ||
      process.env['SSH_CONNECTION'] ||
      process.env['SSH_CLIENT'],
  );
  return cachedIsSSH;
}

/**
 * Resets the cached SSH detection value.
 * Primarily used for testing.
 */
export function resetSSHCache(): void {
  cachedIsSSH = undefined;
}

let cachedIsUnicodeSupported: boolean | undefined;

/**
 * Returns true if the terminal supports Unicode box-drawing and symbol
 * characters beyond the basic ASCII / CP437 range.
 *
 * On non-Windows platforms, Unicode is assumed supported (except the raw
 * Linux virtual console, `TERM=linux`).
 *
 * On Windows, we check for modern terminal emulators that have full Unicode
 * support. Legacy Windows CMD / conhost with raster fonts cannot render
 * characters like ╭╮╰╯╌╎❯●▶ and will show garbled output.
 *
 * This follows the detection logic from the `is-unicode-supported` npm
 * package with additional checks for common terminal emulators.
 */
export function isUnicodeSupported(): boolean {
  if (cachedIsUnicodeSupported !== undefined) {
    return cachedIsUnicodeSupported;
  }

  if (process.platform !== 'win32') {
    // The Linux virtual console (not a terminal emulator) has limited glyph
    // support. Everything else on macOS / Linux is assumed Unicode-capable.
    cachedIsUnicodeSupported = process.env['TERM'] !== 'linux';
    return cachedIsUnicodeSupported;
  }

  // --- Windows-specific detection ---

  cachedIsUnicodeSupported =
    // Windows Terminal (modern, full Unicode)
    Boolean(process.env['WT_SESSION']) ||
    // VS Code integrated terminal
    process.env['TERM_PROGRAM'] === 'vscode' ||
    // ConEmu / Cmder
    process.env['ConEmuANSI'] === 'ON' ||
    Boolean(process.env['ConEmuTask']) ||
    // Terminus (Sublime Text plugin)
    Boolean(process.env['TERMINUS_SUBLIME']) ||
    process.env['TERM_PROGRAM'] === 'Terminus-Sublime' ||
    // JetBrains terminal
    process.env['TERMINAL_EMULATOR'] === 'JetBrains-JediTerm' ||
    // mintty (Git for Windows default), MSYS2, Cygwin — these set TERM
    process.env['TERM'] === 'xterm-256color' ||
    process.env['TERM'] === 'xterm' ||
    // Alacritty
    process.env['TERM'] === 'alacritty' ||
    // WezTerm
    process.env['TERM_PROGRAM'] === 'WezTerm' ||
    // Hyper terminal
    process.env['TERM_PROGRAM'] === 'Hyper' ||
    // Tabby terminal
    process.env['TERM_PROGRAM'] === 'Tabby';

  return cachedIsUnicodeSupported;
}

/**
 * Resets the cached Unicode support detection value.
 * Primarily used for testing.
 */
export function resetUnicodeSupportCache(): void {
  cachedIsUnicodeSupported = undefined;
}

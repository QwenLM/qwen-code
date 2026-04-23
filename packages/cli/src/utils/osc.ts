/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OSC (Operating System Command) escape sequence utilities for terminal
 * notifications, tab status indicators, and multiplexer passthrough.
 */

// ── Escape sequence primitives ──────────────────────────────────────

export const ESC = '\x1b';
export const BEL = '\x07';
/** String Terminator — used by Kitty instead of BEL */
export const ST = ESC + '\\';
export const OSC_PREFIX = ESC + ']';
const SEP = ';';

// ── OSC type codes ──────────────────────────────────────────────────

export const OSC = {
  /** iTerm2 notification / progress */
  ITERM2: 9,
  /** Kitty desktop notification protocol */
  KITTY: 99,
  /** Ghostty / cmux notification */
  GHOSTTY: 777,
} as const;

// ── Terminal type detection ─────────────────────────────────────────

export type TerminalType =
  | 'iTerm.app'
  | 'kitty'
  | 'ghostty'
  | 'Apple_Terminal'
  | 'unknown';

/**
 * Detect the current terminal emulator from environment variables.
 */
export function detectTerminal(): TerminalType {
  // Check TERM before TERM_PROGRAM — some terminals (e.g. Kitty, Ghostty)
  // set TERM but not TERM_PROGRAM, especially on macOS.
  if (process.env['TERM'] === 'xterm-ghostty') {
    return 'ghostty';
  }
  if (process.env['TERM']?.includes('kitty')) {
    return 'kitty';
  }

  const term = process.env['TERM_PROGRAM'];
  switch (term) {
    case 'iTerm.app':
      return 'iTerm.app';
    case 'kitty':
      return 'kitty';
    case 'ghostty':
      return 'ghostty';
    case 'Apple_Terminal':
      return 'Apple_Terminal';
    default:
      // Fallback: check terminal-specific env vars
      if (process.env['KITTY_WINDOW_ID']) return 'kitty';
      return 'unknown';
  }
}

// ── Core OSC builders ───────────────────────────────────────────────

/**
 * Build an OSC escape sequence from parts.
 * Uses ST terminator for Kitty (which doesn't support BEL in OSC),
 * and BEL for all other terminals.
 */
export function osc(...parts: Array<string | number>): string {
  const terminator = detectTerminal() === 'kitty' ? ST : BEL;
  return `${OSC_PREFIX}${parts.join(SEP)}${terminator}`;
}

/**
 * Wrap an OSC sequence for tmux / screen passthrough.
 *
 * - tmux: DCS `\ePtmux;\e<seq>\e\\` with ESC doubling inside
 * - screen: DCS `\eP<seq>\e\\`
 *
 * BEL should NOT be wrapped — raw BEL triggers tmux's bell-action,
 * whereas a wrapped BEL becomes an opaque DCS payload and is ignored.
 */
export function wrapForMultiplexer(sequence: string): string {
  if (process.env['TMUX']) {
    // tmux requires all ESC bytes inside the payload to be doubled
    const escaped = sequence.replaceAll('\x1b', '\x1b\x1b');
    return `\x1bPtmux;${escaped}\x1b\\`;
  }
  if (process.env['STY']) {
    return `\x1bP${sequence}\x1b\\`;
  }
  return sequence;
}

// ── Notification helpers ────────────────────────────────────────────

/**
 * iTerm2 notification via OSC 9.
 * Format: `\e]9;\n\n<title>:\n<message>\a`
 */
export function oscITerm2Notify(title: string, message: string): string {
  const displayString = title ? `${title}:\n${message}` : message;
  // The \n\n prefix signals iTerm2 to show a system notification
  // rather than just a tab badge/growl.
  return osc(OSC.ITERM2, `\n\n${displayString}`);
}

/**
 * Kitty desktop notification via OSC 99 (three-step protocol).
 * Returns an array of sequences that must be written in order.
 *
 * @see https://sw.kovidgoyal.net/kitty/desktop-notifications/
 */
export function oscKittyNotify(
  title: string,
  message: string,
  id: number,
): string[] {
  return [
    osc(OSC.KITTY, `i=${id}:d=0:p=title`, title),
    osc(OSC.KITTY, `i=${id}:p=body`, message),
    osc(OSC.KITTY, `i=${id}:d=1:a=focus`, ''),
  ];
}

/**
 * Ghostty / cmux notification via OSC 777.
 * Format: `\e]777;notify;<title>;<message>\a`
 */
export function oscGhosttyNotify(title: string, message: string): string {
  return osc(OSC.GHOSTTY, 'notify', title, message);
}

/**
 * Generate a random Kitty notification ID.
 */
export function generateKittyId(): number {
  return Math.floor(Math.random() * 2 ** 31);
}

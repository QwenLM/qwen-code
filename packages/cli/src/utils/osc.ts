/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OSC (Operating System Command) escape sequence utilities for terminal
 * notifications, tab status indicators, and multiplexer passthrough.
 *
 * Reference: Claude Code's `src/ink/termio/osc.ts`
 */

// ── Escape sequence primitives ──────────────────────────────────────

export const ESC = '\x1b';
export const BEL = '\x07';
/** String Terminator — used by Kitty instead of BEL */
export const ST = ESC + '\\';
const OSC_PREFIX = ESC + ']';
const SEP = ';';

// ── OSC type codes ──────────────────────────────────────────────────

export const OSC = {
  /** iTerm2 notification / progress */
  ITERM2: 9,
  /** Kitty desktop notification protocol */
  KITTY: 99,
  /** Ghostty / cmux notification */
  GHOSTTY: 777,
  /** cmux tab status (indicator dot + status text) */
  TAB_STATUS: 21337,
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

// ── Tab Status (OSC 21337) ──────────────────────────────────────────

export interface Color {
  r: number;
  g: number;
  b: number;
}

export interface TabStatusFields {
  indicator?: Color | null;
  status?: string | null;
  statusColor?: Color | null;
}

function colorToHex(c: Color): string {
  return `#${[c.r, c.g, c.b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Build an OSC 21337 tab status sequence for cmux.
 * Supports indicator dot color, status text, and status text color.
 */
export function tabStatus(fields: TabStatusFields): string {
  const parts: string[] = [];
  if ('indicator' in fields) {
    parts.push(
      `indicator=${fields.indicator ? colorToHex(fields.indicator) : ''}`,
    );
  }
  if ('status' in fields) {
    parts.push(
      `status=${fields.status?.replaceAll('\\', '\\\\').replaceAll(';', '\\;') ?? ''}`,
    );
  }
  if ('statusColor' in fields) {
    parts.push(
      `status-color=${fields.statusColor ? colorToHex(fields.statusColor) : ''}`,
    );
  }
  return osc(OSC.TAB_STATUS, parts.join(';'));
}

/** Clear all tab status fields */
export const CLEAR_TAB_STATUS = tabStatus({
  indicator: null,
  status: null,
  statusColor: null,
});

// ── Pre-defined tab status colors ───────────────────────────────────

export const TAB_COLORS = {
  /** Green — idle / ready for input */
  IDLE: { r: 0x28, g: 0xa7, b: 0x45 } as Color,
  /** Orange — busy / processing */
  BUSY: { r: 0xf5, g: 0x9e, b: 0x0b } as Color,
  /** Blue — waiting for user confirmation */
  WAITING: { r: 0x3b, g: 0x82, b: 0xf6 } as Color,
} as const;

/**
 * Generate a random Kitty notification ID.
 */
export function generateKittyId(): number {
  return Math.floor(Math.random() * 10000);
}

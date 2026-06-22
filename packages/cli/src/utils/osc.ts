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
 *
 * Strategy: check TERM_PROGRAM first (identifies the actual emulator),
 * then fall back to TERM (describes capabilities, but Ghostty/Kitty set
 * distinctive TERM values when TERM_PROGRAM is absent — e.g. over SSH
 * or inside multiplexers), and finally check terminal-specific env vars.
 */
export function detectTerminal(): TerminalType {
  // 1. TERM_PROGRAM — most reliable for identifying the emulator
  const termProgram = process.env['TERM_PROGRAM'];
  switch (termProgram) {
    case 'iTerm.app':
      return 'iTerm.app';
    case 'kitty':
      return 'kitty';
    case 'ghostty':
      return 'ghostty';
    case 'Apple_Terminal':
      return 'Apple_Terminal';
    default:
      break;
  }

  // 2. TERM — Ghostty and Kitty set distinctive TERM values even when
  //    TERM_PROGRAM is absent (SSH sessions, multiplexers)
  if (process.env['TERM'] === 'xterm-ghostty') {
    return 'ghostty';
  }
  if (process.env['TERM']?.includes('kitty')) {
    return 'kitty';
  }

  // 3. Terminal-specific env vars as last resort
  if (process.env['KITTY_WINDOW_ID']) return 'kitty';

  return 'unknown';
}

// ── Sanitization ───────────────────────────────────────────────────

/**
 * Strip control characters that could break out of an OSC payload.
 * Removes ESC (\x1b), BEL (\x07), ST (ESC + \), and other C0/C1
 * control bytes that terminals interpret as sequence boundaries.
 * Preserves HT (\t), LF (\n), and CR (\r) which are safe in payloads.
 */
export function sanitizeOscPayload(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f]/g, '');
}

// ── Core OSC builders ───────────────────────────────────────────────

/**
 * Build an OSC escape sequence from parts.
 *
 * Terminator selection:
 * - Kitty prefers ST (`ESC \`), but ST inside a GNU screen DCS wrapper
 *   would prematurely terminate the outer DCS. So when `STY` is set
 *   (screen session), we fall back to BEL even for Kitty.
 * - All other terminals always use BEL.
 *
 * All string parts are sanitized to prevent control character injection.
 */
export function osc(...parts: Array<string | number>): string {
  const isKitty = detectTerminal() === 'kitty';
  const inScreen = !!process.env['STY'];
  // Use ST for Kitty except inside screen where ST conflicts with DCS wrapper
  const terminator = isKitty && !inScreen ? ST : BEL;
  const sanitized = parts.map((p) =>
    typeof p === 'string' ? sanitizeOscPayload(p) : p,
  );
  return `${OSC_PREFIX}${sanitized.join(SEP)}${terminator}`;
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

// ── Encoding helpers ───────────────────────────────────────────────

/**
 * Base64-encode a UTF-8 string for Kitty OSC 99 payloads.
 * Kitty requires `e=1` (base64) encoding to safely transport arbitrary
 * UTF-8 text without delimiter/control-character conflicts.
 */
export function encodeKittyPayload(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
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
 * Payloads are base64-encoded (`e=1`) as required by the Kitty
 * notification protocol to safely transport UTF-8 text.
 *
 * @see https://sw.kovidgoyal.net/kitty/desktop-notifications/
 */
export function oscKittyNotify(
  title: string,
  message: string,
  id: number,
): string[] {
  return [
    osc(OSC.KITTY, `i=${id}:d=0:p=title:e=1`, encodeKittyPayload(title)),
    osc(OSC.KITTY, `i=${id}:p=body:e=1`, encodeKittyPayload(message)),
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

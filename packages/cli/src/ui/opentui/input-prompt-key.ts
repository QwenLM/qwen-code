/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Raw-input classification for the OpenTUI input prompt.
 *
 * Backspace is consumed at the renderer raw-input layer (before parsed-key
 * dispatch) so kitty-protocol encodings delete exactly once and never
 * double-fire through the focused editor. The recognized unmodified
 * Backspace encodings are exactly:
 *
 *  - legacy DEL (\x7f) and legacy BS (\x08, Ctrl+H);
 *  - kitty CSI 127u (press, no modifier parameter);
 *  - kitty CSI 127;1u (modifier 1 = no modifiers);
 *  - kitty CSI 127;1:1u (modifier 1, explicit press event);
 *  - kitty CSI 127;1:2u (modifier 1, repeat event).
 *
 * Release events, modified Backspace, and any other ordering or codepoint
 * are rejected. The printable-fallback predicate gates parsed keypresses
 * that the global handler inserts into the editor.
 */

const UNMODIFIED_BACKSPACE_SEQUENCES: ReadonlySet<string> = new Set([
  '\x7f',
  '\x08',
  '\x1b[127u',
  '\x1b[127;1u',
  '\x1b[127;1:1u',
  '\x1b[127;1:2u',
]);

/** True when a raw stdin sequence is a plain or unmodified kitty Backspace. */
export function isUnmodifiedBackspaceSequence(sequence: string): boolean {
  return UNMODIFIED_BACKSPACE_SEQUENCES.has(sequence);
}

/**
 * Raw DELETE_WORD_BACKWARD sequences (keyBindings.ts parity). MinTTY (Git
 * Bash on Windows) emits the byte \x1f (ASCII Unit Separator) for
 * Ctrl+Backspace under its Ctrl-modifies-meta-keys convention; the same byte
 * is the historical Ctrl-mapping of Unit Separator on traditional ANSI/VT
 * terminals. Kitty-encoded modified Backspace (CSI 127;5u etc.) and parsed
 * ctrl/command+backspace keypresses are handled on the parsed-key path.
 */
const DELETE_WORD_BACKWARD_SEQUENCES: ReadonlySet<string> = new Set(['\x1f']);

/** True when a raw stdin sequence is a legacy Ctrl+Backspace word delete. */
export function isDeleteWordBackwardSequence(sequence: string): boolean {
  return DELETE_WORD_BACKWARD_SEQUENCES.has(sequence);
}

/** The parsed-key fields the printable fallback decides on. */
export interface PrintableKeyInput {
  sequence: string;
  /** Shift-produced input stays printable; the flag never rejects. */
  shift?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  super?: boolean;
  hyper?: boolean;
  eventType?: 'press' | 'repeat' | 'release';
}

/**
 * True when a parsed key event carries plain insertable text. ASCII, CJK and
 * emoji pass (plain or Shift-produced); modifier keys, release events, C0
 * controls, DEL and escape-coded editing/navigation sequences do not.
 */
export function isPrintableKeyInput(key: PrintableKeyInput): boolean {
  if (key.ctrl || key.meta || key.option || key.super || key.hyper) {
    return false;
  }
  if (key.eventType === 'release') {
    return false;
  }
  const text = key.sequence;
  if (text.length === 0 || text.startsWith('\x1b')) {
    return false;
  }
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

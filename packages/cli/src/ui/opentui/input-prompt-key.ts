/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { KeyEvent, TextareaRenderable } from '@opentui/core';
import type { TextBuffer } from '../components/shared/text-buffer.js';
import { cpLen } from '../utils/textUtils.js';
import { toOriginalKey } from './key-map.js';
import {
  nativeOffsetToCodePoint,
  replaceNativeSelection,
} from './text-buffer-view.js';

/** Native selection is visual; all edits and undo remain in the Ink buffer. */
export function handleEditorKey(
  editor: TextareaRenderable,
  buffer: TextBuffer,
  key: KeyEvent,
  includeNavigation = false,
): boolean {
  if (key.eventType === 'release') return false;
  const original = toOriginalKey(key);
  const name = original.name;
  const wordLeft =
    ((original.ctrl || original.meta) && original.name === 'left') ||
    (original.meta && !original.ctrl && original.name === 'b');
  const wordRight =
    ((original.ctrl || original.meta) && original.name === 'right') ||
    (original.meta && !original.ctrl && original.name === 'f');
  const nativeSelection =
    (key.shift &&
      (['left', 'right', 'up', 'down', 'home', 'end'].includes(name) ||
        ((key.ctrl || key.meta) && ['a', 'e', 'b', 'f'].includes(name)))) ||
    (key.super && ['left', 'right', 'up', 'down', 'a'].includes(name));
  if (wordLeft || wordRight) {
    editor.clearSelection();
    buffer.move(wordLeft ? 'wordLeft' : 'wordRight');
  } else if (nativeSelection) {
    // These native bindings only move the caret or extend the selection.
    if (!editor.handleKeyPress(key)) return false;
    buffer.moveToOffset(nativeOffsetToCodePoint(editor, editor.cursorOffset));
  } else if ((key.ctrl || key.super) && name === 'z') {
    editor.clearSelection();
    if (key.shift) buffer.redo();
    else buffer.undo();
  } else if (key.ctrl && (name === '-' || name === '.')) {
    editor.clearSelection();
    if (name === '.') buffer.redo();
    else buffer.undo();
  } else if (
    !key.shift &&
    ((!key.ctrl && name === 'home') || ((key.ctrl || key.meta) && name === 'a'))
  ) {
    const selection = editor.getSelection();
    if (selection)
      buffer.moveToOffset(nativeOffsetToCodePoint(editor, selection.start));
    else buffer.move('home');
    editor.clearSelection();
  } else if (
    !key.shift &&
    ((!key.ctrl && name === 'end') || ((key.ctrl || key.meta) && name === 'e'))
  ) {
    const selection = editor.getSelection();
    if (selection)
      buffer.moveToOffset(nativeOffsetToCodePoint(editor, selection.end));
    else buffer.move('end');
    editor.clearSelection();
  } else if (key.ctrl && !key.shift && name === 'k') {
    editor.clearSelection();
    buffer.killLineRight();
  } else if (key.ctrl && !key.shift && name === 'u') {
    editor.clearSelection();
    buffer.killLineLeft();
  } else if (key.ctrl && key.shift && name === 'd') {
    editor.clearSelection();
    const {
      lines,
      cursor: [row],
    } = buffer;
    if (row + 1 < lines.length) {
      buffer.replaceRange(row, 0, row + 1, 0, '');
    } else if (row > 0) {
      buffer.replaceRange(
        row - 1,
        cpLen(lines[row - 1]),
        row,
        cpLen(lines[row]),
        '',
      );
    } else if (lines[0].length > 0) {
      buffer.replaceRange(0, 0, 0, cpLen(lines[0]), '');
    }
  } else if (
    includeNavigation &&
    ((!key.meta &&
      !key.ctrl &&
      ['left', 'right', 'up', 'down'].includes(name)) ||
      (key.ctrl && ['b', 'f'].includes(name)))
  ) {
    const direction = name === 'b' ? 'left' : name === 'f' ? 'right' : name;
    const selection = editor.getSelection();
    if (selection && (direction === 'left' || direction === 'right')) {
      buffer.moveToOffset(
        nativeOffsetToCodePoint(
          editor,
          direction === 'left' ? selection.start : selection.end,
        ),
      );
    } else {
      buffer.move(direction as 'left' | 'right' | 'up' | 'down');
    }
    editor.clearSelection();
  } else if (
    includeNavigation &&
    (['backspace', 'delete'].includes(name) ||
      (key.ctrl && ['h', 'd', 'w'].includes(name)) ||
      (key.meta && name === 'd'))
  ) {
    if (!replaceNativeSelection(editor, buffer, ''))
      buffer.handleInput(original);
  } else if (includeNavigation && name === 'linefeed') {
    if (!replaceNativeSelection(editor, buffer, '\n')) buffer.newline();
  } else {
    return false;
  }
  key.preventDefault();
  return true;
}

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

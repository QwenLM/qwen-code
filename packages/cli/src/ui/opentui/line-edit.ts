/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One-line edit model for the OpenTUI dialog inputs.
 *
 * ink routes every dialog text field through `<TextInput>`, whose editing lives
 * in `useTextBuffer`. The OpenTUI port kept each field's value in the dialog's
 * own state and only ever appended to it, so the caret could not move: ←/→,
 * Home/End, and inserting or deleting in the middle of the string all fell off
 * the keyboard. This module is the single-line slice of that buffer — code-point
 * offsets, ink's own word segmentation, ink's key order — shared by every
 * OpenTUI dialog field.
 *
 * What the model holds is one string, while ink's buffer holds logical lines.
 * The two are equivalent for every operation mapped here, because a line break
 * is just another code point: ink's "join with the previous line" and its
 * "insert a new line" both reduce to adding or removing that character.
 *
 * Not ported, and recorded as follow-ups: word jumps (ctrl/alt+←/→, alt+b/f),
 * delete-word-right (alt+d, ctrl/alt+Delete), kill-line (ctrl+k/ctrl+u) and
 * undo/redo (ctrl+z) — all of which ink's TextInput does bind. ctrl+D is
 * deliberately absent: the app's global EXIT binding acts on it, and this
 * reducer hands it back unhandled, so no field ever edits on that key. Three
 * rendering differences remain as well: ink windows the field at `inputWidth`
 * columns, and its one-line viewport shows only the line the caret is on, so a
 * pasted multi-line value hides everything off that line, while these rows
 * render the whole value; ink blinks the cursor cell every 530 ms, where a
 * steady cell keeps the dialog from repainting on a timer; and the cell carries
 * the theme accent, as the composer's cursor does, where ink paints a gray read
 * from the terminal background (and falls back to an underline where a block
 * would corrupt IME composition).
 */

import { useRef, useState } from 'react';
import {
  findPrevWordStart,
  findPrevWordStartInLine,
  getWordBoundaries,
} from '../components/shared/text-buffer.js';
import type { Key } from '../contexts/KeypressContext.js';
import {
  cpLen,
  cpSlice,
  stripUnsafeCharacters,
  toCodePoints,
} from '../utils/textUtils.js';

export interface LineState {
  /** The field's whole value, line breaks included. */
  text: string;
  /** Caret position as a code-point offset into {@link text}. */
  cursor: number;
}

/** The state ink's TextInput starts a field in: value filled, caret at its end. */
export function endOfLine(text: string): LineState {
  return { text, cursor: cpLen(text) };
}

/** Pull a caret that an externally replaced value left past the end back to it. */
export function clampCaret(state: LineState): LineState {
  const end = cpLen(state.text);
  const cursor = state.cursor < 0 ? 0 : Math.min(state.cursor, end);
  return cursor === state.cursor ? state : { text: state.text, cursor };
}

/**
 * Caret for a value the field's owner may have rewritten.
 *
 * The caret indexes the value the owner acknowledged, not the text this module
 * last proposed: an owner that refuses a character would otherwise leave the
 * caret one cell right of where the user put it, and the next Backspace would
 * delete a character the user never inserted. Capping the caret at the code
 * points the two texts agree on makes a refused keystroke leave no trace at all,
 * and is just the clamp when they are equal.
 */
export function caretForAcceptedValue(
  state: LineState,
  accepted: string,
): LineState {
  if (accepted === state.text) return clampCaret(state);
  const proposed = toCodePoints(state.text);
  const current = toCodePoints(accepted);
  let shared = 0;
  while (
    shared < proposed.length &&
    shared < current.length &&
    proposed[shared] === current[shared]
  ) {
    shared++;
  }
  const cursor = Math.min(state.cursor, shared);
  return { text: accepted, cursor };
}

/** The three pieces a caret splits the value into, for cursor rendering. */
export function caretSpans(state: LineState): {
  before: string;
  at: string;
  after: string;
} {
  const clamped = clampCaret(state);
  return {
    before: cpSlice(clamped.text, 0, clamped.cursor),
    at: cpSlice(clamped.text, clamped.cursor, clamped.cursor + 1),
    after: cpSlice(clamped.text, clamped.cursor + 1),
  };
}

/** `[start, end)` code-point bounds of the line the caret sits on. */
function lineBounds(
  text: string,
  cursor: number,
): { start: number; end: number; line: string } {
  const codePoints = toCodePoints(text);
  let start = cursor;
  while (start > 0 && codePoints[start - 1] !== '\n') start--;
  let end = cursor;
  while (end < codePoints.length && codePoints[end] !== '\n') end++;
  return { start, end, line: codePoints.slice(start, end).join('') };
}

export function insertAtCaret(state: LineState, inserted: string): LineState {
  const { text, cursor } = clampCaret(state);
  const clean = stripUnsafeCharacters(
    inserted.replace(/\r\n/g, '\n').replace(/\r/g, '\n'),
  );
  const width = cpLen(clean);
  if (width === 0) return state;
  return {
    text: cpSlice(text, 0, cursor) + clean + cpSlice(text, cursor),
    cursor: cursor + width,
  };
}

export function backspaceAtCaret(state: LineState): LineState {
  const { text, cursor } = clampCaret(state);
  if (cursor === 0) return state;
  return {
    text: cpSlice(text, 0, cursor - 1) + cpSlice(text, cursor),
    cursor: cursor - 1,
  };
}

export function deleteAtCaret(state: LineState): LineState {
  const { text, cursor } = clampCaret(state);
  if (cursor >= cpLen(text)) return state;
  return {
    text: cpSlice(text, 0, cursor) + cpSlice(text, cursor + 1),
    cursor,
  };
}

export function moveCaretLeft(state: LineState): LineState {
  const { cursor } = clampCaret(state);
  return cursor === 0 ? state : { ...state, cursor: cursor - 1 };
}

export function moveCaretRight(state: LineState): LineState {
  const clamped = clampCaret(state);
  return clamped.cursor >= cpLen(clamped.text)
    ? clamped
    : { ...clamped, cursor: clamped.cursor + 1 };
}

/** To the first code point of the caret's line. */
export function moveCaretHome(state: LineState): LineState {
  const clamped = clampCaret(state);
  return {
    text: clamped.text,
    cursor: lineBounds(clamped.text, clamped.cursor).start,
  };
}

/**
 * Past the last code point of the value. ink's END binding does that rather
 * than the line-end jump its reducer would make: TextInput moves to the line
 * end and then to `cpLen(text)`, so the two differ only after a paste has left
 * the caret on an earlier line.
 */
export function moveCaretEnd(state: LineState): LineState {
  const clamped = clampCaret(state);
  const end = cpLen(clamped.text);
  return clamped.cursor === end ? clamped : { text: clamped.text, cursor: end };
}

export function deleteWordLeftAtCaret(state: LineState): LineState {
  const { text, cursor } = clampCaret(state);
  const { start, line } = lineBounds(text, cursor);
  const col = cursor - start;
  // Column 0 of the first line deletes nothing; on a later line the caret sits
  // after that line's break, so deleting it joins the lines — ink's own
  // delete-word-left fallback.
  if (col === 0) return cursor === 0 ? state : backspaceAtCaret(state);
  const boundary = findPrevWordStart(getWordBoundaries(line), col);
  const fallback = findPrevWordStartInLine(line, col);
  const target = start + (boundary ?? fallback ?? 0);
  return {
    text: cpSlice(text, 0, target) + cpSlice(text, cursor),
    cursor: target,
  };
}

/**
 * ink's `TextBuffer#handleInput` order, restricted to the keys a one-line
 * dialog field can receive. `null` means the field leaves the key to the
 * dialog: Enter, the option-list navigation keys, and every modifier combo
 * this port does not bind.
 */
export function applyLineKey(
  state: LineState,
  key: Pick<Key, 'name' | 'ctrl' | 'meta' | 'sequence'>,
): LineState | null {
  const { name, ctrl, meta, sequence } = key;
  const modified = ctrl || meta;
  const next = clampCaret(state);

  if (name === 'left' && !modified) return moveCaretLeft(next);
  if (ctrl && name === 'b') return moveCaretLeft(next);
  if (name === 'right' && !modified) return moveCaretRight(next);
  if (ctrl && name === 'f') return moveCaretRight(next);
  if (name === 'home' || (ctrl && name === 'a')) return moveCaretHome(next);
  if (name === 'end' || (ctrl && name === 'e')) return moveCaretEnd(next);
  if (ctrl && name === 'w') return deleteWordLeftAtCaret(next);
  if (modified && (name === 'backspace' || sequence === '\x7f')) {
    return deleteWordLeftAtCaret(next);
  }
  if (name === 'backspace' || sequence === '\x7f' || (ctrl && name === 'h')) {
    return backspaceAtCaret(next);
  }
  if (name === 'delete' && !modified) return deleteAtCaret(next);
  return null;
}

/**
 * Caret for a dialog field that keeps its value in the dialog's own state.
 *
 * The mirror exists for the same reason ink's buffer does: a key-event batch
 * sees the render that registered the handler, whose `value` prop is already
 * stale by the second keystroke. Writing it synchronously lets each event edit
 * what the previous one produced, and re-syncing it during render keeps a value
 * replaced from elsewhere (a preset, a go-back) from stranding the caret, or one
 * the owner refused a character of, from leaving that character's trace behind.
 */
export function useLineEdit(
  value: string,
  onChange: (next: string) => void,
  /**
   * Change it to treat the field as freshly mounted: the caret starts past the
   * value, which is where ink's TextInput puts it on mount.
   */
  mountKey?: unknown,
): {
  /**
   * The field's value as the keystroke being handled sees it. Read per access,
   * because the handler a burst runs in belongs to a render that predates it.
   */
  readonly text: string;
  /** Caret offset to render. Read per access, as {@link text} is. */
  readonly caret: number;
  /**
   * ink's TextInput key handling. `false` means the field leaves the key to the
   * dialog — Enter, list navigation, and every combo this port doesn't bind.
   */
  handleKey: (key: Pick<Key, 'name' | 'ctrl' | 'meta' | 'sequence'>) => boolean;
  /** Inserts at the caret: a paste, or a printable key. */
  insert: (text: string) => void;
  /**
   * The field submitted and the wizard moved on. A keystroke handled now would
   * land in the step this read already left, because the read keeps dispatching
   * to the handler of the render that armed it.
   */
  settle: () => void;
  /** Whether {@link settle} was called on this field. */
  readonly settled: boolean;
} {
  const [, repaint] = useState(0);
  // Per render, not per mount: a fresh handler closes over a fresh copy of this,
  // so the flag spans exactly one stdin read while the render that follows the
  // submit clears it. A field whose submit was rejected stays editable.
  let settled = false;
  const mirror = useRef<LineState>(endOfLine(value));
  const mounted = useRef<unknown>(mountKey);
  if (mounted.current !== mountKey) {
    mounted.current = mountKey;
    mirror.current = endOfLine(value);
  } else {
    mirror.current = caretForAcceptedValue(mirror.current, value);
  }
  const commit = (next: LineState) => {
    const changed = next.text !== mirror.current.text;
    mirror.current = next;
    // A caret-only move changes no text, so it needs its own repaint.
    repaint((frame) => frame + 1);
    if (changed) onChange(next.text);
  };
  return {
    get text() {
      return mirror.current.text;
    },
    get caret() {
      return mirror.current.cursor;
    },
    handleKey: (key) => {
      const edited = applyLineKey(mirror.current, key);
      if (!edited) return false;
      commit(edited);
      return true;
    },
    insert: (text) => {
      const edited = insertAtCaret(mirror.current, text);
      if (edited !== mirror.current) commit(edited);
    },
    settle: () => {
      settled = true;
    },
    get settled() {
      return settled;
    },
  };
}

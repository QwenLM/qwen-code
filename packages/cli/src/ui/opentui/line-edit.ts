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
 * undo/redo (ctrl+z) — all of which ink's TextInput does bind, as it does
 * clear-input (ctrl+C) and open-external-editor (ctrl+X). Neither is ported:
 * the app's exit handler acts on ctrl+C wherever a dialog owns the screen, and
 * ctrl+X is unbound in this renderer. ctrl+D is deliberately absent: the app's
 * global EXIT binding acts on it, and this reducer hands it back unhandled, so
 * no field ever edits on that key. Three rendering differences remain as well:
 * ink windows the field at `inputWidth` columns, where these rows do no column
 * windowing of their own; ink blinks the cursor cell every 530 ms, where a
 * steady cell keeps the dialog from repainting on a timer; and the cell carries
 * the theme accent, as the composer's cursor does, where ink paints a gray read
 * from the terminal background (and falls back to an underline where a block
 * would corrupt IME composition). A pasted multi-line value shows only the line
 * the caret is on, as ink's one-line viewport does.
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
import { isDeleteWordBackwardSequence } from './input-prompt-key.js';

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
 * delete a character the user never inserted.
 *
 * Walking the two texts together and charging the caret only for the code points
 * dropped ahead of it covers both shapes an owner refuses in. A single refused
 * keystroke drops one code point at the caret and leaves nothing behind it, and
 * an owner that filters the middle of a pasted value (`1,024` → `1024`) keeps the
 * caret following the accepted tail rather than stranding it on the first
 * character it removed. A value the walk cannot align — the owner inserted or
 * substituted instead of dropping — falls back to capping the caret at the code
 * points the two texts agree on. Both reduce to the clamp when they are equal.
 */
export function caretForAcceptedValue(
  state: LineState,
  accepted: string,
): LineState {
  if (accepted === state.text) return clampCaret(state);
  const proposed = toCodePoints(state.text);
  const current = toCodePoints(accepted);
  const caret0 = Math.min(state.cursor, proposed.length);
  let p = 0;
  let c = 0;
  let dropped = 0;
  while (p < proposed.length && c < current.length) {
    if (proposed[p] === current[c]) {
      p++;
      c++;
    } else if (p < caret0) {
      p++;
      dropped++;
    } else {
      break;
    }
  }
  let cursor = caret0 - dropped;
  if (c < current.length) {
    let shared = 0;
    while (
      shared < proposed.length &&
      shared < current.length &&
      proposed[shared] === current[shared]
    ) {
      shared++;
    }
    cursor = Math.min(state.cursor, shared);
  }
  return {
    text: accepted,
    cursor: Math.max(0, Math.min(cursor, current.length)),
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

/** The three pieces a caret splits the value into, for cursor rendering. */
export function caretSpans(state: LineState): {
  before: string;
  at: string;
  after: string;
} {
  const clamped = clampCaret(state);
  // Only the line under the caret: these spans feed rows that hold one line,
  // and a bracketed paste can carry a newline into a value no keystroke can.
  const { start, end } = lineBounds(clamped.text, clamped.cursor);
  return {
    before: cpSlice(clamped.text, start, clamped.cursor),
    at: cpSlice(
      clamped.text,
      clamped.cursor,
      Math.min(clamped.cursor + 1, end),
    ),
    after: cpSlice(clamped.text, clamped.cursor + 1, end),
  };
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
 * Past the last code point of the caret's line. ink's bare End key falls
 * through to its reducer, whose `end` move is to the end of the line.
 */
export function moveCaretLineEnd(state: LineState): LineState {
  const clamped = clampCaret(state);
  return {
    text: clamped.text,
    cursor: lineBounds(clamped.text, clamped.cursor).end,
  };
}

/**
 * Past the last code point of the value. ink reaches this only through its
 * ctrl+E binding: `TextInput` dispatches the line-end move and then jumps to
 * `cpLen(text)`, so the two differ once a paste leaves the caret on an earlier
 * line. The bare End key stops at the line end instead — see
 * {@link moveCaretLineEnd}.
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
  if (name === 'end') return moveCaretLineEnd(next);
  if (ctrl && name === 'e') return moveCaretEnd(next);
  if (ctrl && name === 'w') return deleteWordLeftAtCaret(next);
  if (
    isDeleteWordBackwardSequence(sequence) ||
    (modified && (name === 'backspace' || sequence === '\x7f'))
  ) {
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
   * The field submitted and its owner moved on. Keys and pastes handled from here
   * would land in the row this read already left, because one stdin read keeps
   * dispatching to the handler of the render that armed it — and the render the
   * submit itself schedules can leave the row mounted and focused.
   */
  settle: () => void;
  /**
   * Whether {@link settle} was called on this field. Holds across renders until
   * `mountKey` re-seeds it, so a submit's own re-render does not disarm the latch.
   */
  readonly settled: boolean;
} {
  const [, repaint] = useState(0);
  // A ref, not a per-render binding: the render a successful submit schedules
  // would otherwise clear the latch, and in the question dialog that render
  // leaves the submitted row mounted and focused for the whole 150 ms pause, so
  // the next stdin read would keep editing an answer already recorded. Clearing
  // it where the mirror is re-seeded re-arms the field exactly when its owner
  // moves on to another row. A field whose submit was rejected stays editable,
  // because only `settle` arms this and every consumer calls it after success.
  const settledRef = useRef(false);
  const mirror = useRef<LineState>(endOfLine(value));
  const mounted = useRef<unknown>(mountKey);
  if (mounted.current !== mountKey) {
    mounted.current = mountKey;
    mirror.current = endOfLine(value);
    settledRef.current = false;
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
      // Enforced here rather than at each call site: a bracketed paste arrives as
      // its own event on the same still-registered handler, so a latch only the
      // keyboard branch checks would let a paste trailing the step-leaving Enter
      // edit a field the wizard has already left.
      if (settledRef.current) return;
      const edited = insertAtCaret(mirror.current, text);
      if (edited !== mirror.current) commit(edited);
    },
    settle: () => {
      settledRef.current = true;
    },
    get settled() {
      return settledRef.current;
    },
  };
}

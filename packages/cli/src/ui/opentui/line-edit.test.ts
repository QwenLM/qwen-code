/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  textBufferReducer,
  type TextBufferAction,
  type TextBufferState,
} from '../components/shared/text-buffer.js';
import type { Key } from '../contexts/KeypressContext.js';
import { cpLen } from '../utils/textUtils.js';
import {
  applyLineKey,
  backspaceAtCaret,
  caretForAcceptedValue,
  caretSpans,
  clampCaret,
  deleteAtCaret,
  deleteWordLeftAtCaret,
  endOfLine,
  insertAtCaret,
  moveCaretEnd,
  moveCaretHome,
  moveCaretLeft,
  moveCaretLineEnd,
  moveCaretRight,
  type LineState,
} from './line-edit.js';

type LineKey = Pick<Key, 'name' | 'ctrl' | 'meta' | 'sequence'>;

const key = (
  name: string,
  modifiers: { ctrl?: boolean; meta?: boolean; sequence?: string } = {},
): LineKey => ({
  name,
  ctrl: modifiers.ctrl ?? false,
  meta: modifiers.meta ?? false,
  sequence: modifiers.sequence ?? '',
});

/**
 * ink's reducer state for a buffer holding `text` with the caret at code-point
 * `cursor`. The visual layout is the identity one `calculateLayout` produces
 * while every line fits the viewport, which is what these fixtures use.
 */
function inkState(text: string, cursor: number): TextBufferState {
  const lines = text.length === 0 ? [''] : text.split('\n');
  let row = 0;
  let remaining = cursor;
  while (row < lines.length - 1 && remaining > lines[row].length) {
    remaining -= [...lines[row]].length + 1;
    row++;
  }
  return {
    lines,
    cursorRow: row,
    cursorCol: Math.min(remaining, [...lines[row]].length),
    preferredCol: null,
    undoStack: [],
    redoStack: [],
    clipboard: null,
    selectionAnchor: null,
    viewportWidth: 80,
    viewportHeight: 1,
    visualLayout: {
      visualLines: lines,
      logicalToVisualMap: lines.map(
        (_, i): Array<[number, number]> => [[i, 0]],
      ),
      visualToLogicalMap: lines.map((_, i): [number, number] => [i, 0]),
    },
  };
}

/** ink's `[row, col]` cursor flattened to a code-point offset in joined text. */
function inkOffset(state: TextBufferState): number {
  let offset = 0;
  for (let i = 0; i < state.cursorRow; i++) {
    offset += [...(state.lines[i] ?? '')].length + 1;
  }
  return offset + state.cursorCol;
}

interface Op {
  ink: (state: TextBufferState) => TextBufferState;
  line: (state: LineState) => LineState;
}

const step = (
  state: TextBufferState,
  action: TextBufferAction,
): TextBufferState => textBufferReducer(state, action);

const typed = (text: string): Op => ({
  ink: (state) => step(state, { type: 'insert', payload: text }),
  line: (state) => insertAtCaret(state, text),
});
const moveHome: Op = {
  ink: (state) => step(state, { type: 'move', payload: { dir: 'home' } }),
  line: moveCaretHome,
};
// ink's END binding is this pair: TextInput dispatches the line-end move and
// then jumps to the end of the whole value.
const moveEnd: Op = {
  ink: (state) =>
    step(step(state, { type: 'move', payload: { dir: 'end' } }), {
      type: 'move_to_offset',
      payload: { offset: cpLen(inkText(state)) },
    }),
  line: moveCaretEnd,
};
// ink's bare End key is not that binding: it falls through to the reducer's
// own line-end move, so it stops at the caret's line.
const bareEnd: Op = {
  ink: (state) => step(state, { type: 'move', payload: { dir: 'end' } }),
  line: moveCaretLineEnd,
};
const stepLeft: Op = {
  ink: (state) => step(state, { type: 'move', payload: { dir: 'left' } }),
  line: moveCaretLeft,
};
const stepRight: Op = {
  ink: (state) => step(state, { type: 'move', payload: { dir: 'right' } }),
  line: moveCaretRight,
};
const eraseBack: Op = {
  ink: (state) => step(state, { type: 'backspace' }),
  line: backspaceAtCaret,
};
const eraseForward: Op = {
  ink: (state) => step(state, { type: 'delete' }),
  line: deleteAtCaret,
};
const eraseWord: Op = {
  ink: (state) => step(state, { type: 'delete_word_left' }),
  line: deleteWordLeftAtCaret,
};

/** Apply every op to both models and compare after each one, not just at the end. */
function agreesWithInk(initial: string, ops: Op[]): void {
  let line = endOfLine(initial);
  let ink = inkState(initial, initial.length);
  for (const [i, op] of ops.entries()) {
    line = op.line(line);
    ink = op.ink(ink);
    expect({ step: i, text: inkText(ink), cursor: inkOffset(ink) }).toEqual({
      step: i,
      text: line.text,
      cursor: line.cursor,
    });
  }
}

const inkText = (state: TextBufferState): string => state.lines.join('\n');

describe('line-edit', () => {
  it("produces ink's textBufferReducer results, keystroke by keystroke", () => {
    // A URL typed into the /auth base-URL field, then corrected in place.
    agreesWithInk('', [
      typed('api.openai.com'),
      moveHome,
      typed('https://'),
      stepLeft,
      stepLeft,
      typed('x'),
      eraseBack,
      eraseWord,
      moveEnd,
      eraseBack,
      eraseForward,
    ]);
  });

  it('agrees with ink across the line break a multi-line paste leaves behind', () => {
    agreesWithInk('', [
      typed('first\r\nsecond\rthird'),
      stepLeft,
      stepLeft,
      typed('!'),
      eraseBack,
      eraseWord,
      moveHome,
      typed('#'),
      moveEnd,
      eraseForward,
    ]);
    agreesWithInk('first\nsecond', [
      stepLeft,
      stepLeft,
      typed('fourth\n'),
      moveHome,
      eraseForward,
      eraseBack,
    ]);
  });

  it('follows ink in jumping ctrl+E past a line break, Home and bare End only to their own', () => {
    expect(moveCaretEnd({ text: 'ab\ncd', cursor: 0 })).toEqual({
      text: 'ab\ncd',
      cursor: 5,
    });
    expect(moveCaretLineEnd({ text: 'ab\ncd', cursor: 0 })).toEqual({
      text: 'ab\ncd',
      cursor: 2,
    });
    expect(moveCaretHome({ text: 'ab\ncd', cursor: 5 })).toEqual({
      text: 'ab\ncd',
      cursor: 3,
    });
    agreesWithInk('ab\ncd', [
      stepLeft,
      stepLeft,
      moveEnd,
      moveHome,
      typed('z'),
      eraseBack,
      eraseBack,
    ]);
    // A paste that leaves the caret on an earlier line is where the two
    // readings of End part: the bare key takes the caret to its own line end,
    // and the next character lands there rather than at the value's.
    agreesWithInk('ab\ncd', [
      moveHome,
      stepLeft,
      stepLeft,
      bareEnd,
      typed('z'),
      eraseBack,
    ]);
    expect(
      applyLineKey({ text: 'ab\ncd', cursor: 0 }, key('end'))?.cursor,
    ).toEqual(
      inkOffset(
        step(inkState('ab\ncd', 0), { type: 'move', payload: { dir: 'end' } }),
      ),
    );
  });

  it('agrees with ink over code points ink weighs as one cell or two', () => {
    agreesWithInk('sk-abc123', [
      stepLeft,
      stepLeft,
      typed('😀'),
      eraseWord,
      moveHome,
      typed('a😀b中c'),
      eraseWord,
      stepRight,
      eraseBack,
    ]);
  });

  it('agrees with ink when the caret is already at a wall', () => {
    agreesWithInk('', [
      eraseBack,
      eraseForward,
      stepLeft,
      stepRight,
      eraseWord,
    ]);
    agreesWithInk('ab', [
      moveHome,
      stepLeft,
      eraseBack,
      moveEnd,
      stepRight,
      eraseForward,
      moveEnd,
      eraseWord,
      moveHome,
      eraseWord,
    ]);
  });

  it("strips what ink strips and normalizes a paste's line endings", () => {
    expect(insertAtCaret(endOfLine('a'), 'b\x07c')).toEqual({
      text: 'abc',
      cursor: 3,
    });
    expect(insertAtCaret(endOfLine('a'), 'b\r\nc\rd')).toEqual({
      text: 'ab\nc\nd',
      cursor: 6,
    });
  });

  it('starts with the caret past the value and clamps one an outside edit left behind', () => {
    expect(endOfLine('a😀b')).toEqual({ text: 'a😀b', cursor: 3 });
    expect(clampCaret({ text: 'ab', cursor: 9 })).toEqual({
      text: 'ab',
      cursor: 2,
    });
    const alreadyInside: LineState = { text: 'ab', cursor: 1 };
    expect(clampCaret(alreadyInside)).toBe(alreadyInside);
  });

  it('lets a value the owner refused leave no trace of its own', () => {
    // The owner's text is what the caret indexes, so a character the field's
    // setter strips back the caret to the last offset that text agrees with.
    expect(
      caretForAcceptedValue({ text: '129x34', cursor: 4 }, '12934'),
    ).toEqual({ text: '12934', cursor: 3 });
    // Repeated refusals cannot walk the caret right: each starts from a state
    // the accepted value already owns.
    expect(
      caretForAcceptedValue({ text: '12934', cursor: 3 }, '12934'),
    ).toEqual({ text: '12934', cursor: 3 });
    // An unrelated value replaces the text, so the caret restarts at its front.
    expect(caretForAcceptedValue({ text: 'abcdef', cursor: 6 }, 'xy')).toEqual({
      text: 'xy',
      cursor: 0,
    });
    // Same text: the plain clamp of an externally shortened value applies.
    expect(caretForAcceptedValue({ text: 'ab', cursor: 9 }, 'ab')).toEqual({
      text: 'ab',
      cursor: 2,
    });
  });

  it('splits the value at the caret for cursor rendering', () => {
    expect(caretSpans({ text: 'abc', cursor: 1 })).toEqual({
      before: 'a',
      at: 'b',
      after: 'c',
    });
    expect(caretSpans({ text: 'abc', cursor: 3 })).toEqual({
      before: 'abc',
      at: '',
      after: '',
    });
    expect(caretSpans({ text: 'ab', cursor: 7 })).toEqual({
      before: 'ab',
      at: '',
      after: '',
    });
  });

  describe('applyLineKey', () => {
    const mid: LineState = { text: 'ab_cd', cursor: 2 };

    it('moves the caret with the arrows and their ctrl bindings', () => {
      expect(applyLineKey(mid, key('left'))).toEqual({ ...mid, cursor: 1 });
      expect(applyLineKey(mid, key('b', { ctrl: true }))).toEqual({
        ...mid,
        cursor: 1,
      });
      expect(applyLineKey(mid, key('right'))).toEqual({ ...mid, cursor: 3 });
      expect(applyLineKey(mid, key('f', { ctrl: true }))).toEqual({
        ...mid,
        cursor: 3,
      });
    });

    it('jumps to the ends of the line by key name and by ctrl+A/ctrl+E', () => {
      expect(applyLineKey(mid, key('home'))).toEqual({ ...mid, cursor: 0 });
      expect(applyLineKey(mid, key('a', { ctrl: true }))).toEqual({
        ...mid,
        cursor: 0,
      });
      expect(applyLineKey(mid, key('end'))).toEqual({ ...mid, cursor: 5 });
      expect(applyLineKey(mid, key('e', { ctrl: true }))).toEqual({
        ...mid,
        cursor: 5,
      });
    });

    it('erases relative to the caret, not the end of the value', () => {
      expect(applyLineKey(mid, key('backspace'))).toEqual({
        text: 'a_cd',
        cursor: 1,
      });
      expect(applyLineKey(mid, key('', { sequence: '\x7f' }))).toEqual({
        text: 'a_cd',
        cursor: 1,
      });
      expect(applyLineKey(mid, key('h', { ctrl: true }))).toEqual({
        text: 'a_cd',
        cursor: 1,
      });
      expect(applyLineKey(mid, key('delete'))).toEqual({
        text: 'abcd',
        cursor: 2,
      });
      expect(applyLineKey({ text: 'ab_cd', cursor: 1 }, key('delete'))).toEqual(
        { text: 'a_cd', cursor: 1 },
      );
    });

    it('deletes a word from ctrl+W, a modified backspace, and the byte a legacy terminal sends for it', () => {
      for (const k of [
        key('w', { ctrl: true }),
        key('backspace', { ctrl: true }),
        key('backspace', { meta: true }),
        key('unknown', { sequence: '\x1f' }),
      ]) {
        expect(applyLineKey({ text: 'https://openai', cursor: 14 }, k)).toEqual(
          {
            text: 'https://',
            cursor: 8,
          },
        );
      }
    });

    it('hands every other key back to the dialog', () => {
      for (const k of [
        key('return'),
        key('up'),
        key('down'),
        key('tab'),
        key('d', { ctrl: true }),
        key('k', { ctrl: true }),
        key('u', { ctrl: true }),
        key('z', { ctrl: true }),
        key('left', { meta: true }),
        key('right', { meta: true }),
        key('b', { meta: true }),
        key('f', { meta: true }),
        key('d', { meta: true }),
        key('delete', { ctrl: true }),
        key('delete', { meta: true }),
      ]) {
        expect(applyLineKey(mid, k)).toBeNull();
      }
    });
  });
});

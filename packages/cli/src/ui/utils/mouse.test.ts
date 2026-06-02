/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  parseSGRMouseEvent,
  parseX11MouseEvent,
  parseMouseEvent,
  isIncompleteMouseSequence,
} from './mouse.js';

const ESC = '\x1b';

describe('parseSGRMouseEvent', () => {
  it('decodes scroll-up (button code 64)', () => {
    const result = parseSGRMouseEvent(`${ESC}[<64;10;20M`);
    expect(result?.event).toMatchObject({
      name: 'scroll-up',
      col: 10,
      row: 20,
      button: 'left', // (64 & 3) === 0
    });
    expect(result?.length).toBe(`${ESC}[<64;10;20M`.length);
  });

  it('decodes scroll-down (button code 65)', () => {
    const result = parseSGRMouseEvent(`${ESC}[<65;5;7M`);
    expect(result?.event.name).toBe('scroll-down');
    expect(result?.event.col).toBe(5);
    expect(result?.event.row).toBe(7);
  });

  it('decodes left-press / left-release', () => {
    const press = parseSGRMouseEvent(`${ESC}[<0;1;1M`);
    expect(press?.event.name).toBe('left-press');
    expect(press?.event.button).toBe('left');
    const release = parseSGRMouseEvent(`${ESC}[<0;1;1m`);
    expect(release?.event.name).toBe('left-release');
  });

  it('decodes modifiers (shift/meta/ctrl)', () => {
    // button 0 + shift(4) + meta(8) + ctrl(16) = 28
    const result = parseSGRMouseEvent(`${ESC}[<28;3;4M`);
    expect(result?.event).toMatchObject({
      name: 'left-press',
      shift: true,
      meta: true,
      ctrl: true,
    });
  });

  it('decodes mouse move (button code 32 + button bits)', () => {
    // 32 (move flag) + 0 (left button) = 32
    const result = parseSGRMouseEvent(`${ESC}[<32;10;10M`);
    expect(result?.event.name).toBe('move');
    expect(result?.event.button).toBe('left');
  });

  it('returns null on garbage', () => {
    expect(parseSGRMouseEvent('not-a-mouse-event')).toBeNull();
    expect(parseSGRMouseEvent(`${ESC}[<10`)).toBeNull(); // incomplete
  });

  it('does not match a well-formed X11 sequence', () => {
    // Security property: useMouseEvents parses via parseSGRMouseEvent (not
    // parseMouseEvent) so an X11 sequence arriving as pasted text cannot
    // misfire a mouse event. The SGR regex requires `<` at position 3 where
    // X11 has `M`, so it structurally cannot match X11.
    const byte0 = String.fromCharCode(64 + 32); // wheel up
    const byte1 = String.fromCharCode(10 + 32);
    const byte2 = String.fromCharCode(20 + 32);
    const x11 = `${ESC}[M${byte0}${byte1}${byte2}`;
    expect(parseX11MouseEvent(x11)).not.toBeNull(); // it IS a valid X11 seq
    expect(parseSGRMouseEvent(x11)).toBeNull(); // but SGR parser ignores it
  });
});

describe('parseX11MouseEvent', () => {
  it('decodes scroll-up via wheel bit', () => {
    // X11: ESC [ M + 3 bytes, each offset by 32. byte0=button+modifiers+wheel(64)+offset(32) = 96 -> char `
    const byte0 = String.fromCharCode(64 + 32); // wheel up
    const byte1 = String.fromCharCode(10 + 32); // col=10
    const byte2 = String.fromCharCode(20 + 32); // row=20
    const result = parseX11MouseEvent(`${ESC}[M${byte0}${byte1}${byte2}`);
    expect(result?.event).toMatchObject({
      name: 'scroll-up',
      col: 10,
      row: 20,
    });
  });

  it('decodes left-press', () => {
    const byte0 = String.fromCharCode(0 + 32); // left press
    const byte1 = String.fromCharCode(5 + 32);
    const byte2 = String.fromCharCode(6 + 32);
    const result = parseX11MouseEvent(`${ESC}[M${byte0}${byte1}${byte2}`);
    expect(result?.event.name).toBe('left-press');
  });

  it('returns null on garbage', () => {
    expect(parseX11MouseEvent('blah')).toBeNull();
  });
});

describe('parseMouseEvent', () => {
  it('prefers SGR when both could match', () => {
    // SGR is parsed first; X11 would not match this string anyway.
    const result = parseMouseEvent(`${ESC}[<64;1;1M`);
    expect(result?.event.name).toBe('scroll-up');
  });
});

describe('isIncompleteMouseSequence', () => {
  it('returns true for prefixes that could become a sequence', () => {
    expect(isIncompleteMouseSequence(`${ESC}`)).toBe(true);
    expect(isIncompleteMouseSequence(`${ESC}[`)).toBe(true);
    expect(isIncompleteMouseSequence(`${ESC}[<`)).toBe(true);
    expect(isIncompleteMouseSequence(`${ESC}[<64;10;`)).toBe(true);
    expect(isIncompleteMouseSequence(`${ESC}[M`)).toBe(true); // X11 needs 3 more bytes
  });

  it('returns false for complete sequences', () => {
    expect(isIncompleteMouseSequence(`${ESC}[<64;10;20M`)).toBe(false);
  });

  it('returns false for clearly non-mouse buffers', () => {
    expect(isIncompleteMouseSequence('a')).toBe(false);
    expect(isIncompleteMouseSequence('hello')).toBe(false);
  });

  it('treats >50-byte unterminated SGR as not-incomplete (garbage guard)', () => {
    const longGarbage = `${ESC}[<${'1'.repeat(60)}`;
    expect(isIncompleteMouseSequence(longGarbage)).toBe(false);
  });
});

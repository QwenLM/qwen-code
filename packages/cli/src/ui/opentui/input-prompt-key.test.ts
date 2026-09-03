/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the raw-input classification behind the OpenTUI prompt's
 * Backspace handling: the exact kitty grammar accepted for unmodified
 * Backspace (release/modified/invalid orderings rejected) and the printable
 * fallback that preserves ASCII/CJK/emoji while rejecting modifiers,
 * controls and release events.
 */

import { describe, expect, it } from 'vitest';
import {
  isDeleteWordBackwardSequence,
  isPrintableKeyInput,
  isUnmodifiedBackspaceSequence,
  type PrintableKeyInput,
} from './input-prompt-key.js';

const key = (input: Partial<PrintableKeyInput> & { sequence: string }) => input;

describe('opentui input-prompt-key: unmodified Backspace', () => {
  it('consumes legacy DEL and legacy BS (Ctrl+H)', () => {
    expect(isUnmodifiedBackspaceSequence('\x7f')).toBe(true);
    expect(isUnmodifiedBackspaceSequence('\x08')).toBe(true);
  });

  it('consumes exactly the four valid kitty Backspace forms', () => {
    expect(isUnmodifiedBackspaceSequence('\x1b[127u')).toBe(true);
    expect(isUnmodifiedBackspaceSequence('\x1b[127;1u')).toBe(true);
    expect(isUnmodifiedBackspaceSequence('\x1b[127;1:1u')).toBe(true);
    expect(isUnmodifiedBackspaceSequence('\x1b[127;1:2u')).toBe(true);
  });

  it('rejects kitty release events', () => {
    for (const release of ['\x1b[127;1:3u', '\x1b[127;2:3u', '\x1b[127;5:3u']) {
      expect(isUnmodifiedBackspaceSequence(release)).toBe(false);
    }
  });

  it('rejects every modified kitty Backspace (complete modifier table)', () => {
    // kitty modifier parameter = 1 + modifier bits
    // (shift 1, alt 2, ctrl 4, super 8, hyper 16, meta 32, caps 64, num 128)
    for (const modified of [
      '\x1b[127;2u', // shift
      '\x1b[127;3u', // alt
      '\x1b[127;4u', // shift+alt
      '\x1b[127;5u', // ctrl
      '\x1b[127;6u', // shift+ctrl
      '\x1b[127;7u', // alt+ctrl
      '\x1b[127;9u', // super
      '\x1b[127;17u', // hyper
      '\x1b[127;33u', // meta
      '\x1b[127;65u', // caps lock
      '\x1b[127;2:1u', // shift press
      '\x1b[127;5:2u', // ctrl repeat
    ]) {
      expect(isUnmodifiedBackspaceSequence(modified)).toBe(false);
    }
  });

  it('rejects invalid kitty orderings and grammar', () => {
    for (const invalid of [
      '\x1b[127:1;1u', // event type on the codepoint parameter
      '\x1b[127;1:1;127u', // trailing text parameter
      '\x1b[1;127u', // swapped parameters
      '\x1b[127;1:1U', // wrong terminator
      '\x1b[0127u', // leading zero
      '\x1b[127;01u', // leading zero in modifiers
      '\x1b[127u\x1b[127u', // two sequences
      '\x1b[127', // missing terminator
      '\x1b127u', // missing CSI
    ]) {
      expect(isUnmodifiedBackspaceSequence(invalid)).toBe(false);
    }
  });

  it('rejects unrelated sequences', () => {
    for (const other of [
      '',
      'a',
      '\x1b',
      '\r',
      '\t',
      '\x1b[97u', // 'a'
      '\x1b[13u', // enter
      '\x1b[3~', // delete
      '\x1b[D', // left arrow
      '\x1b[57347u', // kitty backspace alternate codepoint
    ]) {
      expect(isUnmodifiedBackspaceSequence(other)).toBe(false);
    }
  });
});

describe('opentui input-prompt-key: printable fallback', () => {
  it('preserves ASCII printable input, including space', () => {
    for (const text of ['a', 'Z', '0', ' ', '~', 'hello']) {
      expect(isPrintableKeyInput(key({ sequence: text }))).toBe(true);
    }
  });

  it('preserves CJK and emoji input', () => {
    for (const text of ['中', '你好', '😀', '👨‍👩‍👧', 'a中😀']) {
      expect(isPrintableKeyInput(key({ sequence: text }))).toBe(true);
    }
  });

  it('allows Shift-produced printable input and repeat events', () => {
    expect(isPrintableKeyInput(key({ sequence: 'A', shift: true }))).toBe(true);
    expect(
      isPrintableKeyInput(key({ sequence: 'a', eventType: 'repeat' })),
    ).toBe(true);
  });

  it('rejects ctrl/meta/option/super/hyper combinations', () => {
    expect(isPrintableKeyInput(key({ sequence: 'a', ctrl: true }))).toBe(false);
    expect(isPrintableKeyInput(key({ sequence: 'a', meta: true }))).toBe(false);
    expect(isPrintableKeyInput(key({ sequence: 'ø', option: true }))).toBe(
      false,
    );
    expect(isPrintableKeyInput(key({ sequence: 'a', super: true }))).toBe(
      false,
    );
    expect(isPrintableKeyInput(key({ sequence: 'a', hyper: true }))).toBe(
      false,
    );
    expect(
      isPrintableKeyInput(key({ sequence: 'A', shift: true, ctrl: true })),
    ).toBe(false);
  });

  it('rejects release events', () => {
    expect(
      isPrintableKeyInput(key({ sequence: 'a', eventType: 'release' })),
    ).toBe(false);
    expect(
      isPrintableKeyInput(key({ sequence: '中', eventType: 'release' })),
    ).toBe(false);
  });

  it('rejects C0 controls and DEL payloads', () => {
    for (const sequence of [
      '\t',
      '\r',
      '\n',
      '\x00',
      '\x01',
      '\x03',
      '\x1f',
      '\x7f',
      'a\x01',
    ]) {
      expect(isPrintableKeyInput(key({ sequence }))).toBe(false);
    }
  });

  it('rejects escape-coded editing/navigation/function sequences', () => {
    for (const sequence of [
      '\x1b',
      '\x1b[D', // left
      '\x1b[A', // up
      '\x1b[3~', // delete
      '\x1b[H', // home
      '\x1b[Z', // shift+tab
      '\x1bOP', // F1
      '\x1b[127u', // kitty backspace
      '\x1b[97u', // kitty 'a' without decoded text
    ]) {
      expect(isPrintableKeyInput(key({ sequence }))).toBe(false);
    }
  });

  it('rejects empty sequences', () => {
    expect(isPrintableKeyInput(key({ sequence: '' }))).toBe(false);
  });
});

describe('opentui input-prompt-key: DELETE_WORD_BACKWARD raw byte', () => {
  it('consumes the MinTTY/legacy Ctrl+Backspace byte \\x1f', () => {
    expect(isDeleteWordBackwardSequence('\x1f')).toBe(true);
  });

  it('rejects plain backspace and other controls', () => {
    for (const sequence of ['\x7f', '\x08', '\x17', '\x1b', '', 'a']) {
      expect(isDeleteWordBackwardSequence(sequence)).toBe(false);
    }
  });

  it('rejects kitty-encoded modified backspace (parsed-key path owns them)', () => {
    for (const sequence of ['\x1b[127;5u', '\x1b[127;9u', '\x1b[127u']) {
      expect(isDeleteWordBackwardSequence(sequence)).toBe(false);
    }
  });
});

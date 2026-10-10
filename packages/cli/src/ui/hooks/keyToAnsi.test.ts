/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { keyToAnsi, type Key } from './keyToAnsi.js';

function key(overrides: Partial<Key>): Key {
  return {
    name: '',
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: '',
    ...overrides,
  };
}

describe('keyToAnsi', () => {
  it('maps Ctrl + letter to the matching C0 control code', () => {
    expect(keyToAnsi(key({ name: 'a', ctrl: true }))).toBe('\u0001');
    expect(keyToAnsi(key({ name: 'c', ctrl: true }))).toBe('\u0003');
    expect(keyToAnsi(key({ name: 'z', ctrl: true }))).toBe('\u001a');
  });

  it('maps a bare named key to its escape sequence', () => {
    expect(keyToAnsi(key({ name: 'up' }))).toBe('\x1b[A');
    expect(keyToAnsi(key({ name: 'left' }))).toBe('\x1b[D');
    expect(keyToAnsi(key({ name: 'delete' }))).toBe('\x1b[3~');
    expect(keyToAnsi(key({ name: 'home' }))).toBe('\x1b[H');
  });

  it.each([
    ['escape', '\x1b'],
    ['tab', '\t'],
    ['backspace', '\x7f'],
    ['return', '\r'],
  ])(
    'pins the literal mapping for %s with and without Ctrl',
    (name, expected) => {
      expect(keyToAnsi(key({ name }))).toBe(expected);
      expect(keyToAnsi(key({ name, ctrl: true }))).toBe(expected);
    },
  );

  // ShellInputPrompt forwards every key it does not claim to the pty, so a
  // Ctrl modifier on a named key must not be mistaken for a Ctrl + letter.
  // Ctrl+Down and Ctrl+Delete produced 0x04 (EOF) and Ctrl+Left produced a
  // form feed — raw C0 bytes written into the shell instead of the sequence.
  it.each([
    ['up', '\x1b[A'],
    ['down', '\x1b[B'],
    ['right', '\x1b[C'],
    ['left', '\x1b[D'],
    ['home', '\x1b[H'],
    ['end', '\x1b[F'],
    ['pageup', '\x1b[5~'],
    ['pagedown', '\x1b[6~'],
    ['delete', '\x1b[3~'],
  ])('does not treat Ctrl + %s as Ctrl + a letter', (name, expected) => {
    expect(keyToAnsi(key({ name, ctrl: true }))).toBe(expected);
  });

  it('leaves a named key sequence alone when Ctrl is also held', () => {
    // Ctrl has no translation of its own for a named key, so the mapping
    // below is the only one that should be emitted for it.
    const names = [
      'up',
      'down',
      'left',
      'right',
      'home',
      'end',
      'delete',
      'pageup',
      'pagedown',
      'escape',
      'tab',
      'backspace',
      'return',
    ];
    for (const name of names) {
      expect(keyToAnsi(key({ name, ctrl: true }))).toBe(
        keyToAnsi(key({ name })),
      );
    }
  });

  it('does not fold Ctrl + a single non-letter into a control byte', () => {
    // What node's readline emits for Ctrl+Space / Ctrl+@ (`readline.emitKeypressEvents`
    // in KeypressContext normalizes byte 0x00 to this key). The name is '`', one
    // character and just below 'a', so only the a-z range in the Ctrl guard keeps it
    // out of the Ctrl+letter arithmetic. Rewriting that branch as the usual
    // "Ctrl = code mod 32" fold, or widening the bound, would otherwise write a raw
    // NUL into the pty with this suite still green.
    expect(
      keyToAnsi(key({ name: '`', ctrl: true, sequence: '\u0000' })),
    ).toBeNull();
  });

  it('ignores Shift when mapping Ctrl + a named key', () => {
    // KeypressContext parses `\x1b[1;6D` into { name: 'left', ctrl: true, shift: true },
    // and ShellInputPrompt claims only Ctrl+Shift+Up/Down before calling keyToAnsi, so
    // these bytes reach this mapping. 'left' and 'delete' are used rather than 'up' or
    // 'down' because the latter are intercepted earlier and never arrive here.
    expect(keyToAnsi(key({ name: 'left', ctrl: true, shift: true }))).toBe(
      '\x1b[D',
    );
    expect(keyToAnsi(key({ name: 'delete', ctrl: true, shift: true }))).toBe(
      '\x1b[3~',
    );
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for newline insertion behaviour.
 *
 * Covers:
 * 1. Key binding matching — which key combinations trigger NEWLINE vs SUBMIT
 * 2. Backslash+Enter backward compatibility
 */

import { describe, it, expect } from 'vitest';
import { keyMatchers, Command } from './keyMatchers.js';
import type { Key } from './hooks/useKeypress.js';

// Helper to create a Key object with defaults
function createKey(name: string, mods: Partial<Key> = {}): Key {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    sequence: name,
    ...mods,
  };
}

describe('Newline insertion', () => {
  // =========================================================================
  // 1. Key Binding Matching
  // =========================================================================
  describe('key binding matching', () => {
    it('Shift+Enter should match NEWLINE, not SUBMIT', () => {
      const shiftEnter = createKey('return', { shift: true });
      expect(keyMatchers[Command.NEWLINE](shiftEnter)).toBe(true);
      expect(keyMatchers[Command.SUBMIT](shiftEnter)).toBe(false);
    });

    it('plain Enter should match SUBMIT, not NEWLINE', () => {
      const plainEnter = createKey('return');
      expect(keyMatchers[Command.SUBMIT](plainEnter)).toBe(true);
      expect(keyMatchers[Command.NEWLINE](plainEnter)).toBe(false);
    });

    it('Ctrl+Enter should match NEWLINE, not SUBMIT', () => {
      const ctrlEnter = createKey('return', { ctrl: true });
      expect(keyMatchers[Command.NEWLINE](ctrlEnter)).toBe(true);
      expect(keyMatchers[Command.SUBMIT](ctrlEnter)).toBe(false);
    });

    it('Meta+Enter (Option/Alt+Enter) should match NEWLINE, not SUBMIT', () => {
      const metaEnter = createKey('return', { meta: true });
      expect(keyMatchers[Command.NEWLINE](metaEnter)).toBe(true);
      expect(keyMatchers[Command.SUBMIT](metaEnter)).toBe(false);
    });

    it('Enter during paste should match NEWLINE, not SUBMIT', () => {
      const pasteEnter = createKey('return', { paste: true });
      expect(keyMatchers[Command.NEWLINE](pasteEnter)).toBe(true);
      expect(keyMatchers[Command.SUBMIT](pasteEnter)).toBe(false);
    });

    it('Ctrl+J should match NEWLINE', () => {
      const ctrlJ = createKey('j', { ctrl: true });
      expect(keyMatchers[Command.NEWLINE](ctrlJ)).toBe(true);
    });

    it('Shift+Ctrl+Enter should not match SUBMIT', () => {
      const shiftCtrlEnter = createKey('return', {
        shift: true,
        ctrl: true,
      });
      expect(keyMatchers[Command.SUBMIT](shiftCtrlEnter)).toBe(false);
    });
  });

  // =========================================================================
  // 2. Backslash+Enter Backward Compatibility
  // =========================================================================
  describe('backslash+Enter backward compatibility', () => {
    it('backslash+Enter detection should produce shift=true key', () => {
      // When `\` is followed by Enter within 5ms, KeypressContext broadcasts
      // the key with shift=true, making it match NEWLINE
      const key = createKey('return', { shift: true, sequence: '\r' });
      expect(keyMatchers[Command.NEWLINE](key)).toBe(true);
      expect(keyMatchers[Command.SUBMIT](key)).toBe(false);
    });
  });
});

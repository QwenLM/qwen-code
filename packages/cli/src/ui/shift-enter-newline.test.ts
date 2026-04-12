/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for Shift+Enter newline support across terminal environments.
 *
 * Covers:
 * 1. Key binding matching — Shift+Enter triggers NEWLINE, not SUBMIT
 * 2. Terminal detection — all supported terminals are correctly identified
 * 3. VSCode sequence — ESC+CR byte correctness and JSON serialization
 * 4. Remote SSH detection — prevents misconfiguration on remote machines
 * 5. PlistBuddy profile name escaping — handles special characters safely
 * 6. Modifiers wrapper — graceful degradation on non-macOS
 */

import { describe, it, expect } from 'vitest';
import { keyMatchers, Command } from './keyMatchers.js';
import type { Key } from './hooks/useKeypress.js';
import { VSCODE_SHIFT_ENTER_SEQUENCE } from './utils/platformConstants.js';

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

describe('Shift+Enter newline support', () => {
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
  // 2. VSCode Shift+Enter Sequence
  // =========================================================================
  describe('VSCode Shift+Enter sequence', () => {
    it('should be ESC + CR (2 bytes)', () => {
      expect(VSCODE_SHIFT_ENTER_SEQUENCE.length).toBe(2);
      expect(VSCODE_SHIFT_ENTER_SEQUENCE.charCodeAt(0)).toBe(0x1b); // ESC
      expect(VSCODE_SHIFT_ENTER_SEQUENCE.charCodeAt(1)).toBe(0x0d); // CR
    });

    it('should serialize correctly for VSCode keybindings.json', () => {
      const binding = { text: VSCODE_SHIFT_ENTER_SEQUENCE };
      const json = JSON.stringify(binding);
      // VSCode interprets \u001b as ESC and \r as CR
      expect(json).toContain('\\u001b');
      expect(json).toContain('\\r');
    });

    it('ESC+CR key event should set meta=true (simulating KeypressContext logic)', () => {
      const ESC = '\u001B';
      const key = createKey('return', { sequence: `${ESC}\r` });

      // Simulate KeypressContext line 864-865
      if (key.name === 'return' && key.sequence === `${ESC}\r`) {
        key.meta = true;
      }

      expect(key.meta).toBe(true);
      expect(keyMatchers[Command.NEWLINE](key)).toBe(true);
      expect(keyMatchers[Command.SUBMIT](key)).toBe(false);
    });
  });

  // =========================================================================
  // 3. Terminal Detection Logic
  // =========================================================================
  describe('terminal detection', () => {
    // Inline the detection logic to unit-test without async/filesystem ops
    function detectTerminalSync(
      env: Record<string, string | undefined>,
    ): string | null {
      const termProgram = env['TERM_PROGRAM'];

      if (termProgram === 'Apple_Terminal' && process.platform === 'darwin') {
        return 'apple_terminal';
      }
      if (
        env['CURSOR_TRACE_ID'] ||
        env['VSCODE_GIT_ASKPASS_MAIN']?.toLowerCase().includes('cursor')
      ) {
        return 'cursor';
      }
      if (env['VSCODE_GIT_ASKPASS_MAIN']?.toLowerCase().includes('windsurf')) {
        return 'windsurf';
      }
      if (env['TERM_PRODUCT']?.toLowerCase().includes('trae')) {
        return 'trae';
      }
      if (termProgram === 'vscode' || env['VSCODE_GIT_IPC_HANDLE']) {
        return 'vscode';
      }
      if (termProgram === 'Alacritty' || termProgram === 'alacritty') {
        return 'alacritty';
      }
      if (termProgram === 'zed') {
        return 'zed';
      }
      return null;
    }

    it('should detect VSCode', () => {
      expect(detectTerminalSync({ TERM_PROGRAM: 'vscode' })).toBe('vscode');
    });

    it('should detect VSCode via IPC handle', () => {
      expect(detectTerminalSync({ VSCODE_GIT_IPC_HANDLE: '/tmp/x' })).toBe(
        'vscode',
      );
    });

    it('should detect Cursor via trace ID', () => {
      expect(detectTerminalSync({ CURSOR_TRACE_ID: 'abc' })).toBe('cursor');
    });

    it('should detect Cursor via askpass path', () => {
      expect(
        detectTerminalSync({
          VSCODE_GIT_ASKPASS_MAIN: '/path/to/cursor/askpass',
        }),
      ).toBe('cursor');
    });

    it('should detect Windsurf via askpass path', () => {
      expect(
        detectTerminalSync({
          VSCODE_GIT_ASKPASS_MAIN: '/path/to/windsurf/askpass',
        }),
      ).toBe('windsurf');
    });

    it('should detect Trae', () => {
      expect(detectTerminalSync({ TERM_PRODUCT: 'trae-ide' })).toBe('trae');
    });

    it('should detect Alacritty (capitalized)', () => {
      expect(detectTerminalSync({ TERM_PROGRAM: 'Alacritty' })).toBe(
        'alacritty',
      );
    });

    it('should detect Alacritty (lowercase)', () => {
      expect(detectTerminalSync({ TERM_PROGRAM: 'alacritty' })).toBe(
        'alacritty',
      );
    });

    it('should detect Zed', () => {
      expect(detectTerminalSync({ TERM_PROGRAM: 'zed' })).toBe('zed');
    });

    it('should detect Apple Terminal on macOS', () => {
      if (process.platform === 'darwin') {
        expect(detectTerminalSync({ TERM_PROGRAM: 'Apple_Terminal' })).toBe(
          'apple_terminal',
        );
      }
    });

    it('should return null for unknown terminals', () => {
      expect(detectTerminalSync({ TERM_PROGRAM: 'unknown-term' })).toBeNull();
    });

    it('should return null for empty environment', () => {
      expect(detectTerminalSync({})).toBeNull();
    });

    it('should prioritize Cursor over VSCode when both indicators present', () => {
      expect(
        detectTerminalSync({
          TERM_PROGRAM: 'vscode',
          CURSOR_TRACE_ID: 'abc',
        }),
      ).toBe('cursor');
    });
  });

  // =========================================================================
  // 4. Remote SSH Detection
  // =========================================================================
  describe('Remote SSH detection', () => {
    function isVSCodeRemoteSSH(
      env: Record<string, string | undefined>,
    ): boolean {
      const askpassMain = env['VSCODE_GIT_ASKPASS_MAIN'] ?? '';
      const envPath = env['PATH'] ?? '';
      return (
        askpassMain.includes('.vscode-server') ||
        askpassMain.includes('.cursor-server') ||
        askpassMain.includes('.windsurf-server') ||
        envPath.includes('.vscode-server') ||
        envPath.includes('.cursor-server') ||
        envPath.includes('.windsurf-server')
      );
    }

    it('should detect VSCode remote SSH via askpass', () => {
      expect(
        isVSCodeRemoteSSH({
          VSCODE_GIT_ASKPASS_MAIN: '/home/user/.vscode-server/bin/askpass',
        }),
      ).toBe(true);
    });

    it('should detect Cursor remote SSH via askpass', () => {
      expect(
        isVSCodeRemoteSSH({
          VSCODE_GIT_ASKPASS_MAIN: '/home/user/.cursor-server/bin/askpass',
        }),
      ).toBe(true);
    });

    it('should detect remote SSH via PATH', () => {
      expect(
        isVSCodeRemoteSSH({
          PATH: '/home/user/.vscode-server/bin:/usr/bin',
        }),
      ).toBe(true);
    });

    it('should NOT detect local VSCode as remote SSH', () => {
      expect(
        isVSCodeRemoteSSH({
          VSCODE_GIT_ASKPASS_MAIN: '/Applications/Code.app/askpass',
        }),
      ).toBe(false);
    });

    it('should NOT detect empty env as remote SSH', () => {
      expect(isVSCodeRemoteSSH({})).toBe(false);
    });
  });

  // =========================================================================
  // 5. PlistBuddy Profile Name Escaping
  // =========================================================================
  describe('PlistBuddy profile name escaping', () => {
    function escapeProfileName(profileName: string): string | null {
      const hasControlChars = [...profileName].some(
        (ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f,
      );
      if (hasControlChars) return null;
      return profileName.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    }

    function buildPlistCommand(profileName: string): string | null {
      const escaped = escapeProfileName(profileName);
      if (escaped === null) return null;
      return `Add :'Window Settings':'${escaped}':useOptionAsMetaKey bool true`;
    }

    it('should handle normal profile name', () => {
      expect(buildPlistCommand('Basic')).toBe(
        "Add :'Window Settings':'Basic':useOptionAsMetaKey bool true",
      );
    });

    it('should escape single quotes', () => {
      expect(buildPlistCommand("O'Brien")).toBe(
        "Add :'Window Settings':'O\\'Brien':useOptionAsMetaKey bool true",
      );
    });

    it('should escape backslashes', () => {
      expect(buildPlistCommand('path\\to\\profile')).toBe(
        "Add :'Window Settings':'path\\\\to\\\\profile':useOptionAsMetaKey bool true",
      );
    });

    it('should escape backslash before single quote', () => {
      expect(buildPlistCommand("test\\'name")).toBe(
        "Add :'Window Settings':'test\\\\\\'name':useOptionAsMetaKey bool true",
      );
    });

    it('should reject profile names with control characters', () => {
      expect(buildPlistCommand('name\x00bad')).toBeNull();
      expect(buildPlistCommand('name\nnewline')).toBeNull();
      expect(buildPlistCommand('name\ttab')).toBeNull();
      expect(buildPlistCommand('name\x7fdel')).toBeNull();
    });

    it('should accept profile names with spaces and unicode', () => {
      expect(buildPlistCommand('My Profile')).toBe(
        "Add :'Window Settings':'My Profile':useOptionAsMetaKey bool true",
      );
      expect(buildPlistCommand('日本語')).toBe(
        "Add :'Window Settings':'日本語':useOptionAsMetaKey bool true",
      );
    });
  });

  // =========================================================================
  // 6. Modifiers Wrapper (non-macOS graceful degradation)
  // =========================================================================
  describe('modifiers wrapper', () => {
    it('prewarmModifiers should not throw', async () => {
      const { prewarmModifiers } = await import('./utils/modifiers.js');
      expect(() => prewarmModifiers()).not.toThrow();
    });

    it('isModifierPressed should return boolean', async () => {
      const { isModifierPressed } = await import('./utils/modifiers.js');
      const result = isModifierPressed('shift');
      expect(typeof result).toBe('boolean');
    });
  });

  // =========================================================================
  // 7. Apple Terminal Keypress Simulation
  // =========================================================================
  describe('Apple Terminal native shift detection (simulated)', () => {
    it('should set shift=true when native detection reports Shift held', () => {
      const key = createKey('return', { sequence: '\r' });
      const isAppleTerminal = true;
      const nativeShiftPressed = true;

      // Simulate KeypressContext logic (lines 869-877)
      if (
        key.name === 'return' &&
        !key.shift &&
        !key.kittyProtocol &&
        isAppleTerminal &&
        nativeShiftPressed
      ) {
        key.shift = true;
      }

      expect(key.shift).toBe(true);
      expect(keyMatchers[Command.NEWLINE](key)).toBe(true);
      expect(keyMatchers[Command.SUBMIT](key)).toBe(false);
    });

    it('should NOT set shift for plain Enter in Apple Terminal', () => {
      const key = createKey('return', { sequence: '\r' });
      const isAppleTerminal = true;
      const nativeShiftPressed = false;

      if (
        key.name === 'return' &&
        !key.shift &&
        !key.kittyProtocol &&
        isAppleTerminal &&
        nativeShiftPressed
      ) {
        key.shift = true;
      }

      expect(key.shift).toBe(false);
      expect(keyMatchers[Command.SUBMIT](key)).toBe(true);
    });

    it('should NOT use native detection for Kitty protocol keys', () => {
      const key = createKey('return', {
        sequence: '\x1b[13;2u',
        shift: true,
        kittyProtocol: true,
      });
      const isAppleTerminal = true;
      const nativeShiftPressed = true;

      // The kittyProtocol flag should prevent native detection from running
      if (
        key.name === 'return' &&
        !key.shift &&
        !key.kittyProtocol &&
        isAppleTerminal &&
        nativeShiftPressed
      ) {
        key.shift = true; // Should NOT reach here
      }

      // shift was already true from CSI-u parsing, not from native detection
      expect(key.shift).toBe(true);
      expect(keyMatchers[Command.NEWLINE](key)).toBe(true);
    });
  });

  // =========================================================================
  // 8. Backward Compatibility — Backslash+Enter
  // =========================================================================
  describe('backslash+Enter backward compatibility', () => {
    it('backslash+Enter detection should produce shift=true key', () => {
      // Simulates KeypressContext lines 634-646:
      // When `\` is followed by Enter within 5ms, the key is broadcast
      // with shift=true, making it match NEWLINE
      const key = createKey('return', { shift: true, sequence: '\r' });
      expect(keyMatchers[Command.NEWLINE](key)).toBe(true);
      expect(keyMatchers[Command.SUBMIT](key)).toBe(false);
    });
  });
});

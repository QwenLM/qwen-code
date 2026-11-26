/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  formatKeyBinding,
  formatCommand,
  formatCommandAll,
} from './keybindingUtils.js';
import {
  Command,
  defaultKeyBindingConfig,
  getDefaultTextPasteKeyPatterns,
  KeyBinding,
} from './keyBindings.js';

describe('keybindingUtils', () => {
  describe('formatKeyBinding', () => {
    const testCases: Array<{
      name: string;
      binding: KeyBinding;
      expected: {
        darwin: string;
        win32: string;
        linux: string;
        default: string;
      };
    }> = [
      {
        name: 'simple key',
        binding: new KeyBinding('a'),
        expected: { darwin: 'A', win32: 'A', linux: 'A', default: 'A' },
      },
      {
        name: 'named key (return)',
        binding: new KeyBinding('enter'),
        expected: {
          darwin: 'Enter',
          win32: 'Enter',
          linux: 'Enter',
          default: 'Enter',
        },
      },
      {
        name: 'named key (escape)',
        binding: new KeyBinding('escape'),
        expected: { darwin: 'Esc', win32: 'Esc', linux: 'Esc', default: 'Esc' },
      },
      {
        name: 'ctrl modifier',
        binding: new KeyBinding('ctrl+c'),
        expected: {
          darwin: 'Ctrl+C',
          win32: 'Ctrl+C',
          linux: 'Ctrl+C',
          default: 'Ctrl+C',
        },
      },
      {
        name: 'cmd modifier',
        binding: new KeyBinding('cmd+z'),
        expected: {
          darwin: 'Cmd+Z',
          win32: 'Win+Z',
          linux: 'Super+Z',
          default: 'Cmd/Win+Z',
        },
      },
      {
        name: 'alt/option modifier',
        binding: new KeyBinding('alt+left'),
        expected: {
          darwin: 'Option+Left',
          win32: 'Alt+Left',
          linux: 'Alt+Left',
          default: 'Alt+Left',
        },
      },
      {
        name: 'shift modifier',
        binding: new KeyBinding('shift+up'),
        expected: {
          darwin: 'Shift+Up',
          win32: 'Shift+Up',
          linux: 'Shift+Up',
          default: 'Shift+Up',
        },
      },
      {
        name: 'multiple modifiers (ctrl+shift)',
        binding: new KeyBinding('ctrl+shift+z'),
        expected: {
          darwin: 'Ctrl+Shift+Z',
          win32: 'Ctrl+Shift+Z',
          linux: 'Ctrl+Shift+Z',
          default: 'Ctrl+Shift+Z',
        },
      },
      {
        name: 'all modifiers',
        binding: new KeyBinding('ctrl+alt+shift+cmd+a'),
        expected: {
          darwin: 'Ctrl+Option+Shift+Cmd+A',
          win32: 'Ctrl+Alt+Shift+Win+A',
          linux: 'Ctrl+Alt+Shift+Super+A',
          default: 'Ctrl+Alt+Shift+Cmd/Win+A',
        },
      },
    ];

    testCases.forEach(({ name, binding, expected }) => {
      describe(`${name}`, () => {
        it('formats correctly for darwin', () => {
          expect(formatKeyBinding(binding, 'darwin')).toBe(expected.darwin);
        });
        it('formats correctly for win32', () => {
          expect(formatKeyBinding(binding, 'win32')).toBe(expected.win32);
        });
        it('formats correctly for linux', () => {
          expect(formatKeyBinding(binding, 'linux')).toBe(expected.linux);
        });
        it('formats correctly for default', () => {
          expect(formatKeyBinding(binding, 'default')).toBe(expected.default);
        });
      });
    });
  });

  describe('formatCommand', () => {
    it('formats default commands (using default platform behavior)', () => {
      expect(formatCommand(Command.QUIT, undefined, 'default')).toBe('Ctrl+C');
      expect(formatCommand(Command.SUBMIT, undefined, 'default')).toBe('Enter');
      expect(
        formatCommand(Command.TOGGLE_BACKGROUND_SHELL, undefined, 'default'),
      ).toBe('Ctrl+B');
    });

    it('returns empty string for unknown commands', () => {
      expect(
        formatCommand(
          'unknown.command' as unknown as Command,
          undefined,
          'default',
        ),
      ).toBe('');
    });
  });

  describe('formatCommandAll', () => {
    it('hides the application text paste shortcut on win32', () => {
      const windowsConfig = new Map(defaultKeyBindingConfig);
      windowsConfig.set(
        Command.PASTE_CLIPBOARD,
        getDefaultTextPasteKeyPatterns('win32').map(
          (pattern) => new KeyBinding(pattern),
        ),
      );
      expect(
        formatCommandAll(Command.PASTE_CLIPBOARD, windowsConfig, 'win32'),
      ).toBe('');
    });

    it('shows Ctrl+V on darwin for general paste', () => {
      expect(
        formatCommandAll(Command.PASTE_CLIPBOARD, undefined, 'darwin'),
      ).toBe('Ctrl+V');
    });

    it('shows Ctrl+V on linux for general paste', () => {
      expect(
        formatCommandAll(Command.PASTE_CLIPBOARD, undefined, 'linux'),
      ).toBe('Ctrl+V');
    });

    it('shows Alt+V for image paste', () => {
      expect(
        formatCommandAll(Command.PASTE_CLIPBOARD_IMAGE, undefined, 'win32'),
      ).toBe('Alt+V');
    });

    it('returns empty string for unknown commands', () => {
      expect(
        formatCommandAll(
          'unknown.command' as unknown as Command,
          undefined,
          'default',
        ),
      ).toBe('');
    });
  });
});

describe('undo hints in terminals', () => {
  it.each(['win32', 'linux', 'darwin'])(
    'shows reachable input undo bindings on %s',
    (platform) => {
      const hint = formatCommandAll(
        Command.UNDO,
        defaultKeyBindingConfig,
        platform,
      );
      expect(hint).toBe(
        `Ctrl+_ / Ctrl+Shift+- / ${platform === 'darwin' ? 'Option' : 'Alt'}+Z`,
      );
      expect(
        formatCommand(Command.UNDO, defaultKeyBindingConfig, platform),
      ).toBe('Ctrl+_');
    },
  );
});

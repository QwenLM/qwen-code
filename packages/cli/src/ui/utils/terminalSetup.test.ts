/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  assessTerminalSetup,
  terminalSetup,
  VSCODE_CTRL_ENTER_SEQUENCE,
  VSCODE_SHIFT_ENTER_SEQUENCE,
  shouldPromptForTerminalSetup,
  resetDetectTerminalCacheForTesting,
} from './terminalSetup.js';
import { terminalCapabilityManager } from './terminalCapabilityManager.js';

// Mock dependencies
const mocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execFile: vi.fn(),
  mkdir: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  copyFile: vi.fn(),
  stat: vi.fn(),
  persistentGet: vi.fn(),
  persistentSet: vi.fn(),
  homedir: vi.fn().mockReturnValue('/home/user'),
  platform: vi.fn().mockReturnValue('darwin'),
  nativeModifierAvailable: vi.fn().mockReturnValue(true),
  writeStream: {
    write: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  exec: mocks.exec,
  execFile: mocks.execFile,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const promises = {
    ...actual.promises,
    mkdir: mocks.mkdir,
    readFile: mocks.readFile,
    writeFile: mocks.writeFile,
    copyFile: mocks.copyFile,
    stat: mocks.stat,
  };
  return {
    ...actual,
    createWriteStream: () => mocks.writeStream,
    promises,
  };
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: mocks.homedir,
    platform: mocks.platform,
  };
});

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    homedir: mocks.homedir,
  };
});

vi.mock('./terminalCapabilityManager.js', () => ({
  terminalCapabilityManager: {
    isKittyProtocolEnabled: vi.fn().mockReturnValue(false),
    canDistinguishModifiedEnter: vi.fn().mockReturnValue(false),
    getTerminalName: vi.fn().mockReturnValue(undefined),
  },
}));

vi.mock('./nativeModifierDetector.js', () => ({
  isNativeModifierDetectionAvailable: mocks.nativeModifierAvailable,
}));

vi.mock('../../utils/persistentState.js', () => ({
  persistentState: {
    get: mocks.persistentGet,
    set: mocks.persistentSet,
  },
}));

describe('terminalSetup', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    resetDetectTerminalCacheForTesting();
    vi.stubEnv('TERM_PROGRAM', '');
    vi.stubEnv('CURSOR_TRACE_ID', '');
    vi.stubEnv('VSCODE_GIT_ASKPASS_MAIN', '');
    vi.stubEnv('VSCODE_GIT_IPC_HANDLE', '');
    vi.stubEnv('TMUX', '');
    vi.stubEnv('STY', '');
    vi.stubEnv('SSH_TTY', '');
    vi.stubEnv('SSH_CONNECTION', '');
    vi.stubEnv('SSH_CLIENT', '');
    vi.stubEnv('TERM', 'xterm-256color');
    vi.stubEnv('ZED_TERM', '');
    vi.stubEnv('KITTY_WINDOW_ID', '');
    vi.stubEnv('WT_SESSION', '');
    vi.stubEnv('__CFBundleIdentifier', '');
    vi.stubEnv('XDG_CONFIG_HOME', '');

    // Default mocks
    mocks.homedir.mockReturnValue('/home/user');
    mocks.platform.mockReturnValue('darwin');
    mocks.nativeModifierAvailable.mockReturnValue(true);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.copyFile.mockResolvedValue(undefined);
    mocks.readFile.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.stat.mockResolvedValue({ size: 1 });
    mocks.persistentGet.mockReturnValue(undefined);
    mocks.exec.mockImplementation((cmd, cb) => cb(null, { stdout: '' }));
    vi.mocked(
      terminalCapabilityManager.canDistinguishModifiedEnter,
    ).mockReturnValue(false);
    vi.mocked(terminalCapabilityManager.getTerminalName).mockReturnValue(
      undefined,
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('detectTerminal', () => {
    it('should detect VS Code from env var', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      const result = await terminalSetup();
      expect(result.message).toContain('VS Code');
    });

    it('should detect Cursor from env var', async () => {
      process.env['CURSOR_TRACE_ID'] = 'some-id';
      const result = await terminalSetup();
      expect(result.message).toContain('Cursor');
    });

    it('should detect Windsurf from env var', async () => {
      process.env['VSCODE_GIT_ASKPASS_MAIN'] = '/path/to/windsurf/askpass';
      const result = await terminalSetup();
      expect(result.message).toContain('Windsurf');
    });

    it('should detect from parent process', async () => {
      mocks.platform.mockReturnValue('linux');
      mocks.exec.mockImplementation((cmd, cb) => {
        cb(null, { stdout: 'code\n' });
      });

      const result = await terminalSetup();
      expect(result.message).toContain('VS Code');
    });

    it('should fork ps at most once across repeated callers', async () => {
      mocks.platform.mockReturnValue('linux');
      mocks.exec.mockImplementation((cmd, cb) => {
        cb(null, { stdout: 'code\n' });
      });

      await terminalSetup();
      await terminalSetup();
      await terminalSetup();

      expect(mocks.exec).toHaveBeenCalledTimes(1);
    });
  });

  describe('configureVSCodeStyle', () => {
    it('should create new keybindings file if none exists', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(mocks.writeFile).toHaveBeenCalled();

      const writtenContent = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      expect(writtenContent.map((item: { key?: string }) => item.key)).toEqual([
        'shift+enter',
        'ctrl+enter',
        'cmd+z',
        'alt+z',
        'shift+cmd+z',
        'shift+alt+z',
      ]);
    });

    it('should append to existing keybindings', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue('[]');

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      const writtenContent = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      expect(writtenContent).toHaveLength(6); // Shift+Enter, Ctrl+Enter, Cmd+Z, Alt+Z, Shift+Cmd+Z, Shift+Alt+Z
    });

    it('should not modify if bindings already exist', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      const existingBindings = [
        {
          key: 'shift+enter',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
        },
        {
          key: 'ctrl+enter',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: VSCODE_CTRL_ENTER_SEQUENCE },
        },
        {
          key: 'cmd+z',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: '\u001b[122;9u' },
        },
        {
          key: 'alt+z',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: '\u001b[122;3u' },
        },
        {
          key: 'shift+cmd+z',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: '\u001b[122;10u' },
        },
        {
          key: 'shift+alt+z',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: '\u001b[122;4u' },
        },
      ];
      mocks.readFile.mockResolvedValue(JSON.stringify(existingBindings));

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('writes Ctrl+Enter as its CSI u sequence', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue('[]');

      await terminalSetup();

      const writtenContent = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      const ctrlEnter = writtenContent.find(
        (item: { key?: string }) => item.key === 'ctrl+enter',
      );
      expect(ctrlEnter.args.text).toBe('\u001b[13;5u');
    });

    it('upgrades the old backslash-newline Ctrl+Enter binding in place', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      const existingBindings = [
        {
          key: 'shift+enter',
          command: 'workbench.action.terminal.sendSequence',
          when: 'terminalFocus',
          args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
        },
        {
          key: 'ctrl+enter',
          command: 'workbench.action.terminal.sendSequence',
          when: 'terminalFocus',
          args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
        },
        { key: 'ctrl+k', command: 'user.owned.command' },
      ];
      mocks.readFile.mockResolvedValue(
        JSON.stringify(existingBindings, null, 2),
      );

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).toContain('ctrl+enter');
      const writtenContent = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      // Same slot, new sequence, no duplicate entry; the user's own binding
      // right after it is untouched.
      expect(writtenContent[1]).toEqual({
        key: 'ctrl+enter',
        command: 'workbench.action.terminal.sendSequence',
        when: 'terminalFocus',
        args: { text: VSCODE_CTRL_ENTER_SEQUENCE },
      });
      expect(writtenContent[2]).toEqual({
        key: 'ctrl+k',
        command: 'user.owned.command',
      });
      expect(
        writtenContent.filter(
          (item: { key?: string }) => item.key === 'ctrl+enter',
        ),
      ).toHaveLength(1);
      expect(writtenContent.map((item: { key?: string }) => item.key)).toEqual(
        [
          'shift+enter',
          'ctrl+enter',
          'ctrl+k',
          'cmd+z',
          'alt+z',
          'shift+cmd+z',
          'shift+alt+z',
        ],
      );
    });

    it('should fail gracefully if json is invalid', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue('{ invalid json');

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('invalid JSON');
    });

    it('should handle comments in JSON', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      const jsonWithComments = '// This is a comment\n[]';
      mocks.readFile.mockResolvedValue(jsonWithComments);

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(mocks.writeFile).toHaveBeenCalled();
      expect(mocks.writeFile.mock.calls[0][1]).toContain(
        '// This is a comment',
      );
    });

    it('should stop without writing when Shift+Enter conflicts', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue(
        JSON.stringify([
          {
            key: 'shift+enter',
            command: 'workbench.action.terminal.new',
          },
        ]),
      );

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('bound differently');
      expect(mocks.copyFile).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('should skip an additional binding conflict and write the rest', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue(
        JSON.stringify([
          {
            key: 'ctrl+enter',
            command: 'workbench.action.terminal.new',
          },
        ]),
      );

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).toContain('ctrl+enter');
      const writtenContent = JSON.parse(mocks.writeFile.mock.calls[0][1]);
      expect(
        writtenContent.filter(
          (item: { key?: string }) => item.key === 'ctrl+enter',
        ),
      ).toHaveLength(1);
      expect(
        writtenContent.some(
          (item: { key?: string }) => item.key === 'shift+enter',
        ),
      ).toBe(true);
    });

    it('should not write when backing up an existing file fails', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue('[]');
      mocks.copyFile.mockRejectedValue(new Error('permission denied'));

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('No changes were made');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('should report the backup path when writing an existing file fails', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue('[]');
      mocks.writeFile.mockRejectedValue(new Error('disk full'));

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('Backup: ');
      expect(result.message).toContain('.bak');
    });
  });

  describe('terminal routes', () => {
    it('should not write configuration for native terminals', async () => {
      process.env['TERM_PROGRAM'] = 'ghostty';

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).toContain('without additional configuration');
      expect(mocks.readFile).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('should not write configuration from tmux', async () => {
      process.env['TMUX'] = '/tmp/tmux-501/default,1,0';

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).toContain('outside tmux, screen, or SSH');
      expect(mocks.readFile).not.toHaveBeenCalled();
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('should report unknown instead of prompting for malformed JSONC', async () => {
      process.env['TERM_PROGRAM'] = 'vscode';
      mocks.readFile.mockResolvedValue('[invalid');

      const assessment = await assessTerminalSetup();

      expect(assessment.configurationStatus).toBe('unknown');
      expect(await shouldPromptForTerminalSetup()).toBe(false);
    });
  });

  describe('configureAlacritty', () => {
    it('should use XDG_CONFIG_HOME and install the binding', async () => {
      process.env['TERM_PROGRAM'] = 'alacritty';
      process.env['XDG_CONFIG_HOME'] = '/custom/config';

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.restartNotice).toContain('restart Alacritty');
      expect(mocks.writeFile.mock.calls[0][0]).toBe(
        '/custom/config/alacritty/alacritty.toml',
      );
      expect(mocks.writeFile.mock.calls[0][1]).toContain(
        'chars = "\\u001B\\r"',
      );
      expect(mocks.persistentSet).toHaveBeenCalledWith(
        'shiftEnterKeyBindingInstalled',
        true,
      );
    });

    it('should be idempotent for an existing exact binding', async () => {
      process.env['TERM_PROGRAM'] = 'alacritty';
      mocks.readFile.mockResolvedValue(
        '[[keyboard.bindings]]\nkey = "Return"\nmods = "Shift"\nchars = "\\u001B\\r"\n',
      );

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).toContain('already configured');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('should recognize spaced multi-modifier bindings', async () => {
      process.env['TERM_PROGRAM'] = 'alacritty';
      mocks.readFile.mockResolvedValue(
        '[[keyboard.bindings]]\nkey = "Return"\nmods = "Control | Shift"\nchars = "\\u001B\\r"\n',
      );

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).toContain('already configured');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('should not overwrite a conflicting Shift+Return binding', async () => {
      process.env['TERM_PROGRAM'] = 'alacritty';
      mocks.readFile.mockResolvedValue(
        '[[keyboard.bindings]]\nkey = "Return"\nmods = "Shift"\nchars = "other"\n',
      );

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('different Shift+Return binding');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('configureZed', () => {
    it('should preserve JSONC comments while installing the binding', async () => {
      process.env['TERM_PROGRAM'] = 'zed';
      mocks.readFile.mockResolvedValue('// keep this comment\n[]\n');

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(mocks.writeFile.mock.calls[0][1]).toContain('// keep this comment');
      expect(mocks.writeFile.mock.calls[0][1]).toContain('shift-enter');
    });

    it('should be idempotent for an existing exact binding', async () => {
      process.env['TERM_PROGRAM'] = 'zed';
      mocks.readFile.mockResolvedValue(
        JSON.stringify([
          {
            context: 'Terminal',
            bindings: {
              'shift-enter': ['terminal::SendText', '\u001b\r'],
            },
          },
        ]),
      );

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).toContain('already configured');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });

    it('should not overwrite a conflicting shift-enter binding', async () => {
      process.env['TERM_PROGRAM'] = 'zed';
      mocks.readFile.mockResolvedValue(
        JSON.stringify([
          {
            context: 'Terminal',
            bindings: { 'shift-enter': 'workspace::NewTerminal' },
          },
        ]),
      );

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('different shift-enter binding');
      expect(mocks.writeFile).not.toHaveBeenCalled();
    });
  });

  describe('configureAppleTerminal', () => {
    function mockAppleCommands(options?: {
      failExport?: boolean;
      failPrint?: boolean;
      missingPrint?: boolean;
      productVersion?: string;
      optionAsMeta?: boolean;
      audibleBell?: boolean;
    }) {
      mocks.execFile.mockImplementation(
        (
          command: string,
          args: string[],
          _options: unknown,
          callback: (
            error: Error | null,
            result?: { stdout: string; stderr: string },
          ) => void,
        ) => {
          if (command === 'sw_vers') {
            callback(null, {
              stdout: `${options?.productVersion ?? '26.0'}\n`,
              stderr: '',
            });
          } else if (command === 'defaults' && args[0] === 'read') {
            callback(null, { stdout: 'Basic\n', stderr: '' });
          } else if (command === 'defaults' && args[0] === 'export') {
            callback(options?.failExport ? new Error('export failed') : null, {
              stdout: '',
              stderr: '',
            });
          } else if (
            command === '/usr/libexec/PlistBuddy' &&
            args[1]?.startsWith('Print ')
          ) {
            const isBell = args[1]?.includes(':Bell');
            callback(
              options?.failPrint
                ? Object.assign(new Error('permission denied'), {
                    stderr: 'permission denied',
                  })
                : options?.missingPrint
                  ? Object.assign(new Error('entry does not exist'), {
                      stderr: 'Print: Entry, useOptionAsMetaKey, Does Not Exist',
                    })
                : null,
              {
                stdout: `${
                  isBell
                    ? (options?.audibleBell ?? false)
                    : (options?.optionAsMeta ?? false)
                }\n`,
                stderr: '',
              },
            );
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
        },
      );
    }

    it('should configure the same Terminal.app settings and result message', async () => {
      process.env['TERM_PROGRAM'] = 'Apple_Terminal';
      mockAppleCommands({ missingPrint: true });

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.restartNotice).toContain('restart Terminal.app');
      expect(result.message).toBe(
        'Configured Terminal.app settings:\n' +
          '- Enabled "Use Option as Meta key"\n' +
          '- Disabled the audible bell\n' +
          'Shift+Return will now enter a newline.\n' +
          'Option+Enter will now enter a newline.',
      );
      expect(mocks.execFile).toHaveBeenCalledWith(
        'defaults',
        expect.arrayContaining(['export', 'com.apple.Terminal']),
        expect.anything(),
        expect.any(Function),
      );
      expect(mocks.persistentSet).toHaveBeenCalledWith(
        'optionAsMetaKeyInstalled',
        true,
      );
      expect(mocks.execFile).toHaveBeenCalledWith(
        '/usr/libexec/PlistBuddy',
        expect.arrayContaining([
          expect.stringContaining('useOptionAsMetaKey bool true'),
        ]),
        expect.anything(),
        expect.any(Function),
      );
      expect(mocks.execFile).toHaveBeenCalledWith(
        '/usr/libexec/PlistBuddy',
        expect.arrayContaining([expect.stringContaining(':Bell bool false')]),
        expect.anything(),
        expect.any(Function),
      );
    });

    it('should reapply configured settings and still require a restart', async () => {
      process.env['TERM_PROGRAM'] = 'Apple_Terminal';
      mockAppleCommands({ optionAsMeta: true, audibleBell: false });

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).toContain('Configured Terminal.app settings:');
      expect(result.restartNotice).toBe(
        'You must restart Terminal.app for the changes to take effect.',
      );
      expect(
        mocks.execFile.mock.calls.some(
          ([command, args]) =>
            command === 'defaults' && (args as string[])[0] === 'export',
        ),
      ).toBe(true);
    });

    it('should not advertise Shift+Return when native detection is unavailable', async () => {
      process.env['TERM_PROGRAM'] = 'Apple_Terminal';
      mocks.nativeModifierAvailable.mockReturnValue(false);
      mockAppleCommands({ missingPrint: true });

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(result.message).not.toContain(
        'Shift+Return will now enter a newline.',
      );
      expect(result.message).toContain(
        'native Shift+Return detection is unavailable',
      );
      expect(result.message).toContain(
        'Option+Enter will now enter a newline.',
      );
    });

    it('should leave the audible bell unchanged in screen-reader mode', async () => {
      process.env['TERM_PROGRAM'] = 'Apple_Terminal';
      mockAppleCommands({ missingPrint: true });

      const result = await terminalSetup({ screenReader: true });

      expect(result.success).toBe(true);
      expect(result.message).toContain(
        '- Left the audible bell setting unchanged (screen-reader mode uses it)',
      );
      expect(
        mocks.execFile.mock.calls.some(
          ([command, args]) =>
            command === '/usr/libexec/PlistBuddy' &&
            (args as string[])[1]?.includes(':Bell') &&
            ((args as string[])[1]?.startsWith('Add ') ||
              (args as string[])[1]?.startsWith('Set ')),
        ),
      ).toBe(false);
    });

    it('should make no Terminal.app changes on macOS 27 in screen-reader mode', async () => {
      process.env['TERM_PROGRAM'] = 'Apple_Terminal';
      mockAppleCommands({ productVersion: '27.0' });

      const result = await terminalSetup({ screenReader: true });

      expect(result).toEqual({
        success: true,
        message:
          'No Terminal.app changes needed.\nShift+Return already enters a newline on this macOS version, and screen-reader mode leaves the audible bell setting unchanged.',
      });
      expect(
        mocks.execFile.mock.calls.some(
          ([command, args]) =>
            command === 'defaults' && (args as string[])[0] === 'export',
        ),
      ).toBe(false);
    });

    it('should stop before writing when the backup fails', async () => {
      process.env['TERM_PROGRAM'] = 'Apple_Terminal';
      mockAppleCommands({ failExport: true });

      const result = await terminalSetup();

      expect(result.success).toBe(false);
      expect(result.message).toContain('No changes were made');
      expect(
        mocks.execFile.mock.calls.some(
          ([command, args]) =>
            command === '/usr/libexec/PlistBuddy' &&
            (args as string[])[1]?.startsWith('Add '),
        ),
      ).toBe(false);
    });

    it('should configure even when the read-only preference inspection fails', async () => {
      process.env['TERM_PROGRAM'] = 'Apple_Terminal';
      mockAppleCommands({ failPrint: true });

      const result = await terminalSetup();

      expect(result.success).toBe(true);
      expect(
        mocks.execFile.mock.calls.some(
          ([command, args]) =>
            command === 'defaults' && (args as string[])[0] === 'export',
        ),
      ).toBe(true);
    });
  });

  describe('shouldPromptForTerminalSetup', () => {
    it('should return false when modified Enter is already supported', async () => {
      vi.mocked(
        terminalCapabilityManager.canDistinguishModifiedEnter,
      ).mockReturnValue(true);

      const result = await shouldPromptForTerminalSetup();
      expect(result).toBe(false);
    });

    it('should return false when both Shift+Enter and Ctrl+Enter bindings already exist', async () => {
      vi.mocked(
        terminalCapabilityManager.canDistinguishModifiedEnter,
      ).mockReturnValue(false);
      process.env['TERM_PROGRAM'] = 'vscode';

      const existingBindings = [
        {
          key: 'shift+enter',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
        },
        {
          key: 'ctrl+enter',
          command: 'workbench.action.terminal.sendSequence',
          args: { text: VSCODE_SHIFT_ENTER_SEQUENCE },
        },
      ];
      mocks.readFile.mockResolvedValue(JSON.stringify(existingBindings));

      const result = await shouldPromptForTerminalSetup();
      expect(result).toBe(false);
    });

    it('should return true when keybindings file does not exist', async () => {
      vi.mocked(
        terminalCapabilityManager.canDistinguishModifiedEnter,
      ).mockReturnValue(false);
      process.env['TERM_PROGRAM'] = 'vscode';

      mocks.readFile.mockRejectedValue(
        Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
      );

      const result = await shouldPromptForTerminalSetup();
      expect(result).toBe(true);
    });
  });
});

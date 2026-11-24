/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  vi,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  type Mock,
} from 'vitest';
import {
  checkHasEditorType,
  getDiffCommand,
  openDiff,
  allowEditorTypeInSandbox,
  isEditorAvailable,
  isTerminalEditor,
  getExternalEditorCommand,
  type EditorType,
} from './editor.js';
import { execSync, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ error: null, status: 0 })),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
}));

const originalPlatform = process.platform;

const setPlatform = (value: string) =>
  Object.defineProperty(process, 'platform', { value });
const found = (path: string) =>
  (execSync as Mock).mockReturnValue(Buffer.from(path));
const notFound = () =>
  (execSync as Mock).mockImplementation(() => {
    throw new Error(); // no command found
  });
const foundSecond = (path: string) =>
  (execSync as Mock)
    .mockImplementationOnce(() => {
      throw new Error(); // first command not found
    })
    .mockReturnValueOnce(Buffer.from(path));
const hasApp = (exists: boolean) =>
  (existsSync as Mock).mockReturnValue(exists);
// Accept any path containing Zed.app (the check is for Contents/MacOS/cli).
const hasZedApp = () =>
  (existsSync as Mock).mockImplementation((path: string) =>
    path.includes('Zed.app'),
  );
/** Stubs spawn() so its child fires `event` with `arg`; returns the `on` mock. */
const mockSpawn = (event: 'close' | 'error', arg: unknown) => {
  const on = vi.fn((e, cb) => {
    if (e === event) cb(arg);
  });
  (spawn as Mock).mockReturnValue({ on });
  return on;
};
const diff = (editor: EditorType) =>
  getDiffCommand('old.txt', 'new.txt', editor);
const open = (editor: EditorType, onEditorClose: () => void = () => {}) =>
  openDiff('old.txt', 'new.txt', editor, onEditorClose);
const GUI_DIFF_ARGS = ['--wait', '--diff', 'old.txt', 'new.txt'];
const GUI_EDITORS: EditorType[] = [
  'vscode',
  'vscodium',
  'windsurf',
  'cursor',
  'trae',
];
const TERMINAL_EDITORS: EditorType[] = ['vim', 'neovim', 'emacs'];

const EDITOR_COMMANDS: Array<{
  editor: EditorType;
  commands: string[];
  win32Commands: string[];
}> = [
  { editor: 'vscode', commands: ['code'], win32Commands: ['code.cmd'] },
  { editor: 'vscodium', commands: ['codium'], win32Commands: ['codium.cmd'] },
  { editor: 'windsurf', commands: ['windsurf'], win32Commands: ['windsurf'] },
  { editor: 'cursor', commands: ['cursor'], win32Commands: ['cursor'] },
  { editor: 'vim', commands: ['vim'], win32Commands: ['vim'] },
  { editor: 'neovim', commands: ['nvim'], win32Commands: ['nvim'] },
  { editor: 'zed', commands: ['zed', 'zeditor'], win32Commands: ['zed'] },
  { editor: 'emacs', commands: ['emacs'], win32Commands: ['emacs.exe'] },
  { editor: 'trae', commands: ['trae'], win32Commands: ['trae'] },
];
const PLATFORMS = [
  {
    platform: 'linux',
    label: 'non-windows',
    key: 'commands',
    path: (cmd: string) => `/usr/bin/${cmd}`,
    probe: (cmd: string) => `command -v ${cmd}`,
  },
  {
    platform: 'win32',
    label: 'windows',
    key: 'win32Commands',
    path: (cmd: string) => `C:\\Program Files\\...\\${cmd}`,
    probe: (cmd: string) => `where.exe ${cmd}`,
  },
] as const;

describe('editor utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process, 'platform', {
      value: originalPlatform,
      writable: true,
    });
  });

  describe('checkHasEditorType', () => {
    for (const entry of EDITOR_COMMANDS) {
      const { editor } = entry;
      describe(`${editor}`, () => {
        for (const { platform, label, key, path, probe } of PLATFORMS) {
          const cmds = entry[key];
          it(`should return true if first command "${cmds[0]}" exists on ${label}`, () => {
            setPlatform(platform);
            found(path(cmds[0]));
            expect(checkHasEditorType(editor)).toBe(true);
            expect(execSync).toHaveBeenCalledWith(probe(cmds[0]), {
              stdio: 'ignore',
            });
          });

          if (cmds.length > 1) {
            it(`should return true if first command doesn't exist but second command "${cmds[1]}" exists on ${label}`, () => {
              setPlatform(platform);
              foundSecond(path(cmds[1]));
              expect(checkHasEditorType(editor)).toBe(true);
              expect(execSync).toHaveBeenCalledTimes(2);
            });
          }

          it(`should return false if none of the commands exist on ${label}`, () => {
            setPlatform(platform);
            notFound();
            expect(checkHasEditorType(editor)).toBe(false);
            expect(execSync).toHaveBeenCalledTimes(cmds.length);
          });
        }
      });
    }
  });

  describe('getDiffCommand', () => {
    const guiEntries = EDITOR_COMMANDS.filter((e) =>
      GUI_EDITORS.includes(e.editor),
    );
    for (const entry of guiEntries) {
      for (const { platform, label, key, path } of PLATFORMS) {
        const cmds = entry[key];
        const expectDiff = (command: string) =>
          expect(diff(entry.editor)).toEqual({ command, args: GUI_DIFF_ARGS });

        it(`should use first command "${cmds[0]}" when it exists on ${label}`, () => {
          setPlatform(platform);
          found(path(cmds[0]));
          expectDiff(cmds[0]);
        });

        if (cmds.length > 1) {
          it(`should use second command "${cmds[1]}" when first doesn't exist on ${label}`, () => {
            setPlatform(platform);
            foundSecond(path(cmds[1]));
            expectDiff(cmds[1]);
          });
        }

        it(`should fall back to last command "${cmds[cmds.length - 1]}" when none exist on ${label}`, () => {
          setPlatform(platform);
          notFound();
          expectDiff(cmds[cmds.length - 1]);
        });
      }
    }

    for (const [editor, command] of [
      ['vim', 'vim'],
      ['neovim', 'nvim'],
    ] as const) {
      it(`should return the correct command for ${editor}`, () => {
        expect(diff(editor)).toEqual({
          command,
          args: [
            '-d',
            '-i',
            'NONE',
            '-c',
            'wincmd h | set readonly | wincmd l',
            '-c',
            'highlight DiffAdd cterm=bold ctermbg=22 guibg=#005f00 | highlight DiffChange cterm=bold ctermbg=24 guibg=#005f87 | highlight DiffText ctermbg=21 guibg=#0000af | highlight DiffDelete ctermbg=52 guibg=#5f0000',
            '-c',
            'set showtabline=2 | set tabline=[Instructions]\\ :wqa(save\\ &\\ quit)\\ \\|\\ i/esc(toggle\\ edit\\ mode)',
            '-c',
            'wincmd h | setlocal statusline=OLD\\ FILE',
            '-c',
            'wincmd l | setlocal statusline=%#StatusBold#NEW\\ FILE\\ :wqa(save\\ &\\ quit)\\ \\|\\ i/esc(toggle\\ edit\\ mode)',
            '-c',
            'autocmd BufWritePost * wqa',
            'old.txt',
            'new.txt',
          ],
        });
      });
    }

    it('should return the correct command for emacs', () => {
      expect(diff('emacs')).toEqual({
        command: 'emacs',
        args: ['--eval', '(ediff "old.txt" "new.txt")'],
      });
    });

    it('should escape backslashes and quotes in emacs paths', () => {
      // Backslashes (Windows separators) and double quotes are Elisp string
      // metacharacters: unescaped, a quote ends the (ediff ...) string early
      // and a backslash swallows the following path character.
      const command = getDiffCommand(
        'C:\\tmp\\a"b.txt',
        '/tmp/new.txt',
        'emacs',
      );
      expect(command).toEqual({
        command: 'emacs',
        args: ['--eval', '(ediff "C:\\\\tmp\\\\a\\"b.txt" "/tmp/new.txt")'],
      });
    });

    it('should return null for an unsupported editor', () => {
      // @ts-expect-error Testing unsupported editor
      expect(diff('foobar')).toBeNull();
    });

    // Zed is handled specially for macOS app detection.
    describe('Zed', () => {
      it('should use CLI command "zed" when it exists on Linux', () => {
        setPlatform('linux');
        found('/usr/bin/zed');
        expect(diff('zed')).toEqual({ command: 'zed', args: GUI_DIFF_ARGS });
      });

      it('should use CLI command "zeditor" when "zed" does not exist on Linux', () => {
        setPlatform('linux');
        foundSecond('/usr/bin/zeditor');
        expect(diff('zed')).toEqual({
          command: 'zeditor',
          args: GUI_DIFF_ARGS,
        });
      });

      it('should return null on Linux when no CLI commands exist', () => {
        setPlatform('linux');
        notFound();
        hasApp(false);
        expect(diff('zed')).toBeNull();
      });

      it('should use CLI command "zed" on Windows when it exists', () => {
        setPlatform('win32');
        found('C:\\Program Files\\Zed\\zed.exe');
        expect(diff('zed')).toEqual({ command: 'zed', args: GUI_DIFF_ARGS });
      });
    });
  });

  describe('openDiff', () => {
    for (const editor of GUI_EDITORS) {
      it(`should call spawn for ${editor}`, async () => {
        const on = mockSpawn('close', 0);
        await open(editor);
        const diffCommand = diff(editor)!;
        expect(spawn).toHaveBeenCalledWith(
          diffCommand.command,
          diffCommand.args,
          { stdio: 'inherit', shell: process.platform === 'win32' },
        );
        expect(on).toHaveBeenCalledWith('close', expect.any(Function));
        expect(on).toHaveBeenCalledWith('error', expect.any(Function));
      });

      it(`should reject if spawn for ${editor} fails`, async () => {
        mockSpawn('error', new Error('spawn error'));
        await expect(open(editor)).rejects.toThrow('spawn error');
      });

      it(`should reject if ${editor} exits with non-zero code`, async () => {
        mockSpawn('close', 1);
        await expect(open(editor)).rejects.toThrow(
          `${editor} exited with code 1`,
        );
      });
    }

    describe('Zed', () => {
      it('should call spawn for zed on macOS with CLI', async () => {
        setPlatform('darwin');
        found('/usr/local/bin/zed');
        hasApp(false);
        mockSpawn('close', 0);
        await open('zed');
        expect(spawn).toHaveBeenCalledWith('zed', GUI_DIFF_ARGS, {
          stdio: 'inherit',
          shell: false,
        });
      });

      it('should call spawn for zed on macOS with app bundle CLI', async () => {
        setPlatform('darwin');
        notFound();
        hasZedApp();
        mockSpawn('close', 0);
        await open('zed');
        expect(spawn).toHaveBeenCalled();
        // The command is the app bundle's CLI tool, not the GUI binary.
        expect((spawn as Mock).mock.calls[0][0]).toMatch(/MacOS[/\\]cli$/);
      });

      it('should reject if zed is not installed', async () => {
        setPlatform('darwin');
        notFound();
        hasApp(false);
        // Completes without throwing (logs the error to debugLogger).
        await open('zed');
      });
    });

    for (const editor of TERMINAL_EDITORS) {
      it(`should call spawnSync for ${editor}`, async () => {
        await open(editor);
        const diffCommand = diff(editor)!;
        expect(spawnSync).toHaveBeenCalledWith(
          diffCommand.command,
          diffCommand.args,
          { stdio: 'inherit' },
        );
      });
    }

    it('should handle unsupported editor gracefully', async () => {
      // Completes without throwing (logs the error to debugLogger).
      // @ts-expect-error Testing unsupported editor
      await open('foobar');
    });

    describe('onEditorClose callback', () => {
      for (const editor of TERMINAL_EDITORS) {
        it(`should call onEditorClose for ${editor} on close`, async () => {
          const onEditorClose = vi.fn();
          await open(editor, onEditorClose);
          expect(onEditorClose).toHaveBeenCalledTimes(1);
        });

        it(`should call onEditorClose for ${editor} on error`, async () => {
          const onEditorClose = vi.fn();
          (spawnSync as Mock).mockImplementation(() => {
            throw new Error('spawn error');
          });
          await expect(open(editor, onEditorClose)).rejects.toThrow(
            'spawn error',
          );
          expect(onEditorClose).toHaveBeenCalledTimes(1);
        });
      }

      for (const editor of GUI_EDITORS) {
        it(`should not call onEditorClose for ${editor}`, async () => {
          const onEditorClose = vi.fn();
          mockSpawn('close', 0);
          await open(editor, onEditorClose);
          expect(onEditorClose).not.toHaveBeenCalled();
        });
      }

      it('should not call onEditorClose for zed', async () => {
        setPlatform('darwin');
        found('/usr/local/bin/zed');
        hasApp(false);
        const onEditorClose = vi.fn();
        mockSpawn('close', 0);
        await open('zed', onEditorClose);
        expect(onEditorClose).not.toHaveBeenCalled();
      });
    });
  });

  describe('allowEditorTypeInSandbox', () => {
    for (const editor of ['vim', 'emacs', 'neovim'] as const) {
      it(`should allow ${editor} in sandbox mode`, () => {
        vi.stubEnv('SANDBOX', 'sandbox');
        expect(allowEditorTypeInSandbox(editor)).toBe(true);
      });

      it(`should allow ${editor} when not in sandbox mode`, () => {
        expect(allowEditorTypeInSandbox(editor)).toBe(true);
      });
    }

    const guiEditors: EditorType[] = [
      'vscode',
      'vscodium',
      'windsurf',
      'cursor',
      'zed',
      'trae',
    ];
    for (const editor of guiEditors) {
      it(`should not allow ${editor} in sandbox mode`, () => {
        vi.stubEnv('SANDBOX', 'sandbox');
        expect(allowEditorTypeInSandbox(editor)).toBe(false);
      });

      it(`should allow ${editor} when not in sandbox mode`, () => {
        expect(allowEditorTypeInSandbox(editor)).toBe(true);
      });
    }
  });

  describe('isEditorAvailable', () => {
    it.each([
      ['should return false for undefined editor', undefined],
      ['should return false for empty string editor', ''],
      ['should return false for invalid editor type', 'invalid-editor'],
    ])('%s', (_title, editor) => {
      expect(isEditorAvailable(editor)).toBe(false);
    });

    it('should return true for vscode when installed and not in sandbox mode', () => {
      found('/usr/bin/code');
      expect(isEditorAvailable('vscode')).toBe(true);
    });

    it('should return false for vscode when not installed and not in sandbox mode', () => {
      notFound();
      expect(isEditorAvailable('vscode')).toBe(false);
    });

    it.each([
      [false, 'vscode', 'code'],
      [true, 'vim', 'vim'],
      [true, 'emacs', 'emacs'],
      [true, 'neovim', 'nvim'],
    ] as Array<[boolean, EditorType, string]>)(
      'should return %s for %s when installed and in sandbox mode',
      (expected, editor, bin) => {
        found(`/usr/bin/${bin}`);
        vi.stubEnv('SANDBOX', 'sandbox');
        expect(isEditorAvailable(editor)).toBe(expected);
      },
    );
  });

  describe('Zed macOS app detection', () => {
    describe('checkHasEditorType for Zed', () => {
      it('should return true on macOS when Zed.app exists even if CLI is not in PATH', () => {
        setPlatform('darwin');
        notFound();
        hasApp(true);
        expect(checkHasEditorType('zed')).toBe(true);
      });

      it('should return false on macOS when Zed.app does not exist and CLI is not in PATH', () => {
        setPlatform('darwin');
        notFound();
        hasApp(false);
        expect(checkHasEditorType('zed')).toBe(false);
      });

      it('should return true on macOS when Zed CLI is in PATH', () => {
        setPlatform('darwin');
        found('/usr/local/bin/zed');
        expect(checkHasEditorType('zed')).toBe(true);
      });

      it('should not check for Zed.app on non-macOS platforms', () => {
        setPlatform('linux');
        notFound();
        hasApp(true); // ignored on Linux
        expect(checkHasEditorType('zed')).toBe(false);
      });
    });

    describe('getDiffCommand for Zed on macOS', () => {
      it('should use app bundle CLI path when CLI is not in PATH', () => {
        setPlatform('darwin');
        notFound();
        hasZedApp();
        const diffCommand = diff('zed');
        expect(diffCommand).not.toBeNull();
        // The command is the CLI tool (…/MacOS/cli), not the GUI binary zed.
        expect(diffCommand!.command).toMatch(/MacOS[/\\]cli$/);
        expect(diffCommand!.args).toEqual(GUI_DIFF_ARGS);
      });

      it('should prefer CLI in PATH over app bundle', () => {
        setPlatform('darwin');
        found('/usr/local/bin/zed');
        hasApp(true); // app also exists
        expect(diff('zed')).toEqual({ command: 'zed', args: GUI_DIFF_ARGS });
      });

      it('should return null when Zed is not installed at all', () => {
        setPlatform('darwin');
        notFound();
        hasApp(false);
        expect(diff('zed')).toBeNull();
      });

      it('should check user Applications folder as fallback', () => {
        setPlatform('darwin');
        notFound();
        hasZedApp();
        const diffCommand = diff('zed');
        expect(diffCommand).not.toBeNull();
        expect(diffCommand!.command).toMatch(/MacOS[/\\]cli$/);
      });
    });
  });

  describe('isTerminalEditor', () => {
    it('should return true for terminal editors', () => {
      expect(isTerminalEditor('vim')).toBe(true);
      expect(isTerminalEditor('neovim')).toBe(true);
      expect(isTerminalEditor('emacs')).toBe(true);
    });

    it('should return false for GUI editors', () => {
      expect(isTerminalEditor('vscode')).toBe(false);
      expect(isTerminalEditor('vscodium')).toBe(false);
      expect(isTerminalEditor('windsurf')).toBe(false);
      expect(isTerminalEditor('cursor')).toBe(false);
      expect(isTerminalEditor('zed')).toBe(false);
      expect(isTerminalEditor('trae')).toBe(false);
    });
  });

  describe('getExternalEditorCommand', () => {
    /** Resolves `editor` for /tmp/file.txt and asserts a command was found. */
    const external = (editor: EditorType) => {
      const result = getExternalEditorCommand(editor, '/tmp/file.txt');
      expect(result).not.toBeNull();
      return result!;
    };

    it('should return null when editor executable is not found', () => {
      (execSync as Mock).mockImplementation(() => {
        throw new Error('not found');
      });
      hasApp(false);
      expect(getExternalEditorCommand('vscode', '/tmp/file.txt')).toBeNull();
    });

    /** Resolves `editor` on Linux with its binary at /usr/bin/`bin`. */
    const onLinux = (editor: EditorType, bin: string) => {
      setPlatform('linux');
      found(`/usr/bin/${bin}`);
      return external(editor);
    };

    // `command` null: the original case did not check the resolved command.
    it.each([
      ['vscode', 'code', 'code'],
      ['vscodium', 'codium', 'codium'],
      ['windsurf', 'windsurf', 'windsurf'],
      ['cursor', 'cursor', null],
      ['trae', 'trae', 'trae'],
      ['zed', 'zed', null],
    ] as Array<[EditorType, string, string | null]>)(
      'should return --wait flag for %s',
      (editor, bin, command) => {
        const result = onLinux(editor, bin);
        if (command !== null) expect(result.command).toBe(command);
        expect(result.args).toEqual(['/tmp/file.txt', '--wait']);
      },
    );

    it.each([
      ['vim', 'vim'],
      ['neovim', 'nvim'],
      ['emacs', 'emacs'],
    ] as Array<[EditorType, string]>)(
      'should return plain args for %s (terminal editor)',
      (editor, bin) => {
        const result = onLinux(editor, bin);
        expect(result.command).toBe(bin);
        expect(result.args).toEqual(['/tmp/file.txt']);
      },
    );

    const needsShell = (platform: string, path: string, editor: EditorType) => {
      setPlatform(platform);
      found(path);
      return external(editor).needsShell;
    };

    it('should set needsShell=true for .cmd executables on Windows', () => {
      expect(needsShell('win32', 'C:\\code.cmd', 'vscode')).toBe(true);
    });

    it('should set needsShell=true for .bat executables on Windows', () => {
      expect(needsShell('win32', 'C:\\code.bat', 'vscode')).toBe(true);
    });

    it('should set needsShell=false for non-.cmd executables on Windows', () => {
      expect(needsShell('win32', 'C:\\cursor', 'cursor')).toBe(false);
    });

    it('should set needsShell=false on non-Windows', () => {
      expect(needsShell('linux', '/usr/bin/code', 'vscode')).toBe(false);
    });

    it('should return null for invalid editor type', () => {
      const result = getExternalEditorCommand(
        'nano' as EditorType,
        '/tmp/file.txt',
      );
      expect(result).toBeNull();
    });
  });
});

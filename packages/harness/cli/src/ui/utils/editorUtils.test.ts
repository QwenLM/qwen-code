/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditorType } from '@qwen-code/core';
import { coreEvents } from '@qwen-code/core';
import { spawn, spawnSync } from 'node:child_process';
import {
  openFileInEditor,
  relaunchActiveExternalEditor,
  resolveExternalEditor,
} from './editorUtils.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  spawnSync: vi.fn(() => ({ error: null, status: 0 })),
}));

const { isEditorAvailableMock, commandExistsMock } = vi.hoisted(() => ({
  isEditorAvailableMock: vi.fn<(editor: string | undefined) => boolean>(),
  commandExistsMock: vi.fn<(cmd: string) => boolean>(),
}));

vi.mock('@qwen-code/core', async () => {
  const actual =
    await vi.importActual<typeof import('@qwen-code/core')>(
      '@qwen-code/core',
    );
  return {
    ...actual,
    isEditorAvailable: isEditorAvailableMock,
    commandExists: commandExistsMock,
  };
});

/** Pretend only these editors are installed. `raw` covers vi/nano, which have no EditorType. */
function installed(editors: EditorType[] = [], raw: string[] = []) {
  const set = new Set<string>(editors);
  const rawSet = new Set(raw);
  isEditorAvailableMock.mockImplementation((editor) => set.has(editor ?? ''));
  commandExistsMock.mockImplementation((cmd) => rawSet.has(cmd));
}

const EDITOR_ENV_KEYS = [
  'EDITOR',
  'VISUAL',
  'VSCODE_GIT_ASKPASS_NODE',
  'VSCODE_GIT_ASKPASS_MAIN',
] as const;

describe('resolveExternalEditor', () => {
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    savedEnv = {};
    for (const key of EDITOR_ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    installed();
  });

  afterEach(() => {
    for (const key of EDITOR_ENV_KEYS) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
    vi.restoreAllMocks();
  });

  describe('preferred editor', () => {
    it('uses the preferred editor and marks a GUI editor as non-terminal', () => {
      installed(['cursor']);
      expect(resolveExternalEditor('cursor')).toEqual({
        executable: 'cursor',
        args: ['--wait'],
        isTerminal: false,
        displayName: 'Cursor',
      });
    });

    it('passes -i NONE to vim to skip the viminfo file', () => {
      installed(['vim']);
      expect(resolveExternalEditor('vim')).toEqual({
        executable: 'vim',
        args: ['-i', 'NONE'],
        isTerminal: true,
        displayName: 'Vim',
      });
    });

    it('falls through when the preferred editor is not installed', () => {
      // zed configured but absent; code is what is actually on the machine.
      installed(['vscode']);
      expect(resolveExternalEditor('zed')).toMatchObject({
        executable: 'code',
        isTerminal: false,
      });
    });
  });

  describe('$VISUAL / $EDITOR', () => {
    it('prefers VISUAL over EDITOR', () => {
      process.env['VISUAL'] = 'nano';
      process.env['EDITOR'] = 'vim';
      expect(resolveExternalEditor()).toMatchObject({ executable: 'nano' });
    });

    it('does not mistake a path containing "code" for a GUI editor', () => {
      // The substring-matching bug: /home/me/code/bin/nvim contains "code",
      // gets --wait, and exits immediately.
      process.env['EDITOR'] = '/home/me/code/bin/nvim';
      expect(resolveExternalEditor()).toEqual({
        executable: '/home/me/code/bin/nvim',
        args: ['-i', 'NONE'],
        isTerminal: true,
        displayName: 'nvim',
      });
    });

    it('does not pass -i NONE to a nano living under a "vi" directory', () => {
      // nano's -i is autoindent and NONE would become a second file to open.
      process.env['EDITOR'] = '/home/vi/bin/nano';
      expect(resolveExternalEditor()).toEqual({
        executable: '/home/vi/bin/nano',
        args: [],
        isTerminal: true,
        displayName: 'nano',
      });
    });

    it('adds --wait to a GUI editor that lacks it', () => {
      process.env['EDITOR'] = 'code';
      expect(resolveExternalEditor()).toEqual({
        executable: 'code',
        args: ['--wait'],
        isTerminal: false,
        displayName: 'code',
      });
    });

    it('does not duplicate a wait flag the user already supplied', () => {
      process.env['EDITOR'] = 'code -w';
      expect(resolveExternalEditor()).toMatchObject({ args: ['-w'] });
    });

    it('uses -w for sublime', () => {
      process.env['EDITOR'] = 'subl';
      expect(resolveExternalEditor()).toMatchObject({ args: ['-w'] });
    });

    it('does not inject --wait into editors that do not support it', () => {
      // notepad/gedit are GUI apps but reject --wait, which would turn a launch
      // into an instant non-zero exit — the same failure this issue is about.
      for (const name of ['notepad', 'notepad++', 'gedit']) {
        process.env['EDITOR'] = name;
        expect(resolveExternalEditor()).toMatchObject({ args: [] });
      }
    });

    it('treats an unknown command as a terminal editor', () => {
      process.env['EDITOR'] = '/usr/local/bin/my-editor-wrapper';
      expect(resolveExternalEditor()).toMatchObject({
        args: [],
        isTerminal: true,
      });
    });

    it('ignores an empty EDITOR and falls through to probing', () => {
      process.env['EDITOR'] = '   ';
      installed(['vscode']);
      expect(resolveExternalEditor()).toMatchObject({ executable: 'code' });
    });
  });

  describe('probing', () => {
    it('prefers the host IDE reported by the askpass path over VS Code', () => {
      // Cursor's integrated terminal: TERM_PROGRAM is 'vscode' and
      // CURSOR_TRACE_ID is unset, so only the askpass path identifies it.
      process.env['VSCODE_GIT_ASKPASS_NODE'] =
        '/Applications/Cursor.app/Contents/Frameworks/Cursor Helper.app/Contents/MacOS/Cursor Helper';
      installed(['vscode','cursor','vim']);
      expect(resolveExternalEditor()).toEqual({
        executable: 'cursor',
        args: ['--wait'],
        isTerminal: false,
        displayName: 'Cursor',
      });
    });

    it('recognises Windsurf from the askpass path', () => {
      process.env['VSCODE_GIT_ASKPASS_MAIN'] =
        '/Applications/Windsurf.app/Contents/Resources/app/extensions/git/dist/askpass-main.js';
      installed(['vscode','windsurf']);
      expect(resolveExternalEditor()).toMatchObject({
        executable: 'windsurf',
      });
    });

    it('picks a GUI editor over vim when both are installed', () => {
      // The bug: falling back to vi forces the terminal handoff, which is the
      // path that breaks. A GUI editor needs no handoff at all.
      installed(['vscode','vim']);
      expect(resolveExternalEditor()).toMatchObject({
        executable: 'code',
        isTerminal: false,
      });
    });

    it('falls back to vim when no GUI editor is installed', () => {
      installed(['vim']);
      expect(resolveExternalEditor()).toEqual({
        executable: 'vim',
        args: ['-i', 'NONE'],
        isTerminal: true,
        displayName: 'Vim',
      });
    });

    it('falls back to vi on a box that has vi but not vim', () => {
      // editorCommands.vim only lists 'vim', so the EditorType probe misses a
      // minimal SSH target that ships vi. Without this tail it reports "no
      // editor available" while a usable one sits on PATH.
      installed([], ['vi']);
      expect(resolveExternalEditor()).toEqual({
        executable: 'vi',
        args: ['-i', 'NONE'],
        isTerminal: true,
        displayName: 'vi',
      });
    });

    it('falls back to nano when neither vim nor vi exist', () => {
      installed([], ['nano']);
      expect(resolveExternalEditor()).toMatchObject({
        executable: 'nano',
        args: [],
        isTerminal: true,
      });
    });

    it('returns undefined when nothing is available', () => {
      const platform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      try {
        expect(resolveExternalEditor()).toBeUndefined();
      } finally {
        Object.defineProperty(process, 'platform', { value: platform });
      }
    });

    it('falls back to notepad on win32 when nothing is available', () => {
      const platform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      try {
        expect(resolveExternalEditor()).toMatchObject({
          executable: 'notepad',
          isTerminal: false,
        });
      } finally {
        Object.defineProperty(process, 'platform', { value: platform });
      }
    });
  });
});

/** A stand-in for a spawned editor whose lifecycle the test drives. */
function fakeChild() {
  const handlers = new Map<string, (arg: never) => void>();
  return {
    child: {
      stderr: { on: vi.fn() },
      on: vi.fn((event: string, cb: (arg: never) => void) => {
        handlers.set(event, cb);
      }),
    },
    close: (status: number) => handlers.get('close')?.(status as never),
    fail: (err: Error) => handlers.get('error')?.(err as never),
  };
}

describe('relaunchActiveExternalEditor', () => {
  const spawnMock = vi.mocked(spawn);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(spawnSync).mockReturnValue({
      error: null,
      status: 0,
    } as unknown as ReturnType<typeof spawnSync>);
    installed(['cursor', 'vim']);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Starts a GUI session and hands back the control to end it. */
  function startGuiSession() {
    const editor = fakeChild();
    spawnMock.mockReturnValueOnce(
      editor.child as unknown as ReturnType<typeof spawn>,
    );
    // Synchronous up to its internal await, so the session slot is populated
    // and the editor spawned by the time this returns.
    const finished = openFileInEditor('/tmp/buffer.md', null, undefined, 'cursor');
    return { editor, finished };
  }

  it('reopens the same file in the same editor', async () => {
    const { editor, finished } = startGuiSession();
    spawnMock.mockReturnValueOnce(
      fakeChild().child as unknown as ReturnType<typeof spawn>,
    );

    relaunchActiveExternalEditor();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenLastCalledWith(
      'cursor',
      ['--wait', '/tmp/buffer.md'],
      expect.objectContaining({ stdio: ['ignore', 'ignore', 'pipe'] }),
    );

    editor.close(0);
    await finished;
  });

  it('emits no editor events, which would fail the input gate open', async () => {
    // The gate unlocks on ANY Closed event. A relaunch that emitted its own
    // pair would release it while the first editor is still on screen, which
    // is the echo bug the gate exists to prevent.
    const { editor, finished } = startGuiSession();
    const emitSpy = vi.spyOn(coreEvents, 'emit');
    spawnMock.mockReturnValueOnce(
      fakeChild().child as unknown as ReturnType<typeof spawn>,
    );

    relaunchActiveExternalEditor();

    expect(emitSpy).not.toHaveBeenCalled();

    editor.close(0);
    await finished;
  });

  it('does nothing when no editor session is live', () => {
    relaunchActiveExternalEditor();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('does nothing once the session has ended', async () => {
    const { editor, finished } = startGuiSession();
    editor.close(0);
    await finished;
    spawnMock.mockClear();

    relaunchActiveExternalEditor();

    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('surfaces a failed relaunch once, without rejecting', async () => {
    // Nothing awaits this call — it runs inside the keypress pipeline — so a
    // launch failure has to be reported, never thrown.
    const feedbackSpy = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});
    const { editor, finished } = startGuiSession();
    const relaunched = fakeChild();
    spawnMock.mockReturnValueOnce(
      relaunched.child as unknown as ReturnType<typeof spawn>,
    );

    expect(() => relaunchActiveExternalEditor()).not.toThrow();
    relaunched.fail(new Error('ENOENT'));

    expect(feedbackSpy).toHaveBeenCalledTimes(1);
    expect(feedbackSpy).toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Failed to reopen Cursor'),
      expect.any(Error),
    );

    editor.close(0);
    await finished;
  });

  it('only logs when the reopened window exits non-zero', async () => {
    // That just means this extra window was dismissed; the session's own child
    // is what reports real failures.
    const feedbackSpy = vi
      .spyOn(coreEvents, 'emitFeedback')
      .mockImplementation(() => {});
    const { editor, finished } = startGuiSession();
    const relaunched = fakeChild();
    spawnMock.mockReturnValueOnce(
      relaunched.child as unknown as ReturnType<typeof spawn>,
    );

    relaunchActiveExternalEditor();
    relaunched.close(1);

    expect(feedbackSpy).not.toHaveBeenCalled();

    editor.close(0);
    await finished;
  });

  it('swallows a synchronous spawn throw', async () => {
    // This runs inside internal_eventEmitter.emit('input', ...), which
    // re-throws listener exceptions — an uncaught crash in exactly the state
    // this feature exists to make survivable. spawn throws synchronously on a
    // malformed executable, which $EDITOR can supply.
    const { editor, finished } = startGuiSession();
    spawnMock.mockImplementationOnce(() => {
      throw new TypeError('ERR_INVALID_ARG_TYPE');
    });

    expect(() => relaunchActiveExternalEditor()).not.toThrow();

    editor.close(0);
    await finished;
  });

  it('records no session for a terminal editor, so there is nothing to reopen', async () => {
    // The terminal path suspends stdin outright; no key can reach the gate.
    await openFileInEditor('/tmp/buffer.md', null, undefined, 'vim');
    spawnMock.mockClear();

    relaunchActiveExternalEditor();

    expect(spawnMock).not.toHaveBeenCalled();
  });
});

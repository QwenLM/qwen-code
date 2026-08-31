/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileAsyncMock, spawnMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  spawnMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock,
  });
  return {
    ...actual,
    execFile,
    spawn: spawnMock,
    default: { ...actual, execFile, spawn: spawnMock },
  };
});

const {
  openPathLocally,
  openTerminalLocally,
  isLocalPathOpenAvailable,
  isLocalTerminalAvailable,
  LocalPathOpenUnavailableError,
} = await import('./local-path-open.js');

const xdgOpenDir = mkdtempSync(join(tmpdir(), 'open-xdg-'));
writeFileSync(join(xdgOpenDir, 'xdg-open'), '#!/bin/sh\nexit 0\n');
chmodSync(join(xdgOpenDir, 'xdg-open'), 0o755);
const emptyDir = mkdtempSync(join(tmpdir(), 'open-empty-'));
const xdgOpenDirectoryEntryDir = mkdtempSync(join(tmpdir(), 'open-subdir-'));
mkdirSync(join(xdgOpenDirectoryEntryDir, 'xdg-open'));
const gnomeTerminalDir = mkdtempSync(join(tmpdir(), 'open-gnome-'));
writeFileSync(join(gnomeTerminalDir, 'gnome-terminal'), '#!/bin/sh\nexit 0\n');
chmodSync(join(gnomeTerminalDir, 'gnome-terminal'), 0o755);
const konsoleDir = mkdtempSync(join(tmpdir(), 'open-konsole-'));
writeFileSync(join(konsoleDir, 'konsole'), '#!/bin/sh\nexit 0\n');
chmodSync(join(konsoleDir, 'konsole'), 0o755);
const xtermDir = mkdtempSync(join(tmpdir(), 'open-xterm-'));
writeFileSync(join(xtermDir, 'xterm'), '#!/bin/sh\nexit 0\n');
chmodSync(join(xtermDir, 'xterm'), 0o755);
// win32 launchers refuse a missing directory before spawning, so their tests
// must open a real one.
const existingDir = mkdtempSync(join(tmpdir(), 'open-existing-'));
const missingDir = join(tmpdir(), 'open-win32-missing');

function setPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
}

function fakeChild(result: 'close' | 'error' | 'spawn'): {
  once: (event: string, cb: (error?: Error) => void) => void;
  kill: () => void;
  unref: () => void;
} {
  return {
    once: (event: string, cb: (error?: Error) => void) => {
      if (event === result) {
        queueMicrotask(() =>
          cb(result === 'error' ? new Error('spawn ENOENT') : undefined),
        );
      }
    },
    kill: vi.fn(),
    unref: vi.fn(),
  };
}

beforeEach(() => {
  execFileAsyncMock.mockReset();
  spawnMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('openPathLocally', () => {
  it('opens the path with `open` on macOS', async () => {
    setPlatform('darwin');
    execFileAsyncMock.mockResolvedValue({ stdout: '' });

    await openPathLocally('/Users/me/code');

    expect(execFileAsyncMock).toHaveBeenCalledWith('open', ['/Users/me/code'], {
      timeout: 10_000,
    });
  });

  it('wraps an `open` failure on macOS', async () => {
    setPlatform('darwin');
    execFileAsyncMock.mockRejectedValue(new Error('boom'));

    await expect(openPathLocally('/tmp')).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
  });

  it('spawns explorer.exe on Windows and ignores its exit code', async () => {
    setPlatform('win32');
    spawnMock.mockReturnValue(fakeChild('close'));

    await openPathLocally(existingDir);

    expect(spawnMock).toHaveBeenCalledWith('explorer.exe', [existingDir], {
      stdio: 'ignore',
    });
  });

  it('wraps a spawn-level explorer.exe failure on Windows', async () => {
    setPlatform('win32');
    spawnMock.mockReturnValue(fakeChild('error'));

    await expect(openPathLocally(existingDir)).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
  });

  it('rejects a deleted directory on Windows without spawning', async () => {
    setPlatform('win32');

    await expect(openPathLocally(missingDir)).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
    await expect(openTerminalLocally(missingDir)).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('opens the path with xdg-open on Linux', async () => {
    setPlatform('linux');
    execFileAsyncMock.mockResolvedValue({ stdout: '' });

    await openPathLocally('/home/me/code');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'xdg-open',
      ['/home/me/code'],
      { timeout: 10_000 },
    );
  });

  it('wraps an xdg-open failure on Linux', async () => {
    setPlatform('linux');
    execFileAsyncMock.mockRejectedValue(new Error('boom'));

    await expect(openPathLocally('/tmp')).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
  });

  it('throws unavailable on an unsupported platform', async () => {
    setPlatform('aix');

    await expect(openPathLocally('/tmp')).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('isLocalPathOpenAvailable', () => {
  it('requires positive graphical-session evidence on macOS and Windows', () => {
    setPlatform('darwin');
    expect(
      isLocalPathOpenAvailable({}, { processUid: 0, consoleUid: 501 }),
    ).toBe(false);
    expect(
      isLocalPathOpenAvailable({}, { processUid: 501, consoleUid: 501 }),
    ).toBe(true);
    expect(
      isLocalPathOpenAvailable(
        { SSH_CONNECTION: 'remote' },
        { processUid: 501, consoleUid: 501 },
      ),
    ).toBe(false);
    setPlatform('win32');
    expect(isLocalPathOpenAvailable({})).toBe(false);
    expect(isLocalPathOpenAvailable({ SESSIONNAME: 'Console' })).toBe(true);
    expect(isLocalPathOpenAvailable({ SESSIONNAME: 'Services' })).toBe(false);
  });

  it('is unavailable on unsupported platforms', () => {
    setPlatform('aix');
    expect(isLocalPathOpenAvailable({ DISPLAY: ':0', PATH: xdgOpenDir })).toBe(
      false,
    );
  });

  it('requires a display on Linux', () => {
    setPlatform('linux');
    expect(isLocalPathOpenAvailable({ PATH: xdgOpenDir })).toBe(false);
  });

  it('requires an executable xdg-open on PATH on Linux', () => {
    setPlatform('linux');
    expect(isLocalPathOpenAvailable({ DISPLAY: ':0', PATH: emptyDir })).toBe(
      false,
    );
    expect(isLocalPathOpenAvailable({ DISPLAY: ':0', PATH: xdgOpenDir })).toBe(
      true,
    );
    expect(
      isLocalPathOpenAvailable({
        WAYLAND_DISPLAY: 'wayland-0',
        PATH: xdgOpenDir,
      }),
    ).toBe(true);
  });

  it('rejects a directory named xdg-open on PATH on Linux', () => {
    setPlatform('linux');
    expect(
      isLocalPathOpenAvailable({
        DISPLAY: ':0',
        PATH: xdgOpenDirectoryEntryDir,
      }),
    ).toBe(false);
  });

  it('requires PATH to be set on Linux', () => {
    setPlatform('linux');
    expect(isLocalPathOpenAvailable({ DISPLAY: ':0' })).toBe(false);
  });
});

describe('openTerminalLocally', () => {
  it('opens Terminal.app at the path on macOS', async () => {
    setPlatform('darwin');
    execFileAsyncMock.mockResolvedValue({ stdout: '' });

    await openTerminalLocally('/Users/me/code');

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'open',
      ['-a', 'Terminal', '/Users/me/code'],
      { timeout: 10_000 },
    );
  });

  it('wraps an `open` failure on macOS', async () => {
    setPlatform('darwin');
    execFileAsyncMock.mockRejectedValue(new Error('boom'));

    await expect(openTerminalLocally('/tmp')).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
  });

  it('spawns wt.exe at the path on Windows and ignores its exit code', async () => {
    setPlatform('win32');
    spawnMock.mockReturnValue(fakeChild('close'));

    await openTerminalLocally(existingDir);

    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith('wt.exe', ['-d', existingDir], {
      stdio: 'ignore',
    });
  });

  it('falls back to a PowerShell-launched cmd window when wt.exe fails to spawn on Windows', async () => {
    setPlatform('win32');
    spawnMock
      .mockReturnValueOnce(fakeChild('error'))
      .mockReturnValueOnce(fakeChild('close'));

    await openTerminalLocally(existingDir);

    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(
      1,
      'wt.exe',
      ['-d', existingDir],
      { stdio: 'ignore' },
    );
    // The directory travels as the child's working directory, never
    // embedded in a re-parsed command line.
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-Command',
        'Start-Process cmd.exe -WorkingDirectory "$env:QWEN_LOCAL_OPEN_DIR"',
      ],
      expect.objectContaining({
        stdio: 'ignore',
        env: expect.objectContaining({
          QWEN_LOCAL_OPEN_DIR: existingDir,
        }),
      }),
    );
  });

  it('wraps the failure when both wt.exe and the fallback fail on Windows', async () => {
    setPlatform('win32');
    spawnMock.mockReturnValue(fakeChild('error'));

    await expect(openTerminalLocally(existingDir)).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
  });

  it('spawns gnome-terminal with --working-directory on Linux', async () => {
    setPlatform('linux');
    vi.stubEnv('PATH', gnomeTerminalDir);
    vi.stubEnv('DISPLAY', ':0');
    spawnMock.mockReturnValue(fakeChild('spawn'));

    await openTerminalLocally(existingDir);

    expect(spawnMock).toHaveBeenCalledWith(
      join(gnomeTerminalDir, 'gnome-terminal'),
      [`--working-directory=${existingDir}`],
      { stdio: 'ignore', detached: true },
    );
  });

  it('spawns konsole with --workdir when gnome-terminal is absent on Linux', async () => {
    setPlatform('linux');
    vi.stubEnv('PATH', konsoleDir);
    vi.stubEnv('DISPLAY', ':0');
    spawnMock.mockReturnValue(fakeChild('spawn'));

    await openTerminalLocally(existingDir);

    expect(spawnMock).toHaveBeenCalledWith(
      join(konsoleDir, 'konsole'),
      ['--workdir', existingDir],
      { stdio: 'ignore', detached: true },
    );
  });

  it('spawns xterm with a cd-and-exec shell line when it is the only terminal on Linux', async () => {
    setPlatform('linux');
    vi.stubEnv('PATH', xtermDir);
    vi.stubEnv('DISPLAY', ':0');
    spawnMock.mockReturnValue(fakeChild('spawn'));

    await openTerminalLocally(existingDir);

    expect(spawnMock).toHaveBeenCalledWith(
      join(xtermDir, 'xterm'),
      [
        '-e',
        'sh',
        '-c',
        'cd "$1" && exec "${SHELL:-/bin/sh}"',
        'sh',
        existingDir,
      ],
      { stdio: 'ignore', detached: true },
    );
  });

  it('skips xterm on a pure-Wayland session on Linux', async () => {
    setPlatform('linux');
    vi.stubEnv('PATH', xtermDir);
    vi.stubEnv('WAYLAND_DISPLAY', 'wayland-0');
    vi.stubEnv('DISPLAY', '');

    // xterm is X11-only: with no DISPLAY there is no usable candidate even
    // though WAYLAND_DISPLAY is set.
    await expect(openTerminalLocally(existingDir)).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects a deleted directory on Linux without spawning', async () => {
    setPlatform('linux');
    vi.stubEnv('PATH', gnomeTerminalDir);
    vi.stubEnv('DISPLAY', ':0');

    await expect(openTerminalLocally(missingDir)).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('rejects when the display went away after the boot-time probe on Linux', async () => {
    setPlatform('linux');
    vi.stubEnv('PATH', gnomeTerminalDir);
    vi.stubEnv('DISPLAY', '');
    vi.stubEnv('WAYLAND_DISPLAY', '');

    await expect(openTerminalLocally(existingDir)).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('prefers gnome-terminal over konsole and xterm on Linux', async () => {
    setPlatform('linux');
    vi.stubEnv(
      'PATH',
      [xtermDir, gnomeTerminalDir, konsoleDir].join(delimiter),
    );
    vi.stubEnv('DISPLAY', ':0');
    spawnMock.mockReturnValue(fakeChild('spawn'));

    await openTerminalLocally(existingDir);

    expect(spawnMock).toHaveBeenCalledWith(
      join(gnomeTerminalDir, 'gnome-terminal'),
      [`--working-directory=${existingDir}`],
      { stdio: 'ignore', detached: true },
    );
  });

  it('throws unavailable when no terminal emulator is on PATH on Linux', async () => {
    setPlatform('linux');
    vi.stubEnv('PATH', emptyDir);
    vi.stubEnv('DISPLAY', ':0');

    await expect(openTerminalLocally('/tmp')).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('wraps a spawn-level terminal failure on Linux', async () => {
    setPlatform('linux');
    vi.stubEnv('PATH', gnomeTerminalDir);
    vi.stubEnv('DISPLAY', ':0');
    spawnMock.mockReturnValue(fakeChild('error'));

    await expect(openTerminalLocally('/tmp')).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
  });

  it('throws unavailable on an unsupported platform', async () => {
    setPlatform('aix');

    await expect(openTerminalLocally('/tmp')).rejects.toBeInstanceOf(
      LocalPathOpenUnavailableError,
    );
    expect(execFileAsyncMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe('isLocalTerminalAvailable', () => {
  it('requires positive graphical-session evidence on macOS and Windows', () => {
    setPlatform('darwin');
    expect(
      isLocalTerminalAvailable({}, { processUid: 0, consoleUid: 501 }),
    ).toBe(false);
    expect(
      isLocalTerminalAvailable({}, { processUid: 501, consoleUid: 501 }),
    ).toBe(true);
    expect(
      isLocalTerminalAvailable(
        { SSH_CONNECTION: 'remote' },
        { processUid: 501, consoleUid: 501 },
      ),
    ).toBe(false);
    setPlatform('win32');
    expect(isLocalTerminalAvailable({})).toBe(false);
    expect(isLocalTerminalAvailable({ SESSIONNAME: 'Console' })).toBe(true);
    expect(isLocalTerminalAvailable({ SESSIONNAME: 'Services' })).toBe(false);
  });

  it('is unavailable on unsupported platforms', () => {
    setPlatform('aix');
    expect(
      isLocalTerminalAvailable({ DISPLAY: ':0', PATH: gnomeTerminalDir }),
    ).toBe(false);
  });

  it('requires a display on Linux', () => {
    setPlatform('linux');
    expect(isLocalTerminalAvailable({ PATH: gnomeTerminalDir })).toBe(false);
  });

  it('accepts any supported terminal emulator on PATH on Linux', () => {
    setPlatform('linux');
    expect(isLocalTerminalAvailable({ DISPLAY: ':0', PATH: emptyDir })).toBe(
      false,
    );
    expect(
      isLocalTerminalAvailable({ DISPLAY: ':0', PATH: gnomeTerminalDir }),
    ).toBe(true);
    expect(isLocalTerminalAvailable({ DISPLAY: ':0', PATH: konsoleDir })).toBe(
      true,
    );
    // xterm is X11-only: a pure-Wayland session must not count it.
    expect(
      isLocalTerminalAvailable({
        WAYLAND_DISPLAY: 'wayland-0',
        PATH: xtermDir,
      }),
    ).toBe(false);
    expect(isLocalTerminalAvailable({ DISPLAY: ':0', PATH: xtermDir })).toBe(
      true,
    );
  });

  it('ignores xdg-open for the terminal probe on Linux', () => {
    setPlatform('linux');
    expect(isLocalTerminalAvailable({ DISPLAY: ':0', PATH: xdgOpenDir })).toBe(
      false,
    );
  });

  it('requires PATH to be set on Linux', () => {
    setPlatform('linux');
    expect(isLocalTerminalAvailable({ DISPLAY: ':0' })).toBe(false);
  });
});

describe('spawn helper contracts', () => {
  it('detaches the long-lived terminal window from the daemon event loop', async () => {
    setPlatform('linux');
    vi.stubEnv('PATH', gnomeTerminalDir);
    vi.stubEnv('DISPLAY', ':0');
    spawnMock.mockReturnValue(fakeChild('spawn'));

    await openTerminalLocally(existingDir);

    const child = spawnMock.mock.results[0]?.value as {
      unref: ReturnType<typeof vi.fn>;
    };
    expect(child.unref).toHaveBeenCalled();
  });

  it('resolves even when explorer.exe exits non-zero on Windows', async () => {
    setPlatform('win32');
    spawnMock.mockReturnValue({
      once: (event: string, cb: (code?: number) => void) => {
        if (event === 'close') queueMicrotask(() => cb(1));
      },
      kill: vi.fn(),
      unref: vi.fn(),
    });

    // explorer.exe commonly exits 1 on a successful open; that is the whole
    // reason the exit code is ignored.
    await expect(openPathLocally(existingDir)).resolves.toBeUndefined();
  });

  it('kills and rejects a hung GUI launcher after 10s', async () => {
    vi.useFakeTimers();
    try {
      setPlatform('win32');
      const child = { once: vi.fn(), kill: vi.fn(), unref: vi.fn() };
      spawnMock.mockReturnValue(child);

      const pending = openPathLocally(existingDir);
      const expectation = await expect(pending).rejects.toBeInstanceOf(
        LocalPathOpenUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await expectation;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills and rejects a hung terminal spawn after 10s', async () => {
    vi.useFakeTimers();
    try {
      setPlatform('linux');
      vi.stubEnv('PATH', gnomeTerminalDir);
      vi.stubEnv('DISPLAY', ':0');
      const child = { once: vi.fn(), kill: vi.fn(), unref: vi.fn() };
      spawnMock.mockReturnValue(child);

      const pending = openTerminalLocally(existingDir);
      const expectation = await expect(pending).rejects.toBeInstanceOf(
        LocalPathOpenUnavailableError,
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await expectation;
      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('inherits the daemon environment alongside the injected directory', async () => {
    setPlatform('win32');
    vi.stubEnv('QWEN_TEST_INHERITED_MARKER', 'present');
    spawnMock
      .mockReturnValueOnce(fakeChild('error'))
      .mockReturnValueOnce(fakeChild('close'));

    await openTerminalLocally(existingDir);

    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      'powershell.exe',
      [
        '-NoProfile',
        '-STA',
        '-Command',
        'Start-Process cmd.exe -WorkingDirectory "$env:QWEN_LOCAL_OPEN_DIR"',
      ],
      expect.objectContaining({
        stdio: 'ignore',
        env: expect.objectContaining({
          QWEN_LOCAL_OPEN_DIR: existingDir,
          QWEN_TEST_INHERITED_MARKER: 'present',
        }),
      }),
    );
  });

  it('rejects a darwin session over an SSH tty, not just SSH_CONNECTION', () => {
    setPlatform('darwin');
    expect(
      isLocalTerminalAvailable(
        { SSH_TTY: '/dev/ttys001' },
        { processUid: 501, consoleUid: 501 },
      ),
    ).toBe(false);
  });
});

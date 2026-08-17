/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { execFileAsyncMock } = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const execFile = Object.assign(() => {}, {
    [Symbol.for('nodejs.util.promisify.custom')]: execFileAsyncMock,
  });
  return {
    ...actual,
    execFile,
    default: { ...actual, execFile },
  };
});

const { pickNativeDirectory, NativeDirectoryPickerUnavailableError } =
  await import('./native-directory-picker.js');

function setPlatform(platform: NodeJS.Platform) {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
}

function pickerError(fields: {
  code?: number;
  stderr?: string;
  killed?: boolean;
}): Error {
  return Object.assign(new Error('picker failed'), fields);
}

beforeEach(() => {
  execFileAsyncMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('pickNativeDirectory', () => {
  it('returns the trimmed path on macOS', async () => {
    setPlatform('darwin');
    execFileAsyncMock.mockResolvedValue({ stdout: '/Users/me/code\n' });

    await expect(pickNativeDirectory()).resolves.toBe('/Users/me/code');
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'osascript',
      expect.any(Array),
      { timeout: 300_000 },
    );
  });

  it('treats an AppleScript (-128) cancellation as no selection on macOS', async () => {
    setPlatform('darwin');
    execFileAsyncMock.mockRejectedValue(pickerError({ stderr: '(-128)' }));

    await expect(pickNativeDirectory()).resolves.toBeUndefined();
  });

  it('treats a "User canceled" cancellation as no selection on macOS', async () => {
    setPlatform('darwin');
    execFileAsyncMock.mockRejectedValue(
      pickerError({ stderr: 'User canceled. (-128)' }),
    );

    await expect(pickNativeDirectory()).resolves.toBeUndefined();
  });

  it('throws unavailable for a non-cancel failure on macOS', async () => {
    setPlatform('darwin');
    execFileAsyncMock.mockRejectedValue(pickerError({ stderr: 'boom' }));

    await expect(pickNativeDirectory()).rejects.toBeInstanceOf(
      NativeDirectoryPickerUnavailableError,
    );
  });

  it('returns the selected path on Windows', async () => {
    setPlatform('win32');
    execFileAsyncMock.mockResolvedValue({ stdout: 'C:\\code' });

    await expect(pickNativeDirectory()).resolves.toBe('C:\\code');
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'powershell.exe',
      expect.any(Array),
      { timeout: 300_000 },
    );
  });

  it('sets UTF-8 output encoding in the PowerShell script', async () => {
    setPlatform('win32');
    execFileAsyncMock.mockResolvedValue({ stdout: 'C:\\code' });

    await pickNativeDirectory();

    const args = execFileAsyncMock.mock.calls[0][1] as string[];
    const script = args[args.length - 1];
    expect(script).toContain(
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
    );
  });

  it('returns undefined when the Windows dialog is dismissed', async () => {
    setPlatform('win32');
    execFileAsyncMock.mockResolvedValue({ stdout: '   ' });

    await expect(pickNativeDirectory()).resolves.toBeUndefined();
  });

  it('returns the trimmed path on Linux', async () => {
    setPlatform('linux');
    execFileAsyncMock.mockResolvedValue({ stdout: '/home/me/code\n' });

    await expect(pickNativeDirectory()).resolves.toBe('/home/me/code');
    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'zenity',
      expect.any(Array),
      {
        timeout: 300_000,
      },
    );
  });

  it('treats zenity exit code 1 as a cancel on Linux', async () => {
    setPlatform('linux');
    execFileAsyncMock.mockRejectedValue(pickerError({ code: 1, stderr: '' }));

    await expect(pickNativeDirectory()).resolves.toBeUndefined();
  });

  it('treats a headless "cannot open display" failure as unavailable on Linux', async () => {
    setPlatform('linux');
    execFileAsyncMock.mockRejectedValue(
      pickerError({
        code: 1,
        stderr: 'Gtk-WARNING **: cannot open display:',
      }),
    );

    await expect(pickNativeDirectory()).rejects.toBeInstanceOf(
      NativeDirectoryPickerUnavailableError,
    );
  });

  it('throws unavailable for a non-cancel zenity failure on Linux', async () => {
    setPlatform('linux');
    execFileAsyncMock.mockRejectedValue(pickerError({ code: 127 }));

    await expect(pickNativeDirectory()).rejects.toBeInstanceOf(
      NativeDirectoryPickerUnavailableError,
    );
  });

  it('treats a timeout kill as a cancel on any platform', async () => {
    setPlatform('win32');
    execFileAsyncMock.mockRejectedValue(pickerError({ killed: true }));

    await expect(pickNativeDirectory()).resolves.toBeUndefined();
  });

  it('throws unavailable on an unsupported platform', async () => {
    setPlatform('aix');

    await expect(pickNativeDirectory()).rejects.toBeInstanceOf(
      NativeDirectoryPickerUnavailableError,
    );
    expect(execFileAsyncMock).not.toHaveBeenCalled();
  });

  it('forwards the abort signal to the child process', async () => {
    setPlatform('darwin');
    const controller = new AbortController();
    execFileAsyncMock.mockResolvedValue({ stdout: '/tmp\n' });

    await pickNativeDirectory(controller.signal);

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'osascript',
      expect.any(Array),
      { timeout: 300_000, signal: controller.signal },
    );
  });
});

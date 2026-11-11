/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { isInBundledMode } from '@qwen-code/core';
import {
  broadcastSettingChange,
  configurePATHWindows,
} from './pathConfigWindows.js';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('@qwen-code/core', () => ({
  isInBundledMode: vi.fn(),
  runLogger: {
    debug: vi.fn(),
  },
}));

const execFileSyncMock = vi.mocked(execFileSync);

describe('configurePATHWindows', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    vi.mocked(isInBundledMode).mockReturnValue(false);
  });

  it.each(['REG_SZ', 'REG_EXPAND_SZ'])(
    'preserves existing Unicode paths and %variables% for %s across repeated installs',
    async (type) => {
      const initial = 'C:\\Users\\中文用户\\Python😀;"%USERPROFILE%\\tools";';
      const installDir = 'C:\\Users\\中文用户\\.qwen\\bin\\qwen';
      let value = initial;
      const exports: string[] = [];
      execFileSyncMock.mockImplementation((file, args) => {
        const argv = args as string[];
        if (String(file) === 'reg.exe' && argv[0] === 'export') {
          exports.push(argv[2]);
          const data =
            type === 'REG_SZ'
              ? JSON.stringify(value)
              : 'hex(2):' +
                [...Buffer.from(value + '\0', 'utf16le')]
                  .map((b) => b.toString(16).padStart(2, '0'))
                  .join(',');
          writeFileSync(
            argv[2],
            Buffer.from(
              '\ufeffWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Environment]\r\n"Path"=' +
                data +
                '\r\n\r\n',
              'utf16le',
            ),
          );
          return 'localized stdout is not registry data';
        }
        if (String(file) === 'reg.exe' && argv[0] === 'add') {
          expect(argv[argv.indexOf('/t') + 1]).toBe(type);
          value = argv[argv.indexOf('/d') + 1];
        }
        return '';
      });
      expect((await configurePATHWindows(installDir)).modified).toBe(true);
      expect(value).toBe(initial + ';' + installDir);
      expect((await configurePATHWindows(installDir)).modified).toBe(false);
      expect((await configurePATHWindows(installDir)).modified).toBe(false);
      expect(
        (await configurePATHWindows(installDir, { rebroadcast: true })).modified,
      ).toBe(false);
      expect(exports).toHaveLength(4);
      expect(
        execFileSyncMock.mock.calls.filter(([, args]) => args?.[0] === 'add'),
      ).toHaveLength(1);
      expect(
        execFileSyncMock.mock.calls.filter(([file]) => file === 'rundll32.exe'),
      ).toHaveLength(2);
      for (const file of exports) {
        const prefix =
          process.env['BRAND_REGISTRY_PATH_PREFIX'] || 'qwen-code-registry-path-';
        expect(basename(dirname(file)).startsWith(prefix)).toBe(true);
      }
      expect(exports.every((file) => !existsSync(file))).toBe(true);
    },
  );

  it.each(['access failure', 'malformed export'])(
    'does not write PATH after %s',
    async (failure) => {
      execFileSyncMock.mockImplementation((_file, args) => {
        const argv = args as string[];
        if (failure === 'access failure')
          throw new Error('ERROR: Access is denied');
        if (argv[0] === 'export') writeFileSync(argv[2], 'wrong encoding');
        return '';
      });
      const result = await configurePATHWindows(
        'C:\\Users\\中文用户\\.qwen\\bin\\qwen',
      );
      expect(result).toMatchObject({ modified: false, skipReason: 'error' });
      expect(
        execFileSyncMock.mock.calls.some(
          ([, args]) => (args as string[])[0] === 'add',
        ),
      ).toBe(false);
    },
  );

  it('updates user PATH and broadcasts without PowerShell Add-Type', async () => {
    execFileSyncMock.mockImplementation((file, args) => {
      const argv = (args as string[]) ?? [];
      if (String(file) === 'reg.exe' && argv[0] === 'export') {
        writeFileSync(
          argv[2],
          Buffer.from(
            '\ufeffWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Environment]\r\n"Path"="C:\\\\Windows\\\\System32"\r\n\r\n',
            'utf16le',
          ),
        );
        return '';
      }
      return '';
    });

    const result = await configurePATHWindows(
      'C:\\Users\\DENG 忠阳\\.qwen-cn\\bin\\qwen',
    );

    expect(result).toEqual({
      modified: true,
      detectedShell: 'powershell',
      method: 'registry',
    });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'reg.exe',
      expect.arrayContaining(['add', 'HKCU\\Environment', '/v', 'Path']),
      expect.any(Object),
    );
    expect(execFileSyncMock).toHaveBeenCalledWith(
      'rundll32.exe',
      ['user32.dll,UpdatePerUserSystemParameters', '1,', 'True'],
      expect.objectContaining({
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
    expect(
      execFileSyncMock.mock.calls.some(([file]) =>
        String(file).includes('cmd'),
      ),
    ).toBe(false);
    expect(
      execFileSyncMock.mock.calls.some(([file, args]) =>
        [String(file), ...((args as string[]) ?? []).map(String)].some(
          (part) => part.includes('powershell') || part.includes('Add-Type'),
        ),
      ),
    ).toBe(false);
  });

  it('runs a bounded notification in an isolated Bun child', () => {
    vi.mocked(isInBundledMode).mockReturnValue(true);
    let cwd = '';
    execFileSyncMock.mockImplementationOnce((_file, _args, options) => {
      cwd = String(options?.cwd);
      expect(readFileSync(join(cwd, 'bunfig.toml'), 'utf8')).toBe('');
      return '';
    });

    broadcastSettingChange();

    expect(execFileSyncMock).toHaveBeenCalledExactlyOnceWith(
      process.execPath,
      [
        `--config=${join(cwd, 'bunfig.toml')}`,
        '--no-env-file',
        '--no-install',
        '--eval',
        expect.stringContaining('SendMessageTimeoutW'),
      ],
      {
        cwd,
        env: { BUN_BE_BUN: '1', SystemRoot: process.env['SystemRoot'] },
        timeout: 2_000,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    expect(existsSync(cwd)).toBe(false);
  });

  it('keeps the legacy notification when the native child fails', () => {
    vi.mocked(isInBundledMode).mockReturnValue(true);
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('ETIMEDOUT');
    });

    broadcastSettingChange();

    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(execFileSyncMock).toHaveBeenLastCalledWith(
      'rundll32.exe',
      ['user32.dll,UpdatePerUserSystemParameters', '1,', 'True'],
      expect.any(Object),
    );
  });

  it('keeps PATH update successful when environment broadcast fails', async () => {
    execFileSyncMock.mockImplementation((file, args) => {
      const argv = (args as string[]) ?? [];
      if (String(file) === 'reg.exe' && argv[0] === 'export') {
        writeFileSync(
          argv[2],
          Buffer.from(
            '\ufeffWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Environment]\r\n"Path"="C:\\\\Windows\\\\System32"\r\n\r\n',
            'utf16le',
          ),
        );
        return '';
      }
      if (String(file) === 'rundll32.exe') {
        throw new Error('broadcast blocked');
      }
      return '';
    });

    await expect(
      configurePATHWindows('C:\\Users\\alice\\.qwen-cn\\bin\\qwen'),
    ).resolves.toEqual({
      modified: true,
      detectedShell: 'powershell',
      method: 'registry',
    });
  });

  it('retries reg export on a transient ETIMEDOUT then succeeds', async () => {
    let queryAttempts = 0;
    execFileSyncMock.mockImplementation((file, args) => {
      const argv = (args as string[]) ?? [];
      if (String(file) === 'reg.exe' && argv[0] === 'export') {
        queryAttempts++;
        if (queryAttempts === 1) {
          const err = new Error(
            'spawnSync C:\\Windows\\system32\\reg.exe ETIMEDOUT',
          ) as NodeJS.ErrnoException;
          err.code = 'ETIMEDOUT';
          throw err;
        }
        writeFileSync(
          argv[2],
          Buffer.from(
            '\ufeffWindows Registry Editor Version 5.00\r\n\r\n[HKEY_CURRENT_USER\\Environment]\r\n"Path"="C:\\\\Windows\\\\System32"\r\n\r\n',
            'utf16le',
          ),
        );
        return '';
      }
      return '';
    });

    const result = await configurePATHWindows(
      'C:\\Users\\alice\\.qwen\\bin\\qwen',
    );

    expect(result).toEqual({
      modified: true,
      detectedShell: 'powershell',
      method: 'registry',
    });
    expect(queryAttempts).toBe(2);
  });

  it('reports error after reg export exhausts all retries on ETIMEDOUT', async () => {
    execFileSyncMock.mockImplementation((file, args) => {
      const argv = (args as string[]) ?? [];
      if (String(file) === 'reg.exe' && argv[0] === 'export') {
        const err = new Error(
          'spawnSync C:\\Windows\\system32\\reg.exe ETIMEDOUT',
        ) as NodeJS.ErrnoException;
        err.code = 'ETIMEDOUT';
        throw err;
      }
      return '';
    });

    const result = await configurePATHWindows(
      'C:\\Users\\alice\\.qwen\\bin\\qwen',
    );

    expect(result.modified).toBe(false);
    expect(result.skipReason).toBe('error');
    expect(result.errorMessage).toContain('ETIMEDOUT');
    const queryCalls = execFileSyncMock.mock.calls.filter(
      ([file, args]) =>
        String(file) === 'reg.exe' &&
        ((args as string[]) ?? [])[0] === 'export',
    );
    expect(queryCalls).toHaveLength(3);
  });
});

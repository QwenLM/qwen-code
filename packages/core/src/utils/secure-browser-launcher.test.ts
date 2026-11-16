/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openBrowserSecurely } from './secure-browser-launcher.js';

type FakeChild = {
  once: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

const { mockExecFile, mockSpawn, fakeChild } = vi.hoisted(() => {
  // A spawned child that invokes the listener for `fires` ('spawn' with no
  // arguments, 'error' with a spawn failure) as soon as it is registered.
  const fakeChild = (fires: 'spawn' | 'error') => {
    const child: FakeChild = {
      once: vi.fn((event: string, callback: (error?: Error) => void) => {
        if (event === fires) {
          if (fires === 'error') callback(new Error('spawn failed'));
          else callback();
        }
        return child;
      }),
      unref: vi.fn(),
    };
    return child;
  };
  return {
    mockExecFile: vi.fn(),
    mockSpawn: vi.fn(() => fakeChild('spawn')),
    fakeChild,
  };
});

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  spawn: mockSpawn,
}));
vi.mock('node:util', () => ({
  promisify: () => mockExecFile,
}));

describe('secure-browser-launcher', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    mockSpawn.mockImplementation(() => fakeChild('spawn'));
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    vi.stubEnv('BROWSER', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('DEBIAN_FRONTEND', '');
    vi.stubEnv('SSH_CONNECTION', '');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
    vi.unstubAllEnvs();
  });

  function setPlatform(platform: string) {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  }

  const setLinuxDesktop = () => {
    setPlatform('linux');
    vi.stubEnv('DISPLAY', ':1');
  };
  const setHeadlessLinux = () => {
    setPlatform('linux');
    vi.stubEnv('DISPLAY', '');
    vi.stubEnv('WAYLAND_DISPLAY', '');
    vi.stubEnv('MIR_SOCKET', '');
  };
  const warnSpy = () => vi.spyOn(console, 'warn').mockImplementation(() => {});
  const expectWarned = (spy: ReturnType<typeof warnSpy>, text: string) =>
    expect(spy).toHaveBeenCalledWith(expect.stringContaining(text));

  const expectOpened = (command: string, url = 'https://example.com') =>
    expect(mockExecFile).toHaveBeenCalledWith(
      command,
      [url],
      expect.any(Object),
    );
  const expectSpawned = (command: string, args: string[]) =>
    expect(mockSpawn).toHaveBeenCalledWith(command, args, expect.any(Object));
  const expectPowerShellOpened = () =>
    expect(mockExecFile).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining([
        '-Command',
        `Start-Process 'https://example.com'`,
      ]),
      expect.any(Object),
    );
  const expectPowerShellCommand = (command: string) =>
    expect(mockExecFile).toHaveBeenCalledWith(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-WindowStyle',
        'Hidden',
        '-Command',
        command,
      ],
      expect.any(Object),
    );

  describe('URL validation', () => {
    // 'should allow valid HTTPS URLs' was an exact duplicate of
    // 'Platform-specific behavior > should use correct command on macOS'.
    it('should allow valid HTTP URLs', async () => {
      setPlatform('darwin');
      await openBrowserSecurely('http://example.com');
      expectOpened('open', 'http://example.com');
    });

    it('should reject non-HTTP(S) protocols', async () => {
      for (const url of [
        'file:///etc/passwd',
        'javascript:alert(1)',
        'ftp://example.com',
      ]) {
        await expect(openBrowserSecurely(url)).rejects.toThrow(
          'Unsafe protocol',
        );
      }
    });

    it('should allow file URLs only when explicitly requested with an allow-list', async () => {
      setLinuxDesktop();
      const filePath = resolve('report.html');
      const fileUrl = pathToFileURL(filePath).href;

      await expect(
        openBrowserSecurely('file:///tmp/report.html'),
      ).rejects.toThrow('Unsafe protocol');

      await expect(
        openBrowserSecurely(fileUrl, { allowFile: true }),
      ).rejects.toThrow('allowedFilePaths is required');

      await openBrowserSecurely(fileUrl, {
        allowFile: true,
        allowedFilePaths: [filePath],
      });

      expectOpened('xdg-open', fileUrl);
    });

    it('should restrict file URLs to the caller allow-list when provided', async () => {
      const allowedPath = resolve('report.html');
      const otherPath = resolve('other.html');

      await expect(
        openBrowserSecurely(pathToFileURL(otherPath).href, {
          allowFile: true,
          allowedFilePaths: [allowedPath],
        }),
      ).rejects.toThrow('allowed file set');
    });

    it('should reject invalid URLs', async () => {
      for (const url of ['not-a-url', '']) {
        await expect(openBrowserSecurely(url)).rejects.toThrow('Invalid URL');
      }
    });

    it('should reject URLs with control characters', async () => {
      for (const url of [
        'http://example.com\nmalicious-command',
        'http://example.com\rmalicious-command',
        'http://example.com\x00',
      ]) {
        await expect(openBrowserSecurely(url)).rejects.toThrow(
          'invalid characters',
        );
      }
    });
  });

  describe('Command injection prevention', () => {
    it('should prevent PowerShell command injection on Windows', async () => {
      setPlatform('win32');

      const maliciousUrl =
        "http://127.0.0.1:8080/?param=example#$(Invoke-Expression([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('Y2FsYy5leGU='))))";

      await openBrowserSecurely(maliciousUrl);

      expectPowerShellCommand(
        `Start-Process '${maliciousUrl.replace(/'/g, "''")}'`,
      );
    });

    it('should handle URLs with special shell characters safely', async () => {
      setPlatform('darwin');

      const urlsWithSpecialChars = [
        'http://example.com/path?param=value&other=$value',
        'http://example.com/path#fragment;command',
        'http://example.com/$(whoami)',
        'http://example.com/`command`',
        'http://example.com/|pipe',
        'http://example.com/>redirect',
      ];

      for (const url of urlsWithSpecialChars) {
        await openBrowserSecurely(url);
        expectOpened('open', url);
      }
    });

    it('should properly escape single quotes in URLs on Windows', async () => {
      setPlatform('win32');

      await openBrowserSecurely(
        "http://example.com/path?name=O'Brien&test='value'",
      );

      expectPowerShellCommand(
        `Start-Process 'http://example.com/path?name=O''Brien&test=''value'''`,
      );
    });
  });

  describe('Platform-specific behavior', () => {
    it('should use correct command on macOS', async () => {
      setPlatform('darwin');
      await openBrowserSecurely('https://example.com');
      expectOpened('open');
    });

    it('should use PowerShell on Windows', async () => {
      setPlatform('win32');
      await openBrowserSecurely('https://example.com');
      expectPowerShellOpened();
    });

    it('should use xdg-open on Linux', async () => {
      setLinuxDesktop();
      await openBrowserSecurely('https://example.com');
      expectOpened('xdg-open');
    });

    it('should throw on unsupported platforms', async () => {
      setPlatform('aix');
      await expect(openBrowserSecurely('https://example.com')).rejects.toThrow(
        'Unsupported platform',
      );
    });

    it('should prefer BROWSER when it is configured', async () => {
      setLinuxDesktop();
      vi.stubEnv('BROWSER', 'firefox --new-tab');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['--new-tab', 'https://example.com'],
        expect.objectContaining({ detached: true, stdio: 'ignore' }),
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should substitute the BROWSER placeholder instead of appending the URL', async () => {
      setLinuxDesktop();
      vi.stubEnv('BROWSER', 'firefox --new-tab %s');

      await openBrowserSecurely('https://example.com');

      expectSpawned('firefox', ['--new-tab', 'https://example.com']);
    });

    it('should substitute BROWSER placeholders literally', async () => {
      setLinuxDesktop();
      vi.stubEnv('BROWSER', 'firefox --new-tab %s');
      const url = 'https://example.com/callback?code=$&state=abc';

      await openBrowserSecurely(url);

      expectSpawned('firefox', ['--new-tab', url]);
    });

    it('should parse quoted arguments inside BROWSER tokens', async () => {
      setLinuxDesktop();
      vi.stubEnv(
        'BROWSER',
        'chromium --user-data-dir="/tmp/my profile" --new-tab %s',
      );

      await openBrowserSecurely('https://example.com');

      expectSpawned('chromium', [
        '--user-data-dir=/tmp/my profile',
        '--new-tab',
        'https://example.com',
      ]);
    });

    it('should parse quoted command paths in BROWSER', async () => {
      setLinuxDesktop();
      vi.stubEnv('BROWSER', '"/opt/my browser/chromium" --new-tab %s');

      await openBrowserSecurely('https://example.com');

      expectSpawned('/opt/my browser/chromium', [
        '--new-tab',
        'https://example.com',
      ]);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should let an explicit BROWSER override headless Linux detection', async () => {
      setHeadlessLinux();
      vi.stubEnv('BROWSER', 'firefox');

      await openBrowserSecurely('https://example.com');

      expectSpawned('firefox', ['https://example.com']);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should fall back to the platform opener for blocklisted BROWSER values', async () => {
      setLinuxDesktop();
      vi.stubEnv('BROWSER', 'www-browser --headless');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expectOpened('xdg-open');
    });

    it('should block BROWSER values by command basename before using the platform opener', async () => {
      setLinuxDesktop();
      vi.stubEnv('BROWSER', '/usr/bin/www-browser --headless');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expectOpened('xdg-open');
    });

    it('should still skip blocklisted BROWSER values in headless Linux', async () => {
      setHeadlessLinux();
      vi.stubEnv('BROWSER', 'www-browser');
      const consoleSpy = warnSpy();

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
      expectWarned(consoleSpy, 'Please open this URL manually');

      consoleSpy.mockRestore();
    });

    it('should ignore BROWSER on Windows and keep the PowerShell opener', async () => {
      setPlatform('win32');
      vi.stubEnv('BROWSER', 'firefox --new-tab');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expectPowerShellOpened();
    });

    it('should ignore blocklisted BROWSER values on Windows', async () => {
      setPlatform('win32');
      vi.stubEnv('BROWSER', 'www-browser');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expectPowerShellOpened();
    });

    it('should fall back to the platform opener for invalid BROWSER values', async () => {
      setPlatform('darwin');
      vi.stubEnv('BROWSER', '"');
      const consoleSpy = warnSpy();

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expectOpened('open');
      expectWarned(consoleSpy, 'Invalid BROWSER environment variable');

      consoleSpy.mockRestore();
    });

    it('should fall back to the platform opener when explicit BROWSER launch fails', async () => {
      setLinuxDesktop();
      vi.stubEnv('BROWSER', 'firefox --new-tab');
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });
      mockSpawn.mockImplementationOnce(() => fakeChild('error'));
      const consoleSpy = warnSpy();

      await expect(
        openBrowserSecurely('https://example.com'),
      ).resolves.toBeUndefined();

      expectSpawned('firefox', ['--new-tab', 'https://example.com']);
      expectOpened('xdg-open');
      expectWarned(consoleSpy, 'Failed to open BROWSER command firefox');

      consoleSpy.mockRestore();
    });

    it('should skip browser launch in headless Linux', async () => {
      setHeadlessLinux();
      const consoleSpy = warnSpy();

      await openBrowserSecurely('https://example.com');

      expect(mockExecFile).not.toHaveBeenCalled();
      expectWarned(consoleSpy, 'Please open this URL manually');

      consoleSpy.mockRestore();
    });
  });

  describe('Error handling', () => {
    it('should handle browser launch failures gracefully by logging instead of throwing', async () => {
      setPlatform('darwin');
      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));
      const consoleSpy = warnSpy();

      await expect(
        openBrowserSecurely('https://example.com'),
      ).resolves.toBeUndefined();

      expectWarned(consoleSpy, 'Failed to open browser automatically');

      consoleSpy.mockRestore();
    });
  });

  describe('Linux Fallback', () => {
    it('should try fallback browsers on Linux', async () => {
      setLinuxDesktop();
      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });

      await openBrowserSecurely('https://example.com');

      expect(mockExecFile).toHaveBeenCalledTimes(2);
      expect(mockExecFile).toHaveBeenNthCalledWith(
        1,
        'xdg-open',
        ['https://example.com'],
        expect.any(Object),
      );
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        'gnome-open',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should detach real browser fallback commands', async () => {
      setLinuxDesktop();
      mockExecFile
        .mockRejectedValueOnce(new Error('xdg-open missing'))
        .mockRejectedValueOnce(new Error('gnome-open missing'))
        .mockRejectedValueOnce(new Error('kde-open missing'));

      await openBrowserSecurely('https://example.com');

      expectSpawned('firefox', ['https://example.com']);
    });
  });
});

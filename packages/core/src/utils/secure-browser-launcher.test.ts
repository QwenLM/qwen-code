/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openBrowserSecurely } from './secure-browser-launcher.js';

// Create mock function using vi.hoisted
const mockExecFile = vi.hoisted(() => vi.fn());
const mockSpawn = vi.hoisted(() =>
  vi.fn(() => {
    const child: {
      once: ReturnType<typeof vi.fn>;
      unref: ReturnType<typeof vi.fn>;
    } = {
      once: vi.fn((event: string, callback: () => void) => {
        if (event === 'spawn') {
          callback();
        }
        return child;
      }),
      unref: vi.fn(),
    };
    return child;
  }),
);

// Mock modules
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
    mockSpawn.mockImplementation(() => {
      const child: {
        once: ReturnType<typeof vi.fn>;
        unref: ReturnType<typeof vi.fn>;
      } = {
        once: vi.fn((event: string, callback: () => void) => {
          if (event === 'spawn') {
            callback();
          }
          return child;
        }),
        unref: vi.fn(),
      };
      return child;
    });
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

  describe('URL validation', () => {
    it('should allow valid HTTP URLs', async () => {
      setPlatform('darwin');
      await openBrowserSecurely('http://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['http://example.com'],
        expect.any(Object),
      );
    });

    it('should allow valid HTTPS URLs', async () => {
      setPlatform('darwin');
      await openBrowserSecurely('https://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should reject non-HTTP(S) protocols', async () => {
      await expect(openBrowserSecurely('file:///etc/passwd')).rejects.toThrow(
        'Unsafe protocol',
      );
      await expect(openBrowserSecurely('javascript:alert(1)')).rejects.toThrow(
        'Unsafe protocol',
      );
      await expect(openBrowserSecurely('ftp://example.com')).rejects.toThrow(
        'Unsafe protocol',
      );
    });

    it('should allow file URLs only when explicitly requested with an allow-list', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      const filePath = resolve('report.html');
      const fileUrl = pathToFileURL(filePath).href;

      await expect(
        openBrowserSecurely('file:///tmp/report.html'),
      ).rejects.toThrow('Unsafe protocol');

      await expect(
        openBrowserSecurely(fileUrl, {
          allowFile: true,
        }),
      ).rejects.toThrow('allowedFilePaths is required');

      await openBrowserSecurely(fileUrl, {
        allowFile: true,
        allowedFilePaths: [filePath],
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        [fileUrl],
        expect.any(Object),
      );
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
      await expect(openBrowserSecurely('not-a-url')).rejects.toThrow(
        'Invalid URL',
      );
      await expect(openBrowserSecurely('')).rejects.toThrow('Invalid URL');
    });

    it('should reject URLs with control characters', async () => {
      await expect(
        openBrowserSecurely('http://example.com\nmalicious-command'),
      ).rejects.toThrow('invalid characters');
      await expect(
        openBrowserSecurely('http://example.com\rmalicious-command'),
      ).rejects.toThrow('invalid characters');
      await expect(
        openBrowserSecurely('http://example.com\x00'),
      ).rejects.toThrow('invalid characters');
    });
  });

  describe('Command injection prevention', () => {
    it('should prevent PowerShell command injection on Windows', async () => {
      setPlatform('win32');

      const maliciousUrl =
        "http://127.0.0.1:8080/?param=example#$(Invoke-Expression([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('Y2FsYy5leGU='))))";

      await openBrowserSecurely(maliciousUrl);

      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Start-Process '${maliciousUrl.replace(/'/g, "''")}'`,
        ],
        expect.any(Object),
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
        expect(mockExecFile).toHaveBeenCalledWith(
          'open',
          [url],
          expect.any(Object),
        );
      }
    });

    it('should properly escape single quotes in URLs on Windows', async () => {
      setPlatform('win32');

      const urlWithSingleQuotes =
        "http://example.com/path?name=O'Brien&test='value'";
      await openBrowserSecurely(urlWithSingleQuotes);

      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-WindowStyle',
          'Hidden',
          '-Command',
          `Start-Process 'http://example.com/path?name=O''Brien&test=''value'''`,
        ],
        expect.any(Object),
      );
    });
  });

  describe('Platform-specific behavior', () => {
    it('should use correct command on macOS', async () => {
      setPlatform('darwin');
      await openBrowserSecurely('https://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should use PowerShell on Windows', async () => {
      setPlatform('win32');
      await openBrowserSecurely('https://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining([
          '-Command',
          `Start-Process 'https://example.com'`,
        ]),
        expect.any(Object),
      );
    });

    it('should use xdg-open on Linux', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      await openBrowserSecurely('https://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should throw on unsupported platforms', async () => {
      setPlatform('aix');
      await expect(openBrowserSecurely('https://example.com')).rejects.toThrow(
        'Unsupported platform',
      );
    });

    it('should prefer BROWSER when it is configured', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'firefox --new-tab');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['--new-tab', 'https://example.com'],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
        }),
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should substitute the BROWSER placeholder instead of appending the URL', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'firefox --new-tab %s');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['--new-tab', 'https://example.com'],
        expect.any(Object),
      );
    });

    it('should substitute BROWSER placeholders literally', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'firefox --new-tab %s');
      const url = 'https://example.com/callback?code=$&state=abc';

      await openBrowserSecurely(url);

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['--new-tab', url],
        expect.any(Object),
      );
    });

    it('should parse quoted arguments inside BROWSER tokens', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv(
        'BROWSER',
        'chromium --user-data-dir="/tmp/my profile" --new-tab %s',
      );

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).toHaveBeenCalledWith(
        'chromium',
        ['--user-data-dir=/tmp/my profile', '--new-tab', 'https://example.com'],
        expect.any(Object),
      );
    });

    it('should parse quoted command paths in BROWSER', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', '"/opt/my browser/chromium" --new-tab %s');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).toHaveBeenCalledWith(
        '/opt/my browser/chromium',
        ['--new-tab', 'https://example.com'],
        expect.any(Object),
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should let an explicit BROWSER override headless Linux detection', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      vi.stubEnv('MIR_SOCKET', '');
      vi.stubEnv('BROWSER', 'firefox');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['https://example.com'],
        expect.any(Object),
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should fall back to the platform opener for blocklisted BROWSER values', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'www-browser --headless');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should block BROWSER values by command basename before using the platform opener', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', '/usr/bin/www-browser --headless');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        ['https://example.com'],
        expect.any(Object),
      );
    });

    it('should still skip blocklisted BROWSER values in headless Linux', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      vi.stubEnv('MIR_SOCKET', '');
      vi.stubEnv('BROWSER', 'www-browser');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Please open this URL manually'),
      );

      consoleSpy.mockRestore();
    });

    it('should ignore BROWSER on Windows and keep the PowerShell opener', async () => {
      setPlatform('win32');
      vi.stubEnv('BROWSER', 'firefox --new-tab');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining([
          '-Command',
          `Start-Process 'https://example.com'`,
        ]),
        expect.any(Object),
      );
    });

    it('should ignore blocklisted BROWSER values on Windows', async () => {
      setPlatform('win32');
      vi.stubEnv('BROWSER', 'www-browser');

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'powershell.exe',
        expect.arrayContaining([
          '-Command',
          `Start-Process 'https://example.com'`,
        ]),
        expect.any(Object),
      );
    });

    it('should fall back to the platform opener for invalid BROWSER values', async () => {
      setPlatform('darwin');
      vi.stubEnv('BROWSER', '"');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).not.toHaveBeenCalled();
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['https://example.com'],
        expect.any(Object),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid BROWSER environment variable'),
      );

      consoleSpy.mockRestore();
    });

    it('should fall back to the platform opener when explicit BROWSER launch fails', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');
      vi.stubEnv('BROWSER', 'firefox --new-tab');
      mockExecFile.mockResolvedValueOnce({ stdout: '', stderr: '' });
      mockSpawn.mockImplementationOnce(() => {
        const child: {
          once: ReturnType<typeof vi.fn>;
          unref: ReturnType<typeof vi.fn>;
        } = {
          once: vi.fn((event: string, callback: (error?: Error) => void) => {
            if (event === 'error') {
              callback(new Error('spawn failed'));
            }
            return child;
          }),
          unref: vi.fn(),
        };
        return child;
      });
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        openBrowserSecurely('https://example.com'),
      ).resolves.toBeUndefined();

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['--new-tab', 'https://example.com'],
        expect.any(Object),
      );
      expect(mockExecFile).toHaveBeenCalledWith(
        'xdg-open',
        ['https://example.com'],
        expect.any(Object),
      );
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to open BROWSER command firefox'),
      );

      consoleSpy.mockRestore();
    });

    it('should skip browser launch in headless Linux', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', '');
      vi.stubEnv('WAYLAND_DISPLAY', '');
      vi.stubEnv('MIR_SOCKET', '');
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await openBrowserSecurely('https://example.com');

      expect(mockExecFile).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Please open this URL manually'),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Error handling', () => {
    it('should handle browser launch failures gracefully by logging instead of throwing', async () => {
      setPlatform('darwin');
      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        openBrowserSecurely('https://example.com'),
      ).resolves.toBeUndefined();

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to open browser automatically'),
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Linux Fallback', () => {
    it('should try fallback browsers on Linux', async () => {
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');

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
      setPlatform('linux');
      vi.stubEnv('DISPLAY', ':1');

      mockExecFile
        .mockRejectedValueOnce(new Error('xdg-open missing'))
        .mockRejectedValueOnce(new Error('gnome-open missing'))
        .mockRejectedValueOnce(new Error('kde-open missing'));

      await openBrowserSecurely('https://example.com');

      expect(mockSpawn).toHaveBeenCalledWith(
        'firefox',
        ['https://example.com'],
        expect.any(Object),
      );
    });
  });
});

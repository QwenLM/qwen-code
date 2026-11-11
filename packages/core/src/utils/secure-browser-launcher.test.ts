/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  openBrowserSecurely,
  openEnterpriseUsage,
} from './secure-browser-launcher.js';

// Create mock function using vi.hoisted
const mockExecFile = vi.hoisted(() => vi.fn());

// Mock modules
vi.mock('node:child_process');
vi.mock('node:util', () => ({
  promisify: () => mockExecFile,
}));

describe('secure-browser-launcher', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecFile.mockResolvedValue({ stdout: '', stderr: '' });
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  });

  afterEach(() => {
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform);
    }
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
    it('should avoid shell interpretation on Windows', async () => {
      setPlatform('win32');

      // The POC from the vulnerability report
      const maliciousUrl =
        "http://127.0.0.1:8080/?param=example#$(Invoke-Expression([System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('Y2FsYy5leGU='))))";

      await openBrowserSecurely(maliciousUrl);

      // Verify that execFile was called (not exec) and the URL is passed as an
      // argument to the system URL handler, not through PowerShell or cmd.exe.
      expect(mockExecFile).toHaveBeenCalledWith(
        'rundll32.exe',
        ['url,OpenURL', maliciousUrl],
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
        // Verify the URL is passed as an argument, not interpreted by shell
        expect(mockExecFile).toHaveBeenCalledWith(
          'open',
          [url],
          expect.any(Object),
        );
      }
    });

    it('should pass single quotes as URL characters on Windows', async () => {
      setPlatform('win32');

      const urlWithSingleQuotes =
        "http://example.com/path?name=O'Brien&test='value'";
      await openBrowserSecurely(urlWithSingleQuotes);

      expect(mockExecFile).toHaveBeenCalledWith(
        'rundll32.exe',
        ['url,OpenURL', urlWithSingleQuotes],
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

    it('should use the system URL handler on Windows', async () => {
      setPlatform('win32');
      await openBrowserSecurely('https://example.com');
      expect(mockExecFile).toHaveBeenCalledWith(
        'rundll32.exe',
        ['url,OpenURL', 'https://example.com'],
        expect.any(Object),
      );
    });

    it('should use xdg-open on Linux', async () => {
      setPlatform('linux');
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
  });

  describe('Error handling', () => {
    it('does not launch a browser for an already cancelled request', async () => {
      setPlatform('darwin');
      const controller = new AbortController();
      const reason = new Error('authorization cancelled');
      controller.abort(reason);
      await expect(openBrowserSecurely('https://example.com', controller.signal)).rejects.toBe(reason);
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('does not try Linux fallbacks after cancellation', async () => {
      setPlatform('linux');
      const controller = new AbortController();
      const reason = new Error('authorization cancelled');
      mockExecFile.mockImplementationOnce(async () => {
        controller.abort(reason);
        throw reason;
      });
      await expect(openBrowserSecurely('https://example.com', controller.signal)).rejects.toBe(reason);
      expect(mockExecFile).toHaveBeenCalledOnce();
    });

    it('passes cancellation to a hanging browser opener', async () => {
      setPlatform('darwin');
      const controller = new AbortController();
      const reason = new Error('authorization expired');
      mockExecFile.mockImplementation(
        async (_command, _args, options: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            options.signal?.addEventListener(
              'abort',
              () => reject(options.signal?.reason),
              { once: true },
            );
          }),
      );

      const launch = openBrowserSecurely(
        'https://example.com',
        controller.signal,
      );
      controller.abort(reason);

      await expect(launch).rejects.toBe(reason);
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['https://example.com'],
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('should handle browser launch failures gracefully', async () => {
      setPlatform('darwin');
      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));

      await expect(openBrowserSecurely('https://example.com')).rejects.toThrow(
        'Failed to open browser',
      );
    });

    it('should try fallback browsers on Linux', async () => {
      setPlatform('linux');

      // First call to xdg-open fails
      mockExecFile.mockRejectedValueOnce(new Error('Command not found'));
      // Second call to gnome-open succeeds
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
  });

  describe('Enterprise usage destinations', () => {
    it('opens an externalBrowser destination only when it is HTTPS', async () => {
      setPlatform('darwin');

      await openEnterpriseUsage({
        openMode: 'externalBrowser',
        detailUrl: 'https://usage.example.com',
      });
      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['https://usage.example.com'],
        expect.any(Object),
      );

      await expect(
        openEnterpriseUsage({
          openMode: 'externalBrowser',
          detailUrl: 'http://usage.example.com',
        }),
      ).rejects.toThrow('must use HTTPS');
    });

    it('opens allowlisted DingTalk Deep Links through the system handler', async () => {
      setPlatform('darwin');
      await openEnterpriseUsage({
        openMode: 'systemDeepLink',
        detailUrl: 'dingtalk://dingtalkclient/action/openapp',
        fallbackUrl: 'https://usage.example.com',
      });

      expect(mockExecFile).toHaveBeenCalledWith(
        'open',
        ['dingtalk://dingtalkclient/action/openapp'],
        expect.any(Object),
      );
    });

    it('opens Alilang without a fallback URL', async () => {
      setPlatform('darwin');
      await openEnterpriseUsage({ openMode: 'systemDeepLink', detailUrl: 'alilang://usage/details' });
      expect(mockExecFile).toHaveBeenCalledWith('open', ['alilang://usage/details'], expect.any(Object));
      mockExecFile.mockRejectedValueOnce(new Error('No handler'));
      await expect(openEnterpriseUsage({ openMode: 'systemDeepLink', detailUrl: 'alilang://usage/details' })).rejects.toThrow();
    });

    it('falls back to HTTPS for unsupported or failed Deep Links', async () => {
      setPlatform('darwin');
      await openEnterpriseUsage({
        openMode: 'systemDeepLink',
        detailUrl: 'unknown-app://usage',
        fallbackUrl: 'https://usage.example.com/fallback',
      });
      expect(mockExecFile).toHaveBeenLastCalledWith(
        'open',
        ['https://usage.example.com/fallback'],
        expect.any(Object),
      );

      mockExecFile.mockClear();
      mockExecFile
        .mockRejectedValueOnce(new Error('No handler'))
        .mockResolvedValueOnce({ stdout: '', stderr: '' });
      await openEnterpriseUsage({
        openMode: 'systemDeepLink',
        detailUrl: 'dingtalk://dingtalkclient/action/openapp',
        fallbackUrl: 'https://usage.example.com/fallback',
      });
      expect(mockExecFile).toHaveBeenNthCalledWith(
        2,
        'open',
        ['https://usage.example.com/fallback'],
        expect.any(Object),
      );
    });
  });
});

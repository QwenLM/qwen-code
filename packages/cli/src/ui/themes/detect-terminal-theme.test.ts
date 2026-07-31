/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';
// Static import is safe because all exported functions read process.env /
// process.platform at call time, not import time. If any module-level state
// capture is added, revert to vi.resetModules() + dynamic import.
import {
  detectFromColorFgBg,
  detectMacOSTheme,
  detectOsc11Theme,
  detectTerminalTheme,
  parseOscRgb,
  themeFromOscColor,
} from './detect-terminal-theme.js';

vi.mock('node:child_process');

describe('detectTerminalTheme', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    delete process.env['COLORFGBG'];
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    process.env = originalEnv;
  });

  // ---------------------------------------------------------------------------
  // parseOscRgb + themeFromOscColor (pure, synchronous)
  // ---------------------------------------------------------------------------

  describe('parseOscRgb', () => {
    it('should parse rgb:RRRR/GGGG/BBBB format', async () => {
      const rgb = parseOscRgb('rgb:0000/0000/0000');
      expect(rgb).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should parse short hex components (rgb:RR/GG/BB)', async () => {
      const rgb = parseOscRgb('rgb:ff/ff/ff');
      expect(rgb).toEqual({ r: 1, g: 1, b: 1 });
    });

    it('should parse #RRGGBB format', async () => {
      const rgb = parseOscRgb('#000000');
      expect(rgb).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should parse #RRRRGGGGBBBB format', async () => {
      const rgb = parseOscRgb('#ffffffffffff');
      expect(rgb).toEqual({ r: 1, g: 1, b: 1 });
    });

    it('should return undefined for invalid data', async () => {
      expect(parseOscRgb('garbage')).toBeUndefined();
      expect(parseOscRgb('rgb:0000/0000/0000junk')).toBeUndefined();
      expect(parseOscRgb('')).toBeUndefined();
    });
  });

  describe('themeFromOscColor', () => {
    it('should return "dark" for a dark background', async () => {
      // Pure black background
      expect(themeFromOscColor('rgb:0000/0000/0000')).toBe('dark');
      // Typical dark terminal (e.g., #1e1e2e)
      expect(themeFromOscColor('rgb:1e1e/1e1e/2e2e')).toBe('dark');
    });

    it('should return "light" for a light background', async () => {
      // Pure white background
      expect(themeFromOscColor('rgb:ffff/ffff/ffff')).toBe('light');
      // Typical light terminal (e.g., #fafafa)
      expect(themeFromOscColor('rgb:fafa/fafa/fafa')).toBe('light');
    });

    it('should return undefined for unparseable data', async () => {
      expect(themeFromOscColor('not-a-color')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // detectOsc11Theme (async, TTY interaction)
  // ---------------------------------------------------------------------------

  describe('detectOsc11Theme', () => {
    const forceTTY = () => {
      const origStdinTTY = process.stdin.isTTY;
      const origStdoutTTY = process.stdout.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: true,
        configurable: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });
      return () => {
        Object.defineProperty(process.stdin, 'isTTY', {
          value: origStdinTTY,
          configurable: true,
        });
        Object.defineProperty(process.stdout, 'isTTY', {
          value: origStdoutTTY,
          configurable: true,
        });
      };
    };

    it('should return undefined when stdin is not a TTY', async () => {
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });

      const result = await detectOsc11Theme();
      expect(result).toBeUndefined();

      Object.defineProperty(process.stdin, 'isTTY', {
        value: origIsTTY,
        configurable: true,
      });
    });

    it('should resolve "dark" when terminal reports a dark background', async () => {
      const restoreTTY = forceTTY();
      const writeSpy = vi
        .spyOn(process.stdout, 'write')
        .mockImplementation(() => true);
      const baseline = process.stdin.listenerCount('data');

      try {
        const promise = detectOsc11Theme();
        // Listener must be attached synchronously so the response is captured.
        expect(process.stdin.listenerCount('data')).toBe(baseline + 1);
        expect(writeSpy).toHaveBeenCalledWith('\x1b]11;?\x07');

        process.stdin.emit(
          'data',
          Buffer.from('\x1b]11;rgb:0000/0000/0000\x07'),
        );

        await expect(promise).resolves.toBe('dark');
        // Regression guard: listener must be removed on every exit path.
        expect(process.stdin.listenerCount('data')).toBe(baseline);
      } finally {
        restoreTTY();
      }
    });

    it('should resolve undefined on timeout and remove its data listener', async () => {
      vi.useFakeTimers();
      const restoreTTY = forceTTY();
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      const baseline = process.stdin.listenerCount('data');

      try {
        const promise = detectOsc11Theme();
        expect(process.stdin.listenerCount('data')).toBe(baseline + 1);

        await vi.advanceTimersByTimeAsync(250);

        await expect(promise).resolves.toBeUndefined();
        // Regression guard: the listener-leak that motivated earlier fixes
        // in this PR (OSC 11 bytes bleeding into the input box) only
        // happens when the timeout path forgets to detach.
        expect(process.stdin.listenerCount('data')).toBe(baseline);
      } finally {
        restoreTTY();
        vi.useRealTimers();
      }
    });

    it('should reassemble OSC 11 responses split across multiple data events', async () => {
      const restoreTTY = forceTTY();
      vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      try {
        const promise = detectOsc11Theme();
        // Split a pure-white response across two chunks.
        process.stdin.emit('data', Buffer.from('\x1b]11;rgb:ffff/'));
        process.stdin.emit('data', Buffer.from('ffff/ffff\x07'));

        await expect(promise).resolves.toBe('light');
      } finally {
        restoreTTY();
      }
    });
  });

  // ---------------------------------------------------------------------------
  // detectMacOSTheme (sync)
  // ---------------------------------------------------------------------------

  describe('detectMacOSTheme', () => {
    it('should return "dark" when macOS dark mode is active', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockReturnValue('Dark\n');

      expect(detectMacOSTheme()).toBe('dark');
    });

    it('should return "light" when macOS light mode is active', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error('The domain/default pair does not exist');
      });

      expect(detectMacOSTheme()).toBe('light');
    });

    it('should return "light" when the "does not exist" message is on stderr only', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        const err = new Error('Command failed') as Error & {
          stderr?: string;
        };
        err.stderr =
          'The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist\n';
        throw err;
      });

      expect(detectMacOSTheme()).toBe('light');
    });

    it('should return undefined on timeout (do not assume Light Mode)', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error('Command failed: defaults read -g AppleInterfaceStyle');
      });

      expect(detectMacOSTheme()).toBeUndefined();
    });

    it('should return undefined when `defaults` is not on PATH', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        const err = new Error('spawnSync defaults ENOENT') as Error & {
          code?: string;
        };
        err.code = 'ENOENT';
        throw err;
      });

      expect(detectMacOSTheme()).toBeUndefined();
    });

    it('should return undefined on non-macOS platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      expect(detectMacOSTheme()).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // detectFromColorFgBg (sync)
  // ---------------------------------------------------------------------------

  describe('detectFromColorFgBg', () => {
    it('should return "dark" when background is dark (COLORFGBG=15;0)', async () => {
      process.env['COLORFGBG'] = '15;0';
      expect(detectFromColorFgBg()).toBe('dark');
    });

    it('should return "light" when background is light (COLORFGBG=0;15)', async () => {
      process.env['COLORFGBG'] = '0;15';
      expect(detectFromColorFgBg()).toBe('light');
    });

    it('should return "light" when background is 7 (light gray)', async () => {
      process.env['COLORFGBG'] = '0;7';
      expect(detectFromColorFgBg()).toBe('light');
    });

    it('should return "dark" when background is 8 (dark gray)', async () => {
      process.env['COLORFGBG'] = '15;8';
      expect(detectFromColorFgBg()).toBe('dark');
    });

    it('should handle three-part format (fg;extra;bg)', async () => {
      process.env['COLORFGBG'] = '15;0;0';
      expect(detectFromColorFgBg()).toBe('dark');
    });

    it('should return undefined when COLORFGBG is not set', async () => {
      delete process.env['COLORFGBG'];
      expect(detectFromColorFgBg()).toBeUndefined();
    });

    it('should return undefined when COLORFGBG has invalid value', async () => {
      process.env['COLORFGBG'] = 'invalid';
      expect(detectFromColorFgBg()).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // detectTerminalTheme (sync entry point)
  // ---------------------------------------------------------------------------

  describe('detectTerminalTheme (sync)', () => {
    it('should prefer COLORFGBG over macOS detection', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockReturnValue('Dark\n');
      process.env['COLORFGBG'] = '0;15';

      expect(detectTerminalTheme()).toBe('light');
    });

    it('should fall back to macOS when COLORFGBG is not set', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockReturnValue('Dark\n');
      delete process.env['COLORFGBG'];

      expect(detectTerminalTheme()).toBe('dark');
    });

    it('should fall back to COLORFGBG on non-macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env['COLORFGBG'] = '0;15';

      expect(detectTerminalTheme()).toBe('light');
    });

    it('should default to dark when no detection method works', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      delete process.env['COLORFGBG'];

      expect(detectTerminalTheme()).toBe('dark');
    });
  });
});

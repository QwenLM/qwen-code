/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as childProcess from 'node:child_process';

vi.mock('node:child_process');

describe('detectTerminalTheme', () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
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
      const { parseOscRgb } = await import('./detect-terminal-theme.js');
      const rgb = parseOscRgb('rgb:0000/0000/0000');
      expect(rgb).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should parse short hex components (rgb:RR/GG/BB)', async () => {
      const { parseOscRgb } = await import('./detect-terminal-theme.js');
      const rgb = parseOscRgb('rgb:ff/ff/ff');
      expect(rgb).toEqual({ r: 1, g: 1, b: 1 });
    });

    it('should parse #RRGGBB format', async () => {
      const { parseOscRgb } = await import('./detect-terminal-theme.js');
      const rgb = parseOscRgb('#000000');
      expect(rgb).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should parse #RRRRGGGGBBBB format', async () => {
      const { parseOscRgb } = await import('./detect-terminal-theme.js');
      const rgb = parseOscRgb('#ffffffffffff');
      expect(rgb).toEqual({ r: 1, g: 1, b: 1 });
    });

    it('should return undefined for invalid data', async () => {
      const { parseOscRgb } = await import('./detect-terminal-theme.js');
      expect(parseOscRgb('garbage')).toBeUndefined();
      expect(parseOscRgb('')).toBeUndefined();
    });
  });

  describe('themeFromOscColor', () => {
    it('should return "dark" for a dark background', async () => {
      const { themeFromOscColor } = await import('./detect-terminal-theme.js');
      // Pure black background
      expect(themeFromOscColor('rgb:0000/0000/0000')).toBe('dark');
      // Typical dark terminal (e.g., #1e1e2e)
      expect(themeFromOscColor('rgb:1e1e/1e1e/2e2e')).toBe('dark');
    });

    it('should return "light" for a light background', async () => {
      const { themeFromOscColor } = await import('./detect-terminal-theme.js');
      // Pure white background
      expect(themeFromOscColor('rgb:ffff/ffff/ffff')).toBe('light');
      // Typical light terminal (e.g., #fafafa)
      expect(themeFromOscColor('rgb:fafa/fafa/fafa')).toBe('light');
    });

    it('should return undefined for unparseable data', async () => {
      const { themeFromOscColor } = await import('./detect-terminal-theme.js');
      expect(themeFromOscColor('not-a-color')).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // detectOsc11Theme (async, TTY interaction)
  // ---------------------------------------------------------------------------

  describe('detectOsc11Theme', () => {
    it('should return undefined when stdin is not a TTY', async () => {
      const origIsTTY = process.stdin.isTTY;
      Object.defineProperty(process.stdin, 'isTTY', {
        value: false,
        configurable: true,
      });

      const { detectOsc11Theme } = await import('./detect-terminal-theme.js');
      const result = await detectOsc11Theme();
      expect(result).toBeUndefined();

      Object.defineProperty(process.stdin, 'isTTY', {
        value: origIsTTY,
        configurable: true,
      });
    });
  });

  // ---------------------------------------------------------------------------
  // detectMacOSTheme (sync)
  // ---------------------------------------------------------------------------

  describe('detectMacOSTheme', () => {
    it('should return "dark" when macOS dark mode is active', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockReturnValue('Dark\n');

      const { detectMacOSTheme } = await import('./detect-terminal-theme.js');
      expect(detectMacOSTheme()).toBe('dark');
    });

    it('should return "light" when macOS light mode is active', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error('The domain/default pair does not exist');
      });

      const { detectMacOSTheme } = await import('./detect-terminal-theme.js');
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

      const { detectMacOSTheme } = await import('./detect-terminal-theme.js');
      expect(detectMacOSTheme()).toBe('light');
    });

    it('should return undefined on timeout (do not assume Light Mode)', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockImplementation(() => {
        throw new Error('Command failed: defaults read -g AppleInterfaceStyle');
      });

      const { detectMacOSTheme } = await import('./detect-terminal-theme.js');
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

      const { detectMacOSTheme } = await import('./detect-terminal-theme.js');
      expect(detectMacOSTheme()).toBeUndefined();
    });

    it('should return undefined on non-macOS platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const { detectMacOSTheme } = await import('./detect-terminal-theme.js');
      expect(detectMacOSTheme()).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // detectFromColorFgBg (sync)
  // ---------------------------------------------------------------------------

  describe('detectFromColorFgBg', () => {
    it('should return "dark" when background is dark (COLORFGBG=15;0)', async () => {
      process.env['COLORFGBG'] = '15;0';
      const { detectFromColorFgBg } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectFromColorFgBg()).toBe('dark');
    });

    it('should return "light" when background is light (COLORFGBG=0;15)', async () => {
      process.env['COLORFGBG'] = '0;15';
      const { detectFromColorFgBg } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectFromColorFgBg()).toBe('light');
    });

    it('should return "light" when background is 7 (light gray)', async () => {
      process.env['COLORFGBG'] = '0;7';
      const { detectFromColorFgBg } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectFromColorFgBg()).toBe('light');
    });

    it('should return "dark" when background is 8 (dark gray)', async () => {
      process.env['COLORFGBG'] = '15;8';
      const { detectFromColorFgBg } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectFromColorFgBg()).toBe('dark');
    });

    it('should handle three-part format (fg;extra;bg)', async () => {
      process.env['COLORFGBG'] = '15;0;0';
      const { detectFromColorFgBg } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectFromColorFgBg()).toBe('dark');
    });

    it('should return undefined when COLORFGBG is not set', async () => {
      delete process.env['COLORFGBG'];
      const { detectFromColorFgBg } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectFromColorFgBg()).toBeUndefined();
    });

    it('should return undefined when COLORFGBG has invalid value', async () => {
      process.env['COLORFGBG'] = 'invalid';
      const { detectFromColorFgBg } = await import(
        './detect-terminal-theme.js'
      );
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

      const { detectTerminalTheme } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectTerminalTheme()).toBe('light');
    });

    it('should fall back to macOS when COLORFGBG is not set', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockReturnValue('Dark\n');
      delete process.env['COLORFGBG'];

      const { detectTerminalTheme } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectTerminalTheme()).toBe('dark');
    });

    it('should fall back to COLORFGBG on non-macOS', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      process.env['COLORFGBG'] = '0;15';

      const { detectTerminalTheme } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectTerminalTheme()).toBe('light');
    });

    it('should default to dark when no detection method works', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      delete process.env['COLORFGBG'];

      const { detectTerminalTheme } = await import(
        './detect-terminal-theme.js'
      );
      expect(detectTerminalTheme()).toBe('dark');
    });
  });
});

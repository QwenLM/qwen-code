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

    it('should return undefined on non-macOS platforms', async () => {
      Object.defineProperty(process, 'platform', { value: 'linux' });

      const { detectMacOSTheme } = await import('./detect-terminal-theme.js');
      expect(detectMacOSTheme()).toBeUndefined();
    });
  });

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

  describe('detectTerminalTheme', () => {
    it('should prefer macOS detection over COLORFGBG', async () => {
      Object.defineProperty(process, 'platform', { value: 'darwin' });
      vi.mocked(childProcess.execSync).mockReturnValue('Dark\n');
      // Set COLORFGBG to light to verify macOS takes precedence
      process.env['COLORFGBG'] = '0;15';

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

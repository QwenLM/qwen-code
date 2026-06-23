/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  getEffectiveInputBackground,
  getInputBackgroundFill,
  themeBackgroundMatchesTerminal,
} from './theme-background.js';
import { themeManager } from '../themes/theme-manager.js';
import { theme } from '../semantic-colors.js';
import type { CustomTheme } from '../themes/theme.js';

const customTheme: CustomTheme = {
  type: 'custom',
  name: 'MyCustomTheme',
  Background: '#102030',
  Foreground: '#ffffff',
  LightBlue: '#89BDCD',
  AccentBlue: '#3B82F6',
  AccentPurple: '#8B5CF6',
  AccentCyan: '#06B6D4',
  AccentGreen: '#3CA84B',
  AccentYellow: 'yellow',
  AccentRed: 'red',
  DiffAdded: 'green',
  DiffRemoved: 'red',
  Comment: 'gray',
  Gray: 'gray',
};

// Force the terminal background detection result without probing the real
// terminal: cachedAutoDetection takes precedence in getTerminalBackgroundType.
function setDetectedTerminal(value: 'dark' | 'light') {
  (
    themeManager as unknown as { cachedAutoDetection: 'dark' | 'light' }
  ).cachedAutoDetection = value;
}

describe('theme-background', () => {
  beforeEach(() => {
    // themeManager is a module-level singleton; reset state so ordering is not
    // load-bearing across tests.
    themeManager.loadCustomThemes({});
    (
      themeManager as unknown as {
        cachedAutoDetection: unknown;
        terminalBackground: unknown;
      }
    ).cachedAutoDetection = undefined;
    (
      themeManager as unknown as { terminalBackground: unknown }
    ).terminalBackground = undefined;
  });

  describe('themeBackgroundMatchesTerminal', () => {
    it('matches when a light theme runs on a light terminal', () => {
      themeManager.setActiveTheme('Qwen Light');
      setDetectedTerminal('light');
      expect(themeBackgroundMatchesTerminal()).toBe(true);
    });

    it('matches when a dark theme runs on a dark terminal', () => {
      themeManager.setActiveTheme('Qwen Dark');
      setDetectedTerminal('dark');
      expect(themeBackgroundMatchesTerminal()).toBe(true);
    });

    it('does not match a light theme forced onto a dark terminal', () => {
      themeManager.setActiveTheme('Qwen Light');
      setDetectedTerminal('dark');
      expect(themeBackgroundMatchesTerminal()).toBe(false);
    });

    it('does not match a dark theme forced onto a light terminal', () => {
      themeManager.setActiveTheme('Qwen Dark');
      setDetectedTerminal('light');
      expect(themeBackgroundMatchesTerminal()).toBe(false);
    });

    it('treats custom themes as matching (brightness cannot be classified)', () => {
      themeManager.loadCustomThemes({ MyCustomTheme: customTheme });
      themeManager.setActiveTheme('MyCustomTheme');
      setDetectedTerminal('light');
      expect(themeBackgroundMatchesTerminal()).toBe(true);
    });
  });

  describe('getInputBackgroundFill', () => {
    it('fills with the theme background when it matches the terminal', () => {
      themeManager.setActiveTheme('Qwen Light');
      setDetectedTerminal('light');
      expect(getInputBackgroundFill()).toBe(theme.background.primary);
    });

    it('leaves the box transparent when the theme fights the terminal', () => {
      themeManager.setActiveTheme('Qwen Light');
      setDetectedTerminal('dark');
      expect(getInputBackgroundFill()).toBeUndefined();
    });
  });

  describe('getEffectiveInputBackground', () => {
    it('returns the theme background when it matches the terminal', () => {
      themeManager.setActiveTheme('Qwen Dark');
      setDetectedTerminal('dark');
      expect(getEffectiveInputBackground()).toBe(theme.background.primary);
    });

    it('returns a dark stand-in for a light theme on a dark terminal', () => {
      themeManager.setActiveTheme('Qwen Light');
      setDetectedTerminal('dark');
      expect(getEffectiveInputBackground()).toBe('#000000');
    });

    it('returns a light stand-in for a dark theme on a light terminal', () => {
      themeManager.setActiveTheme('Qwen Dark');
      setDetectedTerminal('light');
      expect(getEffectiveInputBackground()).toBe('#ffffff');
    });
  });
});

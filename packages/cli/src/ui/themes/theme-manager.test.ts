/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Patch: Unset NO_COLOR at the very top before any imports
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  themeManager,
  DEFAULT_THEME,
  isAutoThemeSetting,
} from './theme-manager.js';
import { runLogger, type CustomTheme } from '@qwen-code/core';
import type { Theme } from './theme.js';
import { interpolateColor } from './theme.js';
import { DEFAULT_SELECTION_OPACITY } from '../constants.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import type * as osActual from 'node:os';

vi.mock('node:fs');
vi.mock('node:os', async (importOriginal) => {
  const actualOs = await importOriginal<typeof osActual>();
  return {
    ...actualOs,
    homedir: vi.fn(),
    platform: vi.fn(() => 'linux'),
  };
});

vi.mock('@qwen-code/core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/core')>();
  return {
    ...actual,
    homedir: () => os.homedir(),
  };
});

const validCustomTheme: CustomTheme = {
  type: 'custom',
  name: 'MyCustomTheme',
  Background: '#000000',
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

describe('ThemeManager', () => {
  beforeEach(() => {
    // Reset themeManager state and inject mocks
    themeManager.reinitialize({ fs, homedir: os.homedir });
    themeManager.loadCustomThemes({});
    themeManager.setActiveTheme(DEFAULT_THEME.name);
    themeManager.setTerminalBackground(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should load valid custom themes', () => {
    themeManager.loadCustomThemes({ MyCustomTheme: validCustomTheme });
    expect(themeManager.getCustomThemeNames()).toContain('MyCustomTheme');
    expect(themeManager.isCustomTheme('MyCustomTheme')).toBe(true);
  });

  it('should set and get the active theme', () => {
    expect(themeManager.getActiveTheme().name).toBe(DEFAULT_THEME.name);
    themeManager.setActiveTheme('Ayu');
    expect(themeManager.getActiveTheme().name).toBe('Ayu');
  });

  it('should set and get a custom active theme', () => {
    themeManager.loadCustomThemes({ MyCustomTheme: validCustomTheme });
    themeManager.setActiveTheme('MyCustomTheme');
    expect(themeManager.getActiveTheme().name).toBe('MyCustomTheme');
  });

  it('should return false when setting a non-existent theme', () => {
    expect(themeManager.setActiveTheme('NonExistentTheme')).toBe(false);
    expect(themeManager.getActiveTheme().name).toBe(DEFAULT_THEME.name);
  });

  it('should list available themes including custom themes', () => {
    themeManager.loadCustomThemes({ MyCustomTheme: validCustomTheme });
    const available = themeManager.getAvailableThemes();
    expect(
      available.some(
        (t: { name: string; isCustom?: boolean }) =>
          t.name === 'MyCustomTheme' && t.isCustom,
      ),
    ).toBe(true);
  });

  it('should get a theme by name', () => {
    expect(themeManager.getTheme('Ayu')).toBeDefined();
    themeManager.loadCustomThemes({ MyCustomTheme: validCustomTheme });
    expect(themeManager.getTheme('MyCustomTheme')).toBeDefined();
  });

  it('should fall back to default theme if active theme is invalid', () => {
    (themeManager as unknown as { activeTheme: unknown }).activeTheme = {
      name: 'NonExistent',
      type: 'custom',
    };
    expect(themeManager.getActiveTheme().name).toBe(DEFAULT_THEME.name);
  });

  it('should return NoColorTheme if NO_COLOR is set', () => {
    const original = process.env['NO_COLOR'];
    process.env['NO_COLOR'] = '1';
    expect(themeManager.getActiveTheme().name).toBe('NoColor');
    if (original === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = original;
    }
  });

  describe('when loading a theme from a file', () => {
    const mockThemePath = './my-theme.json';
    const mockTheme: CustomTheme = {
      ...validCustomTheme,
      name: 'My File Theme',
    };

    beforeEach(() => {
      vi.mocked(os.homedir).mockReturnValue('/home/user');
      vi.spyOn(fs, 'realpathSync').mockImplementation((p) => p as string);
    });

    it('should load a theme from a valid file path', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(mockTheme));

      const result = themeManager.setActiveTheme('/home/user/my-theme.json');

      expect(result).toBe(true);
      const activeTheme = themeManager.getActiveTheme();
      expect(activeTheme.name).toBe('My File Theme');
      expect(fs.readFileSync).toHaveBeenCalledWith(
        expect.stringContaining('my-theme.json'),
        'utf-8',
      );
    });

    it('should not load a theme if the file does not exist', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      const result = themeManager.setActiveTheme(mockThemePath);

      expect(result).toBe(false);
      expect(themeManager.getActiveTheme().name).toBe(DEFAULT_THEME.name);
    });

    it('should not load a theme from a file with invalid JSON', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue('invalid json');

      const result = themeManager.setActiveTheme(mockThemePath);

      expect(result).toBe(false);
      expect(themeManager.getActiveTheme().name).toBe(DEFAULT_THEME.name);
    });

    it('should not load a theme from an untrusted file path and log a message', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(mockTheme));
      const consoleWarnSpy = vi
        .spyOn(runLogger, 'warn')
        .mockImplementation(() => {});

      const result = themeManager.setActiveTheme('/untrusted/my-theme.json');

      expect(result).toBe(false);
      expect(themeManager.getActiveTheme().name).toBe(DEFAULT_THEME.name);
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('is outside your home directory'),
      );

      consoleWarnSpy.mockRestore();
    });
  });

  describe('terminalBackground override', () => {
    it.each([
      ['Qwen Light', '#FFFFFF', '#8B5CF6'],
      ['Qwen Dark', '#111111', '#CBA6F7'],
    ])(
      'keeps %s selection aligned with slash-command accent before and after background detection',
      (name, background, accent) => {
        themeManager.setActiveTheme(name);
        const initial = themeManager.getSemanticColors();
        expect(initial.text.accent).toBe(accent);
        expect(initial.ui.focus).toBe(accent);
        expect(initial.ui.active).toBe(accent);
        expect(initial.background.focus).toBe(
          themeManager.getActiveTheme().colors.FocusBackground,
        );

        themeManager.setTerminalBackground(background);
        const detected = themeManager.getSemanticColors();
        expect(detected.ui.focus).toBe(detected.text.accent);
        expect(detected.ui.active).toBe(accent);
        expect(detected.background.focus).toBe(
          interpolateColor(background, accent, DEFAULT_SELECTION_OPACITY),
        );
        expect(detected.status.success).toBe(initial.status.success);
      },
    );

    it('should store and retrieve terminal background', () => {
      themeManager.setTerminalBackground('#123456');
      expect(themeManager.getTerminalBackground()).toBe('#123456');
      themeManager.setTerminalBackground(undefined);
      expect(themeManager.getTerminalBackground()).toBeUndefined();
    });

    it('should override background.primary in semantic colors when terminal background is set', () => {
      const color = '#1a1a1a';
      themeManager.setTerminalBackground(color);
      const semanticColors = themeManager.getSemanticColors();
      expect(semanticColors.background.primary).toBe(color);
    });

    it('should override Background in colors when terminal background is set', () => {
      const color = '#1a1a1a';
      themeManager.setTerminalBackground(color);
      const colors = themeManager.getColors();
      expect(colors.Background).toBe(color);
    });

    it('should re-calculate dependent semantic colors when terminal background is set', () => {
      themeManager.setTerminalBackground('#000000');
      const semanticColors = themeManager.getSemanticColors();

      // border.default should be interpolated from background (#000000) and Gray
      // ui.dark should be interpolated from Gray and background (#000000)
      expect(semanticColors.border.default).toBeDefined();
      expect(semanticColors.ui.dark).toBeDefined();
      expect(semanticColors.border.default).not.toBe(
        DEFAULT_THEME.semanticColors.border.default,
      );
    });

    it('should return original semantic colors when terminal background is NOT set', () => {
      themeManager.setTerminalBackground(undefined);
      const semanticColors = themeManager.getSemanticColors();
      expect(semanticColors).toEqual(DEFAULT_THEME.semanticColors);
    });

    it('should NOT override background when theme is incompatible (Light theme on Dark terminal)', () => {
      themeManager.setActiveTheme('Default Light');
      const darkTerminalBg = '#000000';
      themeManager.setTerminalBackground(darkTerminalBg);

      const semanticColors = themeManager.getSemanticColors();
      expect(semanticColors.background.primary).toBe(
        themeManager.getTheme('Default Light')!.colors.Background,
      );

      const colors = themeManager.getColors();
      expect(colors.Background).toBe(
        themeManager.getTheme('Default Light')!.colors.Background,
      );
    });

    it('should NOT override background when theme is incompatible (Dark theme on Light terminal)', () => {
      themeManager.setActiveTheme('Default');
      const lightTerminalBg = '#FFFFFF';
      themeManager.setTerminalBackground(lightTerminalBg);

      const semanticColors = themeManager.getSemanticColors();
      expect(semanticColors.background.primary).toBe(
        themeManager.getTheme('Default')!.colors.Background,
      );

      const colors = themeManager.getColors();
      expect(colors.Background).toBe(
        themeManager.getTheme('Default')!.colors.Background,
      );
    });

    it('should override background for custom theme when compatible', () => {
      themeManager.loadCustomThemes({
        MyDark: {
          name: 'MyDark',
          type: 'custom',
          Background: '#000000',
          Foreground: '#ffffff',
        },
      });
      themeManager.setActiveTheme('MyDark');

      const darkTerminalBg = '#1a1a1a';
      themeManager.setTerminalBackground(darkTerminalBg);

      const semanticColors = themeManager.getSemanticColors();
      expect(semanticColors.background.primary).toBe(darkTerminalBg);
    });

    it('should NOT override background for custom theme when incompatible', () => {
      themeManager.loadCustomThemes({
        MyLight: {
          name: 'MyLight',
          type: 'custom',
          Background: '#ffffff',
          Foreground: '#000000',
        },
      });
      themeManager.setActiveTheme('MyLight');

      const darkTerminalBg = '#000000';
      themeManager.setTerminalBackground(darkTerminalBg);

      const semanticColors = themeManager.getSemanticColors();
      expect(semanticColors.background.primary).toBe('#ffffff');
    });
  });

  describe('isAutoThemeSetting', () => {
    it('treats an unset theme as auto', () => {
      // Unset has always been resolved from the background at startup and
      // followed at runtime, so folding it into 'auto' preserves behavior.
      expect(isAutoThemeSetting(undefined)).toBe(true);
      expect(isAutoThemeSetting('auto')).toBe(true);
      expect(isAutoThemeSetting('Default')).toBe(false);
      expect(isAutoThemeSetting('Dracula')).toBe(false);
    });
  });

  describe('resolveThemeSetting', () => {
    it('passes concrete theme names through untouched', () => {
      expect(
        themeManager.resolveThemeSetting('Dracula', '#ffffff'),
      ).toBe('Dracula');
      // Even when the background disagrees — a pinned theme is never overridden.
      expect(
        themeManager.resolveThemeSetting('GitHub Dark', '#ffffff'),
      ).toBe('GitHub Dark');
    });

    it('resolves auto from the background at cold start', () => {
      expect(themeManager.resolveThemeSetting('auto', '#ffffff')).toBe(
        'Default Light',
      );
      expect(themeManager.resolveThemeSetting('auto', '#000000')).toBe(
        DEFAULT_THEME.name,
      );
    });

    it('resolves an unset theme identically to auto', () => {
      expect(themeManager.resolveThemeSetting(undefined, '#ffffff')).toBe(
        'Default Light',
      );
      expect(themeManager.resolveThemeSetting(undefined, '#000000')).toBe(
        DEFAULT_THEME.name,
      );
    });

    it('falls back to the dark default when no background was detected', () => {
      expect(themeManager.resolveThemeSetting('auto', undefined)).toBe(
        DEFAULT_THEME.name,
      );
    });

    it('honours a configured theme pair', () => {
      const pair = { dark: 'Dracula', light: 'GitHub Light' };
      expect(themeManager.resolveThemeSetting('auto', '#000000', pair)).toBe(
        'Dracula',
      );
      expect(themeManager.resolveThemeSetting('auto', '#ffffff', pair)).toBe(
        'GitHub Light',
      );
    });

    it('falls back per-key when a paired theme name is unknown', () => {
      const warnSpy = vi.spyOn(runLogger, 'warn').mockImplementation(() => {});
      const pair = { dark: 'No Such Theme', light: 'GitHub Light' };

      expect(themeManager.resolveThemeSetting('auto', '#000000', pair)).toBe(
        DEFAULT_THEME.name,
      );
      // The valid half of the pair still applies.
      expect(themeManager.resolveThemeSetting('auto', '#ffffff', pair)).toBe(
        'GitHub Light',
      );
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });

    it('applies hysteresis when re-resolving against a current theme', () => {
      const dark = DEFAULT_THEME.name;
      const light = 'Default Light';

      // #c0c0c0 is luminance 134.4 — inside the ambiguous band, so hold.
      expect(
        themeManager.resolveThemeSetting('auto', '#c0c0c0', undefined, dark),
      ).toBe(dark);
      expect(
        themeManager.resolveThemeSetting('auto', '#c0c0c0', undefined, light),
      ).toBe(light);

      // Outside the band it commits.
      expect(
        themeManager.resolveThemeSetting('auto', '#ffffff', undefined, dark),
      ).toBe(light);
      expect(
        themeManager.resolveThemeSetting('auto', '#000000', undefined, light),
      ).toBe(dark);
    });

    it('holds the current theme when the background becomes unknown', () => {
      expect(
        themeManager.resolveThemeSetting(
          'auto',
          undefined,
          undefined,
          'Default Light',
        ),
      ).toBe('Default Light');
    });
  });

  describe('getMismatchedBackgroundType', () => {
    const darkTheme = themeManager.getTheme(DEFAULT_THEME.name)!;
    const lightTheme = themeManager.getTheme('Default Light')!;

    it('reports the background type on an unambiguous mismatch', () => {
      expect(
        themeManager.getMismatchedBackgroundType(darkTheme, '#ffffff'),
      ).toBe('light');
      expect(
        themeManager.getMismatchedBackgroundType(lightTheme, '#000000'),
      ).toBe('dark');
    });

    it('reports nothing when the theme already matches', () => {
      expect(
        themeManager.getMismatchedBackgroundType(darkTheme, '#000000'),
      ).toBeUndefined();
      expect(
        themeManager.getMismatchedBackgroundType(lightTheme, '#ffffff'),
      ).toBeUndefined();
    });

    it('stays silent inside the ambiguous band', () => {
      // The bug: the old predicate called #c0c0c0 "light" and warned forever,
      // while auto-switching never acted on it. Warning must imply a fix.
      expect(
        themeManager.getMismatchedBackgroundType(darkTheme, '#c0c0c0'),
      ).toBeUndefined();
      expect(
        themeManager.getMismatchedBackgroundType(lightTheme, '#b8b8b8'),
      ).toBeUndefined();
    });

    it('never flags ansi-typed themes or a missing background', () => {
      // No built-in currently carries type 'ansi' (the "ANSI" theme is typed
      // 'dark', and NoColorTheme only sets 'ansi' on its colors), so the branch
      // is exercised with a stand-in rather than a real theme.
      const ansiTheme = Object.assign(
        Object.create(Object.getPrototypeOf(darkTheme) as object),
        darkTheme,
        { type: 'ansi' },
      ) as Theme;
      expect(
        themeManager.getMismatchedBackgroundType(ansiTheme, '#ffffff'),
      ).toBeUndefined();
      expect(
        themeManager.getMismatchedBackgroundType(darkTheme, undefined),
      ).toBeUndefined();
    });
  });
});

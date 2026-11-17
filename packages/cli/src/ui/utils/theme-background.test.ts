/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { themeManager } from '../themes/theme-manager.js';
import { QwenDark } from '../themes/qwen-dark.js';
import { QwenLight } from '../themes/qwen-light.js';
import { NoColorTheme } from '../themes/no-color.js';
import {
  getDialogSurfaceColor,
  getEffectiveTerminalBackground,
} from './theme-background.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('native terminal background', () => {
  it.each([
    ['dark', '#000000'],
    ['light', '#ffffff'],
  ] as const)(
    'returns a representative color for %s terminals',
    (terminal, expected) => {
      vi.spyOn(themeManager, 'getTerminalBackgroundType').mockReturnValue(
        terminal,
      );
      expect(getEffectiveTerminalBackground()).toBe(expected);
    },
  );

  it('uses the native background even when the active theme differs', () => {
    vi.spyOn(themeManager, 'getTerminalBackgroundType').mockReturnValue('dark');
    vi.spyOn(themeManager, 'getActiveTheme').mockReturnValue(QwenLight);
    expect(getEffectiveTerminalBackground()).toBe('#000000');
  });
});

describe('dialog surfaces on the terminal canvas', () => {
  it.each([
    [QwenDark, 'light'],
    [QwenLight, 'dark'],
  ] as const)(
    'leaves %s transparent on a %s terminal',
    (selected, terminal) => {
      vi.spyOn(themeManager, 'getActiveTheme').mockReturnValue(selected);
      vi.spyOn(themeManager, 'getTerminalBackgroundType').mockReturnValue(
        terminal,
      );
      expect(selected.semanticColors.text.primary).toBe('');
      expect(getDialogSurfaceColor()).toBeUndefined();
    },
  );

  it.each([
    [QwenDark, 'dark'],
    [QwenLight, 'light'],
  ] as const)('paints %s on a matching %s terminal', (selected, terminal) => {
    vi.spyOn(themeManager, 'getActiveTheme').mockReturnValue(selected);
    vi.spyOn(themeManager, 'getTerminalBackgroundType').mockReturnValue(
      terminal,
    );
    expect(getDialogSurfaceColor()).toBe(
      selected.semanticColors.background.surface,
    );
  });

  it('keeps uncolored output transparent', () => {
    vi.spyOn(themeManager, 'getActiveTheme').mockReturnValue(NoColorTheme);
    expect(getDialogSurfaceColor()).toBeUndefined();
  });
});

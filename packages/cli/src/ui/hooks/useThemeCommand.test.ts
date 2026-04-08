/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { useThemeCommand } from './useThemeCommand.js';
import { themeManager } from '../themes/theme-manager.js';

describe('useThemeCommand', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    themeManager.setActiveTheme('Qwen Dark');
  });

  it('restores previous theme on cancel (Esc)', () => {
    const setValue =
      vi.fn<(scope: SettingScope, key: string, value: unknown) => void>();
    const settings = {
      merged: { ui: { theme: 'Qwen Dark' } },
      user: { settings: { ui: {} } },
      workspace: { settings: { ui: {} } },
      setValue,
    } as unknown as LoadedSettings;

    const setThemeError = vi.fn<(error: string | null) => void>();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useThemeCommand(settings, setThemeError, addItem, null),
    );

    act(() => {
      themeManager.setActiveTheme('Dracula');
      result.current.openThemeDialog();
      result.current.handleThemeHighlight('Default');
    });
    expect(themeManager.getActiveTheme().name).toBe('Default');

    act(() => {
      result.current.handleThemeSelect(undefined, SettingScope.User);
    });

    expect(themeManager.getActiveTheme().name).toBe('Dracula');
    expect(setValue).not.toHaveBeenCalled();
    expect(result.current.isThemeDialogOpen).toBe(false);
  });
});

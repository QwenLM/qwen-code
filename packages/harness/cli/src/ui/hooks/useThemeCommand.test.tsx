/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from '../../test-utils/render.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';

const mocks = vi.hoisted(() => ({
  queryTerminalBackground: vi.fn().mockResolvedValue(undefined),
  findThemeByName: vi.fn(),
  resolveThemeSetting: vi.fn((theme: string | undefined) => theme),
  setActiveTheme: vi.fn().mockReturnValue(true),
  loadCustomThemes: vi.fn(),
}));

vi.mock('../contexts/TerminalContext.js', () => ({
  useTerminalContext: () => ({
    queryTerminalBackground: mocks.queryTerminalBackground,
  }),
}));

vi.mock('../themes/theme-manager.js', () => ({
  AUTO_THEME_SETTING: 'auto',
  themeManager: {
    findThemeByName: mocks.findThemeByName,
    resolveThemeSetting: mocks.resolveThemeSetting,
    setActiveTheme: mocks.setActiveTheme,
    loadCustomThemes: mocks.loadCustomThemes,
    getTerminalBackground: () => 'dark',
  },
}));

import { useThemeCommand } from './useThemeCommand.js';

describe('useThemeCommand persistence ordering', () => {
  let result: ReturnType<typeof useThemeCommand>;
  let settings: LoadedSettings;
  const setThemeError = vi.fn();
  const addItem = vi.fn();
  const requestRender = vi.fn();

  function TestComponent() {
    result = useThemeCommand(
      settings,
      setThemeError,
      addItem,
      null,
      requestRender,
    );
    return null;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findThemeByName.mockReturnValue({ name: 'Known' });
    settings = {
      user: { settings: { ui: {} } },
      project: { settings: { ui: {} } },
      merged: { ui: { theme: 'Known' } },
      setValue: vi.fn().mockReturnValue(false),
    } as unknown as LoadedSettings;
  });

  it('keeps the dialog open and does not apply a theme when saving fails', async () => {
    const view = await render(<TestComponent />);
    await act(async () => {
      await result.openThemeDialog();
    });
    expect(result.isThemeDialogOpen).toBe(true);

    await act(async () => {
      await result.handleThemeSelect('Known', SettingScope.User);
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'ui.theme',
      'Known',
    );
    expect(result.isThemeDialogOpen).toBe(true);
    expect(mocks.setActiveTheme).not.toHaveBeenCalled();
    expect(requestRender).not.toHaveBeenCalled();
    view.unmount();
  });
});

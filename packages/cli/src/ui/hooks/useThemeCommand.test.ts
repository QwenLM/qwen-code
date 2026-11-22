/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act } from 'react';
import { renderHook } from '@testing-library/react';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LoadedSettings, SettingScope } from '../../config/settings.js';
import type { Settings, SettingsFile } from '../../config/settings.js';
import { useThemeCommand } from './useThemeCommand.js';
import { themeManager } from '../themes/theme-manager.js';
import { MessageType } from '../types.js';
import type { Config } from '@qwen-code/qwen-code-core';
import process from 'node:process';

describe('useThemeCommand', () => {
  const previousNoColor = process.env['NO_COLOR'];

  beforeEach(() => {
    vi.restoreAllMocks();
    themeManager.setActiveTheme('Qwen Dark');
    delete process.env['NO_COLOR'];
  });

  afterEach(() => {
    if (previousNoColor === undefined) delete process.env['NO_COLOR'];
    else process.env['NO_COLOR'] = previousNoColor;
  });

  it('records the NO_COLOR feedback for transcript reconstruction', () => {
    process.env['NO_COLOR'] = '1';
    const recordSlashCommand = vi.fn();
    const addItem = vi.fn();
    const config = {
      getChatRecordingService: () => ({ recordSlashCommand }),
    } as unknown as Config;
    const settings = {
      merged: {},
      user: { settings: {} },
      workspace: { settings: {} },
    } as unknown as LoadedSettings;

    const { result } = renderHook(() =>
      useThemeCommand(settings, vi.fn(), addItem, null, config),
    );

    act(() => result.current.openThemeDialog());

    const feedbackItem = {
      type: MessageType.INFO,
      text: 'Theme configuration unavailable due to NO_COLOR env variable.',
    };
    expect(addItem).toHaveBeenCalledWith(feedbackItem, expect.any(Number));
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/theme',
      outputHistoryItems: [feedbackItem],
    });
    expect(result.current.isThemeDialogOpen).toBe(false);
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

  it('keeps the dialog open with the error when a selection fails, and clears it on reopen', () => {
    vi.spyOn(themeManager, 'setActiveTheme').mockReturnValue(false);
    const user = { settings: { ui: {} } };
    const settings = {
      merged: { ui: {} },
      system: { settings: {} },
      user,
      workspace: { settings: { ui: {} } },
      forScope: () => user,
      setValue: vi.fn(),
      recomputeMerged: vi.fn(),
    } as unknown as LoadedSettings;
    const setThemeError = vi.fn<(error: string | null) => void>();

    const { result } = renderHook(() =>
      useThemeCommand(settings, setThemeError, vi.fn(), null),
    );

    act(() => result.current.openThemeDialog());
    act(() => result.current.handleThemeSelect('ANSI', SettingScope.User));

    expect(result.current.isThemeDialogOpen).toBe(true);
    expect(setThemeError).toHaveBeenLastCalledWith(
      'Theme "ANSI" could not be applied.',
    );

    act(() => result.current.openThemeDialog());
    expect(setThemeError).toHaveBeenLastCalledWith(null);
  });

  describe('with real settings', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-hook-'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
      themeManager.loadCustomThemes(undefined);
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function file(name: string, settings: Settings = {}): SettingsFile {
      return {
        settings: structuredClone(settings),
        originalSettings: structuredClone(settings),
        path: path.join(tmpDir, name, 'settings.json'),
      };
    }

    function makeSettings(
      user: Settings = {},
      workspace: Settings = {},
      system: Settings = {},
    ) {
      return new LoadedSettings(
        file('system', system),
        file('system-defaults'),
        file('user', user),
        file('workspace', workspace),
        true,
        new Set(),
      );
    }

    function openPicker(settings: LoadedSettings) {
      const setThemeError = vi.fn<(error: string | null) => void>();
      const hook = renderHook(() =>
        useThemeCommand(settings, setThemeError, vi.fn(), null),
      );
      act(() => hook.result.current.openThemeDialog());
      return { result: hook.result, setThemeError };
    }

    it('treats a pick that another scope overrides as a failed selection', () => {
      const settings = makeSettings({}, { ui: { theme: 'Dracula' } });
      const { result, setThemeError } = openPicker(settings);

      act(() =>
        result.current.handleThemeSelect('Qwen Light', SettingScope.User),
      );

      expect(result.current.isThemeDialogOpen).toBe(true);
      expect(setThemeError).toHaveBeenLastCalledWith(
        'Theme "Qwen Light" could not be applied.',
      );
    });

    it('refuses a pick without saving when system settings pin the theme', () => {
      const settings = makeSettings({}, {}, { ui: { theme: 'Qwen Light' } });
      const { result, setThemeError } = openPicker(settings);

      act(() => result.current.handleThemeSelect('Dracula', SettingScope.User));

      expect(settings.user.settings.ui?.theme).toBeUndefined();
      expect(result.current.isThemeDialogOpen).toBe(true);
      expect(setThemeError).toHaveBeenLastCalledWith(
        'The theme is set in system settings, so /theme cannot change it.',
      );
    });

    it('keeps the dialog open for a name that is not in the selected scope', () => {
      const settings = makeSettings();
      const { result, setThemeError } = openPicker(settings);

      act(() =>
        result.current.handleThemeSelect('No Such Theme', SettingScope.User),
      );

      expect(result.current.isThemeDialogOpen).toBe(true);
      expect(setThemeError).toHaveBeenLastCalledWith(
        'Theme "No Such Theme" not found in selected scope.',
      );

      act(() => result.current.handleThemeSelect('ANSI', SettingScope.User));

      expect(result.current.isThemeDialogOpen).toBe(false);
      expect(setThemeError).toHaveBeenLastCalledWith(null);
    });
  });
});

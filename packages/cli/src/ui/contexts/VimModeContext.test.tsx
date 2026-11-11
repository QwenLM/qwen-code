/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createLoadedSettings } from '../../config/settings.js';
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderHookWithProviders } from '../../test-utils/render.js';
import type {
  LoadedSettings} from '../../config/settings.js';
import {
  SettingScope,
  type Settings,
  type SettingsFile,
} from '../../config/settings.js';
import { useVimMode } from './VimModeContext.js';
import type { VimMode } from './VimModeContext.js';

type VimModeHook = {
  vimEnabled: boolean;
  vimMode: VimMode;
  toggleVimEnabled: () => Promise<boolean>;
  setVimMode: (mode: VimMode) => void;
};

function makeSettingsFile(
  path: string,
  settings: Partial<Settings>,
): SettingsFile {
  return {
    path,
    settings: settings as Settings,
    originalSettings: structuredClone(settings) as Settings,
    readOnly: true,
  };
}

function loadedSettingsWith(
  sources: {
    user?: Partial<Settings>;
    project?: Partial<Settings>;
    local?: Partial<Settings>;
    flag?: Partial<Settings>;
  } = {},
): LoadedSettings {
  return createLoadedSettings(
    makeSettingsFile('/user/settings.json', sources.user ?? {}),
    makeSettingsFile('/project/settings.json', sources.project ?? {}),
    makeSettingsFile('/project/settings.local.json', sources.local ?? {}),
    true,
    [],
    makeSettingsFile('/flag/settings.json', sources.flag ?? {}),
  );
}

const renderVimModeHook = (settings: LoadedSettings) =>
  renderHookWithProviders(() => useVimMode(), { settings });

async function toggle(result: { current: VimModeHook }): Promise<boolean> {
  let newValue = false;
  await act(async () => {
    newValue = await result.current.toggleVimEnabled();
  });
  return newValue;
}

describe('VimModeContext', () => {
  it('toggles vim mode for the current session from the default persisted value', async () => {
    const loadedSettings = loadedSettingsWith();
    const { result, unmount } = await renderVimModeHook(loadedSettings);

    expect(result.current.vimEnabled).toBe(false);
    await expect(toggle(result)).resolves.toBe(true);
    expect(result.current.vimEnabled).toBe(true);
    await expect(toggle(result)).resolves.toBe(false);
    expect(result.current.vimEnabled).toBe(false);
    await expect(toggle(result)).resolves.toBe(true);
    expect(result.current.vimEnabled).toBe(true);

    unmount();
  });

  it('can disable and re-enable vim mode when persisted vimMode is true', async () => {
    const loadedSettings = loadedSettingsWith({
      user: { general: { vimMode: true } },
    });
    const { result, unmount } = await renderVimModeHook(loadedSettings);

    expect(result.current.vimEnabled).toBe(true);
    await expect(toggle(result)).resolves.toBe(false);
    expect(result.current.vimEnabled).toBe(false);
    await expect(toggle(result)).resolves.toBe(true);
    expect(result.current.vimEnabled).toBe(true);

    unmount();
  });

  it('clears the session override when persisted vimMode changes', async () => {
    const loadedSettings = loadedSettingsWith();
    const { result, unmount, waitUntilReady } =
      await renderVimModeHook(loadedSettings);

    await expect(toggle(result)).resolves.toBe(true);
    expect(result.current.vimEnabled).toBe(true);

    await act(async () => {
      loadedSettings.setValue(SettingScope.User, 'general.vimMode', false);
    });
    await waitUntilReady();

    expect(result.current.vimEnabled).toBe(false);

    unmount();
  });

  it('clears the session override when a scope change does not change merged vimMode', async () => {
    const loadedSettings = loadedSettingsWith({
      local: { general: { vimMode: false } },
    });
    const { result, unmount, waitUntilReady } =
      await renderVimModeHook(loadedSettings);

    expect(result.current.vimEnabled).toBe(false);
    await expect(toggle(result)).resolves.toBe(true);
    expect(result.current.vimEnabled).toBe(true);

    await act(async () => {
      loadedSettings.setValue(SettingScope.User, 'general.vimMode', true);
    });
    await waitUntilReady();

    expect(loadedSettings.merged.general.vimMode).toBe(false);
    expect(result.current.vimEnabled).toBe(false);

    unmount();
  });

  it('does not resurrect a stale override when the persisted signature returns to a prior value', async () => {
    const loadedSettings = loadedSettingsWith();
    const { result, unmount, waitUntilReady } =
      await renderVimModeHook(loadedSettings);

    await expect(toggle(result)).resolves.toBe(true);
    expect(result.current.vimEnabled).toBe(true);

    await act(async () => {
      loadedSettings.setValue(SettingScope.User, 'general.vimMode', false);
    });
    await waitUntilReady();
    expect(result.current.vimEnabled).toBe(false);

    await act(async () => {
      loadedSettings.setValue(SettingScope.User, 'general.vimMode', undefined);
    });
    await waitUntilReady();

    // Signature literal returns to its initial '|||' but the prior override
    // must NOT come back to life.
    expect(result.current.vimEnabled).toBe(false);

    unmount();
  });

  it('does not write any settings scope when toggled', async () => {
    const loadedSettings = loadedSettingsWith({
      user: { general: { vimMode: false } },
      project: { general: { vimMode: true } },
      local: { general: { vimMode: false } },
      flag: { general: { vimMode: true } },
    });
    const setValueSpy = vi.spyOn(loadedSettings, 'setValue');
    const { result, unmount } = await renderVimModeHook(loadedSettings);

    await toggle(result);
    await toggle(result);

    expect(setValueSpy).not.toHaveBeenCalled();

    unmount();
  });

  it('resets vim mode to INSERT when enabling vim mode', async () => {
    const loadedSettings = loadedSettingsWith({
      user: { general: { vimMode: true } },
    });
    const { result, unmount } = await renderVimModeHook(loadedSettings);

    act(() => {
      result.current.setVimMode('NORMAL');
    });
    expect(result.current.vimMode).toBe('NORMAL');

    await expect(toggle(result)).resolves.toBe(false);
    expect(result.current.vimMode).toBe('NORMAL');

    await expect(toggle(result)).resolves.toBe(true);
    expect(result.current.vimMode).toBe('INSERT');

    unmount();
  });
});

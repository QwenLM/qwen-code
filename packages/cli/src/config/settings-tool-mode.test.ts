/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  getDisplayValue,
  getEffectiveValue,
  saveModifiedSettings,
} from './settingsUtils.js';
import { LoadedSettings, SettingScope, type Settings } from './settings.js';

const file = (settings: Settings) => ({
  settings,
  originalSettings: settings,
  path: 'fixture',
});

describe('legacy tool mode settings', () => {
  const legacy = { tools: { codeModeOnly: true } } as unknown as Settings;
  it('displays the effective legacy mode and honors an explicit mode', () => {
    expect(getEffectiveValue('tools.mode', legacy, legacy)).toBe(
      'code_mode_only',
    );
    expect(getDisplayValue('tools.mode', legacy, legacy, new Set())).toBe(
      'Code Mode Only*',
    );
    expect(
      getEffectiveValue('tools.mode', legacy, { tools: { mode: 'direct' } }),
    ).toBe('direct');
    expect(
      getEffectiveValue('tools.mode', { tools: { mode: 'code_mode' } }, legacy),
    ).toBe('code_mode');
  });
  it('persists Direct so restart cannot reactivate the legacy mode', () => {
    const settings = structuredClone(legacy);
    const setValue = vi.fn(
      (_scope: SettingScope, _key: string, value: 'direct') => {
        settings.tools = { ...settings.tools, mode: value };
      },
    );
    const loaded = {
      forScope: () => ({ settings }),
      setValue,
    } as unknown as LoadedSettings;
    saveModifiedSettings(
      new Set(['tools.mode']),
      { tools: { mode: 'direct' } },
      loaded,
      SettingScope.User,
    );
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'tools.mode',
      'direct',
    );
    expect(getEffectiveValue('tools.mode', settings, settings)).toBe('direct');
  });

  it('resolves an operator legacy mode over a lower-precedence tools.mode', () => {
    const loaded = new LoadedSettings(
      file({ tools: { codeModeOnly: true } } as unknown as Settings),
      file({}),
      file({ tools: { mode: 'direct' } }),
      file({}),
      true,
      new Set(),
    );

    expect(
      (loaded.merged.tools as { codeModeOnly?: unknown })?.codeModeOnly,
    ).toBe(true);
    expect(loaded.merged.tools?.mode).toBeUndefined();
    expect(getEffectiveValue('tools.mode', {}, loaded.merged)).toBe(
      'code_mode_only',
    );
  });

  it('keeps an explicit mode over the legacy key in the same scope', () => {
    const loaded = new LoadedSettings(
      file({}),
      file({}),
      file({
        tools: { codeModeOnly: true, mode: 'direct' },
      } as unknown as Settings),
      file({}),
      true,
      new Set(),
    );

    expect(loaded.merged.tools?.mode).toBe('direct');
    expect(getEffectiveValue('tools.mode', {}, loaded.merged)).toBe('direct');
  });

  it('keeps a higher-precedence tools.mode over a lower legacy mode', () => {
    const loaded = new LoadedSettings(
      file({ tools: { mode: 'direct' } }),
      file({ tools: { codeModeOnly: true } } as unknown as Settings),
      file({}),
      file({}),
      true,
      new Set(),
    );

    expect(loaded.merged.tools?.mode).toBe('direct');
    expect(getEffectiveValue('tools.mode', {}, loaded.merged)).toBe('direct');
  });
});

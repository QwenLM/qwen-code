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
import {
  SettingScope,
  type LoadedSettings,
  type Settings,
} from './settings.js';

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
});

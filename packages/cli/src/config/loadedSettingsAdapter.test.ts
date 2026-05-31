/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createLoadedSettingsAdapter } from './loadedSettingsAdapter.js';
import { SettingScope } from './settings.js';

// settingsUtils makes real fs calls in backup/restore — stub them out so the
// tests can focus on adapter behavior without touching disk.
vi.mock('../utils/settingsUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/settingsUtils.js')>();
  return {
    ...actual,
    backupSettingsFile: vi.fn(),
    restoreSettingsFromBackup: vi.fn(),
    cleanupSettingsBackup: vi.fn(),
  };
});

// Named shape so dot-access on the known keys (`env`, `modelProviders`) is not
// treated as access through an index signature — keeps the strict TS option
// `noPropertyAccessFromIndexSignature` happy while still allowing arbitrary
// extra keys via the index signature.
interface SettingsShape {
  env?: Record<string, unknown>;
  modelProviders?: Record<string, unknown>;
  [key: string]: unknown;
}

interface MutableSettingsFile {
  settings: SettingsShape;
  originalSettings: SettingsShape;
  path: string;
}

function makeSettings(initial: SettingsShape = {}) {
  const file: MutableSettingsFile = {
    settings: structuredClone(initial),
    originalSettings: structuredClone(initial),
    path: '/tmp/qwen-test-settings.json',
  };
  const setValue = vi.fn(
    (_scope: SettingScope, key: string, value: unknown) => {
      const parts = key.split('.');
      let current: Record<string, unknown> = file.settings as Record<
        string,
        unknown
      >;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        // Mirror setNestedPropertySafe's reserved-segment rejection. Inline
        // literal === comparisons (rather than e.g. Set.has) are what
        // CodeQL's prototype-pollution sanitiser recognises, so we use them
        // at the only step that actually writes to `current`.
        if (
          part === '__proto__' ||
          part === 'constructor' ||
          part === 'prototype'
        ) {
          throw new Error(`mock setValue refused reserved segment in: ${key}`);
        }
        if (i === parts.length - 1) {
          current[part] = value;
        } else {
          if (!current[part] || typeof current[part] !== 'object') {
            current[part] = {};
          }
          current = current[part] as Record<string, unknown>;
        }
      }
      file.originalSettings = structuredClone(file.settings);
    },
  );
  const recomputeMerged = vi.fn(() => {
    /* merged() is computed lazily via the getter below */
  });
  const settings = {
    get merged() {
      return file.settings;
    },
    forScope: vi.fn(() => file),
    setValue,
    recomputeMerged,
  };
  return { settings, file, setValue, recomputeMerged };
}

describe('createLoadedSettingsAdapter', () => {
  it('forwards setValue to LoadedSettings.setValue with the resolved scope', () => {
    const { settings, setValue } = makeSettings();
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );
    adapter.setValue('env.MY_KEY', 'val');
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'env.MY_KEY',
      'val',
    );
  });

  it('rejects prototype-pollution keys before reaching LoadedSettings', () => {
    const { settings, setValue } = makeSettings();
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );
    expect(() => adapter.setValue('__proto__.polluted', 'x')).toThrow(
      /reserved segment/,
    );
    expect(() => adapter.setValue('foo.constructor.bar', 'x')).toThrow(
      /reserved segment/,
    );
    expect(() => adapter.setValue('prototype.x', 'x')).toThrow(
      /reserved segment/,
    );
    // The guard short-circuits before delegating to LoadedSettings — that's the
    // contract this test exists to lock in.
    expect(setValue).not.toHaveBeenCalled();
  });

  it('getValue reads from settings.merged via dotted key', () => {
    const { settings } = makeSettings({
      env: { MY_KEY: 'from-merged' },
      modelProviders: { openai: [{ id: 'gpt' }] },
    });
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );
    expect(adapter.getValue('env.MY_KEY')).toBe('from-merged');
    expect(adapter.getValue('modelProviders.openai')).toEqual([{ id: 'gpt' }]);
    expect(adapter.getValue('missing.path')).toBeUndefined();
  });

  it('backup() snapshots in-memory state; restore() reverts and recomputes merged', () => {
    const { settings, file, recomputeMerged } = makeSettings({
      env: { ORIGINAL: '1' },
    });
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );

    // backup/restore/cleanupBackup are optional in the contract, but
    // createLoadedSettingsAdapter always installs them — assert + use !.
    expect(adapter.backup).toBeTypeOf('function');
    adapter.backup!();

    // Simulate mutations that would happen during an install plan apply.
    adapter.setValue('env.NEW_KEY', 'new-value');
    expect(file.settings.env).toEqual({
      ORIGINAL: '1',
      NEW_KEY: 'new-value',
    });

    expect(adapter.restore).toBeTypeOf('function');
    adapter.restore!();

    expect(file.settings).toEqual({ env: { ORIGINAL: '1' } });
    expect(file.originalSettings).toEqual({ env: { ORIGINAL: '1' } });
    expect(recomputeMerged).toHaveBeenCalled();
  });

  it('cleanupBackup() clears the in-memory snapshot so a later restore is a no-op', () => {
    const { settings, file } = makeSettings({ env: { K: 'v1' } });
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );
    expect(adapter.backup).toBeTypeOf('function');
    adapter.backup!();
    adapter.setValue('env.K', 'v2');
    expect(adapter.cleanupBackup).toBeTypeOf('function');
    adapter.cleanupBackup!();
    // restore after cleanup should not bring v1 back
    expect(adapter.restore).toBeTypeOf('function');
    adapter.restore!();
    expect(file.settings.env).toEqual({ K: 'v2' });
  });
});

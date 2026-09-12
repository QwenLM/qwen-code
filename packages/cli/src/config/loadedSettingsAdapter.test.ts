/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLoadedSettingsAdapter } from './loadedSettingsAdapter.js';
import { SettingScope, loadSettings } from './settings.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuthType,
  applyProviderInstallPlan,
  buildInstallPlan,
  customProvider,
  generateCustomEnvKey,
} from '@qwen-code/qwen-code-core';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-adapter-'));
  temporaryRoots.push(root);
  const file: MutableSettingsFile = {
    settings: structuredClone(initial),
    originalSettings: structuredClone(initial),
    path: path.join(root, 'settings.json'),
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
  it.each([true, false])(
    'restores actual file contents or absence after a shadowed install (existing: %s)',
    async (existingFile) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-rollback-'));
      const workspace = path.join(root, 'workspace');
      const userHome = path.join(root, 'home');
      fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
      fs.mkdirSync(userHome);
      vi.stubEnv('QWEN_HOME', userHome);
      const userFile = path.join(userHome, 'settings.json');
      const workspaceFile = path.join(workspace, '.qwen', 'settings.json');
      const originalUser =
        '{"$version":4,"modelProviders":{"openai":[{"id":"old-user"}]}}\n';
      const originalWorkspace = JSON.stringify({
        $version: 4,
        modelProviders: { openai: [{ id: 'workspace-chat' }] },
      });
      if (existingFile) fs.writeFileSync(userFile, originalUser);
      fs.writeFileSync(workspaceFile, originalWorkspace);
      try {
        const loaded = loadSettings(workspace, {
          skipLoadEnvironment: true,
          workspaceTrusted: true,
        });
        const before = structuredClone(loaded.merged);
        const plan = buildInstallPlan(
          customProvider,
          {
            baseUrl: 'https://rollback.example/v1',
            apiKey: 'test-only',
            modelIds: ['new-model'],
          },
          loaded.merged.modelProviders?.['openai'],
        );
        const envKey = Object.keys(plan.env!)[0]!;
        const originalEnv = process.env[envKey];
        await expect(
          applyProviderInstallPlan(plan, {
            settings: createLoadedSettingsAdapter(loaded, SettingScope.User),
            doRefreshAuth: false,
          }),
        ).rejects.toThrow('higher-precedence');
        expect(fs.existsSync(userFile)).toBe(existingFile);
        if (existingFile)
          expect(fs.readFileSync(userFile, 'utf8')).toBe(originalUser);
        expect(fs.readFileSync(workspaceFile, 'utf8')).toBe(originalWorkspace);
        expect(loaded.merged).toEqual(before);
        expect(process.env[envKey]).toBe(originalEnv);
        expect(fs.existsSync(userFile + '.orig')).toBe(false);
        await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(loaded, SettingScope.Workspace),
          doRefreshAuth: false,
        });
        expect(loaded.merged.model?.name).toBe('new-model');
        expect(loaded.merged.modelProviders?.['openai']?.[0]?.id).toBe(
          'new-model',
        );
        expect(fs.existsSync(workspaceFile + '.orig')).toBe(false);
        if (originalEnv === undefined) delete process.env[envKey];
        else process.env[envKey] = originalEnv;
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([SettingScope.User, SettingScope.Workspace])(
    'preserves placeholders on disk and resolved runtime values during service reconnect (%s)',
    async (scope) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-raw-'));
      const workspace = path.join(root, 'workspace');
      const userHome = path.join(root, 'home');
      fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
      fs.mkdirSync(userHome);
      vi.stubEnv('QWEN_HOME', userHome);
      vi.stubEnv('RECONNECT_TEST_TOKEN', 'resolved-private-token');
      vi.stubEnv('RECONNECT_TEST_ID', 'image-model');
      vi.stubEnv('RECONNECT_TEST_URL', 'https://media.example/v1');
      const envKey = `${generateCustomEnvKey(AuthType.USE_OPENAI, 'https://media.example/v1')}_IMAGE`;
      vi.stubEnv(envKey, 'old-service-key');
      const filename = path.join(
        scope === SettingScope.User ? userHome : path.join(workspace, '.qwen'),
        'settings.json',
      );
      const raw = {
        id: '${RECONNECT_TEST_ID}',
        baseUrl: '${RECONNECT_TEST_URL}',
        envKey,
        imageOnly: true,
        generationConfig: {
          contextWindowSize: 65536,
          customHeaders: {
            Authorization: '${RECONNECT_TEST_TOKEN}',
            'X-Rotated': 'Bearer ${' + envKey + '}',
          },
        },
      };
      fs.writeFileSync(
        filename,
        JSON.stringify({ $version: 4, modelProviders: { openai: [raw] } }),
      );
      try {
        const loaded = loadSettings(workspace, {
          skipLoadEnvironment: true,
          workspaceTrusted: true,
        });
        const plan = buildInstallPlan(
          customProvider,
          {
            baseUrl: 'https://media.example/v1',
            apiKey: 'new-service-key',
            modelIds: ['image-model'],
          },
          loaded.merged.modelProviders?.['openai'],
        );
        const result = await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(loaded, scope),
        });
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        expect(saved.modelProviders.openai[0]).toMatchObject(raw);
        expect(JSON.stringify(saved)).not.toContain('resolved-private-token');
        expect(saved.env[envKey]).toBe('new-service-key');
        expect(loaded.merged.modelProviders?.['openai']?.[0]).toMatchObject({
          id: 'image-model',
          baseUrl: 'https://media.example/v1',
          generationConfig: {
            customHeaders: {
              Authorization: 'resolved-private-token',
              'X-Rotated': 'Bearer new-service-key',
            },
          },
        });
        expect(result.updatedModelProviders['openai']).toEqual(
          loaded.merged.modelProviders?.['openai'],
        );
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

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

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { loadSettings } from '../../../test-utils/resolveSettings.js';
import { createLoadedSettings } from '../../../config/settings.js';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it, vi } from 'vitest';
import {
  SettingsService,
  type SettingsSchemaDefaults,
} from '@qwen-code/resource';
import { createCliSettingsService } from '../../../config/createCliSettingsService.js';
import { SETTINGS_DEFAULTS } from '../../../config/settingsSchema.js';
import { getSettingsZodSchema } from '../../../config/settings-validation.js';
import { Storage } from '@qwen-code/core';
import { runLogger, type ModelConfig } from '@qwen-code/core';
import { testListedModel } from '../../../../../core/src/test-utils/listed-model.js';
import type { LoadedSettings } from '../../../config/settings.js';
import {
  clearSettingsCache,
  getFlagSettingsInput,
  type Settings,
  type SettingsFile,
} from '../../../config/settings.js';
import type { ThreadCallContext } from '../contract/hostContext.js';
import type { ThreadSessionInternals } from '../contract/handlerContract.js';
import { applyFlagSettings, getSettings } from './configurationHandlers.js';
const publicService = new SettingsService();
publicService.configureDefaults(
  { defaults: SETTINGS_DEFAULTS, createValidation: getSettingsZodSchema },
  {},
);
afterAll(() => publicService.dispose());

it('uses the current session product schema for dynamic flag updates', async () => {
  class ProductService extends SettingsService {
    override getSchema(defaults: SettingsSchemaDefaults) {
      return {
        ...super.getSchema(defaults),
        video: {
          type: 'object' as const,
          label: 'Video',
          category: 'Advanced',
          requiresRestart: false,
          default: {},
          showInDialog: false,
          properties: {
            delivery: {
              type: 'enum' as const,
              label: 'Delivery',
              category: 'Advanced',
              requiresRestart: false,
              default: undefined,
              showInDialog: false,
              options: [
                { label: 'URL', value: 'url' },
                { label: 'Download', value: 'download' },
              ],
            },
          },
        },
      };
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'session-product-rules-'));
  const storage = vi.spyOn(Storage, 'getGlobalConfigDir').mockReturnValue(root);
  const service = createCliSettingsService({
    service: new ProductService(),
    environmentPolicy: 'session',
  });
  const loaded = service.resolve({ projectPath: root, sources: [] });
  const config = {
    getModel: () => 'model',
    getModelRequestIdentity: () => 'account',
    getWorkingDir: () => root,
    getSettingsService: () => publicService,
    getModelProviderManager: () => ({
      getModel: async () => undefined,
      getModelConfig: () => undefined,
    }),
    reloadHooks: async () => undefined,
    reloadSkills: async () => undefined,
    isUltracodeActive: () => false,
  };
  const session = {
    signal: new AbortController().signal,
    isTerminated: () => false,
    requireConfig: () => config,
    getCurrentSettings: () => loaded,
  } as unknown as ThreadSessionInternals;
  try {
    await applyFlagSettings(session, {} as ThreadCallContext, {
      video: { delivery: 'invalid' },
    });
    expect(Reflect.get(loaded.merged, 'video')).toEqual({});
    expect(
      loaded.errors.some((error) => error.message.includes('video.delivery')),
    ).toBe(true);
    await applyFlagSettings(session, {} as ThreadCallContext, {
      video: { delivery: 'url' },
    });
    expect(Reflect.get(loaded.merged, 'video')).toEqual({ delivery: 'url' });
  } finally {
    await service.dispose();
    storage.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

it.each(['model', 'account', 'terminated', 'aborted', 'config'])(
  '设置查询丢弃 %s 变化后的迟到结果',
  async (change) => {
    let finish!: (value: undefined) => void;
    let model = 'model';
    let identity = 'account';
    let terminated = false;
    const controller = new AbortController();
    const config = {
      getModel: () => model,
      getModelRequestIdentity: () => identity,
      getModelProviderManager: () => ({
        getModel: () =>
          new Promise<undefined>((resolve) => {
            finish = resolve;
          }),
      }),
    };
    let currentConfig = config;
    const getCurrentSettings = vi.fn();
    const session = {
      signal: controller.signal,
      isTerminated: () => terminated,
      requireConfig: () => currentConfig,
      getCurrentSettings,
    } as unknown as ThreadSessionInternals;
    const pending = getSettings(session, {} as ThreadCallContext);
    const rejected = (async () => {
      await expect(pending).rejects.toThrow('会话目标已变化');
    })();
    if (change === 'model') model = 'next';
    if (change === 'account') identity = 'next';
    if (change === 'terminated') terminated = true;
    if (change === 'aborted') controller.abort();
    if (change === 'config') currentConfig = { ...config };
    finish(undefined);
    await rejected;
    expect(getCurrentSettings).not.toHaveBeenCalled();
  },
);

it('设置更新不让较早的模型查询覆盖较新 UltraCode 请求', async () => {
  let finish!: (value: undefined) => void;
  const getModel = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(undefined);
  const setUltracode = vi.fn();
  const setModelConfig = vi.fn(() => true);
  const config = {
    getModel: () => 'model',
    getModelRequestIdentity: () => 'account',
    getModelProviderManager: () => ({
      getModel,
      getModelConfig: () => undefined,
      setModelConfig,
    }),
    isUltracodeActive: () => false,
    setUltracode,
  };
  const session = {
    signal: new AbortController().signal,
    isTerminated: () => false,
    requireConfig: () => config,
    peekQueryRunner: () => undefined,
  } as unknown as ThreadSessionInternals;
  const older = applyFlagSettings(session, {} as ThreadCallContext, {
    ultracode: true,
  });
  const rejected = (async () => {
    await expect(older).rejects.toThrow('会话目标已变化');
  })();
  await applyFlagSettings(session, {} as ThreadCallContext, {
    ultracode: false,
  });
  finish(undefined);
  await rejected;
  expect(setUltracode).toHaveBeenCalledExactlyOnceWith(false);
  expect(setModelConfig).not.toHaveBeenCalled();
});

it('preserves the settings response keys while reading the internal project snapshot', async () => {
  const file = (settings: Settings): SettingsFile => ({
    path: '',
    settings,
    originalSettings: settings,
  });
  const settings = createLoadedSettings(
    file({ ui: { theme: 'dark' } }),
    file({ ui: { language: 'en' } }),
    file({}),
    true,
  );
  const config = {
    getModel: () => 'model',
    getModelRequestIdentity: () => 'account',
    getModelProviderManager: () => ({
          getModel: async () => undefined,
          getModelConfig: () => undefined,
        }),
    getUltracode: () => false,
    isUltracodeActive: () => false,
  };
  const session = {
    signal: new AbortController().signal,
    isTerminated: () => false,
    requireConfig: () => config,
    getCurrentSettings: () => settings,
  } as unknown as ThreadSessionInternals;

  const result = await getSettings(session, {} as ThreadCallContext);
  expect(result['sources']).toEqual({
    user: { ui: { theme: 'dark' } },
    workspace: { ui: { language: 'en' } },
    local: {},
    flag: {},
  });
  expect(result['sources']).not.toHaveProperty('project');
  expect(result['effective']).toMatchObject({
    ui: { theme: 'dark', language: 'en' },
  });
});

it('updates flag settings on the existing manager and reloads dependent resources', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'session-flag-settings-'));
  const file = (settings: Settings): SettingsFile => ({
    path: '',
    settings,
    originalSettings: settings,
  });
  const currentSettings = createLoadedSettings(
    file({}),
    file({}),
    file({}),
    true,
    [
      {
        path: join(workspace, 'user-settings.json'),
        message: 'existing user warning',
        severity: 'warning',
      },
    ],
  );
  const setCurrentSettings = vi.fn();
  const reloadHooks = vi.fn(async () => undefined);
  const reloadSkills = vi.fn(async () => undefined);
  const config = {
    getModel: () => 'model',
    getModelRequestIdentity: () => 'account',
    getModelProviderManager: () => ({
      getModel: async () => undefined,
      getModelConfig: () => undefined,
    }),
    getWorkingDir: () => workspace,
    getSettingsService: () => publicService,
    reloadHooks,
    reloadSkills,
    isUltracodeActive: () => false,
  };
  const session = {
    signal: new AbortController().signal,
    isTerminated: () => false,
    requireConfig: () => config,
    getCurrentSettings: () => currentSettings,
    setCurrentSettings,
  } as unknown as ThreadSessionInternals;

  vi.stubEnv('TMPDIR', workspace);
  vi.stubEnv('TEMP', workspace);
  vi.stubEnv('TMP', workspace);
  try {
    await applyFlagSettings(session, {} as ThreadCallContext, {
      context: { fileName: 'flag.md' },
      mcpServers: {
        invalid: { args: 123, type: 'stdio', command: 'foo' },
      },
    });

    expect(session.getCurrentSettings()).toBe(currentSettings);
    expect(setCurrentSettings).not.toHaveBeenCalled();
    // The flag layer lives on this session's manager; the process-level slot is untouched.
    expect(getFlagSettingsInput()).toBeUndefined();
    expect(currentSettings.flag.path).toBe('<flag>');
    expect(currentSettings.merged.context.fileName).toBe('flag.md');
    expect(currentSettings.merged.mcpServers).toEqual({});
    expect(currentSettings.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ message: 'existing user warning' }),
        expect.objectContaining({
          message: expect.stringContaining(
            'Skipped invalid MCP server "invalid"',
          ),
        }),
      ]),
    );

    await applyFlagSettings(session, {} as ThreadCallContext, {
      context: { fileName: 'next-flag.md' },
    });

    expect(currentSettings.flag.path).toBe('<flag>');
    expect(currentSettings.merged.context.fileName).toBe('next-flag.md');
    expect(currentSettings.errors).toEqual([
      expect.objectContaining({ message: 'existing user warning' }),
    ]);
    expect(reloadHooks).toHaveBeenCalledTimes(2);
    expect(reloadHooks).toHaveBeenCalledWith('settings-event');
    expect(reloadSkills).toHaveBeenCalledTimes(2);
    expect(readdirSync(workspace)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('keeps flag settings isolated between sessions in one process', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'session-flag-settings-'));
  const file = (settings: Settings): SettingsFile => ({
    path: '',
    settings,
    originalSettings: settings,
  });
  const makeSession = (settings: LoadedSettings) => {
    const config = {
      getModel: () => 'model',
      getModelRequestIdentity: () => 'account',
      getModelProviderManager: () => ({
        getModel: async () => undefined,
        getModelConfig: () => undefined,
      }),
      getWorkingDir: () => workspace,
      getSettingsService: () => publicService,
      reloadHooks: async () => undefined,
      reloadSkills: async () => undefined,
      isUltracodeActive: () => false,
    };
    return {
      signal: new AbortController().signal,
      isTerminated: () => false,
      requireConfig: () => config,
      getCurrentSettings: () => settings,
    } as unknown as ThreadSessionInternals;
  };
  const settingsA = createLoadedSettings(file({}), file({}), file({}), true);
  const settingsB = createLoadedSettings(file({}), file({}), file({}), true);
  const sessionA = makeSession(settingsA);

  try {
    await applyFlagSettings(sessionA, {} as ThreadCallContext, {
      context: { fileName: 'only-a.md' },
    });

    expect(settingsA.merged.context.fileName).toBe('only-a.md');
    expect(settingsB.merged.context.fileName).not.toBe('only-a.md');
    expect(settingsB.flag.path).toBe('');
    // A fresh process-wide load must not inherit A's flag layer either.
    expect(getFlagSettingsInput()).toBeUndefined();
    expect(loadSettings(workspace).flag.settings).toEqual({});
  } finally {
    clearSettingsCache();
    rmSync(workspace, { recursive: true, force: true });
  }
});

it('keeps applied flag settings and continues with ultracode when reloads fail', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'session-flag-settings-'));
  const file = (settings: Settings): SettingsFile => ({
    path: '',
    settings,
    originalSettings: settings,
  });
  const currentSettings = createLoadedSettings(
    file({}),
    file({}),
    file({}),
    true,
  );
  let ultracodeActive = false;
  let preference: ModelConfig | undefined;
  const listed = testListedModel('model', {
    is_reasoning: true,
    efforts: ['xhigh'],
  });
  const setUltracode = vi.fn((active: boolean) => {
    ultracodeActive = active;
  });
  const setModelConfig = vi.fn((_model: unknown, patch: ModelConfig) => {
    preference = patch;
    return true;
  });
  const reloadHooks = vi.fn(async () => {
    throw new Error('hook reload failed');
  });
  const reloadSkills = vi.fn(async () => {
    throw new Error('skill reload failed');
  });
  const logError = vi.spyOn(runLogger, 'error').mockImplementation(() => {});
  const config = {
    getModel: () => 'model',
    getModelRequestIdentity: () => 'account',
    getWorkingDir: () => workspace,
    getSettingsService: () => publicService,
    reloadHooks,
    reloadSkills,
    getModelProviderManager: () => ({
      getModel: async () => listed,
      getModelConfig: () => preference,
      setModelConfig,
    }),
    setUltracode,
    clearUltracodeOverride: vi.fn(),
    getUltracode: () => false,
    isUltracodeActive: () => ultracodeActive,
  };
  const refreshRuntimeContext = vi.fn();
  const session = {
    signal: new AbortController().signal,
    isTerminated: () => false,
    requireConfig: () => config,
    getCurrentSettings: () => currentSettings,
    peekQueryRunner: () => ({ refreshRuntimeContext }),
  } as unknown as ThreadSessionInternals;

  try {
    await expect(
      applyFlagSettings(session, {} as ThreadCallContext, {
        context: { fileName: 'flag.md' },
        ultracode: true,
      }),
    ).resolves.toEqual({
      applied: { effort: 'xhigh', ultracode: true },
    });

    expect(currentSettings.merged.context.fileName).toBe('flag.md');
    expect(reloadHooks).toHaveBeenCalledWith('settings-event');
    expect(reloadSkills).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledTimes(2);
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('hook reload failed'),
    );
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('skill reload failed'),
    );
    expect(setModelConfig).toHaveBeenCalledExactlyOnceWith(listed, {
      reasoning: { effort: 'xhigh' },
    });
    expect(setUltracode).toHaveBeenCalledWith(true);
    expect(refreshRuntimeContext).toHaveBeenCalledWith({
      resetModelRouting: true,
    });
  } finally {
    logError.mockRestore();
    rmSync(workspace, { recursive: true, force: true });
  }
});

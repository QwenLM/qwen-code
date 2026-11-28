/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config } from './config.js';
import { BRAND_ENV_PREFIX } from './brand.js';
import { createEmptyLoadedSettings } from '../test-utils/config.js';
import {
  mockListedModels,
  testListedModel,
} from '../test-utils/listed-model.js';

describe('explicit Custom Provider startup with a saved platform model', () => {
  const configs: Config[] = [];
  const customKeys = ['alibaba/qwen3.8-max', 'gateway/qwen3.8-flash'];

  beforeEach(() => {
    vi.stubEnv(`${BRAND_ENV_PREFIX}MODEL`, undefined);
    mockListedModels([
      testListedModel('auto', { is_default: true }),
      testListedModel('gmodel'),
      testListedModel('qmodel_38max'),
      ...customKeys.map((key) =>
        testListedModel(key, { source: 'custom', provider: key.split('/')[0] }),
      ),
    ]);
  });

  afterEach(async () => {
    for (const config of configs.splice(0)) await config.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function startup(model: string, savedModel = 'gmodel') {
    const loadedSettings = createEmptyLoadedSettings();
    loadedSettings.merged.model = {
      ...loadedSettings.merged.model,
      name: savedModel,
    };
    const config = new Config({
      loadedSettings,
      sessionId: 'explicit-custom-model-startup',
      targetDir: '.',
      cwd: '.',
      debugMode: false,
      model,
      modelSource: 'cli',
      customProviderSettings: {
        alibaba: {
          baseUrl: 'https://alibaba.example/v1',
          apiKey: 'test-secret',
        },
        gateway: {
          baseUrl: 'https://gateway.example/v1',
          apiKey: 'test-secret',
          models: [{ model: 'qwen3.8-flash' }],
        },
      },
    });
    configs.push(config);
    vi.spyOn(config.getSettingsService(), 'resolve').mockReturnValue(
      loadedSettings,
    );
    await config.getModelProviderManager().start();
    await config.initializeCustomProviders();
    expect(config.getModel()).toBe(savedModel);
    return config;
  }

  it.each(customKeys)(
    'selects %s without changing saved settings',
    async (model) => {
      const config = await startup(model);
      await config.reconcileModelWithListedModels({ modelsWereAwaited: true });
      expect(config.getModel()).toBe(model);
      expect(
        config.getSettingsService().resolve({ projectPath: '.' }).merged.model
          ?.name,
      ).toBe('gmodel');
    },
  );

  it('keeps a Qoder-owned BYOK model outside the local configuration gate', async () => {
    const key = customKeys[1];
    mockListedModels([
      testListedModel('gmodel', { is_default: true }),
      testListedModel(key, {
        source: 'user',
        provider: 'gateway',
        model: 'qwen3.8-flash',
      }),
    ]);
    const config = await startup(key);
    await config.reconcileModelWithListedModels({ modelsWereAwaited: true });
    expect(config.getModel()).toBe(key);
    expect(
      config.isConfiguredCustomProviderModelKey(
        key,
        await config.getModelProviderManager().getModel(key),
      ),
    ).toBe(false);
  });

  it.each(
    ['startup', 'switch'].flatMap((operation) =>
      ['model', 'session'].map((target) => ({ operation, target })),
    ),
  )(
    'does not apply a stale $operation after the $target changed during access validation',
    async ({ operation, target }) => {
      const config = await startup(customKeys[1]);
      let finish!: () => void;
      const wait = vi
        .spyOn(config, 'waitForCustomProviderAccess')
        .mockImplementationOnce(
          () =>
            new Promise<void>((resolve) => {
              finish = resolve;
            }),
        );
      const selectModel = vi.spyOn(
        config.getModelProviderManager(),
        'setMainModel',
      );
      const pending =
        operation === 'startup'
          ? config.reconcileModelWithListedModels({ modelsWereAwaited: true })
          : config.setModel(customKeys[1], false);
      await vi.waitFor(() => expect(wait).toHaveBeenCalled());
      if (target === 'model') await config.setModel('gmodel', true);
      else config.setSessionId('replacement-session');
      selectModel.mockClear();
      finish();
      await pending;
      expect(config.getModel()).toBe('gmodel');
      expect(selectModel).not.toHaveBeenCalled();
    },
  );
});

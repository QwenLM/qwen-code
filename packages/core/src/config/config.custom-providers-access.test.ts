/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createEmptyLoadedSettings } from '../test-utils/config.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Config, type ConfigParameters } from './config.js';
import { synchronizeSessionModelProvider } from '../provider/session-model.js';
import {
  mockListedModels,
  testListedModel,
} from '../test-utils/listed-model.js';

describe('Custom Providers runtime access', () => {
  let identity: string;
  const configs: Config[] = [];
  const params: ConfigParameters = {
    loadedSettings: createEmptyLoadedSettings(),
    sessionId: 'custom-provider-gate',
    targetDir: '.',
    debugMode: false,
    model: 'gateway/test-model',
    cwd: '.',
    customProviderSettings: {
      gateway: {
        baseUrl: 'https://gateway.example/v1',
        apiKey: 'secret',
        model: 'test-model',
      },
    },
  };

  function makeConfig(extra: Partial<ConfigParameters> = {}): Config {
    const config = new Config({ ...params, ...extra });
    vi.spyOn(config, 'getModelRequestIdentity').mockImplementation(
      () => identity,
    );
    configs.push(config);
    return config;
  }

  beforeEach(() => {
    identity = 'first-owner';
  });
  afterEach(async () => {
    for (const config of configs.splice(0)) await config.dispose();
    vi.restoreAllMocks();
  });

  it.each(['local', 'sdk'] as const)(
    'allows %s custom provider configuration',
    async (mode) => {
      const config = makeConfig({ customProviderAccessMode: mode });
      await config.initializeCustomProviders();
      expect(config.canUseCustomProviders()).toBe(true);
      expect(config.getCustomProvidersState().status).toBe('active');
    },
  );

  it('uses the declared window for a local model without context tiers', async () => {
    const config = makeConfig({
      customProviderSettings: {
        gateway: {
          baseUrl: 'https://gateway.example/v1',
          apiKey: '',
          models: [
            {
              model: 'test-model',
              capabilities: {
                thinking: { modes: ['adaptive'], supportedEffortLevels: [] },
              },
            },
          ],
        },
      },
    });
    await config.initializeCustomProviders();
    const model = testListedModel('gateway/test-model', {
      source: 'custom',
      provider: 'gateway',
      max_input_tokens: 128000,
    });
    vi.spyOn(
      config.getModelProviderManager(),
      'getModelConfig',
    ).mockReturnValue(undefined);
    expect(config.getEffectiveContextWindow(model)).toBe(128000);
  });

  it('does not remove another session projection or credentials when disposed', async () => {
    const first = makeConfig();
    const second = makeConfig({
      sessionId: 'second-session',
      customProviderSettings: {
        gateway: {
          baseUrl: 'https://second.example/v1',
          apiKey: 'second-secret',
          model: 'test-model',
        },
      },
    });
    await first.initializeCustomProviders();
    await second.initializeCustomProviders();
    const descriptor = second
      .getCustomProviderRegistry()
      .getModelDescriptor(params.model)!;
    await first.dispose();
    configs.splice(configs.indexOf(first), 1);
    expect(
      second.getCustomProviderRegistry().getModelDescriptor(params.model),
    ).toEqual(descriptor);
    expect(
      second.getCustomProviderRegistry().getProviderForModel(params.model),
    ).toMatchObject({
      apiKey: 'second-secret',
      baseUrl: 'https://second.example/v1',
    });
  });

  it('replaces local settings immediately and retains the new snapshot across refreshes', async () => {
    const config = makeConfig();
    await config.initializeCustomProviders();
    await config.replaceCustomProviderSettings({
      second: {
        baseUrl: 'https://second.example/v1',
        apiKey: 'new-secret',
        model: 'new-model',
        protocol: 'openai-responses',
      },
    });
    await config.ensureCustomProvidersAccess();
    expect(config.canUseCustomProviders()).toBe(true);
    expect(
      config
        .getCustomProviderRegistry()
        .getPublicModels()
        .map((model) => model.key),
    ).toEqual(['second/new-model']);
    await config.replaceCustomProviderSettings({});
    expect(config.getCustomProvidersState().status).toBe('not_configured');
  });

  it('keeps disabled runtimes inactive', async () => {
    const config = makeConfig({ customProviderAccessMode: 'disabled' });
    await config.initializeCustomProviders();
    expect(await config.ensureCustomProvidersAccess()).toBe(false);
    expect(config.getCustomProvidersState()).toEqual({
      status: 'inactive',
      reason: 'remote_worker',
    });
    expect(
      config.getCustomProviderRegistry().getPublicProviders(),
    ).toHaveLength(1);
    expect(
      config.getCustomProviderRegistry().getProviderForModel(params.model)
        ?.apiKey,
    ).toBe('');
  });

  it('rejects a disabled saved Custom Provider without silently falling back', async () => {
    const config = makeConfig({ customProviderAccessMode: 'disabled' });
    const manager = config.getModelProviderManager();
    await manager.start();
    manager.setMainModelKey(params.model);
    await config.initializeCustomProviders();
    await expect(
      config.reconcileModelWithListedModels({ modelsWereAwaited: true }),
    ).rejects.toMatchObject({
      name: 'CustomProviderAccessError',
      reason: 'denied',
    });
    expect(config.getModel()).toBe(params.model);
  });

  it('does not shadow an existing direct-connection model with an inactive provider of the same name', async () => {
    const config = makeConfig({ customProviderAccessMode: 'disabled' });
    mockListedModels([
      testListedModel('gateway/test-model', {
        display_name: 'Legacy direct connection',
        source: 'user',
        provider: 'gateway',
        model: 'test-model',
        url: 'https://legacy.example/v1',
        max_input_tokens: 128000,
      }),
    ]);
    await config.initializeCustomProviders();
    expect(
      config.isConfiguredCustomProviderModelKey(
        params.model,
        await config.getModelProviderManager().getModel(params.model),
      ),
    ).toBe(false);
    const setMainModel = vi.spyOn(
      config.getModelProviderManager(),
      'setMainModel',
    );
    config.getModelProviderManager().setMainModelKey(params.model);
    await synchronizeSessionModelProvider(config);
    expect(setMainModel).toHaveBeenCalledWith(
      expect.objectContaining({ key: params.model, source: 'qoder' }),
      false,
    );
  });

  it.each(['model', 'identity', 'session'] as const)(
    'does not submit an anchor query after the session %s changes',
    async (target) => {
      const config = makeConfig();
      const manager = config.getModelProviderManager();
      let resolveModels!: (
        models: Awaited<ReturnType<typeof manager.listModels>>,
      ) => void;
      vi.spyOn(manager, 'listModels').mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveModels = resolve;
          }),
      );
      const setMainModel = vi.spyOn(manager, 'setMainModel');
      const pending = synchronizeSessionModelProvider(config);
      if (target === 'model')
        vi.spyOn(config, 'getModel').mockReturnValue('auto');
      else if (target === 'identity') identity = 'next-account';
      else vi.spyOn(config, 'getSessionId').mockReturnValue('next-session');
      resolveModels([testListedModel(params.model)]);
      await expect(pending).rejects.toThrow('Session model changed');
      expect(setMainModel).not.toHaveBeenCalled();
    },
  );

  it('does not submit an anchor after a pending query is cancelled', async () => {
    const config = makeConfig();
    const manager = config.getModelProviderManager();
    let resolveModels!: (
      models: Awaited<ReturnType<typeof manager.listModels>>,
    ) => void;
    vi.spyOn(manager, 'listModels').mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve;
        }),
    );
    const setMainModel = vi.spyOn(manager, 'setMainModel');
    const controller = new AbortController();
    const pending = synchronizeSessionModelProvider(config, controller.signal);
    const reason = new Error('cancel selection');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    resolveModels([testListedModel(params.model)]);
    await Promise.resolve();
    expect(setMainModel).not.toHaveBeenCalled();
  });

  it('does not wait for QCS when only platform models are configured', async () => {
    const config = makeConfig({ customProviderSettings: undefined });
    await config.initializeCustomProviders();
    expect(config.getCustomProvidersState().status).toBe('not_configured');
  });

  it('activates providers alongside a selected platform model', async () => {
    const config = makeConfig({ model: 'auto' });
    await config.initializeCustomProviders();
    expect(config.getCustomProvidersState().status).toBe('active');
    expect(
      config.getCustomProviderRegistry().getPublicProviders(),
    ).toHaveLength(1);
  });

  it('never activates after initialization resumes following disposal', async () => {
    const config = makeConfig();
    const pending = config.initializeCustomProviders();
    await config.dispose();
    configs.splice(configs.indexOf(config), 1);
    await pending;
    expect(
      config.getCustomProviderRegistry().getPublicProviders(),
    ).toHaveLength(0);
    expect(await config.ensureCustomProvidersAccess()).toBe(false);
  });
});

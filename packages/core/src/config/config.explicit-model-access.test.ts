/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '@qwen-code/resource';
import type { SettingsSource } from '@qwen-code/resource';
import { Config } from './config.js';
import { FatalAuthenticationError } from '../utils/errors.js';
import { createEmptyLoadedSettings } from '../test-utils/config.js';
import type { ModelProvider } from '../provider/modelProvider.js';
import { createCustomModelProvidersFromSettingsTexts } from '../provider/impl/customModelProviderFactory.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import { OPENAI_CHAT_COMPLETIONS } from '../provider/transport/modelProtocol.js';
import type { ModelStreamEvent } from '../provider/event/modelStreamEvent.js';

describe('explicit model resolution', () => {
  const configs: Config[] = [];
  const key = 'gateway/test-model';
  afterEach(async () => {
    for (const config of configs.splice(0)) await config.dispose();
    vi.restoreAllMocks();
  });

  function makeConfig(input?: string) {
    const loadedSettings = createEmptyLoadedSettings();
    loadedSettings.merged.model = { ...loadedSettings.merged.model, name: key };
    loadedSettings.merged.providers = {
      gateway: {
        baseUrl: 'https://unused.invalid/v1',
        apiKey: 'test-secret',
        model: 'test-model',
        models: [{ model: 'test-model', displayName: 'Gateway model' }],
      },
    };
    const settingsService = new SettingsService();
    vi.spyOn(settingsService, 'resolve').mockReturnValue(loadedSettings);
    const stream = vi.fn(async function* (): AsyncGenerator<ModelStreamEvent> {
      yield {
        type: 'message_start',
        message: { id: 'reply', role: 'assistant', model: key },
      };
      yield {
        type: 'content_block_start',
        index: 0,
        contentBlock: { type: 'text', text: '' },
      };
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      };
      yield { type: 'content_block_stop', index: 0 };
      yield { type: 'message_delta', delta: { stopReason: 'end_turn' } };
      yield { type: 'message_stop' };
    });
    const transports = new ModelTransportManager([
      { protocol: OPENAI_CHAT_COMPLETIONS, stream },
    ]);
    const product: ModelProvider = {
      providerId: 'product',
      start: async () => {},
      stop: async () => {},
      listModels: async () => [],
      getModel: async () => undefined,
      getModelConfig: () => undefined,
      setModelConfig: () => true,
      select: vi.fn(),
      inference: vi.fn(),
    };
    const config = new Config({
      loadedSettings,
      settingsService,
      modelProviderFactory: () => [
        product,
        ...createCustomModelProvidersFromSettingsTexts(
          [JSON.stringify(loadedSettings.merged)],
          transports,
          settingsService,
          'user',
        ),
      ],
      modelTransportManager: transports,
      customProviderSettings: loadedSettings.merged.providers,
      sessionId: 'explicit-model-admission',
      targetDir: '.',
      cwd: '.',
      debugMode: false,
      model: input ?? key,
      modelSource: input === undefined ? 'config' : 'cli',
    });
    configs.push(config);
    return { config, stream, product };
  }

  it('runs an explicit open-source custom model', async () => {
    const { config, stream } = makeConfig(key);
    const manager = config.getModelProviderManager();
    await manager.start();
    await config.initializeCustomProviders();
    await config.reconcileModelWithListedModels();
    const resolution = await manager.select({ purpose: 'main' });
    expect(resolution.model).toMatchObject({ key, source: 'gateway' });
    const response = await manager.inference({
      resolution,
      prompt: { messages: [{ role: 'user', content: 'hello' }] },
    });
    await expect(response.completed).resolves.toMatchObject({ model: key });
    expect(stream).toHaveBeenCalledOnce();
  });

  it('resolves a Custom startup display name when another provider requires login', async () => {
    const { config, stream, product } = makeConfig('Gateway model');
    product.getModel = vi
      .fn()
      .mockRejectedValue(new FatalAuthenticationError('Not logged in'));
    const manager = config.getModelProviderManager();
    await manager.start();
    await config.initializeCustomProviders();
    await config.reconcileModelWithListedModels();
    const resolution = await manager.select({ purpose: 'main' });
    expect(resolution.model).toMatchObject({ key, source: 'gateway' });
    const response = await manager.inference({
      resolution,
      prompt: { messages: [{ role: 'user', content: 'hello' }] },
    });
    await response.completed;
    expect(stream).toHaveBeenCalledOnce();
  });

  it('preserves authentication errors for an unresolved startup model', async () => {
    const { config, stream, product } = makeConfig('unknown');
    const error = new FatalAuthenticationError('Not logged in');
    product.getModel = vi.fn().mockRejectedValue(error);
    await config.getModelProviderManager().start();
    await expect(config.reconcileModelWithListedModels()).rejects.toBe(error);
    expect(stream).not.toHaveBeenCalled();
  });
});

describe('workspace trust gates project custom providers at startup', () => {
  const configs: Config[] = [];

  afterEach(async () => {
    for (const config of configs.splice(0)) await config.dispose();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  function makeStartupConfig(
    isTrusted: boolean,
    providerSettingsSources?: readonly SettingsSource[],
    projectionSources: readonly SettingsSource[] = ['project', 'local'],
    providerRejectedEnvKeys?: ReadonlySet<string>,
  ) {
    const loadedSettings = createEmptyLoadedSettings();
    loadedSettings.isTrusted = isTrusted;
    loadedSettings.project.readOnly = !projectionSources.includes('project');
    loadedSettings.local.readOnly = !projectionSources.includes('local');
    const settingsService = new SettingsService();
    vi.spyOn(settingsService, 'resolve').mockReturnValue(loadedSettings);
    const settingsText = (providerId: string) =>
      JSON.stringify({
        providers: {
          [providerId]: {
            baseUrl: 'https://unused.invalid/v1',
            apiKey: '${QWEN_STARTUP_TRUST_KEY}',
            models: [{ model: '${QWEN_STARTUP_TRUST_MODEL}' }],
          },
        },
      });
    const projectRead = vi.fn(() => settingsText('projectGw'));
    const localRead = vi.fn(() => settingsText('localGw'));
    vi.spyOn(settingsService, 'getProjectSettingsSources').mockReturnValue({
      project: { read: projectRead },
      local: { read: localRead },
    } as unknown as ReturnType<SettingsService['getProjectSettingsSources']>);
    const config = new Config({
      loadedSettings,
      settingsService,
      sessionId: 'startup-trust-gate',
      targetDir: '.',
      cwd: '.',
      debugMode: false,
      model: 'gateway/test-model',
      modelSource: 'config',
      providerSettingsSources,
      providerRejectedEnvKeys,
    });
    configs.push(config);
    return { config, projectRead, localRead };
  }

  it('reads and admits project and local providers in a trusted workspace', async () => {
    vi.stubEnv('QWEN_STARTUP_TRUST_KEY', 'resolved-secret');
    vi.stubEnv('QWEN_STARTUP_TRUST_MODEL', 'test-model');
    const { config, projectRead, localRead } = makeStartupConfig(true);
    expect(projectRead).toHaveBeenCalled();
    expect(localRead).toHaveBeenCalled();
    const manager = config.getModelProviderManager();
    await manager.start();
    const models = await manager.listModels();
    expect(models.map(({ key }) => key).sort()).toEqual([
      'localGw/test-model',
      'projectGw/test-model',
    ]);
  });

  it('does not read or admit project or local providers in an untrusted workspace', async () => {
    vi.stubEnv('QWEN_STARTUP_TRUST_KEY', 'resolved-secret');
    vi.stubEnv('QWEN_STARTUP_TRUST_MODEL', 'test-model');
    const { config, projectRead, localRead } = makeStartupConfig(false);
    const manager = config.getModelProviderManager();
    await manager.start();

    expect(projectRead).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
    await expect(manager.listModels()).resolves.toEqual([]);
  });

  it('reads only the project layer when the source selection excludes local', async () => {
    vi.stubEnv('QWEN_STARTUP_TRUST_KEY', 'resolved-secret');
    vi.stubEnv('QWEN_STARTUP_TRUST_MODEL', 'test-model');
    const { config, projectRead, localRead } = makeStartupConfig(true, [
      'project',
    ]);
    // Assert the assembly boundary before manager.start(): preference
    // storage legitimately re-reads both layers afterwards.
    expect(projectRead).toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
    const manager = config.getModelProviderManager();
    await manager.start();
    const models = await manager.listModels();
    expect(models.map(({ key }) => key)).toEqual(['projectGw/test-model']);
  });

  it.each(['project', 'local'] as const)(
    'reads only %s when the loaded projection excluded the other source',
    async (source) => {
      vi.stubEnv('QWEN_STARTUP_TRUST_KEY', 'resolved-secret');
      vi.stubEnv('QWEN_STARTUP_TRUST_MODEL', 'test-model');
      const { config, projectRead, localRead } = makeStartupConfig(
        true,
        undefined,
        [source],
      );
      expect(projectRead).toHaveBeenCalledTimes(source === 'project' ? 1 : 0);
      expect(localRead).toHaveBeenCalledTimes(source === 'local' ? 1 : 0);
      const manager = config.getModelProviderManager();
      await manager.start();
      const models = await manager.listModels();
      expect(models.map(({ key }) => key)).toEqual([`${source}Gw/test-model`]);
    },
  );

  it.each([false, true])(
    'uses only allowed environment values in selected project and local providers (reject: %s)',
    async (reject) => {
      vi.stubEnv('QWEN_STARTUP_TRUST_KEY', 'resolved-key');
      vi.stubEnv('QWEN_STARTUP_TRUST_MODEL', 'test-model');
      const { config } = makeStartupConfig(
        true,
        ['project', 'local'],
        undefined,
        new Set(reject ? ['QWEN_STARTUP_TRUST_KEY'] : []),
      );
      const manager = config.getModelProviderManager();
      await manager.start();
      const models = await manager.listModels();
      expect(models.map(({ key }) => key).sort()).toEqual(
        reject ? [] : ['localGw/test-model', 'projectGw/test-model'],
      );
      expect(process.env['QWEN_STARTUP_TRUST_KEY']).toBe('resolved-key');
    },
  );

  it('reads neither layer for an empty source selection in a trusted workspace', async () => {
    vi.stubEnv('QWEN_STARTUP_TRUST_KEY', 'resolved-secret');
    vi.stubEnv('QWEN_STARTUP_TRUST_MODEL', 'test-model');
    const { config, projectRead, localRead } = makeStartupConfig(true, []);
    const manager = config.getModelProviderManager();
    await manager.start();

    expect(projectRead).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
    await expect(manager.listModels()).resolves.toEqual([]);
  });

  it('keeps the trust gate decisive when both project sources are selected', async () => {
    vi.stubEnv('QWEN_STARTUP_TRUST_KEY', 'resolved-secret');
    vi.stubEnv('QWEN_STARTUP_TRUST_MODEL', 'test-model');
    const { config, projectRead, localRead } = makeStartupConfig(false, [
      'project',
      'local',
    ]);
    const manager = config.getModelProviderManager();
    await manager.start();

    expect(projectRead).not.toHaveBeenCalled();
    expect(localRead).not.toHaveBeenCalled();
    await expect(manager.listModels()).resolves.toEqual([]);
  });
});

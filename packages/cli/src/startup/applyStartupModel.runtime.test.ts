/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Config,
  ChatCompletionsTransport,
  createCustomModelProviders,
  ModelTransportManager,
} from '@qwen-code/core';
import { SettingsService } from '@qwen-code/resource';
import { createEmptyLoadedSettings } from '../../../core/src/test-utils/config.js';
import { HttpTransport } from '../../../core/src/client/transport/httpTransport.js';
import { ENV_MODEL } from '../../../core/src/config/brand.js';
import { HeadlessSession } from '../headless/headlessSession.js';
import type { CliArgs } from '../config/config.js';
import type { ThreadManager } from '../thread-manager/threadManager.js';
import { createStartupModelApplier } from './applyStartupModel.js';

describe('Startup model runtime', () => {
  const configs: Config[] = [];
  beforeEach(() => vi.stubEnv(ENV_MODEL, undefined));
  afterEach(async () => {
    await Promise.all(configs.splice(0).map((config) => config.dispose()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  async function setup(input?: string) {
    const settings = {
      model: { name: 'gateway/saved' },
      providers: {
        gateway: {
          baseUrl: 'https://models.example/v1',
          apiKey: 'test-key',
          model: 'saved',
          models: [
            { model: 'saved', contextWindow: 128000 },
            {
              model: 'alternate',
              displayName: 'Alternate Model',
              contextWindow: 64000,
            },
          ],
        },
      },
    };
    const loaded = createEmptyLoadedSettings();
    loaded.user.settings = settings;
    vi.spyOn(loaded, 'merged', 'get').mockReturnValue({
      ...loaded.merged,
      ...settings,
      model: { ...loaded.merged.model, ...settings.model },
      hooksConfig: { ...loaded.merged.hooksConfig, headlessFastMode: false },
    });
    const service = new SettingsService();
    vi.spyOn(service, 'resolve').mockReturnValue(loaded);
    const mutate = vi.fn();
    vi.spyOn(service, 'peekUserSettingsSource').mockReturnValue({
      read: () => JSON.stringify(settings),
      mutate,
    } as never);
    vi.spyOn(service, 'getProjectSettingsSources').mockReturnValue({
      project: { read: () => '{}' },
      local: { read: () => '{}' },
    } as never);
    const transports = new ModelTransportManager([
      new ChatCompletionsTransport(),
    ]);
    const config = new Config({
      loadedSettings: loaded,
      settingsService: service,
      sessionId: 'cli-startup-model',
      cwd: process.cwd(),
      targetDir: process.cwd(),
      debugMode: false,
      model: input ?? '',
      modelSource: input === undefined ? 'config' : 'cli',
      modelTransportManager: transports,
      modelProviderFactory: () =>
        createCustomModelProviders(
          settings.providers,
          transports,
          service,
          'user',
        ),
      customProviderSettings: settings.providers,
    });
    configs.push(config);
    await config.getModelProviderManager().start();
    await config.initializeCustomProviders();
    const session = new HeadlessSession({
      settings: loaded,
      cliArgs: { model: input } as CliArgs,
      workspaceRoot: process.cwd(),
      threadManager: {
        open: async () => config.getSessionId(),
        get: () => ({ requireConfig: () => config }),
        requireSession: () => ({ requireConfig: () => config }),
      } as unknown as ThreadManager,
    });
    const apply = () =>
      (session as unknown as { openSession(): Promise<void> }).openSession();
    return { config, settings, mutate, apply };
  }

  it.each(['gateway/alternate', 'Alternate Model'])(
    'applies %s through the headless entry before inference',
    async (input) => {
      const { config, settings, mutate, apply } = await setup(input);
      const wire = vi
        .spyOn(HttpTransport.prototype, 'invoke')
        .mockImplementation(async (_request, response) => {
          response.raw = new Response(
            'data: {"id":"reply","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\n\n' +
              'data: {"id":"reply","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
              'data: [DONE]\n\n',
            { headers: { 'content-type': 'text/event-stream' } },
          );
        });
      expect(config.getModel()).toBe('gateway/saved');
      await apply();
      const manager = config.getModelProviderManager();
      const resolution = await manager.select({ purpose: 'main' });
      const response = await manager.inference({
        resolution,
        prompt: { messages: [{ role: 'user', content: 'hello' }] },
      });
      expect((await response.completed).blocks).toMatchObject([
        { type: 'text', text: 'hello' },
      ]);
      expect(JSON.parse(wire.mock.calls[0]![0].body as string).model).toBe(
        'alternate',
      );
      expect(settings.model.name).toBe('gateway/saved');
      expect(mutate).not.toHaveBeenCalled();
    },
  );

  it('rejects an unknown headless model before inference', async () => {
    const { config, mutate, apply } = await setup('222');
    const wire = vi
      .spyOn(HttpTransport.prototype, 'invoke')
      .mockRejectedValue(new Error('Unexpected inference request'));
    await expect(apply()).rejects.toMatchObject({ name: 'FatalInputError' });
    expect(wire).not.toHaveBeenCalled();
    expect(config.getModel()).toBe('gateway/saved');
    expect(mutate).not.toHaveBeenCalled();
  });

  it('keeps the saved model without -m in headless', async () => {
    const { config, apply } = await setup();
    await apply();
    expect(config.getModel()).toBe('gateway/saved');
  });

  it('preserves a user switch made after auth reconciliation and before the shared startup action', async () => {
    const { config } = await setup('Alternate Model');
    const apply = createStartupModelApplier(config.getCliModel());
    await config.reconcileModelWithListedModels();
    await config.setModel('gateway/saved', true);
    await apply(config);
    expect(config.getModel()).toBe('gateway/saved');
  });
});

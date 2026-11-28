/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import {
  Config,
  CustomProviderManager,
  createCustomModelProviders,
  ModelTransportManager,
  ChatCompletionsTransport,
  runLogger,
} from '@qwen-code/core';
import {
  resolveEnvVarsInObject,
  SettingsService,
  type MergedSettings,
  type Settings,
} from '@qwen-code/resource';
import { createEmptyLoadedSettings } from '../../../../core/src/test-utils/config.js';
import { HttpTransport } from '../../../../core/src/client/transport/httpTransport.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { modelCommand } from '../commands/modelCommand.js';
import {
  createLocalProviderFromTui,
  deleteLocalProviderFromTui,
  getLocalModelEdit,
  refreshLocalProvidersFromTui,
  updateLocalModelFromTui,
} from './localCustomModels.js';

const gateway = {
  baseUrl: 'https://original.example/v1',
  apiKey: 'original-secret',
  model: 'main',
  models: [{ model: 'main', contextWindow: 128000 }],
};
const configs: Config[] = [];

afterEach(async () => {
  await Promise.all(configs.splice(0).map((config) => config.dispose()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

/** Keep persistence in memory; exercise the real Config, CRUD, providers and SSE path. */
async function setup(
  initial: Settings = {},
  projectSettings: Settings = {},
  localSettings: Settings = {},
) {
  for (const level of ['log', 'warn', 'error'] as const) {
    vi.spyOn(runLogger, level).mockImplementation(() => {});
  }
  let disk = structuredClone(initial);
  const project = structuredClone(projectSettings);
  const local = structuredClone(localSettings);
  const source = {
    read: () => JSON.stringify(disk),
    invalidate: vi.fn(),
    mutate: (mutation: (value: Record<string, unknown>) => boolean) => {
      const next = structuredClone(disk);
      if (mutation(next)) disk = next;
    },
  };
  const settingsService = new SettingsService();
  vi.spyOn(settingsService, 'peekUserSettingsSource').mockReturnValue(
    source as never,
  );
  vi.spyOn(settingsService, 'getProjectSettingsSources').mockReturnValue({
    project: { read: () => JSON.stringify(project) },
    local: { read: () => JSON.stringify(local) },
  } as never);
  const loaded = createEmptyLoadedSettings();
  loaded.user.readOnly = false;
  loaded.isTrusted = true;
  loaded.project.settings = project;
  loaded.local.settings = local;
  const reload = () => {
    loaded.user.settings = resolveEnvVarsInObject(structuredClone(disk));
  };
  reload();
  vi.spyOn(loaded, 'reload').mockImplementation(reload);
  vi.spyOn(loaded, 'merged', 'get').mockImplementation(
    () =>
      ({
        ...loaded.user.settings,
        providers: {
          ...loaded.user.settings.providers,
          ...project.providers,
          ...local.providers,
        },
      }) as MergedSettings,
  );
  const transports = new ModelTransportManager([
    new ChatCompletionsTransport(),
  ]);
  const config = new Config({
    loadedSettings: loaded,
    settingsService,
    customProviderManager: new CustomProviderManager(settingsService),
    modelTransportManager: transports,
    modelProviderFactory: () =>
      createCustomModelProviders(
        loaded.user.settings.providers,
        transports,
        settingsService,
        'user',
      ),
    customProviderSettings: loaded.merged.providers,
    customProviderAccessMode: 'local',
    sessionId: 'local-custom-runtime',
    model: '',
    targetDir: process.cwd(),
    cwd: process.cwd(),
    debugMode: false,
  });
  configs.push(config);
  const wire = vi
    .spyOn(HttpTransport.prototype, 'invoke')
    .mockImplementation(async (request, response) => {
      const body = JSON.parse(request.body as string);
      const chunk = (choices: unknown[]) =>
        `data: ${JSON.stringify({
          id: 'test-response',
          model: body.model,
          choices,
        })}\n\n`;
      response.raw = new Response(
        chunk([
          {
            index: 0,
            delta: { role: 'assistant', content: 'hello' },
            finish_reason: null,
          },
        ]) +
          chunk([{ index: 0, delta: {}, finish_reason: 'stop' }]) +
          'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
  await config.getModelProviderManager().start();
  await config.initializeCustomProviders();
  return { config, wire, disk: () => disk, project, local };
}

async function infer(config: Config) {
  const manager = config.getModelProviderManager();
  const resolution = await manager.select({ purpose: 'main' });
  const response = await manager.inference({
    resolution,
    prompt: { messages: [{ role: 'user', content: 'hello' }] },
  });
  const events = [];
  for await (const event of response.events) events.push(event);
  expect(await response.completed).toMatchObject({
    blocks: [{ type: 'text', text: 'hello' }],
  });
  expect(events).toContainEqual(
    expect.objectContaining({ type: 'message_complete' }),
  );
  return resolution;
}

describe('local Custom Provider save in the running session', () => {
  it('adds the first BYOK and immediately selects and infers through the same manager', async () => {
    const { config, wire, disk } = await setup();
    const manager = config.getModelProviderManager();
    expect(config.hasModelProviderManager()).toBe(false);
    await expect(
      createLocalProviderFromTui(config, { providerId: 'gateway', ...gateway }),
    ).resolves.toEqual({
      modelKey: 'gateway/main',
      applied: true,
    });
    expect(wire).not.toHaveBeenCalled();
    expect(disk().providers?.['gateway']).toBeDefined();
    expect(config.getModelProviderManager()).toBe(manager);
    expect(config.hasModelProviderManager()).toBe(true);
    await config.setModel('gateway/main');
    expect((await infer(config)).model.key).toBe('gateway/main');
    expect(wire.mock.calls[0]?.[0].url).toBe(
      'https://original.example/v1/chat/completions',
    );
    expect(wire.mock.calls[0]?.[0].headers['Authorization']).toBe(
      'Bearer original-secret',
    );
  });

  it('uses the edited endpoint, key and capacity on the next request while retaining session preferences', async () => {
    const { config, wire } = await setup({ providers: { gateway } });
    const manager = config.getModelProviderManager();
    await config.setModel('gateway/main');
    const before = await manager.getMainModel();
    manager.setModelConfig(before, { sampling: { temperature: 0.3 } });
    await infer(config);
    const original = getLocalModelEdit(config, 'gateway/main')!;
    await expect(
      updateLocalModelFromTui(config, original, {
        baseUrl: 'https://updated.example/v1',
        apiKey: 'updated-secret',
        model: { ...original.model, contextWindow: 256000 },
      }),
    ).resolves.toEqual({ modelKey: 'gateway/main', applied: true });
    expect(wire).toHaveBeenCalledOnce();
    expect(config.getModelProviderManager()).toBe(manager);
    const selected = await infer(config);
    expect(selected.model.limits.maxContextTokens).toBe(256000);
    expect(selected.config.sampling?.temperature).toBe(0.3);
    const sent = wire.mock.calls[1]![0];
    expect(sent.url).toBe('https://updated.example/v1/chat/completions');
    expect(sent.headers['Authorization']).toBe('Bearer updated-secret');
    expect(JSON.parse(sent.body as string)).toMatchObject({
      model: 'main',
      temperature: 0.3,
    });
  });

  it('removes a deleted BYOK from inference without silently switching the main model', async () => {
    const { config } = await setup({ providers: { gateway } });
    await config.setModel('gateway/main');
    await deleteLocalProviderFromTui(config, 'gateway/main');
    expect(config.hasModelProviderManager()).toBe(false);
    expect(
      await config.getModelProviderManager().getModel('gateway/main'),
    ).toBeUndefined();
    expect(config.getModel()).toBe('gateway/main');
    await expect(
      config.getModelProviderManager().select({ purpose: 'main' }),
    ).rejects.toThrow();
  });

  it('keeps /model open after deleting a vision model with effort and context settings', async () => {
    const key = 'remove/reasoning';
    const { config, disk } = await setup({
      providers: {
        keep: gateway,
        remove: {
          ...gateway,
          protocol: 'openai',
          model: 'reasoning',
          models: [
            {
              model: 'reasoning',
              displayName: 'Vision model',
              contextWindow: 256000,
              capabilities: {
                vision: true,
                thinking: {
                  modes: ['enabled'],
                  supportsEffort: true,
                  supportedEffortLevels: ['low', 'high'],
                },
              },
            },
          ],
        },
      },
    });
    const manager = config.getModelProviderManager();
    manager.setModelConfig((await manager.getModel(key))!, {
      reasoning: { effort: 'high' },
      context: { contextWindow: 256000 },
    });
    await config.setModel('keep/main');
    const setModel = vi.spyOn(config, 'setModel');
    const context = createMockCommandContext();
    context.services.agentContext = { config } as never;
    context.ui.removeComponent = vi.fn();
    const result = await modelCommand.action!(context, '');
    if (result?.type !== 'custom_dialog' || !React.isValidElement(result.component))
      throw new Error('Model selector did not open');
    const rendered = await renderWithProviders(result.component, {
      width: 120,
      config,
    });
    const press = async (key: string) => {
      await act(async () => {
        rendered.stdin.write(key);
      });
      await rendered.waitUntilReady();
    };
    try {
      await waitFor(() => expect(rendered.lastFrame()).toContain('Custom (2)'));
      await rendered.waitUntilReady();
      await press('\u001b[B');
      await press('\u001b[B');
      await press('d');
      await waitFor(() => expect(rendered.lastFrame()).toContain('Delete'));
      expect(rendered.lastFrame()).toContain('Vision model');
      await press('\u001b[B');
      await press('\r');
      await waitFor(() => expect(rendered.lastFrame()).toContain('Custom (1)'));
      expect(rendered.lastFrame()).toContain('Context: 128K');
      expect(rendered.lastFrame()).not.toContain('Vision model');
      expect(disk().providers?.['remove']).toBeUndefined();
      expect(await manager.getModel(key)).toBeUndefined();
      expect(config.getModel()).toBe('keep/main');
      expect(setModel).not.toHaveBeenCalled();
      expect(context.ui.removeComponent).not.toHaveBeenCalled();
      await press('\u001b');
      expect(context.ui.removeComponent).toHaveBeenCalledOnce();
    } finally {
      rendered.unmount();
    }
  });

  it('recognizes project-only BYOK and keeps project/local precedence after refresh', async () => {
    const { config, wire } = await setup(
      {},
      {
        providers: {
          gateway: { ...gateway, baseUrl: 'https://project.example/v1' },
        },
      },
      {
        providers: {
          gateway: { ...gateway, baseUrl: 'https://local.example/v1' },
        },
      },
    );
    expect(config.hasModelProviderManager()).toBe(true);
    await refreshLocalProvidersFromTui(config);
    await config.setModel('gateway/main');
    await infer(config);
    expect(wire.mock.calls[0]![0].url).toBe(
      'https://local.example/v1/chat/completions',
    );
  });
});

/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsService } from '@qwen-code/resource';
import { createCustomModelProviders } from '../provider/impl/customModelProviderFactory.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import { ChatCompletionsTransport } from '../provider/transport/impl/chatCompletionsTransport.js';
import { Config } from '../config/config.js';
import { createEmptyLoadedSettings } from '../test-utils/config.js';
import type { BuiltinPluginContributions } from '../builtin-plugins/registry.js';
import type { BuiltinRuntimeHookDefinition } from '../builtin-plugins/types.js';
import type { ModelImageBlock } from '../provider/modelStreamRequest.js';
import { HookSystem } from './hookSystem.js';
import { HookPlanner } from './hookPlanner.js';
import { prepareImageBlocks, validatePreparedImages } from './imagePrepare.js';

const image: ModelImageBlock = {
  type: 'image',
  source: { type: 'base64', mediaType: 'image/png', data: 'aGVsbG8=' },
};
const uploaded: ModelImageBlock = {
  type: 'image',
  source: { type: 'url', url: 'https://images.example/a.png' },
};
const systems: HookSystem[] = [];
afterEach(() => {
  for (const system of systems.splice(0)) system.dispose();
  vi.restoreAllMocks();
});

async function setup(
  actions: Array<BuiltinRuntimeHookDefinition['action']> = [],
  hookOptions: Pick<BuiltinRuntimeHookDefinition, 'timeout'> = {},
) {
  const config = new Config({
    loadedSettings: createEmptyLoadedSettings(),
    targetDir: process.cwd(),
    cwd: process.cwd(),
    sessionId: 'image-test',
    debugMode: false,
    model: 'main',
    builtinPlugins: {
      isReady: () => true,
      getHooks: () =>
        actions.map((action, index) => ({
          event: 'ImagePrepare',
          type: 'runtime',
          internal: true,
          name: `image-${index}`,
          action,
          ...hookOptions,
        })),
    } as unknown as BuiltinPluginContributions,
  });
  vi.spyOn(config, 'getModel').mockReturnValue('main');
  const hooks = new HookSystem(config);
  systems.push(hooks);
  await hooks.initialize();
  vi.spyOn(config, 'getHookSystem').mockReturnValue(hooks);
  vi.spyOn(config, 'getModelProviderManager').mockReturnValue({
    getModel: async (key: string) => ({
      source: 'qwen-provider',
      key,
      apiKey: 'secret',
    }),
  } as never);
  return { config, hooks };
}

describe('ImagePrepare runtime hook', () => {
  it('uses the current session model instead of the stale main model anchor', async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const { config } = await setup([action]);
    const manager = config.getModelProviderManager();
    const lookup = vi.spyOn(manager, 'getModel');
    vi.spyOn(config, 'getModel').mockReturnValue('auto');
    await prepareImageBlocks([image], { config });
    expect(lookup).toHaveBeenCalledWith('auto');
    expect(action.mock.calls[0][0].imageModel).toEqual({ source: 'qwen-provider', key: 'auto' });
    vi.mocked(config.getModel).mockReturnValue('changed-model');
    await prepareImageBlocks([image], { config });
    expect(lookup).toHaveBeenLastCalledWith('changed-model');
  });

  it('preserves an explicit agent model override', async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const { config } = await setup([action]);
    await prepareImageBlocks([image], { config, modelKey: 'agent-model' });
    expect(action.mock.calls[0][0].imageModel).toEqual({ source: 'qwen-provider', key: 'agent-model' });
  });

  it('resolves local ownership from the registry without consulting the main provider', async () => {
    const action = vi.fn().mockResolvedValue(undefined);
    const { config } = await setup([action]);
    config.getCustomProviderRegistry().replace({
      local: { baseUrl: 'https://models.example/v1', apiKey: 'secret', model: 'vision' },
    });
    vi.mocked(config.getModelProviderManager).mockClear();
    vi.spyOn(config, 'getModel').mockReturnValue('local/vision');
    expect(await prepareImageBlocks([image], { config })).toEqual([image]);
    expect(action.mock.calls[0][0].imageModel).toEqual({ source: 'local', key: 'local/vision' });
    expect(config.getModelProviderManager).not.toHaveBeenCalled();
    expect(JSON.stringify(action.mock.calls[0][0])).not.toContain('secret');
    vi.mocked(config.getModel).mockReturnValue('auto');
    await prepareImageBlocks([image], { config, modelKey: 'local/vision' });
    expect(action.mock.calls[1][0].imageModel).toEqual({ source: 'local', key: 'local/vision' });
    expect(config.getModelProviderManager).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'uses a configured BYOK model before legacy registry initialization (vision=%s)',
    async (vision) => {
      const settings = {
        local: {
          baseUrl: 'https://models.example/v1',
          apiKey: 'test-secret',
          model: 'custom-model',
          models: [{ model: 'custom-model', capabilities: { vision } }],
        },
      };
      const settingsService = new SettingsService();
      const modelTransportManager = new ModelTransportManager([
        new ChatCompletionsTransport(),
      ]);
      const action = vi.fn().mockResolvedValue(undefined);
      const config = new Config({
        loadedSettings: createEmptyLoadedSettings(),
        targetDir: process.cwd(),
        cwd: process.cwd(),
        sessionId: 'byok-image-test',
        model: 'local/custom-model',
        debugMode: false,
        customProviderSettings: settings,
        settingsService,
        modelTransportManager,
        modelProviderFactory: () =>
          createCustomModelProviders(
            settings,
            modelTransportManager,
            settingsService,
            'user',
          ),
        builtinPlugins: {
          isReady: () => true,
          getHooks: () => [
            {
              event: 'ImagePrepare',
              type: 'runtime',
              internal: true,
              name: 'image',
              action,
            },
          ],
        } as unknown as BuiltinPluginContributions,
      });
      const key = 'local/custom-model';
      expect(
        config.getCustomProviderRegistry().getModelDescriptor(key),
      ).toBeUndefined();
      const model = await config.getModelProviderManager().getModel(key);
      expect(model).toMatchObject({ source: 'local', key, capabilities: { vision } });
      expect(config.isConfiguredCustomProviderModelKey(key, model)).toBe(true);
      const hooks = new HookSystem(config);
      systems.push(hooks);
      await hooks.initialize();
      expect(
        await hooks.fireImagePrepareEvent({
          images: [image],
          modelKey: key,
          failureMode: 'throw',
        }),
      ).toEqual([image]);
      expect(action.mock.calls[0][0].imageModel).toEqual({ source: 'local', key });
    },
  );

  it('rejects unavailable models before upload', async () => {
    const action = vi.fn();
    const { config } = await setup([action]);
    vi.spyOn(config.getModelProviderManager(), 'getModel').mockResolvedValue(undefined);
    await expect(prepareImageBlocks([image], { config, modelKey: 'local/vision' }))
      .rejects.toThrow('ImagePrepare model is not available');
    expect(action).not.toHaveBeenCalled();
  });

  it('uses platform ownership for a provider-prefixed key', async () => {
    const action = vi.fn();
    const { config } = await setup([action]);
    vi.spyOn(config, 'getModel').mockReturnValue('gateway/model');
    await prepareImageBlocks([image], { config });
    expect(action.mock.calls[0][0].imageModel).toEqual({ source: 'qwen-provider', key: 'gateway/model' });
  });

  it('rejects a session model change while resolving image ownership', async () => {
    const action = vi.fn();
    const { config } = await setup([action]);
    vi.spyOn(config.getModelProviderManager(), 'getModel').mockImplementation(async () => {
      vi.mocked(config.getModel).mockReturnValue('other');
      return undefined;
    });
    await expect(prepareImageBlocks([image], { config })).rejects.toThrow('Session model changed');
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps internal image preparation enabled when ordinary hooks are disabled', async () => {
    const action = vi.fn().mockResolvedValue({ hookSpecificOutput: { images: [uploaded] } });
    const { config } = await setup([action]);
    vi.spyOn(config, 'isAllHooksDisabled').mockReturnValue(true);
    expect(await prepareImageBlocks([image], { config })).toEqual([uploaded]);
    expect(action).toHaveBeenCalledOnce();
  });

  it('uses the common runtime timeout and preserves both failure modes', async () => {
    const { config } = await setup([async () => new Promise(() => {})], { timeout: 0.01 });
    expect(await prepareImageBlocks([image], { config })).toEqual([image]);
    await expect(prepareImageBlocks([image], { config, failureMode: 'throw' })).rejects.toThrow();
  });

  it('validates the result after common aggregation', async () => {
    const { config } = await setup([async () => ({ hookSpecificOutput: { images: [] } })]);
    await expect(prepareImageBlocks([image], { config })).rejects.toThrow('preserve image count');
  });
  it('preserves open-source input when no plugin is registered', async () => {
    const { config } = await setup();
    const plan = vi.spyOn(HookPlanner.prototype, 'createExecutionPlan');
    const blocks = [image];
    expect(await prepareImageBlocks(blocks, { config })).toEqual(blocks);
    expect(config.getModelProviderManager).toHaveBeenCalledOnce();
    expect(plan).toHaveBeenCalledOnce();
  });

  it('uses the registered runtime handler, preserves text/order and excludes model credentials', async () => {
    const action = vi
      .fn()
      .mockResolvedValue({ hookSpecificOutput: { images: [uploaded] } });
    const { config } = await setup([action]);
    const plan = vi.spyOn(HookPlanner.prototype, 'createExecutionPlan');
    const text = { type: 'text' as const, text: 'describe' };
    expect(await prepareImageBlocks([text, image], { config })).toEqual([
      text,
      uploaded,
    ]);
    expect(action.mock.calls[0][0].imageModel).toEqual({
      source: 'qwen-provider',
      key: 'main',
    });
    expect(image.source.type).toBe('base64');
    expect(plan).toHaveBeenCalledOnce();
    expect(config.getModelProviderManager).toHaveBeenCalledOnce();
  });

  it('allows a handler to decline without replacing images', async () => {
    const { config } = await setup([async () => undefined]);
    expect(await prepareImageBlocks([image], { config })).toEqual([image]);
  });

  it('uses ordinary aggregation when multiple handlers return images', async () => {
    const secondImage: ModelImageBlock = {
      type: 'image', source: { type: 'url', url: 'https://images.example/second.png' },
    };
    const first = vi.fn().mockResolvedValue({ hookSpecificOutput: { images: [uploaded] } });
    const second = vi.fn().mockResolvedValue({ hookSpecificOutput: { images: [secondImage] } });
    const { config } = await setup([first, second]);
    expect(await prepareImageBlocks([image], { config })).toEqual([secondImage]);
    expect(first).toHaveBeenCalledOnce();
    expect(second).toHaveBeenCalledOnce();
    expect(config.getModelProviderManager).toHaveBeenCalledOnce();
  });

  it('propagates model resolution errors instead of treating them as upload failures', async () => {
    const action = vi.fn();
    const { config } = await setup([action]);
    vi.mocked(config.getModelProviderManager).mockImplementation(() => {
      throw new Error('Model manager is unavailable');
    });
    await expect(prepareImageBlocks([image], { config })).rejects.toThrow('Model manager is unavailable');
    expect(action).not.toHaveBeenCalled();
  });

  it('resolves an explicit model key before dispatching the event', async () => {
    const action = vi.fn().mockResolvedValue({ hookSpecificOutput: { images: [uploaded] } });
    const { config } = await setup([action]);
    const getModel = vi.fn().mockResolvedValue({ source: 'custom', key: 'override', apiKey: 'secret' });
    vi.mocked(config.getModelProviderManager).mockReturnValue({ getModel } as never);
    await prepareImageBlocks([image], { config, modelKey: 'override' });
    expect(getModel).toHaveBeenCalledWith('override');
    expect(action.mock.calls[0][0].imageModel).toEqual({ source: 'custom', key: 'override' });
  });

  it('uses ordinary hook error handling when execution planning fails', async () => {
    const action = vi.fn();
    const { config } = await setup([action]);
    vi.spyOn(HookPlanner.prototype, 'createExecutionPlan').mockImplementation(() => {
      throw new Error('planning failed');
    });
    expect(await prepareImageBlocks([image], { config })).toEqual([image]);
    await expect(
      prepareImageBlocks([image], { config, failureMode: 'throw' }),
    ).rejects.toThrow('planning failed');
    expect(action).not.toHaveBeenCalled();
  });

  it('keeps ordinary input on failure but exposes failure to queue degradation', async () => {
    const { config } = await setup([
      async () => {
        throw new Error('upload failed');
      },
    ]);
    expect(await prepareImageBlocks([image], { config })).toEqual([image]);
    await expect(
      prepareImageBlocks([image], { config, failureMode: 'throw' }),
    ).rejects.toThrow('upload failed');
  });

  it('propagates cancellation', async () => {
    const controller = new AbortController();
    const { config } = await setup([
      async () => {
        controller.abort(new Error('cancel'));
      },
    ]);
    await expect(
      prepareImageBlocks([image], { config, signal: controller.signal }),
    ).rejects.toThrow('cancel');
  });

  it('rejects invalid replacements and changed image counts', () => {
    for (const value of [
      [],
      [null],
      [{ type: 'image', source: { type: 'url', url: 'file:///tmp/private' } }],
    ]) {
      expect(() => validatePreparedImages(value, [image])).toThrow();
    }
    expect(() => validatePreparedImages([image], [uploaded])).toThrow();
  });
});

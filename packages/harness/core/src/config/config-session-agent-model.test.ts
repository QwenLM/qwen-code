/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Config } from './config.js';
import type { LocalAgentDefinition } from '../agents/types.js';
import { makeFakeConfig } from '../test-utils/config.js';
import { testProviderModel } from '../test-utils/model-resolution.js';

const configs: Config[] = [];

afterEach(async () => {
  await Promise.all(configs.splice(0).map((config) => config.dispose()));
  vi.restoreAllMocks();
});

function setup(displayName = 'GLM-5.3', key = 'gm51model') {
  const config = makeFakeConfig({ sessionAgent: 'review' });
  configs.push(config);
  const definition: LocalAgentDefinition = {
    kind: 'local',
    name: 'review',
    description: 'Review changes',
    modelConfig: { model: displayName },
    promptConfig: { systemPrompt: 'Review changes' },
    toolConfig: { tools: ['Read'] },
  };
  const tools = {
    getTool: vi.fn(),
    getKnownTool: vi.fn(),
    getAllToolNames: () => ['Read', 'Write'],
    unregisterTool: vi.fn(),
  };
  const getDefinition = vi.fn(
    (): LocalAgentDefinition | undefined => definition,
  );
  Object.assign(config, {
    agentRegistry: { getDefinition, dispose: vi.fn() },
    _toolRegistry: tools,
  });
  const model = { ...testProviderModel(key), displayName };
  const manager = config.getModelProviderManager();
  const listModels = vi.spyOn(manager, 'listModels').mockResolvedValue([model]);
  const getModel = vi.spyOn(manager, 'getModel').mockResolvedValue(undefined);
  const setModel = vi.spyOn(config, 'setModel').mockResolvedValue(true);
  return {
    config,
    definition,
    tools,
    model,
    listModels,
    getModel,
    setModel,
    getDefinition,
  };
}

describe('session agent model names', () => {
  it('leaves an ambiguous model unapplied and retries after the catalog changes', async () => {
    const h = setup('target', 'Target');
    h.listModels.mockResolvedValue([h.model, { ...h.model, key: 'TARGET' }]);

    await expect(h.config.applySessionAgent()).rejects.toThrow('ambiguous');
    expect(h.config.getSessionAgentDefinition()).toBeUndefined();
    expect(h.tools.unregisterTool).not.toHaveBeenCalled();
    expect(h.setModel).not.toHaveBeenCalled();
    expect(h.getModel).not.toHaveBeenCalled();

    h.listModels.mockResolvedValue([h.model]);
    await h.config.applySessionAgent();
    expect(h.config.getSessionAgentDefinition()).toBe(h.definition);
    expect(h.setModel).toHaveBeenCalledExactlyOnceWith('Target', true);
    expect(h.tools.unregisterTool).toHaveBeenCalledExactlyOnceWith('Write');
  });

  it.each([
    ['GLM-5.3', 'gm51model'],
    ['Kimi-K3.1-Pro', 'kmodel_latest'],
  ])(
    'applies display name %s using its catalog ID',
    async (displayName, key) => {
      const h = setup(displayName, key);
      await h.config.applySessionAgent();

      expect(h.setModel).toHaveBeenCalledExactlyOnceWith(key, true);
      expect(h.definition.modelConfig.model).toBe(displayName);
      expect(h.config.getSessionAgentDefinition()).toBe(h.definition);
      await h.config.applySessionAgent();
      expect(h.setModel).toHaveBeenCalledOnce();
      expect(h.tools.unregisterTool).toHaveBeenCalledExactlyOnceWith('Write');
    },
  );

  it('keeps pending application private and makes concurrent callers wait', async () => {
    const h = setup();
    let resolveSwitch!: (value: boolean) => void;
    h.setModel.mockReturnValue(
      new Promise<boolean>((resolve) => {
        resolveSwitch = resolve;
      }),
    );
    const firstCompleted = vi.fn();
    const secondCompleted = vi.fn();
    const first = h.config.applySessionAgent().then(firstCompleted);
    const second = h.config.applySessionAgent().then(secondCompleted);

    await vi.waitFor(() => expect(h.setModel).toHaveBeenCalledOnce());
    expect(h.config.getSessionAgentDefinition()).toBeUndefined();
    expect(h.tools.unregisterTool).not.toHaveBeenCalled();
    expect(firstCompleted).not.toHaveBeenCalled();
    expect(secondCompleted).not.toHaveBeenCalled();
    resolveSwitch(true);
    await Promise.all([first, second]);
    expect(firstCompleted).toHaveBeenCalledOnce();
    expect(secondCompleted).toHaveBeenCalledOnce();
    expect(h.listModels).toHaveBeenCalledOnce();
    expect(h.tools.unregisterTool).toHaveBeenCalledExactlyOnceWith('Write');
    expect(h.config.getSessionAgentDefinition()).toBe(h.definition);
  });

  it.each(['rejection', 'stale selection'])(
    'leaves model %s retryable without applying prompt or tools',
    async (failure) => {
      const h = setup();
      if (failure === 'rejection')
        h.setModel.mockRejectedValueOnce(new Error('model switch failed'));
      else h.setModel.mockResolvedValueOnce(false);
      const results = await Promise.allSettled([
        h.config.applySessionAgent(),
        h.config.applySessionAgent(),
      ]);
      expect(results.map((result) => result.status)).toEqual([
        'rejected',
        'rejected',
      ]);
      expect(h.setModel).toHaveBeenCalledOnce();
      expect(h.config.getSessionAgentDefinition()).toBeUndefined();
      expect(h.tools.unregisterTool).not.toHaveBeenCalled();

      await h.config.applySessionAgent();
      expect(h.setModel).toHaveBeenCalledTimes(2);
      expect(h.tools.unregisterTool).toHaveBeenCalledExactlyOnceWith('Write');
      expect(h.config.getSessionAgentDefinition()).toBe(h.definition);
    },
  );

  it('can retry an application after the model directory fails to load', async () => {
    const h = setup();
    const error = new Error('catalog unavailable');
    h.listModels.mockRejectedValueOnce(error);
    await expect(h.config.applySessionAgent()).rejects.toBe(error);
    expect(h.config.getSessionAgentDefinition()).toBeUndefined();
    expect(h.tools.unregisterTool).not.toHaveBeenCalled();
    expect(h.setModel).not.toHaveBeenCalled();

    await h.config.applySessionAgent();
    expect(h.config.getSessionAgentDefinition()).toBe(h.definition);
  });

  it('can apply an agent that is registered after the first startup attempt', async () => {
    const h = setup();
    h.getDefinition.mockReturnValueOnce(undefined);
    await h.config.applySessionAgent();
    expect(h.config.getSessionAgentDefinition()).toBeUndefined();
    expect(h.setModel).not.toHaveBeenCalled();

    await h.config.applySessionAgent();
    expect(h.setModel).toHaveBeenCalledOnce();
    expect(h.config.getSessionAgentDefinition()).toBe(h.definition);
  });
});

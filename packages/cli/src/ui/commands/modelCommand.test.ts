/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Model } from '@qwen-code/core';
import type { CommandContext } from './types.js';
import { modelCommand } from './modelCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { ModelSelector } from '../components/ModelSelector.js';

const localModel: Model = {
  source: 'local',
  key: 'local/gpt-test',
  displayName: 'GPT Test',
  capabilities: {
    tools: true,
    vision: false,
    reasoning: { supported: true, supportedEfforts: ['high'] },
    contextWindows: [{ tokens: 128000 }],
  },
  limits: { maxContextTokens: 128000 },
};

function createLocalConfig(setModel = vi.fn().mockResolvedValue(true)) {
  let currentModel = 'auto';
  const manager = {
    listModels: vi.fn(async () => [localModel]),
    getModel: async () => localModel,
    getModelConfig: () => undefined,
    setModelConfig: vi.fn(() => true),
  };
  return {
    getModelProviderManager: () => manager,
    getCustomProviderRegistry: () => ({
      getPublicModels: () => [],
      getProviderForModel: () => undefined,
    }),
    getModelRequestIdentity: () => 'account-a',
    getSessionId: () => 'session-a',
    setModel: vi.fn(async (key: string, temporary: boolean) => {
      const saved = await setModel(key, temporary);
      currentModel = key;
      return saved;
    }),
    getModel: () => currentModel,
  };
}

const providerModel = {
  source: 'qwen-provider',
  key: 'qmodel_38max',
  displayName: 'Qwen3.8-Max',
  enabled: true,
  capabilities: {
    tools: true,
    vision: true,
    reasoning: {
      supported: true,
      supportedEfforts: ['none', 'low', 'high'],
    },
    contextWindows: [{ tokens: 200_000 }],
  },
  limits: { maxContextTokens: 200_000, maxOutputTokens: 32_000 },
} as never;

function withProviderModel(config: ReturnType<typeof createLocalConfig>) {
  const manager = config.getModelProviderManager();
  vi.spyOn(config, 'getModelProviderManager').mockReturnValue({
    ...manager,
    listModels: async () => [providerModel],
  } as never);
  vi.spyOn(config, 'getCustomProviderRegistry').mockReturnValue({
    getPublicModels: () => [],
  } as never);
  return config;
}

describe('modelCommand local fallback', () => {
  let context: CommandContext;

  const run = (args: string) => {
    if (!modelCommand.action) throw new Error('model action is unavailable');
    return modelCommand.action(context, args);
  };

  beforeEach(() => {
    context = createMockCommandContext();
    context.ui.removeComponent = vi.fn();
  });

  it.each(['', 'local/', 'gPt t'])(
    'displays local model names while completing canonical keys for %s',
    async (prefix) => {
      context.services.agentContext = { config: createLocalConfig() } as never;

      expect(await modelCommand.completion?.(context, prefix)).toEqual([
        { label: 'GPT Test', value: 'local/gpt-test' },
      ]);
    },
  );

  it('disambiguates duplicate local display names even when filtering by a single key', async () => {
    const config = createLocalConfig();
    config
      .getModelProviderManager()
      .listModels.mockResolvedValue([
        localModel,
        { ...localModel, source: 'other', key: 'other/gpt-test' },
      ]);
    context.services.agentContext = { config } as never;
    expect(await modelCommand.completion?.(context, 'other/')).toEqual([
      {
        label: 'GPT Test',
        value: 'other/gpt-test',
        description: 'other/gpt-test',
      },
    ]);
  });

  it('resolves a local provider display name case-insensitively', async () => {
    const setModel = vi.fn();
    context.services.agentContext = {
      config: createLocalConfig(setModel),
    } as never;

    await run('gpt test --session-only');

    expect(setModel).toHaveBeenCalledWith('local/gpt-test', true);
  });

  it('includes provider-manager models in completion', async () => {
    const config = withProviderModel(createLocalConfig());
    context.services.agentContext = { config } as never;

    expect(await modelCommand.completion?.(context, 'qwen3.8')).toEqual([
      { label: 'Qwen3.8-Max', value: 'qmodel_38max' },
    ]);
  });

  it('switches to a provider-manager model by display name', async () => {
    const setModel = vi.fn();
    const config = withProviderModel(createLocalConfig(setModel));
    context.services.agentContext = { config } as never;

    await run('qwen3.8-max');

    expect(setModel).toHaveBeenCalledWith('qmodel_38max', false);
  });

  it('switches to a provider-manager model by key', async () => {
    const setModel = vi.fn();
    const config = withProviderModel(createLocalConfig(setModel));
    context.services.agentContext = { config } as never;

    await run('qmodel_38max');

    expect(setModel).toHaveBeenCalledWith('qmodel_38max', false);
  });

  it('passes the provider catalog into the open-source selector', async () => {
    const config = withProviderModel(createLocalConfig());
    context.services.agentContext = { config } as never;

    const result = (await run('')) as {
      type: string;
      component: React.ReactElement<{
        listedModels?: ReadonlyArray<{ key: string }>;
      }>;
    };

    expect(result.type).toBe('custom_dialog');
    expect(result.component.props.listedModels?.map((model) => model.key)).toContain(
      'qmodel_38max',
    );
  });

  it('drops completions from a previous session config', async () => {
    const config = createLocalConfig();
    let finish!: (models: Model[]) => void;
    config.getModelProviderManager().listModels.mockReturnValueOnce(
      new Promise<Model[]>((resolve) => {
        finish = resolve;
      }),
    );
    context.services.agentContext = { config } as never;
    const pending = modelCommand.completion?.(context, '');
    context.services.agentContext = { config: createLocalConfig() } as never;
    finish([localModel]);
    await expect(pending).resolves.toEqual([]);
  });

  it('rejects a non-local model', async () => {
    context.services.agentContext = { config: createLocalConfig() } as never;

    await run('commercial-only');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('to see available models'),
      }),
    );
  });

  it('keeps the latest selection when an older provider lookup completes late', async () => {
    const config = createLocalConfig();
    const second = {
      ...localModel,
      key: 'local/second',
      displayName: 'Second',
    };
    const models = [localModel, second];
    let finish!: (value: Model[]) => void;
    config
      .getModelProviderManager()
      .listModels.mockReturnValueOnce(
        new Promise<Model[]>((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce(models);
    context.services.agentContext = { config } as never;
    const first = run('local/gpt-test');
    await run('local/second');
    finish(models);
    await first;
    expect(config.getModel()).toBe('local/second');
    expect(config.setModel).toHaveBeenCalledExactlyOnceWith(
      'local/second',
      false,
    );
  });

  it('等待保存结果，false 仍提示模型已切换但保存失败', async () => {
    let resolve!: (saved: boolean) => void;
    const setModel = vi.fn(
      () =>
        new Promise<boolean>((yes) => {
          resolve = yes;
        }),
    );
    const config = createLocalConfig(setModel);
    context.services.agentContext = { config } as never;
    const pending = run('local/gpt-test');
    expect(context.ui.addItem).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(setModel).toHaveBeenCalled());
    resolve(false);
    await pending;
    expect(config.getModel()).toBe('local/gpt-test');
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Failed to save the preferred model'),
      }),
    );
    expect(
      config.getModelProviderManager().setModelConfig,
    ).not.toHaveBeenCalled();
  });

  it('Config 替换后不继续应用 effort', async () => {
    let resolve!: (saved: boolean) => void;
    const config = createLocalConfig(
      vi.fn(
        () =>
          new Promise<boolean>((yes) => {
            resolve = yes;
          }),
      ),
    );
    context.services.agentContext = { config } as never;
    const pending = run('local/gpt-test high');
    await vi.waitFor(() => expect(config.setModel).toHaveBeenCalled());
    context.services.agentContext = { config: createLocalConfig() } as never;
    resolve(true);
    await expect(pending).rejects.toThrow('会话目标已变化');
    expect(
      config.getModelProviderManager().setModelConfig,
    ).not.toHaveBeenCalled();
  });

  it('关闭后的 picker 回调不切换模型', async () => {
    const config = createLocalConfig();
    context.services.agentContext = { config } as never;
    const result = await run('');
    if (
      result?.type !== 'custom_dialog' ||
      !React.isValidElement(result.component)
    )
      throw new Error('missing picker');
    const props = result.component.props as {
      onClose: () => void;
      onSelect: (key: string) => Promise<void>;
    };
    props.onClose();
    await props.onSelect('local/gpt-test');
    expect(config.setModel).not.toHaveBeenCalled();
  });

  it('opens the open-source selector', async () => {
    context.services.agentContext = { config: createLocalConfig() } as never;

    const result = await run('');

    expect(result?.type).toBe('custom_dialog');
    if (
      result?.type === 'custom_dialog' &&
      React.isValidElement(result.component)
    ) {
      expect(result.component.type).toBe(ModelSelector);
    }
  });
});

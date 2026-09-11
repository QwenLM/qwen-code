/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ModelsConfig } from './modelsConfig.js';
import { AuthType } from '../core/contentGenerator.js';
import type { ModelProvidersConfig } from './types.js';
import type { ReasoningEffort } from '../core/reasoning-effort.js';

const providers = (defaultEffort: ReasoningEffort): ModelProvidersConfig => ({
  openai: [
    {
      id: 'alias',
      generationConfig: {
        reasoningConfig: { profile: 'openai-effort', defaultEffort },
      },
    },
  ],
});

describe('model providers reload at the next user prompt', () => {
  function create() {
    return new ModelsConfig({
      initialAuthType: AuthType.USE_OPENAI,
      generationConfig: { model: 'alias' },
      modelProvidersConfig: providers('low'),
    });
  }

  it('stages immutable latest settings without changing the active registry', async () => {
    const config = create();
    config.stageModelProvidersReload(providers('medium'));
    const latest = providers('high');
    config.stageModelProvidersReload(latest);
    latest['openai']![0]!.generationConfig!.reasoningConfig!.defaultEffort =
      'max';
    expect(config.getModelProvidersConfig()).toEqual(providers('low'));
    const refresh = vi.fn(async () => {
      expect(config.getModelProvidersConfig()).toEqual(providers('high'));
    });
    expect(await config.applyPendingModelProvidersReload(refresh)).toBe(true);
    expect(await config.applyPendingModelProvidersReload(refresh)).toBe(false);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('keeps a reload staged during refresh for the following user prompt', async () => {
    const config = create();
    config.stageModelProvidersReload(providers('medium'));
    await config.applyPendingModelProvidersReload(async () => {
      config.stageModelProvidersReload(providers('max'));
    });
    expect(config.getModelProvidersConfig()).toEqual(providers('medium'));
    await config.applyPendingModelProvidersReload(async () => {});
    expect(config.getModelProvidersConfig()).toEqual(providers('max'));
  });

  it('discards an older staged snapshot after a successful immediate reload', async () => {
    const config = create();
    config.stageModelProvidersReload(providers('medium'), undefined, 'alias');
    config.reloadModelProvidersConfig(providers('high'));
    expect(await config.applyPendingModelProvidersReload(async () => {})).toBe(
      false,
    );
    expect(config.getModelProvidersConfig()).toEqual(providers('high'));
    expect(config['pendingModelSelection']).toBeUndefined();
    expect(config['pendingModelSelectionSource']).toBeUndefined();
  });

  it('applies a model selected in the same settings update against the new registry', async () => {
    const config = create();
    const next = providers('medium');
    next['openai']!.push({
      id: 'new-alias',
      generationConfig: {
        reasoningConfig: {
          profile: 'openai-effort',
          defaultEffort: 'high',
        },
      },
    });
    config.stageModelProvidersReload(next, undefined, 'new-alias');
    config.stageModelProvidersReload(structuredClone(next));
    await config.applyPendingModelProvidersReload(async (selection) => {
      expect(selection).toEqual({ modelId: 'new-alias' });
      await config.switchModel(AuthType.USE_OPENAI, selection!.modelId);
    });
    expect(config.getModel()).toBe('new-alias');
  });

  it('preserves an exact endpoint selected with the same model id', async () => {
    const config = create();
    const next: ModelProvidersConfig = {
      openai: [
        {
          id: 'alias',
          baseUrl: 'https://first.example/v1',
          generationConfig: {
            reasoningConfig: {
              profile: 'openai-effort',
              defaultEffort: 'low',
            },
          },
        },
        {
          id: 'alias',
          baseUrl: 'https://second.example/v1',
          generationConfig: {
            reasoningConfig: {
              profile: 'openai-effort',
              defaultEffort: 'high',
            },
          },
        },
      ],
    };
    config.stageModelProvidersReload(
      next,
      undefined,
      'alias',
      'https://second.example/v1',
    );
    await config.applyPendingModelProvidersReload(async (selection) => {
      expect(selection).toEqual({
        modelId: 'alias',
        baseUrl: 'https://second.example/v1',
      });
      await config.switchModel(AuthType.USE_OPENAI, selection!.modelId, {
        baseUrl: selection!.baseUrl,
      });
    });
    expect(config.getCurrentRegistryBaseUrl()).toBe(
      'https://second.example/v1',
    );
  });

  it('does not overwrite a model explicitly selected after staging', async () => {
    const config = create();
    const next = providers('medium');
    next['openai']!.push({ id: 'staged-alias' }, { id: 'user-alias' });
    config.reloadModelProvidersConfig(next);
    config.stageModelProvidersReload(next, undefined, 'staged-alias');
    await config.switchModel(AuthType.USE_OPENAI, 'user-alias');

    const refresh = vi.fn(async (selection) => {
      expect(selection).toBeUndefined();
    });
    await config.applyPendingModelProvidersReload(refresh);

    expect(config.getModel()).toBe('user-alias');
  });

  it('does not revive a staged selection after switching away and back', async () => {
    const config = create();
    const next = providers('medium');
    next['openai']!.push({ id: 'staged-alias' }, { id: 'user-alias' });
    config.reloadModelProvidersConfig(next);
    config.stageModelProvidersReload(next, undefined, 'staged-alias');
    await config.switchModel(AuthType.USE_OPENAI, 'user-alias');
    await config.switchModel(AuthType.USE_OPENAI, 'alias');

    await config.applyPendingModelProvidersReload(async (selection) => {
      expect(selection).toBeUndefined();
    });

    expect(config.getModel()).toBe('alias');
  });

  it('drops an unresolvable staged selection without blocking provider reload', async () => {
    const config = create();
    const next = providers('medium');
    config.stageModelProvidersReload(next, undefined, 'missing-model');

    expect(
      await config.applyPendingModelProvidersReload(async (selection) => {
        if (selection)
          await config.switchModel(AuthType.USE_OPENAI, selection.modelId);
      }),
    ).toBe(true);
    expect(config.getModelProvidersConfig()).toEqual(next);
    expect(config.getModel()).toBe('alias');
    expect(await config.applyPendingModelProvidersReload(async () => {})).toBe(
      false,
    );
  });

  it('rolls back registry and selection when refresh fails, retaining the pending update', async () => {
    const config = create();
    config.stageModelProvidersReload(providers('high'));
    await expect(
      config.applyPendingModelProvidersReload(async () => {
        config.syncAfterAuthRefresh(AuthType.USE_OPENAI, 'alias');
        throw new Error('credentials unavailable');
      }),
    ).rejects.toThrow('credentials unavailable');
    expect(config.getModelProvidersConfig()).toEqual(providers('low'));
    expect(config.getGenerationConfig()).toEqual({ model: 'alias' });
    expect(await config.applyPendingModelProvidersReload(async () => {})).toBe(
      true,
    );
    expect(config.getModelProvidersConfig()).toEqual(providers('high'));
  });

  it('rejects invalid updates without discarding the previous pending snapshot', async () => {
    const config = create();
    config.stageModelProvidersReload(providers('medium'));
    const invalid = providers('high');
    invalid['openai']![0]!.generationConfig!.reasoningConfig!.supportedEfforts =
      ['low'];
    expect(() => config.stageModelProvidersReload(invalid)).toThrow(
      'defaultEffort',
    );
    await config.applyPendingModelProvidersReload(async () => {});
    expect(config.getModelProvidersConfig()).toEqual(providers('medium'));
  });
});

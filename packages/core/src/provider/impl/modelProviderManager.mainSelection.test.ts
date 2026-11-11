/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from '@qwen-code/resource';
import type { ModelProvider } from '../modelProvider.js';
import type { Model } from '../model/model.js';
import { mergeModelConfig } from '../model/modelConfig.js';
import { ModelNotFoundError } from '../../utils/httpErrors.js';
import type { ModelSelectContext } from '../model/modelSelectContext.js';
import { ModelProviderManager } from './modelProviderManager.js';
import { ModelTransportManager } from '../transport/modelTransportManager.js';
import { resolveModelSelectionOverride } from '../session-model.js';

function model(key: string, source = 'qoder'): Model {
  return {
    key,
    source,
    displayName: key,
    capabilities: {
      tools: true,
      vision: false,
      reasoning: {
        supported: true,
        supportedEfforts: ['none', 'low', 'medium', 'high'],
      },
      contextWindows: [{ tokens: 128000 }, { tokens: 256000 }],
    },
    limits: { maxContextTokens: 256000 },
  };
}

function provider(models: Model[]): ModelProvider {
  const configs = new Map<string, import('../model/model.js').ModelConfig>();
  return {
    providerId: models[0].source,
    start: async () => {},
    stop: async () => {},
    listModels: async () => models,
    getModel: async (key) => models.find((entry) => entry.key === key),
    select: vi.fn(async (ctx: ModelSelectContext) => {
      const override = ctx.overrideSelection;
      const selected =
        override && 'model' in override
          ? models.find((entry) => entry.key === override.model.key)
          : (ctx.parentSelection?.model ?? ctx.mainModel);
      if (!selected || selected.enabled === false) {
        throw new ModelNotFoundError(
          '模型不可用',
          selected?.enabled === false ? 403 : 404,
        );
      }
      if (ctx.parentSelection?.model.key === selected.key)
        return ctx.parentSelection;
      return {
        model: selected,
        config: mergeModelConfig(
          selected.defaultModelConfig,
          configs.get(selected.key),
        ),
      };
    }),
    getModelConfig: (model) => configs.get(model.key),
    setModelConfig: (model, patch) => {
      configs.set(model.key, { ...configs.get(model.key), ...patch });
      return true;
    },
    inference: vi.fn(),
  };
}

describe('ModelProviderManager main selection', () => {
  function setup() {
    const anchor = model('auto');
    const override = model('gateway/fast', 'gateway');
    const primary = provider([anchor, model('lite')]);
    const gateway = provider([override]);
    const manager = new ModelProviderManager({
      userProviders: [primary, gateway],
      modelTransportManager: new ModelTransportManager([]),
      settingsService: new SettingsService(),
    });
    manager.setMainModel(anchor);
    return { manager, anchor, override, primary, gateway };
  }

  it('does not cross the anchored provider when a session policy overrides the model', async () => {
    const { manager, anchor, override } = setup();
    const policy = vi.fn(async () => ({ key: override.key }));
    manager.setSelectionPolicy(policy);
    await expect(
      manager.select({
        purpose: 'main',
        request: { sessionId: 'session', turnIndex: 0 },
      }),
    ).rejects.toThrow('outside the anchored provider');
    expect(policy).toHaveBeenCalledOnce();
    expect(manager.getMainModelKey()).toBe(anchor.key);
  });

  it('selects main using only its purpose and stored model preferences', async () => {
    const { manager, primary, anchor } = setup();
    manager.setModelConfig(anchor, {
      reasoning: { effort: 'low' },
      context: { contextWindow: 128000 },
    });
    expect(
      await manager.select({
        purpose: 'main',
      }),
    ).toMatchObject({
      config: {
        reasoning: { effort: 'low' },
        context: { contextWindow: 128000 },
      },
    });
    expect(primary.select).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: 'main', mainModel: anchor }),
    );
    expect(vi.mocked(primary.select).mock.calls[0]![0]).not.toHaveProperty(
      'modelConfig',
    );
    expect(manager.getModelConfig(model('auto'))?.reasoning?.effort).toBe(
      'low',
    );
  });

  it('原样透传请求级 workdirs，不写入选模结果或会话锚点', async () => {
    const { manager, anchor, primary } = setup();
    const workdirs = Object.freeze(['/repo-a', '/repo-b']);
    const providerContext = Object.freeze({ tenant: 'test' });
    const input = Object.freeze({
      purpose: 'main' as const,
      workdirs,
      providerContext,
    });
    const result = await manager.select(input);
    const received = vi.mocked(primary.select).mock.calls[0]![0] as typeof input;
    expect(received.workdirs).toBe(workdirs);
    expect(received.providerContext).toBe(providerContext);
    expect(input).toEqual({ purpose: 'main', workdirs, providerContext });
    expect(result).not.toHaveProperty('workdirs');
    expect(result).not.toHaveProperty('providerContext');
    expect(await manager.getMainModel()).toBe(anchor);
  });

  it.each([false, true])(
    '规范化父选择（跨 owner=%s）时保留扩展和请求覆盖，不修改输入',
    async (foreign) => {
      const { manager, anchor, override, primary, gateway } = setup();
      const workdirs = Object.freeze(['/repo']);
      const parentSelection = {
        model: foreign ? override : anchor,
        config: {},
      };
      const overrideSelection = { model: anchor, config: {} };
      const input = Object.freeze({
        purpose: 'main' as const,
        parentSelection,
        overrideSelection,
        workdirs,
      });
      const result = await manager.select(input);
      const received = vi.mocked(primary.select).mock
        .calls[0]![0] as typeof input;
      expect(received.parentSelection).toBe(
        foreign ? undefined : parentSelection,
      );
      expect(received.overrideSelection).toBe(overrideSelection);
      expect(received.workdirs).toBe(workdirs);
      expect(input.parentSelection).toBe(parentSelection);
      expect(result.model).toBe(anchor);
      expect(gateway.select).not.toHaveBeenCalled();
      expect(await manager.getMainModel()).toBe(anchor);
    },
  );

  it('本次业务覆盖优先，但不写回 provider 偏好', async () => {
    const { manager, anchor } = setup();
    manager.setModelConfig(anchor, { reasoning: { effort: 'low' } });
    expect(
      (
        await manager.select({
          purpose: 'main',
          overrideSelection: {
            model: anchor,
            config: { reasoning: { effort: 'high' } },
          },
        })
      ).config.reasoning?.effort,
    ).toBe('high');
    expect(manager.getModelConfig(model('auto'))?.reasoning?.effort).toBe(
      'low',
    );
    expect(
      (await manager.select({ purpose: 'main' })).config.reasoning?.effort,
    ).toBe('low');
  });

  it('context 主模型取当前会话锚点，覆盖调用方旧值且不修改输入', async () => {
    const { manager, anchor, override, primary, gateway } = setup();
    const input = Object.freeze({
      purpose: 'main' as const,
      mainModel: override,
    });
    expect((await manager.select(input)).model).toBe(anchor);
    expect(vi.mocked(primary.select).mock.calls[0]![0]).toHaveProperty(
      'mainModel',
      anchor,
    );
    expect(input.mainModel).toBe(override);
    expect(await manager.getMainModel()).toBe(anchor);
    expect(gateway.select).not.toHaveBeenCalled();
    const next = (await manager.getModel('lite'))!;
    manager.setMainModel(next);
    expect(await manager.getMainModel()).toBe(next);
    expect((await manager.select(input)).model).toBe(next);
    expect(vi.mocked(primary.select).mock.lastCall?.[0].mainModel).toBe(next);
    expect(
      (
        await manager.select({
          purpose: 'main',
          overrideSelection: { model: anchor, config: {} },
        })
      ).model,
    ).toBe(anchor);
    expect(await manager.getMainModel()).toBe(next);
  });

  it('一次 select 只查询一次主模型，Provider 直接读取 context', async () => {
    const { manager, anchor, primary } = setup();
    const getMainModel = vi.spyOn(manager, 'getMainModel');
    expect((await manager.select({ purpose: 'main' })).model).toBe(anchor);
    expect(getMainModel).toHaveBeenCalledOnce();
    expect(vi.mocked(primary.select).mock.lastCall?.[0].mainModel).toBe(anchor);
  });

  it('主模型获取失败时不委派 Provider，不静默回退', async () => {
    const { manager, primary, gateway } = setup();
    const error = new Error('会话主模型未就绪');
    vi.spyOn(manager, 'getMainModel').mockRejectedValue(error);
    await expect(manager.select({ purpose: 'main' })).rejects.toBe(error);
    expect(primary.select).not.toHaveBeenCalled();
    expect(gateway.select).not.toHaveBeenCalled();
  });

  it('uses model defaults when there are no stored preferences', async () => {
    const { manager } = setup();
    expect((await manager.select({ purpose: 'main' })).config).toEqual({
      reasoning: { effort: 'medium' },
      context: { contextWindow: 256000 },
    });
    expect(manager.getModelConfig(model('auto'))).toBeUndefined();
  });

  it.each(['main', 'task', 'compact', 'title'] as const)(
    '%s rejects a key outside the anchored provider without switching it',
    async (purpose) => {
      const { manager, anchor, override, primary, gateway } = setup();
      await expect(
        manager.select({
          purpose,
          overrideSelection: { model: override, config: {} },
        }),
      ).rejects.toMatchObject({ code: 404 });
      expect(primary.select).not.toHaveBeenCalled();
      expect(gateway.select).not.toHaveBeenCalled();
      expect(await manager.getMainModel()).toBe(anchor);
    },
  );

  it('allows the other provider only after explicitly switching the main model', async () => {
    const { manager, override, primary, gateway } = setup();
    manager.setMainModel(override, false);
    expect((await manager.select({ purpose: 'main' })).model).toBe(override);
    expect(gateway.select).toHaveBeenCalledOnce();
    expect(primary.select).not.toHaveBeenCalled();
  });

  it('keeps parent configuration on a same-model policy reselect and caps output', async () => {
    const { manager, anchor } = setup();
    const parentResolution = {
      model: { ...anchor, limits: { ...anchor.limits, maxOutputTokens: 1024 } },
      config: {
        reasoning: { effort: 'high' as const },
        sampling: { temperature: 0.2 },
      },
    };
    const resolution = await manager.select({
      purpose: 'compact',
      parentSelection: parentResolution,
      overrideSelection: {
        model: parentResolution.model,
        config: {
          context: { maxOutputTokens: 4096 },
          reasoning: { preserve: false },
        },
      },
    });
    expect(resolution.config).toMatchObject({
      reasoning: { effort: 'high', preserve: false },
      sampling: { temperature: 0.2 },
      context: { maxOutputTokens: 1024 },
    });
    expect(Object.keys(resolution).sort()).toEqual(['config', 'model']);
  });

  it('fails an unknown explicit main model without selecting the session default', async () => {
    const { manager, primary } = setup();
    await expect(
      manager.select({
        purpose: 'main',
        overrideSelection: { model: model('missing'), config: {} },
      }),
    ).rejects.toMatchObject({ code: 404 });
    expect(primary.select).toHaveBeenCalledOnce();
  });

  it('模型 key 兑换保留模型身份，不选择或切换主模型，缺失时报错', async () => {
    const { manager, anchor, primary } = setup();
    const config = { context: { maxOutputTokens: 4096 } };
    const override = await resolveModelSelectionOverride(
      manager,
      'lite',
      config,
    );
    expect(override.model.key).toBe('lite');
    expect(override.config).toBe(config);
    expect(primary.select).not.toHaveBeenCalled();
    expect(await manager.getMainModel()).toBe(anchor);
    await expect(
      resolveModelSelectionOverride(manager, 'missing'),
    ).rejects.toMatchObject({ code: 404 });
  });

  it('blocks a disabled main model returned by its provider', async () => {
    const { manager, anchor, primary } = setup();
    vi.mocked(primary.select).mockResolvedValue({
      model: { ...anchor, enabled: false },
      config: {},
    });
    await expect(manager.select({ purpose: 'main' })).rejects.toMatchObject({
      code: 403,
    });
    expect(primary.select).toHaveBeenCalledOnce();
  });
});

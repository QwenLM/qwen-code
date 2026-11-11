/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelSelection } from '../provider/model/modelSelection.js';
import { describe, expect, it, vi } from 'vitest';
import { SettingsService } from '@qwen-code/resource';
import type { Model } from '../provider/model/model.js';
import type { ModelProvider } from '../provider/modelProvider.js';
import { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import { mergeModelConfig } from '../provider/model/modelConfig.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';
import { ModelNotFoundError } from '../utils/httpErrors.js';
import { FatalRoutingError } from '../routing/errors.js';
import { createModelSelectionPolicy } from './model-policy.js';
import { createCompactRequestResolver } from './compact-request-resolver.js';
import type { Config } from '../config/config.js';
import type {
  GetModelPolicyCallback,
  RequestModelOverride,
} from './model-policy.js';
import { createModelRequestGuard } from '../provider/session-model.js';
import { testRequestConfig } from '../test-utils/model-resolution.js';

function setup() {
  const models: Model[] = [];
  const provider = {
    providerId: 'qoder',
    start: async () => {},
    stop: async () => {},
    listModels: async () => models,
    getModel: async (key) => models.find((model) => model.key === key),
    getModelConfig: () => undefined,
    setModelConfig: vi.fn(() => true),
    select: vi.fn(
      async (
        context: ModelSelectContext & { overrideSelection?: ModelSelection } & {
          readonly workdirs?: readonly string[];
        },
      ) => {
        const key =
          context.overrideSelection?.model.key ??
          context.parentSelection?.model.key ??
          context.mainModel?.key;
        const model = models.find((entry) => entry.key === key);
        if (!model) throw new ModelNotFoundError('目录中没有模型', 404);
        // 对齐实际 selector：同模型的 main/task/compact 请求继承父配置。
        const parent = context.parentSelection;
        const inheritsParent =
          ['main', 'hook_prompt', 'task', 'compact'].includes(
            context.purpose,
          ) &&
          parent?.model.key === model.key &&
          parent.model.source === model.source;
        return {
          model,
          config: mergeModelConfig(
            inheritsParent ? parent.config : model.defaultModelConfig,
            context.overrideSelection?.config,
          ),
        };
      },
    ),
    inference: vi.fn(),
  } satisfies ModelProvider;
  const manager: ModelProviderManager = new ModelProviderManager({
    userProviders: [
      provider,
      {
        ...provider,
        providerId: 'other',
        listModels: async () => [
          { ...directModel, key: 'foreign', source: 'other' },
        ],
        getModel: async (key) =>
          key === 'foreign'
            ? { ...directModel, key, source: 'other' }
            : undefined,
      },
    ],
    modelTransportManager: new ModelTransportManager([]),
    settingsService: new SettingsService(),
    createSelectionRequestGuard: (signal) =>
      createModelRequestGuard(config, signal),
  });
  manager.setMainModel(directModel, false);
  const state = {
    key: 'direct',
    identity: 'account-1',
    sessionId: 'session-1',
    manager,
  };
  const config = {
    ...testRequestConfig(),
    getModel: () => state.key,
    getModelRequestIdentity: () => state.identity,
    getSessionId: () => state.sessionId,
    getModelProviderManager: () => state.manager,
  };
  const input = { purpose: 'main' as const, workdirs: ['/repo'] };
  const run = (
    getModelPolicy: GetModelPolicyCallback,
    modelOverride?: RequestModelOverride,
    signal?: AbortSignal,
  ) => {
    manager.setSelectionPolicy(createModelSelectionPolicy(getModelPolicy));
    return manager
      .select({
        ...input,
        overrideSelection: modelOverride,
        request: { sessionId: state.sessionId, turnIndex: 0 },
        signal,
      })
      .then(({ model, config, policy }) => ({
        resolution: { model, config },
        labels: policy?.labels,
        overridden: policy?.overridden,
      }));
  };
  return { models, provider, manager, state, config, run };
}

const directModel: Model = {
  key: 'direct',
  source: 'qoder',
  displayName: 'Direct',
  capabilities: {
    tools: true,
    vision: false,
    reasoning: { supported: true, supportedEfforts: ['none', 'low', 'high'] },
    contextWindows: [{ tokens: 1000 }, { tokens: 2000 }],
  },
  limits: { maxContextTokens: 2000 },
};

describe('手动压缩前置选模的 SDK 恢复', () => {
  const requestModel = { ...directModel, key: 'requested' };
  const policyModel = { ...directModel, key: 'policy' };
  const requestConfig = {
    context: { maxOutputTokens: 512 },
    sampling: { temperature: 0.3 },
  };

  function compact(
    fixture: ReturnType<typeof setup>,
    getModelPolicy: GetModelPolicyCallback,
    signal = new AbortController().signal,
  ) {
    fixture.manager.setSelectionPolicy(
      createModelSelectionPolicy(getModelPolicy),
    );
    return createCompactRequestResolver({
      config: {
        ...fixture.config,
        hasModelProviderManager: () => true,
        getWorkspaceContext: () => ({ getDirectories: () => ['/repo'] }),
        getModelPolicy,
      } as unknown as Config,
      parent: { model: 'requested', source: 'explicit', config: requestConfig },
      signal,
      sessionId: 'session-1',
      turnIndex: 2,
      logLabel: 'manual compact test',
    });
  }

  it('合法父模型准备不调用 compact 策略，实际压缩时才调用一次', async () => {
    const fixture = setup();
    fixture.models.push(directModel, requestModel, policyModel);
    const host = vi.fn(async () => ({ model: 'policy' }));
    const resolve = compact(fixture, host);
    const prepared = await resolve.prepareParent();
    expect(await resolve.prepareParent()).toBe(prepared);
    expect(prepared.model).toBe('requested');
    expect(prepared.modelResolution.config).toMatchObject(requestConfig);
    expect(host).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(fixture.provider.select)
        .mock.calls.map(([input]) => input.purpose),
    ).toEqual(['main']);
    const request = await resolve();
    expect(request.model).toBe('policy');
    expect(request.modelResolution.config).toMatchObject(requestConfig);
    expect(await resolve()).toBe(request);
    expect(host).toHaveBeenCalledOnce();
    const selections = vi.mocked(fixture.provider.select).mock.calls;
    const workdirs = selections[0]![0].workdirs;
    expect(workdirs).toEqual(['/repo']);
    expect(selections.every(([input]) => input.workdirs === workdirs)).toBe(
      true,
    );
  });

  it.each([
    undefined,
    { parameters: { reasoningEffort: 'low' as const } },
    { model: 'policy' },
  ])('父模型准备缺失时以 %s 恢复，后续压缩不重复调用宿主', async (policy) => {
    const fixture = setup();
    fixture.models.push(directModel);
    const host = vi.fn(async () => {
      fixture.models.push(requestModel, policyModel);
      return policy;
    });
    const resolve = compact(fixture, host);
    const request = await resolve.prepareParent();
    expect(request.model).toBe(
      policy && 'model' in policy ? policy.model : 'requested',
    );
    expect(request.modelResolution.config).toMatchObject(requestConfig);
    expect(await resolve()).toBe(request);
    expect(await resolve.prepareParent()).toBe(request);
    expect(host).toHaveBeenCalledOnce();
    expect(await fixture.manager.getMainModel()).toBe(directModel);
  });

  it('父模型准备 main 404 在宿主响应前不重复选模', async () => {
    const fixture = setup();
    fixture.models.push(directModel, requestModel);
    vi.mocked(fixture.provider.select).mockRejectedValueOnce(
      new ModelNotFoundError('暂缺主模型', 404),
    );
    const host = vi.fn(async () => {
      expect(fixture.provider.select).toHaveBeenCalledOnce();
      return undefined;
    });
    const resolve = compact(fixture, host);
    const request = await resolve.prepareParent();
    expect(await resolve()).toBe(request);
    expect(host).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(fixture.provider.select)
        .mock.calls.map(([input]) => input.purpose),
    ).toEqual(['main', 'main', 'compact']);
  });

  it.each(['key', 'identity', 'sessionId', 'manager'] as const)(
    '父模型准备期间 %s 变化，不调用宿主或 compact 选模',
    async (field) => {
      const fixture = setup();
      fixture.models.push(directModel, requestModel);
      vi.mocked(fixture.provider.select).mockImplementationOnce(async () => {
        if (field === 'manager') fixture.state.manager = setup().manager;
        else fixture.state[field] = 'changed';
        return { model: requestModel, config: requestConfig };
      });
      const host = vi.fn(async () => undefined);
      const resolve = compact(fixture, host);
      await expect(resolve.prepareParent()).rejects.toThrow(
        'Session model changed',
      );
      expect(host).not.toHaveBeenCalled();
      expect(fixture.provider.select).toHaveBeenCalledOnce();
    },
  );

  it('父模型准备 main 403 阻断，不调用宿主', async () => {
    const fixture = setup();
    fixture.models.push(directModel, requestModel);
    const error = new ModelNotFoundError('仓库受限', 403);
    vi.mocked(fixture.provider.select).mockRejectedValue(error);
    const host = vi.fn(async () => undefined);
    await expect(compact(fixture, host).prepareParent()).rejects.toBe(error);
    expect(host).not.toHaveBeenCalled();
  });

  it.each([undefined, { parameters: { reasoningEffort: 'low' as const } }])(
    '压缩前置模型缺失，宿主返回 %s 后恢复原显式模型且只调用一次策略',
    async (policy) => {
      const fixture = setup();
      fixture.models.push(directModel);
      const host = vi.fn(async () => {
        fixture.models.push(requestModel);
        return policy;
      });
      const resolve = compact(fixture, host);
      const request = await resolve();
      expect(await resolve()).toBe(request);
      expect(request.model).toBe('requested');
      expect(request.modelResolution.config).toMatchObject(requestConfig);
      if (policy) expect(request.reasoningEffort).toBe('low');
      expect(host).toHaveBeenCalledExactlyOnceWith(
        'compact',
        'session-1',
        2,
        undefined,
        expect.any(AbortSignal),
        {},
      );
      expect(
        vi
          .mocked(fixture.provider.select)
          .mock.calls.map(([input]) => input.purpose),
      ).toEqual(policy ? ['main', 'compact', 'compact'] : ['main', 'compact']);
      expect(
        vi
          .mocked(fixture.provider.select)
          .mock.calls.every(([input]) => input.workdirs?.[0] === '/repo'),
      ).toBe(true);
      expect(await fixture.manager.getMainModel()).toBe(directModel);
    },
  );

  it('压缩显式策略替换缺失模型，不把策略模型写为主锚点', async () => {
    const fixture = setup();
    fixture.models.push(directModel);
    const request = await compact(fixture, async () => {
      fixture.models.push(policyModel);
      return { model: 'policy', labels: { taskId: 'compact-host' } };
    })();
    expect(request.model).toBe('policy');
    expect(request.modelResolution.config).toMatchObject(requestConfig);
    expect(request.policyLabels).toEqual({ taskId: 'compact-host' });
    expect(
      vi
        .mocked(fixture.provider.select)
        .mock.calls.map(([input]) => input.purpose),
    ).toEqual(['compact']);
    expect(await fixture.manager.getMainModel()).toBe(directModel);
    expect(fixture.provider.setModelConfig).not.toHaveBeenCalled();
  });

  it('压缩前置 main 选模 404 也在恢复边界内', async () => {
    const fixture = setup();
    fixture.models.push(directModel, requestModel);
    vi.mocked(fixture.provider.select).mockRejectedValueOnce(
      new ModelNotFoundError('暂缺主模型', 404),
    );
    const host = vi.fn(async () => undefined);
    expect((await compact(fixture, host)()).model).toBe('requested');
    expect(host).toHaveBeenCalledOnce();
    expect(
      vi
        .mocked(fixture.provider.select)
        .mock.calls.map(([input]) => input.purpose),
    ).toEqual(['main', 'main', 'compact']);
  });

  it('压缩前置 403 不调用宿主、不进入 compact 选模', async () => {
    const fixture = setup();
    fixture.models.push(directModel, requestModel);
    const error = new ModelNotFoundError('仓库受限', 403);
    vi.mocked(fixture.provider.select).mockRejectedValue(error);
    const host = vi.fn(async () => undefined);
    await expect(compact(fixture, host)()).rejects.toBe(error);
    expect(host).not.toHaveBeenCalled();
    expect(fixture.provider.select).toHaveBeenCalledOnce();
  });

  it.each(['key', 'identity', 'sessionId', 'manager'] as const)(
    '压缩前置 main 选模期间 %s 变化，不进入 compact 或宿主恢复',
    async (field) => {
      const fixture = setup();
      fixture.models.push(directModel, requestModel);
      vi.mocked(fixture.provider.select).mockImplementationOnce(async () => {
        if (field === 'manager') fixture.state.manager = setup().manager;
        else fixture.state[field] = 'changed';
        return { model: requestModel, config: requestConfig };
      });
      const host = vi.fn(async () => undefined);
      await expect(compact(fixture, host)()).rejects.toThrow(
        'Session model changed',
      );
      expect(host).not.toHaveBeenCalled();
      expect(fixture.provider.select).toHaveBeenCalledOnce();
    },
  );

  it('压缩前置 main 选模等待期间取消，不消费迟到结果', async () => {
    const fixture = setup();
    fixture.models.push(directModel, requestModel);
    const controller = new AbortController();
    let finish!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const response = new Promise<void>((resolve) => {
      finish = resolve;
    });
    vi.mocked(fixture.provider.select).mockImplementationOnce(async () => {
      started();
      await response;
      return { model: requestModel, config: requestConfig };
    });
    const host = vi.fn(async () => undefined);
    const pending = compact(fixture, host, controller.signal).prepareParent();
    await entered;
    controller.abort(new Error('cancelled main preparation'));
    try {
      await expect(pending).rejects.toBe(controller.signal.reason);
    } finally {
      finish();
    }
    await response;
    expect(host).not.toHaveBeenCalled();
    expect(fixture.provider.select).toHaveBeenCalledOnce();
    expect(fixture.provider.inference).not.toHaveBeenCalled();
  });

  it.each(['error', 'cancel', 'identity'] as const)(
    '压缩宿主等待发生 %s 时不进入后续 select',
    async (mode) => {
      const fixture = setup();
      fixture.models.push(directModel);
      const controller = new AbortController();
      const error = new Error('宿主失败');
      const promise = compact(
        fixture,
        async () => {
          if (mode === 'error') throw error;
          if (mode === 'cancel') controller.abort(error);
          else fixture.state.identity = 'changed';
          fixture.models.push(requestModel);
          return undefined;
        },
        controller.signal,
      )();
      if (mode === 'identity')
        await expect(promise).rejects.toThrow('Session model changed');
      else await expect(promise).rejects.toBe(error);
      expect(fixture.provider.select).not.toHaveBeenCalled();
    },
  );
});

describe('SDK 请求级策略与目录恢复', () => {
  const requested: Model = { ...directModel, key: 'requested' };
  const policyModel: Model = {
    ...directModel,
    key: 'policy',
    defaultModelConfig: { sampling: { temperature: 0.2 } },
  };

  it('目录 404 后宿主补目录，保留原主锚点并选择请求覆盖', async () => {
    const { models, manager, provider, run } = setup();
    const host = vi.fn(async () => {
      models.push(directModel, requested, policyModel);
      return {
        model: 'policy',
        parameters: { reasoningEffort: 'high' as const },
        labels: { taskId: 'sdk' },
      };
    });
    const result = await run(host, {
      key: 'requested',
      config: { context: { maxOutputTokens: 512 } },
    });
    expect(result.resolution).toMatchObject({
      model: { key: 'policy' },
      config: {
        reasoning: { effort: 'high' },
        context: { maxOutputTokens: 512 },
        sampling: { temperature: 0.2 },
      },
    });
    expect(result.labels).toEqual({ taskId: 'sdk' });
    expect(result.resolution).not.toHaveProperty('labels');
    expect(host.mock.calls[0]).toEqual([
      'main',
      'session-1',
      0,
      undefined,
      undefined,
      {},
    ]);
    expect(vi.mocked(provider.select).mock.calls[0]![0].workdirs).toEqual([
      '/repo',
    ]);
    expect(await manager.getMainModel()).toBe(directModel);
    expect(provider.setModelConfig).not.toHaveBeenCalled();
    expect(manager.getModelConfig(policyModel)).toBeUndefined();
  });

  it.each([undefined, { parameters: { reasoningEffort: 'low' as const } }])(
    '宿主补目录返回 %s 时保留原显式模型和请求参数',
    async (policy) => {
      const { models, manager, run } = setup();
      const result = await run(
        async () => {
          models.push(directModel, requested);
          return policy;
        },
        { key: 'requested', config: { context: { maxOutputTokens: 512 } } },
      );
      expect(result.resolution.model.key).toBe('requested');
      expect(result.resolution.config.context?.maxOutputTokens).toBe(512);
      if (policy)
        expect(result.resolution.config.reasoning?.effort).toBe('low');
      expect(await manager.getMainModel()).toBe(directModel);
    },
  );

  it('基础主锚点合法但显式模型尚未入目录时，也允许宿主先补目录', async () => {
    const { models, run } = setup();
    models.push(directModel);
    const host = vi.fn(async () => {
      models.push(requested);
      return undefined;
    });
    expect((await run(host, { key: 'requested' })).resolution.model).toBe(
      requested,
    );
    expect(host).toHaveBeenCalledOnce();
  });

  it.each([undefined, { parameters: { reasoningEffort: 'low' as const } }])(
    '原显式模型仍缺失时，%s 不可回落到会话默认模型',
    async (policy) => {
      const { models, provider, run } = setup();
      await expect(
        run(
          async () => {
            models.push(directModel);
            return policy;
          },
          { key: 'missing' },
        ),
      ).rejects.toMatchObject({ code: 404 });
      expect(provider.select).not.toHaveBeenCalled();
    },
  );

  it('宿主只补覆盖模型不能绕过已下架的主锚点', async () => {
    const { models, provider, manager, run } = setup();
    await expect(
      run(async () => {
        models.push(policyModel);
        return { model: 'policy' };
      }),
    ).rejects.toMatchObject({ code: 404 });
    await expect(manager.getMainModel()).rejects.toMatchObject({ code: 404 });
    expect(provider.select).not.toHaveBeenCalled();
  });

  it('跨 owner 策略拒绝，不切换主锚点', async () => {
    const { models, manager, run } = setup();
    models.push(directModel);
    await expect(run(async () => ({ model: 'foreign' }))).rejects.toMatchObject(
      { code: 404 },
    );
    expect(await manager.getMainModel()).toBe(directModel);
  });

  it.each([false, true])(
    '403 治理限制（Fatal=%s）不调用宿主恢复',
    async (fatal) => {
      const { models, provider, run } = setup();
      models.push(directModel);
      const cause = new ModelNotFoundError('C4 restricted', 403);
      const error = fatal
        ? new FatalRoutingError('C4 restricted', { cause })
        : cause;
      vi.mocked(provider.select).mockRejectedValue(error);
      const host = vi.fn(async () => ({ model: 'policy' }));
      await expect(run(host)).rejects.toBe(error);
      expect(host).not.toHaveBeenCalled();
    },
  );

  it('404 后宿主失败原样透传，不重试基础选模', async () => {
    const { provider, run } = setup();
    const error = new Error('get_model_policy timeout');
    await expect(
      run(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(provider.select).not.toHaveBeenCalled();
  });

  it.each(['key', 'identity', 'sessionId', 'manager'] as const)(
    '宿主等待期间 %s 变化阻断兑换和恢复',
    async (field) => {
      const { models, provider, run, state } = setup();
      await expect(
        run(async () => {
          models.push(directModel, policyModel);
          if (field === 'manager') state.manager = setup().manager;
          else state[field] = 'changed';
          return { model: 'policy' };
        }),
      ).rejects.toThrow('Session model changed');
      expect(provider.select).not.toHaveBeenCalled();
    },
  );

  it('模型兑换期间身份变化，禁止第二次 select', async () => {
    const { models, provider, manager, run, state } = setup();
    models.push(directModel, policyModel);
    const original = manager.getModel.bind(manager);
    vi.spyOn(manager, 'getModel').mockImplementation(async (key) => {
      const model = await original(key);
      state.identity = 'changed';
      return model;
    });
    await expect(run(async () => ({ model: 'policy' }))).rejects.toThrow(
      'Session model changed',
    );
    expect(provider.select).toHaveBeenCalledOnce();
  });

  it('策略重选期间 session 变化，结果不能成为最终请求选择', async () => {
    const { models, provider, run, state } = setup();
    models.push(directModel, policyModel);
    vi.mocked(provider.select)
      .mockResolvedValueOnce({ model: directModel, config: {} })
      .mockImplementationOnce(async () => {
        state.sessionId = 'changed';
        return { model: policyModel, config: {} };
      });
    await expect(run(async () => ({ model: 'policy' }))).rejects.toThrow(
      'Session model changed',
    );
  });

  it('读取主锚点期间身份变化，不更新主锚点、不调用宿主', async () => {
    const { manager, provider, run, state } = setup();
    const setMainModel = vi.spyOn(manager, 'setMainModel');
    vi.spyOn(manager, 'getMainModel').mockImplementation(async () => {
      state.identity = 'changed';
      throw new ModelNotFoundError('missing', 404);
    });
    const host = vi.fn(async () => undefined);
    await expect(run(host)).rejects.toThrow('Session model changed');
    expect(setMainModel).not.toHaveBeenCalled();
    expect(host).not.toHaveBeenCalled();
    expect(provider.select).not.toHaveBeenCalled();
  });

  it('宿主返回前取消，不兑换迟到模型或发起推理', async () => {
    const { models, provider, run } = setup();
    const controller = new AbortController();
    let finish!: () => void;
    const ready = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const pending = run(
      async () => {
        await ready;
        models.push(directModel, policyModel);
        return { model: 'policy' };
      },
      undefined,
      controller.signal,
    );
    // 目录缺失后宿主开始等待。
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('cancelled'));
    await expect(pending).rejects.toBe(controller.signal.reason);
    finish();
    await ready;
    expect(provider.select).not.toHaveBeenCalled();
    expect(provider.inference).not.toHaveBeenCalled();
  });
});

describe('SDK empty Provider catalog', () => {
  it('rejects an empty catalog and accepts a model once the runtime overlay is ready', async () => {
    const { models, manager } = setup();
    await expect(manager.select({ purpose: 'main' })).rejects.toMatchObject({
      name: 'ModelNotFoundError',
      code: 404,
    });
    models.push(directModel);
    manager.setMainModel(directModel, false);
    await expect(manager.select({ purpose: 'main' })).resolves.toMatchObject({
      model: { key: 'direct' },
    });
  });

  it('does not silently fall back when the session model is not in the Provider catalog', async () => {
    const { manager, provider } = setup();
    await expect(manager.select({ purpose: 'main' })).rejects.toMatchObject({
      code: 404,
    });
    expect(provider.inference).not.toHaveBeenCalled();
  });
});

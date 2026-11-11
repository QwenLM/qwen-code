/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { makeFakeConfig } from '../../test-utils/config.js';
import { testProviderModel } from '../../test-utils/model-resolution.js';
import type { Model, ModelConfig } from '../model/model.js';
import type { ModelProvider } from '../modelProvider.js';
import type { ModelPolicySelectContext } from '../../core/model-policy.js';
import { ModelNotFoundError } from '../../utils/httpErrors.js';
import { FatalRoutingError } from '../../routing/errors.js';
import { CustomModelSelector } from './customModelSelector.js';
import { CustomProviderConfig } from './customProviderConfig.js';
import { OPENAI_CHAT_COMPLETIONS } from '../transport/modelProtocol.js';
import { buildMessagesStreamReq } from '../transport/impl/messages-factory/request/messagesStreamReqFactory.js';
import { buildChatCompletionsStreamReq } from '../transport/impl/chat-completions-factory/request/chatCompletionsStreamReqFactory.js';
import { buildResponsesStreamReq } from '../transport/impl/responses-factory/request/responsesStreamReqFactory.js';

import { createCompactRequestResolver } from '../../core/compact-request-resolver.js';
import * as contextWindowSelection from '../../config-service/features/contextWindowSelection.js';
import { AgentRegistry } from '../../agents/registry/agentRegistry.js';
import { TaskRegistry } from '../../tasks/task-registry.js';
import type { LocalAgentDefinition } from '../../agents/types.js';

function setup(maxOutputTokens?: number, contextWindows = [128000]) {
  const base: Model = {
    ...testProviderModel('local/base'),
    source: 'local',
    capabilities: {
      tools: true,
      vision: false,
      reasoning: { supported: true, supportedEfforts: ['none', 'low', 'high'] },
      contextWindows: contextWindows.map((tokens) => ({ tokens })),
    },
    limits: { maxContextTokens: 128000, maxOutputTokens },
    defaultModelConfig: { reasoning: { effort: 'high' } },
  };
  const fast: Model = {
    ...base,
    key: 'local/fast',
    defaultModelConfig: { reasoning: { effort: 'low' } },
  };
  const models = [base, fast];
  let provider!: ModelProvider;
  const config = makeFakeConfig({
    model: base.key,
    modelProviderFactory: () => {
      const configs = new Map<string, ModelConfig>();
      const preferences = {
        getModelConfig: (model: Model) => configs.get(model.key),
        setModelConfig: (model: Model, patch: ModelConfig) => {
          configs.set(model.key, patch);
          return true;
        },
      };
      const selector = new CustomModelSelector(
        new CustomProviderConfig({
          providerId: 'local',
          baseUrl: 'https://unused.invalid',
          protocol: OPENAI_CHAT_COMPLETIONS,
          models,
        }),
        preferences,
      );
      provider = {
        providerId: 'local',
        start: async () => {},
        stop: async () => {},
        listModels: async () => models,
        getModel: async (key) => models.find((model) => model.key === key),
        ...preferences,
        select: (input) => selector.select(input),
        inference: async () => {
          throw new Error('selection must not infer');
        },
      };
      return [provider];
    },
  });
  const manager = config.getModelProviderManager();
  manager.setMainModel(base);
  const input: ModelPolicySelectContext = {
    purpose: 'main',
    policyPurpose: 'main',
    request: {
      sessionId: config.getSessionId(),
      turnIndex: 3,
      cumulativeUsage: { input_tokens: 40, output_tokens: 10 },
    },
  };
  return { config, manager, input, base, fast, models, provider };
}

async function setupRegisteredAgent(
  definitionPatch: Partial<LocalAgentDefinition> = {},
) {
  const state = setup();
  const { config, fast, input } = state;
  const registry = new AgentRegistry(config);
  vi.spyOn(config, 'getAgentRegistry').mockReturnValue(registry);
  const registered = await registry.registerSdkAgents([
    {
      kind: 'local',
      name: 'reviewer',
      description: 'Review',
      modelConfig: {
        model: fast.key,
        generateContentConfig: { temperature: 0.2 },
      },
      effort: 'low',
      runConfig: { maxTimeMinutes: 1 },
      promptConfig: { systemPrompt: 'Review the code.' },
      ...definitionPatch,
    },
  ]);
  expect(registered.failed).toEqual([]);
  config.taskRegistry = new TaskRegistry();
  config.taskRegistry.register({
    id: 'a-review-1',
    agentId: 'review-1',
    agentName: 'reviewer',
    agentType: 'reviewer',
    resolvedModel: fast.key,
    type: 'local_agent',
    status: 'running',
    description: 'Review',
    startTime: 0,
    notified: false,
    executionId: 1,
    completionBehavior: 'silent',
    prompt: 'Review',
    isBackgrounded: false,
    taskId: 'task-1',
  });
  return {
    ...state,
    registry,
    input: {
      ...input,
      purpose: 'task' as const,
      request: {
        ...input.request!,
        agentId: 'review-1',
        agentType: 'reviewer',
      },
    },
  };
}

describe('registered Agent selection defaults', () => {
  it('reads definition config without a task and preserves the supplied runtime model', async () => {
    const { config, manager, input, base } = await setupRegisteredAgent();
    config.taskRegistry = undefined;
    expect(
      await manager.select({ ...input, overrideSelection: { key: base.key } }),
    ).toMatchObject({
      model: base,
      config: { reasoning: { effort: 'low' }, sampling: { temperature: 0.2 } },
    });
    expect(
      await manager.select({
        ...input,
        overrideSelection: {
          key: base.key,
          config: { reasoning: { effort: 'high' } },
        },
      }),
    ).toMatchObject({
      model: base,
      config: { reasoning: { effort: 'high' }, sampling: { temperature: 0.2 } },
    });
    expect(
      await manager.select({ ...input, overrideSelection: { key: base.key } }),
    ).toMatchObject({ config: { reasoning: { effort: 'low' } } });
  });

  it('reads only the registered fork model, without Agent defaults or SDK selection', async () => {
    const { config, manager, input, fast } = await setupRegisteredAgent();
    vi.spyOn(config, 'getAgentRegistry').mockImplementation(() => {
      throw new Error('fork has no registered definition');
    });
    manager.setModelConfig(fast, { reasoning: { effort: 'high' } });
    const host = vi.fn();
    config.setModelPolicyCallbacks(host);
    const selected = await manager.select({ ...input, purpose: 'fork' });
    expect(selected).toMatchObject({
      model: fast,
      config: { reasoning: { effort: 'high' } },
    });
    expect(selected.config.sampling).toBeUndefined();
    expect(host).not.toHaveBeenCalled();
    config.taskRegistry!.update('a-review-1', { resolvedModel: 'missing' });
    await expect(
      manager.select({ ...input, purpose: 'fork' }),
    ).rejects.toMatchObject({ code: 404 });
    expect(host).not.toHaveBeenCalled();
  });

  it('keeps parent reuse and explicit fork requirements ahead of the registered model', async () => {
    const { manager, input, base } = await setupRegisteredAgent();
    const parentSelection = {
      model: base,
      config: { sampling: { temperature: 0.7 } },
    };
    expect(
      await manager.select({ ...input, purpose: 'fork', parentSelection }),
    ).toMatchObject({ ...parentSelection, reusedSelection: true });
    expect(
      await manager.select({
        ...input,
        purpose: 'fork',
        overrideSelection: { key: base.key },
      }),
    ).toMatchObject({ model: base });
  });

  it('consults SDK on a fork Skill model change without copying registered-model preferences', async () => {
    const { config, manager, input, base, fast } = await setupRegisteredAgent();
    config.taskRegistry!.update('a-review-1', { resolvedModel: base.key });
    manager.setModelConfig(base, {
      reasoning: { effort: 'high' },
      sampling: { temperature: 0.8 },
    });
    const host = vi.fn(async () => ({ model: fast.key }));
    config.setModelPolicyCallbacks(host);
    const selected = await manager.select({ ...input, purpose: 'fork' });
    expect(host).not.toHaveBeenCalled();
    const next = await manager.select({
      ...input,
      purpose: 'fork',
      modelResolution: selected,
      adjustment: { kind: 'skill-model', key: fast.key },
    });
    expect(next).toMatchObject({
      model: fast,
      config: { reasoning: { effort: 'low' } },
    });
    expect(next.config.sampling).toBeUndefined();
    expect(host).toHaveBeenCalledOnce();
  });

  it('reads Agent config and the registered model without a query override', async () => {
    const { manager, input, fast, base } = await setupRegisteredAgent();
    expect(input.overrideSelection).toBeUndefined();
    expect(await manager.select(input)).toMatchObject({
      model: fast,
      config: { reasoning: { effort: 'low' }, sampling: { temperature: 0.2 } },
    });
    expect(manager.getMainModelKey()).toBe(base.key);
  });

  it('applies one query override and leaves the next query defaults unchanged', async () => {
    const { manager, input, base, fast } = await setupRegisteredAgent();
    expect(
      await manager.select({
        ...input,
        overrideSelection: {
          key: base.key,
          config: { reasoning: { effort: 'high' } },
        },
      }),
    ).toMatchObject({
      model: base,
      config: { reasoning: { effort: 'high' }, sampling: { temperature: 0.2 } },
    });
    expect(await manager.select(input)).toMatchObject({
      model: fast,
      config: { reasoning: { effort: 'low' } },
    });
  });

  it('keeps Agent config when SDK changes the model, and SDK config still wins', async () => {
    const { config, manager, input, base } = await setupRegisteredAgent();
    config.setModelPolicyCallbacks(async () => ({ model: base.key }));
    expect(await manager.select(input)).toMatchObject({
      model: base,
      config: { reasoning: { effort: 'low' } },
    });
    config.setModelPolicyCallbacks(async () => ({
      model: base.key,
      parameters: { reasoningEffort: 'high' },
    }));
    expect(await manager.select(input)).toMatchObject({
      model: base,
      config: { reasoning: { effort: 'high' } },
    });
  });

  it('preserves SDK recovery when the registered startup model is missing', async () => {
    const { config, manager, input, base } = await setupRegisteredAgent();
    config.taskRegistry!.update('a-review-1', { resolvedModel: 'missing' });
    const host = vi.fn(async () => ({ model: base.key }));
    config.setModelPolicyCallbacks(host);
    expect(await manager.select(input)).toMatchObject({
      model: base,
      config: { reasoning: { effort: 'low' } },
    });
    expect(host).toHaveBeenCalledOnce();
  });

  it.each([true, false])(
    'retains parent effort with same-model=%s, including Skill model changes',
    async (sameModel) => {
      const { config, manager, input, base, fast } = await setupRegisteredAgent(
        { effort: undefined },
      );
      if (sameModel)
        config.taskRegistry!.update('a-review-1', { resolvedModel: base.key });
      const parentSelection = {
        model: base,
        config: { reasoning: { effort: 'high' as const } },
      };
      const selected = await manager.select({ ...input, parentSelection });
      expect(selected.model).toBe(sameModel ? base : fast);
      expect(selected.config.reasoning?.effort).toBe('high');
      expect(
        await manager.select({
          ...input,
          parentSelection,
          modelResolution: selected,
          adjustment: { kind: 'skill-model', key: fast.key },
        }),
      ).toMatchObject({
        model: fast,
        config: { reasoning: { effort: 'high' } },
      });
    },
  );

  it('does not reread Agent defaults for effort-only adjustments', async () => {
    const { manager, input, fast } = await setupRegisteredAgent();
    const selected = await manager.select(input);
    expect(
      await manager.select({
        ...input,
        modelResolution: selected,
        adjustment: { kind: 'skill-effort', effort: 'high' },
      }),
    ).toMatchObject({ model: fast, config: { reasoning: { effort: 'high' } } });
  });
});

describe('session selection through the real manager', () => {
  it('keeps explicit selection requirements local to each select call', async () => {
    const { manager, input, base, fast } = setup();
    const [overridden, normal] = await Promise.all([
      manager.select({
        ...input,
        overrideSelection: {
          key: fast.key,
          config: { reasoning: { effort: 'low' } },
        },
      }),
      manager.select(input),
    ]);
    expect(overridden).toMatchObject({
      model: fast,
      config: { reasoning: { effort: 'low' } },
    });
    expect(normal).toMatchObject({
      model: base,
      config: { reasoning: { effort: 'high' } },
    });
    expect((await manager.select(input)).model).toBe(base);
    expect(manager.getModelConfig(fast)).toBeUndefined();
  });

  it('keeps SDK priority and 404 recovery for explicit selection requirements', async () => {
    const { config, manager, input, base } = setup();
    const host = vi.fn(async () => ({
      model: base.key,
      parameters: { reasoningEffort: 'low' as const },
    }));
    config.setModelPolicyCallbacks(host);
    expect(
      await manager.select({
        ...input,
        overrideSelection: {
          key: 'missing',
          config: {
            reasoning: { effort: 'high' },
            sampling: { temperature: 0.2 },
          },
        },
      }),
    ).toMatchObject({
      model: base,
      config: { reasoning: { effort: 'low' }, sampling: { temperature: 0.2 } },
    });
    expect(host).toHaveBeenCalledOnce();
  });

  it('reads the current session model without a request override', async () => {
    const { manager, input, base, fast } = setup();
    expect((await manager.select(input)).model).toBe(base);
    manager.setMainModel(fast);
    const selected = await manager.select(input);
    expect(selected.model).toBe(fast);
    expect(selected.config.reasoning?.effort).toBe('low');
  });

  it.each<ModelConfig['reasoning']>([
    { effort: 'high', preserve: true },
    { effort: 'none' },
    { effort: 'high', thinking: { type: 'disabled' } },
    { effort: 'low', thinking: { type: 'enabled', budgetTokens: 4096 } },
    { thinking: { type: 'adaptive' } },
  ])(
    'reads fork preferences directly without carrying them into Skill overrides (%j)',
    async (reasoning) => {
      const { config, manager, input, base, fast } = setup(
        8192,
        [64000, 128000],
      );
      const preferences: ModelConfig = {
        reasoning,
        sampling: { temperature: 0.4, topP: 0.8, topK: 20 },
        context: { contextWindow: 64000, maxOutputTokens: 2048 },
      };
      manager.setModelConfig(base, preferences, true);
      const before = await manager.select({
        purpose: 'fork',
        overrideSelection: {
          key: base.key,
          config: preferences,
        },
      });
      const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(
        async () => undefined,
      );
      config.setModelPolicyCallbacks(host);
      const current = await manager.select({
        purpose: 'fork',
        overrideSelection: { key: base.key },
        request: input.request,
      });
      expect(current.model).toBe(before.model);
      expect(current.config.context).toEqual(before.config.context);
      for (const buildRequest of [
        buildMessagesStreamReq,
        buildChatCompletionsStreamReq,
        buildResponsesStreamReq,
      ]) {
        expect(
          buildRequest({ resolution: current, prompt: { messages: [] } }),
        ).toEqual(
          buildRequest({ resolution: before, prompt: { messages: [] } }),
        );
      }
      expect(host).not.toHaveBeenCalled();
      const next = await manager.select({
        purpose: 'fork',
        overrideSelection: { key: base.key },
        modelResolution: current,
        adjustment: { kind: 'skill-model', key: fast.key },
        request: input.request,
      });
      expect(next.model).toBe(fast);
      expect(next.config.sampling).toBeUndefined();
      expect(next.config.context).toEqual({ contextWindow: 128000 });
      expect(next.config.reasoning?.effort).toBe('low');
      expect(host).toHaveBeenCalledOnce();
    },
  );

  it('applies config-only requirements before SDK and keeps them across its model override', async () => {
    const { config, manager, input, base, fast } = setup();
    const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(async () => ({
      model: fast.key,
    }));
    config.setModelPolicyCallbacks(host);
    const selected = await manager.select({
      ...input,
      overrideSelection: {
        config: {
          reasoning: { effort: 'high' },
          context: { maxOutputTokens: 123 },
        },
      },
    });
    expect(host).toHaveBeenCalledOnce();
    expect(host.mock.calls[0]?.[5]).toMatchObject({ resolvedModel: base.key });
    expect(selected.model).toBe(fast);
    expect(selected.config).toMatchObject({
      reasoning: { effort: 'high' },
      context: { maxOutputTokens: 123 },
    });
    expect(manager.getMainModelKey()).toBe(base.key);
    config.setModelPolicyCallbacks(undefined);
    expect(
      (await manager.select({ ...input, overrideSelection: { key: fast.key } }))
        .config.reasoning?.effort,
    ).toBe('low');
  });

  it('normalizes config-only requests against model limits without a second base selection', async () => {
    const { manager, input, provider } = setup(500);
    const select = vi.spyOn(provider, 'select');
    const selected = await manager.select({
      ...input,
      overrideSelection: {
        config: {
          context: { maxOutputTokens: 1000 },
          reasoning: { effort: 'max' },
        },
      },
    });
    expect(select).toHaveBeenCalledOnce();
    expect(selected.config.context?.maxOutputTokens).toBe(500);
    expect(selected.config.reasoning?.effort).toBe('high');
  });

  it('lets SDK configuration override config-only requirements', async () => {
    const { config, manager, input } = setup();
    config.setModelPolicyCallbacks(async () => ({
      parameters: { reasoningEffort: 'low' },
    }));
    const selected = await manager.select({
      ...input,
      overrideSelection: { config: { reasoning: { effort: 'high' } } },
    });
    expect(selected.config.reasoning?.effort).toBe('low');
  });

  it('reads parent preferences inside select when an older snapshot has no effort', async () => {
    const { manager, input, base } = setup();
    manager.setModelConfig(base, { reasoning: { effort: 'low' } }, false);
    const selected = await manager.select({
      ...input,
      purpose: 'task',
      parentSelection: { model: base, config: {} },
    });
    expect(selected.config.reasoning?.effort).toBe('low');
  });

  it.each(['keep', 'model', 'effort'] as const)(
    'Agent config-only inheritance matches the previous explicit input through SDK and Skill changes: %s',
    async (policy) => {
      const { config, manager, input, base, fast } = setup();
      const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(async () =>
        policy === 'model'
          ? { model: fast.key }
          : policy === 'effort'
            ? { parameters: { reasoningEffort: 'low' } }
            : undefined,
      );
      config.setModelPolicyCallbacks(host);
      const parentSelection = {
        model: base,
        config: {
          reasoning: { effort: 'high' as const },
          sampling: { temperature: 0.8 },
          context: { maxOutputTokens: 8192 },
        },
      };
      const task = { ...input, purpose: 'task' as const, parentSelection };
      const explicitConfig = {
        sampling: { temperature: 0.2 },
        context: { maxOutputTokens: 456 },
      };
      const before = {
        ...task,
        overrideSelection: {
          key: base.key,
          config: { ...explicitConfig, reasoning: { effort: 'high' as const } },
        },
      };
      const after = { ...task, overrideSelection: { config: explicitConfig } };
      const previous = await manager.select(before);
      const selected = await manager.select(after);
      expect(selected).toEqual(previous);
      const adjustment = { kind: 'skill-model' as const, key: fast.key };
      expect(
        await manager.select({
          ...after,
          modelResolution: selected,
          adjustment,
        }),
      ).toEqual(
        await manager.select({
          ...before,
          modelResolution: previous,
          adjustment,
        }),
      );
      expect(host).toHaveBeenCalledTimes(4);
      expect(manager.getMainModelKey()).toBe(base.key);
    },
  );

  it('keeps an explicit-key Agent opt-out from acquiring parent effort on SDK model changes', async () => {
    const { config, manager, input, base, fast } = setup();
    config.setModelPolicyCallbacks(async () => ({ model: fast.key }));
    const selected = await manager.select({
      ...input,
      purpose: 'task',
      parentSelection: {
        model: base,
        config: { reasoning: { effort: 'high' } },
      },
      overrideSelection: { key: base.key, config: { reasoning: {} } },
    });
    expect(selected.model).toBe(fast);
    expect(selected.config.reasoning?.effort).toBe('low');
  });

  it('inherits an ordinary Agent effort inside select, including SDK and Skill model changes', async () => {
    const { config, manager, input, base, fast } = setup();
    const parentSelection = {
      model: base,
      config: {
        reasoning: { effort: 'high' as const },
        sampling: { temperature: 0.7 },
      },
    };
    const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(async () => ({
      model: fast.key,
    }));
    config.setModelPolicyCallbacks(host);
    const task = { ...input, purpose: 'task' as const, parentSelection };
    const selected = await manager.select(task);
    expect(selected.model).toBe(fast);
    expect(selected.config.reasoning?.effort).toBe('high');
    expect(selected.config.sampling).toBeUndefined();
    config.setModelPolicyCallbacks(undefined);
    const changed = await manager.select({
      ...task,
      modelResolution: selected,
      adjustment: { kind: 'skill-model', key: fast.key },
    });
    expect(changed.config.reasoning?.effort).toBe('high');
    expect(changed.config.sampling).toBeUndefined();
  });

  it.each(['side_question', 'fork'] as const)(
    'reuses the complete %s parent before compatibility results or session lookup',
    async (purpose) => {
      const { config, manager, base, fast, input } = setup();
      const host = vi.fn();
      config.setModelPolicyCallbacks(host);
      const lookup = vi.spyOn(manager, 'getMainModel');
      const preparation = vi.fn(
        async (input: ModelPolicySelectContext) => input,
      );
      manager.setSelectionPreparation(preparation);
      const parentSelection = {
        model: { ...fast, source: 'previous-owner' },
        config: {
          sampling: { temperature: 0.3 },
          context: { maxOutputTokens: 512 },
        },
      };
      const selected = await manager.select({
        ...input,
        purpose,
        parentSelection,
        modelResolution: { model: base, config: {} },
        overrideSelection: { key: 'missing' },
      });
      expect(selected).toEqual({ ...parentSelection, reusedSelection: true });
      expect(selected.model).toBe(parentSelection.model);
      expect(selected.config).toBe(parentSelection.config);
      expect(lookup).not.toHaveBeenCalled();
      expect(preparation).not.toHaveBeenCalled();
      expect(host).not.toHaveBeenCalled();
    },
  );

  it('reuses a compact result without another policy and still honors cancellation', async () => {
    const { config, manager, input, fast } = setup();
    const host = vi.fn();
    config.setModelPolicyCallbacks(host);
    const lookup = vi.spyOn(manager, 'getMainModel');
    const preparation = vi.fn(async (input: ModelPolicySelectContext) => input);
    manager.setSelectionPreparation(preparation);
    const modelResolution = {
      model: fast,
      config: { sampling: { temperature: 0.5 } },
    };
    const selected = await manager.select({
      ...input,
      purpose: 'compact',
      compactSelection: modelResolution,
    });
    expect(selected).toEqual({ ...modelResolution, reusedSelection: true });
    expect(selected.model).toBe(modelResolution.model);
    expect(selected.config).toBe(modelResolution.config);
    const controller = new AbortController();
    controller.abort();
    await expect(
      manager.select({
        ...input,
        purpose: 'compact',
        compactSelection: modelResolution,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(host).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(preparation).not.toHaveBeenCalled();
  });

  it.each(['main', 'fork', 'side_question'] as const)(
    'does not reuse a generic initial result for %s',
    async (purpose) => {
      const { config, manager, input, base, fast } = setup();
      const host = vi.fn(async () => undefined);
      config.setModelPolicyCallbacks(host);
      const selected = await manager.select({
        ...input,
        purpose,
        modelResolution: { model: fast, config: {} },
      });
      expect(selected.model).toBe(base);
      expect(selected.reusedSelection).toBeUndefined();
      expect(host).toHaveBeenCalledTimes(purpose === 'fork' ? 0 : 1);
    },
  );

  it('selects a fresh fork once without consulting the SDK or recovering a missing model through it', async () => {
    const { config, manager, input, fast } = setup();
    const host = vi.fn();
    config.setModelPolicyCallbacks(host);
    const selected = await manager.select({
      ...input,
      purpose: 'fork',
      overrideSelection: { key: fast.key },
    });
    expect(selected.model).toBe(fast);
    expect(selected.reusedSelection).toBeUndefined();
    await expect(
      manager.select({
        ...input,
        purpose: 'fork',
        overrideSelection: { key: 'missing' },
      }),
    ).rejects.toMatchObject({ code: 404 });
    expect(host).not.toHaveBeenCalled();
  });

  it('keeps the parent model owner for an ordinary Agent key override and still executes the policy', async () => {
    const { config, manager, input, base } = setup();
    const host = vi.fn(async () => undefined);
    config.setModelPolicyCallbacks(host);
    const lookup = vi.spyOn(manager, 'getModel');
    const parentSelection = {
      model: base,
      config: { sampling: { temperature: 0.4 } },
    };
    const selected = await manager.select({
      ...input,
      purpose: 'task',
      parentSelection,
      overrideSelection: { key: base.key },
    });
    expect(selected.config.sampling?.temperature).toBe(0.4);
    expect(lookup).not.toHaveBeenCalled();
    expect(host).toHaveBeenCalledOnce();
    config.setModelPolicyCallbacks(undefined);
    await expect(
      manager.select({
        ...input,
        purpose: 'task',
        parentSelection: {
          ...parentSelection,
          model: { ...base, source: 'another-owner' },
        },
        overrideSelection: { key: base.key },
      }),
    ).rejects.toThrow('outside the anchored provider');
    expect(lookup).not.toHaveBeenCalled();
  });

  it.each(['side_question', 'fork'] as const)(
    'executes SDK on a Skill model change after %s reuse and carries only explicit config',
    async (purpose) => {
      const { config, manager, base, fast, input } = setup();
      const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(
        async () => ({ parameters: { reasoningEffort: 'low' as const } }),
      );
      config.setModelPolicyCallbacks(host);
      const original = {
        model: base,
        config: {
          reasoning: { effort: 'high' as const },
          sampling: { temperature: 0.7 },
          context: { maxOutputTokens: 8192 },
        },
      };
      const request = { ...input.request!, agentId: 'child' };
      const current = await manager.select({
        purpose,
        parentSelection: original,
        request,
      });
      expect(host).not.toHaveBeenCalled();
      const selected = await manager.select({
        purpose,
        request,
        parentSelection: original,
        modelResolution: current,
        overrideSelection: {
          key: base.key,
          config: { context: { maxOutputTokens: 512 } },
        },
        adjustment: { kind: 'skill-model', key: fast.key },
      });
      expect(selected.model).toBe(fast);
      expect(selected.config.reasoning?.effort).toBe('low');
      expect(selected.config.context?.maxOutputTokens).toBe(512);
      expect(selected.config.sampling).toBeUndefined();
      expect(selected.reusedSelection).toBeUndefined();
      expect(host).toHaveBeenCalledOnce();
      expect(host.mock.calls[0]?.[0]).toBe(
        purpose === 'fork' ? 'task' : 'utility',
      );
    },
  );

  it.each(['main', 'fork'] as const)(
    'adjusts effort and output limits in %s without SDK and retains the remaining config',
    async (purpose) => {
      const { config, manager, input, base } = setup();
      const host = vi.fn();
      config.setModelPolicyCallbacks(host);
      const current = {
        model: base,
        config: {
          sampling: { temperature: 0.3 },
          context: { maxOutputTokens: 1024 },
        },
      };
      const effort = await manager.select({
        ...input,
        purpose,
        modelResolution: current,
        adjustment: { kind: 'skill-effort', effort: 'low' },
      });
      expect(effort.config.reasoning).toMatchObject({
        effort: 'low',
        thinking: { type: 'enabled', budgetTokens: 1024 },
      });
      expect(effort.config.sampling).toEqual(current.config.sampling);
      const output = await manager.select({
        ...input,
        purpose,
        modelResolution: effort,
        adjustment: { kind: 'output-limit', maxOutputTokens: 2048 },
      });
      expect(output.config.reasoning).toEqual(effort.config.reasoning);
      expect(output.config.context?.maxOutputTokens).toBe(2048);
      expect(host).not.toHaveBeenCalled();
    },
  );

  it.each(['key', 'model'] as const)(
    'resolves %s overrides without changing the session anchor',
    async (form) => {
      const { manager, input, base, fast } = setup();
      const selected = await manager.select({
        ...input,
        overrideSelection:
          form === 'key' ? { key: fast.key } : { model: fast, config: {} },
      });
      expect(selected.model).toBe(fast);
      expect(selected.policy).toBeUndefined();
      expect(manager.getMainModelKey()).toBe(base.key);
    },
  );

  it('binds the existing SDK callback, converts its patch and supports unbinding', async () => {
    const { config, manager, input, base, fast } = setup();
    const host = vi.fn(async () => ({
      model: fast.key,
      parameters: { reasoningEffort: 'high' as const },
      labels: { taskId: 'task' },
    }));
    config.setModelPolicyCallbacks(host);
    const selected = await manager.select(input);
    expect(selected).toMatchObject({
      model: fast,
      config: { reasoning: { effort: 'high' } },
      policy: { overridden: true, labels: { taskId: 'task' } },
    });
    expect(host).toHaveBeenCalledExactlyOnceWith(
      'main',
      config.getSessionId(),
      3,
      undefined,
      undefined,
      { resolvedModel: base.key, estimatedInputTokens: 40 },
    );
    expect(manager.getMainModelKey()).toBe(base.key);
    config.setModelPolicyCallbacks(undefined);
    expect((await manager.select(input)).policy).toBeUndefined();
    expect(host).toHaveBeenCalledOnce();
  });

  it('does not add SDK calls to ordinary purpose-only selection', async () => {
    const { config, manager } = setup();
    const host = vi.fn();
    config.setModelPolicyCallbacks(host);
    expect((await manager.select({ purpose: 'title' })).policy).toBeUndefined();
    expect(host).not.toHaveBeenCalled();
  });

  it.each(['empty', 'config', 'model'] as const)(
    'recovers an empty catalog with a %s policy response',
    async (response) => {
      const { config, manager, input, base, fast, models } = setup();
      models.length = 0;
      const host = vi.fn(async () => {
        models.push(base, fast);
        return response === 'empty'
          ? undefined
          : response === 'model'
            ? { model: fast.key }
            : { parameters: { reasoningEffort: 'low' as const } };
      });
      config.setModelPolicyCallbacks(host);
      const selected = await manager.select({
        ...input,
        overrideSelection: {
          key: base.key,
          config: { context: { maxOutputTokens: 1234 } },
        },
      });
      expect(selected.model.key).toBe(
        response === 'model' ? fast.key : base.key,
      );
      expect(selected.config.context?.maxOutputTokens).toBe(1234);
      expect(selected.policy?.overridden).toBe(response !== 'empty');
      expect(host).toHaveBeenCalledOnce();
      expect(host.mock.calls[0]).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ resolvedModel: expect.any(String) }),
        ]),
      );
      expect(manager.getMainModelKey()).toBe(base.key);
    },
  );

  it('still fails if the host cannot restore the anchored model', async () => {
    const { config, manager, input, models, fast } = setup();
    models.splice(0, 1);
    config.setModelPolicyCallbacks(async () => ({ model: fast.key }));
    await expect(manager.select(input)).rejects.toMatchObject({ code: 404 });
  });

  it('does not query the host after a disabled-model error', async () => {
    const { config, manager, input, fast, models } = setup();
    models[1] = { ...fast, enabled: false };
    const host = vi.fn();
    config.setModelPolicyCallbacks(host);
    await expect(
      manager.select({ ...input, overrideSelection: { key: fast.key } }),
    ).rejects.toMatchObject({ code: 403 });
    expect(host).not.toHaveBeenCalled();
  });

  it('recovers a wrapped catalog miss through the SDK policy', async () => {
    const { config, manager, input, provider, fast } = setup();
    vi.spyOn(provider, 'select').mockRejectedValueOnce(
      new FatalRoutingError('missing', {
        cause: new ModelNotFoundError('missing', 404),
      }),
    );
    const host = vi.fn(async () => ({ model: fast.key }));
    config.setModelPolicyCallbacks(host);
    expect((await manager.select(input)).model.key).toBe(fast.key);
    expect(host).toHaveBeenCalledOnce();
  });

  it('does not query the host after an unrelated selection error', async () => {
    const { config, manager, input, provider } = setup();
    const failure = new Error('network');
    vi.spyOn(provider, 'select').mockRejectedValueOnce(failure);
    const host = vi.fn();
    config.setModelPolicyCallbacks(host);
    await expect(manager.select(input)).rejects.toBe(failure);
    expect(host).not.toHaveBeenCalled();
  });

  it('preserves parent config but does not make it explicit on an SDK model switch', async () => {
    const { config, manager, input, base, fast } = setup();
    const parentSelection = {
      model: base,
      config: {
        reasoning: { effort: 'high' as const },
        context: { maxOutputTokens: 8192 },
      },
    };
    expect(
      (await manager.select({ ...input, parentSelection })).config.context
        ?.maxOutputTokens,
    ).toBe(8192);
    config.setModelPolicyCallbacks(async () => ({ model: fast.key }));
    const selected = await manager.select({ ...input, parentSelection });
    expect(selected.config.reasoning?.effort).toBe('low');
    expect(selected.config.context?.maxOutputTokens).not.toBe(8192);
  });

  it.each(['none', 'config', 'model'] as const)(
    'prepares snapshotless manual compact from session preferences and delays SDK (%s)',
    async (mode) => {
      const { config, manager, base, fast, provider } = setup(
        8192,
        [64000, 128000],
      );
      manager.setModelConfig(
        base,
        {
          reasoning: { effort: 'high' },
          sampling: { temperature: 0.8 },
          context: { contextWindow: 64000, maxOutputTokens: 1024 },
        },
        true,
      );
      const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(async () =>
        mode === 'model'
          ? { model: fast.key }
          : mode === 'config'
            ? { parameters: { reasoningEffort: 'low' } }
            : undefined,
      );
      config.setModelPolicyCallbacks(host);
      const selectBase = vi.spyOn(provider, 'select');
      const resolve = createCompactRequestResolver({
        config,
        signal: new AbortController().signal,
        sessionId: config.getSessionId(),
        turnIndex: 3,
        logLabel: 'snapshotless compact',
      });
      const prepared = await resolve.prepareParent();
      expect(await resolve.prepareParent()).toBe(prepared);
      expect(prepared.modelResolution).toMatchObject({
        model: base,
        config: {
          reasoning: { effort: 'high' },
          sampling: { temperature: 0.8 },
          context: { contextWindow: 64000, maxOutputTokens: 1024 },
        },
      });
      expect(prepared.source).toBe('current');
      expect(host).not.toHaveBeenCalled();
      expect(selectBase).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          purpose: 'main',
          parentSelection: undefined,
          overrideSelection: undefined,
        }),
      );
      const [selected, repeated] = await Promise.all([resolve(), resolve()]);
      expect(repeated).toBe(selected);
      expect(host).toHaveBeenCalledOnce();
      expect(host.mock.calls[0]?.[0]).toBe('compact');
      expect(host.mock.calls[0]?.[5]).toMatchObject({
        resolvedModel: base.key,
      });
      expect(selected.modelResolution.model).toBe(
        mode === 'model' ? fast : base,
      );
      expect(selected.modelResolution.config.reasoning?.effort).toBe(
        mode === 'none' ? 'high' : 'low',
      );
      if (mode === 'model') {
        expect(selected.modelResolution.config.sampling).toBeUndefined();
        expect(selected.modelResolution.config.context).toEqual({
          contextWindow: 128000,
        });
      } else {
        expect(selected.modelResolution.config.sampling?.temperature).toBe(0.8);
        expect(selected.modelResolution.config.context?.contextWindow).toBe(
          64000,
        );
      }
      expect(manager.getMainModelKey()).toBe(base.key);
    },
  );

  it.each(['empty', 'config', 'model'] as const)(
    'caches final snapshotless manual compact selection after prepare-time 404 recovery (%s)',
    async (response) => {
      const { config, manager, base, fast, models } = setup();
      models.length = 0;
      const labels = { taskId: 'recovered-compact' };
      const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(
        async () => {
          models.push(base, fast);
          return response === 'empty'
            ? { labels }
            : response === 'config'
              ? { parameters: { reasoningEffort: 'low' }, labels }
              : { model: fast.key, labels };
        },
      );
      config.setModelPolicyCallbacks(host);
      const resolve = createCompactRequestResolver({
        config,
        signal: new AbortController().signal,
        sessionId: config.getSessionId(),
        turnIndex: 0,
        logLabel: 'snapshotless recovery',
      });
      const prepared = await resolve.prepareParent();
      expect(prepared.modelResolution.model).toBe(
        response === 'model' ? fast : base,
      );
      expect(prepared.modelResolution.config.reasoning?.effort).toBe(
        response === 'empty' ? 'high' : 'low',
      );
      expect(prepared.policyLabels).toEqual(labels);
      expect(await resolve()).toBe(prepared);
      expect(await resolve()).toBe(prepared);
      expect(host).toHaveBeenCalledOnce();
      expect(host.mock.calls[0]?.[5]).not.toHaveProperty('resolvedModel');
      expect(manager.getMainModelKey()).toBe(base.key);
    },
  );

  it.each(['unavailable', 'sdk-error', 'cancel', 'identity'] as const)(
    'does not hide failed snapshotless compact recovery (%s)',
    async (mode) => {
      const { config, fast, models } = setup();
      models.length = 0;
      const controller = new AbortController();
      const failure = new Error('SDK preparation failed');
      const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(
        async () => {
          if (mode === 'sdk-error') throw failure;
          if (mode === 'cancel') controller.abort(failure);
          if (mode === 'identity')
            vi.spyOn(config, 'getModelRequestIdentity').mockReturnValue(
              'changed',
            );
          return { model: fast.key };
        },
      );
      config.setModelPolicyCallbacks(host);
      const resolve = createCompactRequestResolver({
        config,
        signal: controller.signal,
        sessionId: config.getSessionId(),
        turnIndex: 0,
        logLabel: 'failed compact recovery',
      });
      if (mode === 'unavailable')
        await expect(resolve.prepareParent()).rejects.toMatchObject({
          code: 404,
        });
      else if (mode === 'identity')
        await expect(resolve.prepareParent()).rejects.toThrow(
          'Session model changed',
        );
      else await expect(resolve.prepareParent()).rejects.toBe(failure);
      expect(host).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    'uses the selected window for snapshotless compact when the UI window gate is %s',
    async (enabled) => {
      const gate = vi
        .spyOn(contextWindowSelection, 'isContextWindowSelectionEnabled')
        .mockReturnValue(enabled);
      try {
        const { config, manager, base } = setup(undefined, [64000, 128000]);
        manager.setModelConfig(
          base,
          { context: { contextWindow: 64000 } },
          true,
        );
        const main = await manager.select({ purpose: 'main' });
        const prepared = await manager.select({
          purpose: 'compact',
          prepareParent: true,
          request: { sessionId: config.getSessionId(), turnIndex: 0 },
        });
        expect(prepared.config.context?.contextWindow).toBe(64000);
        expect(prepared.config.context).toEqual(main.config.context);
        if (!enabled)
          expect(config.getEffectiveContextWindow(base)).toBe(128000);
      } finally {
        gate.mockRestore();
      }
    },
  );

  it('prepares a manual compact parent without SDK and preserves only raw overrides on a model switch', async () => {
    const { config, manager, input, base, fast } = setup();
    const host = vi.fn<NonNullable<typeof config.getModelPolicy>>(async () => ({
      model: fast.key,
    }));
    config.setModelPolicyCallbacks(host);
    const parentOverride = {
      key: base.key,
      config: { context: { maxOutputTokens: 512 } },
    };
    const prepared = await manager.select({
      ...input,
      purpose: 'compact',
      parentOverride,
      prepareParent: true,
    });
    expect(prepared.preparedParentOnly).toBe(true);
    expect(prepared.config.reasoning?.effort).toBe('high');
    expect(host).not.toHaveBeenCalled();
    const compact = await manager.select({
      ...input,
      purpose: 'compact',
      parentOverride,
      parentSelection: prepared,
    });
    expect(compact.model).toBe(fast);
    // high 来自父模型默认值，不能变成对新模型的显式覆盖。
    expect(compact.config.reasoning?.effort).toBe('low');
    expect(compact.config.context?.maxOutputTokens).toBe(512);
    expect(compact.preparedParentOnly).toBeUndefined();
    expect(host).toHaveBeenCalledOnce();
    expect(manager.getMainModelKey()).toBe(base.key);
  });

  it('keeps labels-only responses separate from model overrides', async () => {
    const { config, manager, input, base } = setup();
    config.setModelPolicyCallbacks(async () => ({
      labels: { taskId: 'current' },
    }));
    expect(await manager.select(input)).toMatchObject({
      model: base,
      policy: { overridden: false, labels: { taskId: 'current' } },
    });
    config.setModelPolicyCallbacks(async () => undefined);
    expect((await manager.select(input)).policy).toEqual({
      overridden: false,
      labels: undefined,
    });
  });

  it('propagates policy failures without falling back', async () => {
    const { config, manager, input } = setup();
    const failure = new Error('policy unavailable');
    config.setModelPolicyCallbacks(async () => {
      throw failure;
    });
    await expect(manager.select(input)).rejects.toBe(failure);
  });

  it('cancels a pending policy and keeps the original abort reason', async () => {
    const { config, manager, input } = setup();
    const controller = new AbortController();
    const failure = new Error('cancelled');
    config.setModelPolicyCallbacks(async () => {
      controller.abort(failure);
      return new Promise(() => {});
    });
    await expect(
      manager.select({ ...input, signal: controller.signal }),
    ).rejects.toBe(failure);
  });

  it('rejects an in-flight result after the session model changes', async () => {
    const { config, manager, input, fast } = setup();
    config.setModelPolicyCallbacks(async () => {
      manager.setMainModel(fast);
      return undefined;
    });
    await expect(manager.select(input)).rejects.toThrow(
      'Session model changed',
    );
  });

  it('does not silently replace an unknown explicit key', async () => {
    const { config, manager, input } = setup();
    config.setModelPolicyCallbacks(async () => undefined);
    await expect(
      manager.select({ ...input, overrideSelection: { key: 'local/missing' } }),
    ).rejects.toBeInstanceOf(ModelNotFoundError);
  });
});

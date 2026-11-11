/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingsService } from '@qwen-code/resource';
import type { Config } from '../config/config.js';
import { readAgentSelectionDefaults } from '../agents/agentModelConfig.js';
import {
  createModelSelectionPolicy,
  type GetModelPolicyCallback,
} from '../core/model-policy.js';
import type { PrepareModelSelection } from '../provider/model/modelSelector.js';
import { SessionModelSelector } from '../provider/impl/sessionModelSelector.js';
import { createModelRequestGuard } from '../provider/session-model.js';
import type { ModelResolver } from '../provider/model/modelResolver.js';
import { mergeModelConfig } from '../provider/model/modelConfig.js';
import type { ModelSelectContext } from '../provider/model/modelSelectContext.js';
import type { ModelSelection } from '../provider/model/modelSelection.js';
import type { CustomProviderRegistry } from '../provider/custom/registry.js';
import { customProviderConfigFromRuntime } from '../provider/impl/customModelProviderFactory.js';
import { CustomModelSelector } from '../provider/impl/customModelSelector.js';
import { ModelProviderManager } from '../provider/impl/modelProviderManager.js';
import { ModelTransportManager } from '../provider/transport/modelTransportManager.js';
import type { ModelProvider } from '../provider/modelProvider.js';
import {
  testModelResolution,
  testProviderModel,
  testRequestConfig,
} from './model-resolution.js';

export { testProviderModel };

export interface TestModelSelection {
  readonly kind: 'fixed' | 'sdk' | 'headless' | 'tui';
  resolve: ((input: ModelSelectContext) => Promise<ModelSelection>) & {
    getModelPolicy?: GetModelPolicyCallback;
  };
}

/** Data-only standalone selection fixture; production uses the session Provider. */
export function fixedSelection(
  selection: string | ModelSelection,
): TestModelSelection {
  return {
    kind: 'fixed',
    resolve: (input) => {
      const value =
        typeof selection === 'string'
          ? testModelResolution(selection)
          : selection;
      const override = input.overrideSelection;
      const target =
        override && 'model' in override
          ? override.model
          : override?.key !== undefined
            ? testProviderModel(override.key)
            : undefined;
      const key =
        target?.key ?? input.parentSelection?.model.key ?? value.model.key;
      const parent =
        input.parentSelection?.model.key === key
          ? input.parentSelection
          : value.model.key === key
            ? value
            : undefined;
      return Promise.resolve({
        model: target ?? parent?.model ?? testProviderModel(key),
        config: mergeModelConfig(
          parent?.config,
          input.overrideSelection?.config,
        ),
      });
    },
  };
}

/** Real manager and Custom selector, without a network or credential fixture. */
export function providerSelection(
  registry: CustomProviderRegistry,
  key: string,
): TestModelSelection {
  const providers = registry
    .getPublicProviders()
    .map((entry): ModelProvider => {
      const runtime = registry.getProviderForModel(
        `${entry.providerId}/${entry.models[0]!.modelId}`,
      )!;
      const config = customProviderConfigFromRuntime(runtime);
      const selector = new CustomModelSelector(config, {
        getModelConfig: () => undefined,
        setModelConfig: () => true,
      });
      return {
        providerId: config.providerId,
        start: async () => {},
        stop: async () => {},
        listModels: async () => [...config.models],
        getModel: async (modelKey) =>
          config.models.find((model) => model.key === modelKey),
        getModelConfig: () => undefined,
        setModelConfig: () => true,
        select: (context) => selector.select(context),
        inference: async () => {
          throw new Error('Unexpected inference in selection fixture');
        },
      };
    });
  const manager = new ModelProviderManager({
    userProviders: providers,
    modelTransportManager: new ModelTransportManager([]),
    settingsService: new SettingsService(),
  });
  const model = registry.getProviderForModel(key);
  if (model)
    manager.setMainModel(
      customProviderConfigFromRuntime(model).models.find(
        (entry) => entry.key === key,
      )!,
      false,
    );
  return {
    kind: 'fixed',
    resolve: (input) => manager.select(input),
  };
}

export function policySelection(options: {
  baseRouter: TestModelSelection;
  getModelPolicy: GetModelPolicyCallback;
  customProviderRegistry?: CustomProviderRegistry;
}): TestModelSelection {
  return {
    kind: 'sdk',
    resolve: Object.assign(options.baseRouter.resolve, {
      getModelPolicy: options.getModelPolicy,
    }),
  };
}

export function purposeSelection(
  base: TestModelSelection,
  registry?: CustomProviderRegistry,
): TestModelSelection {
  return {
    kind: base.kind,
    resolve: async (input) => {
      const selected = await base.resolve(input);
      return registry?.isCustomProviderModel(selected.model.key)
        ? providerSelection(registry, selected.model.key).resolve({
            ...input,
            overrideSelection: selected,
          })
        : selected;
    },
  };
}

/** 在测试 Config 上装配 manager 端口，不拦截生产选模函数。 */
export function withTestSelection<
  T extends { config?: Config; selectModel?: TestModelSelection['resolve'] },
>(options: T): Omit<T, 'selectModel'> {
  const { selectModel, ...rest } = options;
  if (!selectModel) return rest;
  if (options.config?.hasModelProviderManager?.()) return rest;
  const facts = options as {
    sessionId?: string;
    model?: string;
    parent?: { model?: string };
  };
  const modelKey =
    facts.model ??
    facts.parent?.model ??
    options.config?.getModel?.() ??
    'auto';
  const current = options.config;
  const preferenceManager = current?.getModelProviderManager?.();
  const manager = {
    getModelConfig: preferenceManager?.getModelConfig?.bind(preferenceManager) ?? (() => undefined),
    select: async (input: ModelSelectContext) => {
      const selected = await selectModel(input);
      return {
        model: selected.model,
        config: mergeModelConfig(selected.config, input.overrideSelection?.config),
      };
    },
    listModels: async () => [testProviderModel(modelKey)],
    getModel: async (key: string) => testProviderModel(key),
    setMainModel: () => {},
    inference: async () => {
      throw new Error('请在推理测试中显式装配 inference 端口');
    },
  };
  const configBase = current ?? {};
  for (const [key, value] of Object.entries(testRequestConfig())) {
    if (!(key in configBase)) Object.assign(configBase, { [key]: value });
  }
  const config = Object.assign(configBase, {
    getSessionId:
      current?.getSessionId?.bind(current) ??
      (() => facts.sessionId ?? 'test-session'),
    getModel: current?.getModel?.bind(current) ?? (() => modelKey),
    hasModelProviderManager: () => true,
    getModelProviderManager: () => manager,
    ...(selectModel.getModelPolicy
      ? { getModelPolicy: selectModel.getModelPolicy }
      : {}),
  }) as unknown as Config;
  const sessionManager = withSessionSelection(manager, config);
  config.getModelProviderManager = () =>
    sessionManager as unknown as ModelProviderManager;
  return { ...rest, config };
}

/** 用真实会话 selector 包住测试的模型目录/基础规则端口。 */
export function withSessionSelection<
  T extends Pick<ModelResolver, 'getModel'> & {
    getModelConfig?: (
      model: ModelSelection['model'],
    ) => ModelSelection['config'] | undefined;
    select: (input: ModelSelectContext) => Promise<ModelSelection>;
  },
>(
  base: T,
  config: Config,
): Omit<T, 'select'> & {
  select: SessionModelSelector['select'];
  setSelectionPreparation: (prepare: PrepareModelSelection) => void;
} {
  const selector = new SessionModelSelector({
    resolver: {
      getModel: (key) => manager.getModel(key),
      getModelConfig: (model) => base.getModelConfig?.(model),
    },
    selectBase: (input) => base.select(input),
    createRequestGuard: (signal) => createModelRequestGuard(config, signal),
    readAgentSelectionDefaults: (request, purpose) =>
      readAgentSelectionDefaults(config, request, purpose),
  });
  const manager: Omit<T, 'select'> & {
    select: SessionModelSelector['select'];
    setSelectionPreparation: (prepare: PrepareModelSelection) => void;
  } = {
    ...base,
    setSelectionPreparation: (prepare) => selector.setPreparation(prepare),
    select: (input) => {
      const policy = config.getModelPolicy;
      selector.setPolicy(
        policy ? createModelSelectionPolicy(policy) : undefined,
      );
      return selector.select(input);
    },
  };
  return manager;
}

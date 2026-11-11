/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Model } from '../model/model.js';
import type { ModelConfig } from '../model/model.js';
import type { ModelSelection } from '../model/modelSelection.js';
import type {
  ModelPurpose,
  ModelSelectContext,
} from '../model/modelSelectContext.js';
import type { ModelSelector } from '../model/modelSelector.js';
import type { ModelConfigurator } from '../model/modelConfigurator.js';
import type { CustomProviderConfig } from './customProviderConfig.js';
import type { CustomProviderRoutingPurpose } from '../custom/types.js';
import { mergeModelConfig } from '../model/modelConfig.js';
import { ModelNotFoundError } from '../../utils/httpErrors.js';

/**
 * 单一选模策略（候选池 = 本 provider 的 models）：
 * - 显式 key：池内兑换，查无报错；task/compact 与父同模型时沿用父 config；
 * - main/hook_prompt/task/compact 有父：沿用父选择（task/compact 配了 routing 时走 routing）；
 * - 其余：查 routing 表，未配置或查无此模型回落主模型。
 */
export class CustomModelSelector implements ModelSelector {
  private readonly config: CustomProviderConfig;

  constructor(
    config: CustomProviderConfig,
    private readonly preferences: ModelConfigurator,
  ) {
    this.config = config;
  }

  async select(context: ModelSelectContext): Promise<ModelSelection> {
    const mainModel = context.mainModel;
    if (!mainModel) {
      throw new Error('Model selection requires a main model in context');
    }
    const parent = context.parentSelection;
    if (
      context.overrideSelection &&
      ('model' in context.overrideSelection ||
        context.overrideSelection.key !== undefined)
    ) {
      const override = context.overrideSelection;
      const target =
        'model' in override
          ? override.model
          : { key: override.key, source: this.config.providerId };
      const model = this.config.models.find(
        (entry) => entry.key === target.key && entry.source === target.source,
      );
      if (!model || model.enabled === false) {
        return Promise.reject(
          new ModelNotFoundError(
            `Model '${target.key}' is unavailable.`,
            model?.enabled === false ? 403 : 404,
          ),
        );
      }
      if (
        parent &&
        parent.model.key === model.key &&
        inheritsParent(context.purpose)
      ) {
        return Promise.resolve({
          model,
          config: mergeModelConfig(
            parent.config,
            context.overrideSelection.config,
          ),
        });
      }
      return Promise.resolve({
        model,
        config: mergeModelConfig(
          usesSessionPreference(context.purpose)
            ? mergeModelConfig(
                model.defaultModelConfig,
                this.preferences.getModelConfig(model),
              )
            : this.deriveModelConfig(model),
          context.overrideSelection.config,
        ),
      });
    }
    if (parent && inheritsParent(context.purpose)) {
      return Promise.resolve({
        model: parent.model,
        config: mergeModelConfig(
          parent.config,
          context.overrideSelection?.config,
        ),
      });
    }
    if (context.purpose === 'task' || context.purpose === 'compact') {
      return Promise.reject(
        new Error(
          `Model selection for "${context.purpose}" requires a parent resolution`,
        ),
      );
    }
    const model = usesSessionPreference(context.purpose)
      ? mainModel
      : (this.selectRoutingTarget(context) ?? mainModel);
    return Promise.resolve({
      model,
      config: mergeModelConfig(
        usesSessionPreference(context.purpose)
          ? mergeModelConfig(
              model.defaultModelConfig,
              this.preferences.getModelConfig(model),
            )
          : this.deriveModelConfig(model),
        context.overrideSelection?.config,
      ),
    });
  }

  /** 查 routing 表；无映射、映射目标不在候选池时返回 undefined（回落主模型）。 */
  private selectRoutingTarget(context: ModelSelectContext): Model | undefined {
    const purpose = routingPurposeFor(context.purpose);
    if (!purpose) return undefined;
    const modelId = this.config.routing[purpose];
    if (!modelId) return undefined;
    return (
      this.config.models.find((model) => model.key === modelId) ??
      this.config.models.find(
        (model) => model.key.slice(model.key.indexOf('/') + 1) === modelId,
      )
    );
  }

  /** 选模配置派生：优先模型内禀默认，缺省按 capabilities 推导。 */
  private deriveModelConfig(model: Model): ModelConfig {
    const windows = model.capabilities.contextWindows.map(
      ({ tokens }) => tokens,
    );
    return mergeModelConfig(
      {
        reasoning: {
          effort: model.capabilities.reasoning.supported ? 'medium' : 'none',
        },
        context: {
          contextWindow: windows.length
            ? Math.max(...windows)
            : model.limits.maxContextTokens,
        },
      },
      model.defaultModelConfig,
    );
  }
}

/** 有父选择时沿用父的 purpose。 */
function inheritsParent(purpose: ModelPurpose): boolean {
  return (
    purpose === 'main' ||
    purpose === 'hook_prompt' ||
    purpose === 'task' ||
    purpose === 'compact'
  );
}

/** 基础 config 读用户偏好的 purpose；其余由 provider 按能力推导。 */
function usesSessionPreference(purpose: ModelPurpose): boolean {
  return purpose === 'main' || purpose === 'hook_prompt';
}

/** 新栈 ModelPurpose 到 provider routing 表用途的映射；无映射的用主模型。 */
function routingPurposeFor(
  purpose: ModelPurpose,
): CustomProviderRoutingPurpose | undefined {
  switch (purpose) {
    case 'compact':
      return 'compact';
    case 'task':
      return 'subagent';
    case 'title':
      return 'session_title';
    case 'summary':
      return 'summary';
    case 'auto_permission':
    case 'insights':
    case 'suggestion':
    case 'generate':
    case 'hook_prompt':
    case 'web_fetch':
      return 'utility';
    default:
      return undefined;
  }
}

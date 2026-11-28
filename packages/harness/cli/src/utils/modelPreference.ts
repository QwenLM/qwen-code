/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type Config,
  type LlmGenerationConfig,
  type Model,
  type ModelConfig,
  type ReasoningEffortLevel,
  generationFromModelConfig,
  isContextWindowSelectionEnabled,
  modelConfigFromGeneration,
  runLogger,
} from '@qwen-code/core';

/**
 * 模型偏好的读写都经 ModelProviderManager；读取使用调用方已解析的 Model，
 * 目录未就绪时视为未配置。写入可先把会话里的模型 key 解析成 Model。
 */
export function getModelPreference(
  config: Config,
  model: Model | undefined,
): ModelConfig | undefined {
  return model
    ? config.getModelProviderManager().getModelConfig(model)
    : undefined;
}

export function getPreferredReasoningEffort(
  config: Config,
  model: Model | undefined,
): ReasoningEffortLevel | undefined {
  return getModelPreference(config, model)?.reasoning?.effort;
}

/** 功能开关关闭时视为未配置。 */
export function getPreferredContextWindow(
  config: Config,
  model: Model | undefined,
): number | undefined {
  if (!isContextWindowSelectionEnabled()) return undefined;
  return getModelPreference(config, model)?.context?.contextWindow;
}

/** 偏好中的生成参数（effort / thinking / 采样 / maxTokens）。 */
export function getPreferredGeneration(
  config: Config,
  model: Model | undefined,
): LlmGenerationConfig | undefined {
  return generationFromModelConfig(getModelPreference(config, model) ?? {});
}

/** 整体替换生成参数；缺失字段显式清除，contextWindow 保持不变。 */
export function setPreferredGeneration(
  config: Config,
  generation: LlmGenerationConfig | undefined,
  options: { persist?: boolean; model?: Model | string } = {},
): Promise<boolean> {
  const next = modelConfigFromGeneration(generation);
  return setModelPreference(
    config,
    {
      reasoning: {
        effort: next.reasoning?.effort,
        thinking: next.reasoning?.thinking,
        preserve: next.reasoning?.preserve,
      },
      context: { maxOutputTokens: next.context?.maxOutputTokens },
      sampling: {
        temperature: next.sampling?.temperature,
        topP: next.sampling?.topP,
        topK: next.sampling?.topK,
      },
    },
    options,
  );
}

/**
 * 合并写入偏好；目标模型不在目录中时告警并返回 false。不支持的 effort /
 * contextWindow 由 manager 校验抛错。
 */
export async function setModelPreference(
  config: Config,
  patch: ModelConfig,
  options: { persist?: boolean; model?: Model | string } = {},
): Promise<boolean> {
  const manager = config.getModelProviderManager();
  const target = options.model ?? config.getModel();
  const model =
    typeof target === 'string' ? await manager.getModel(target) : target;
  if (!model) {
    runLogger.warn(
      `[modelPreference] Skipping preference update: model "${String(target)}" was not found.`,
    );
    return false;
  }
  return manager.setModelConfig(model, patch, options.persist);
}

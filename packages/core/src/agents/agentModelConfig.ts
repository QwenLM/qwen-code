/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentConfig } from '@google/genai';
import type { ReasoningEffortLevel } from '../config/model-values.js';
import type { Model } from '../provider/model/model.js';
import type { ModelResolver } from '../provider/model/modelResolver.js';
import { resolveModelName } from '../provider/model/resolveModelName.js';
import { ModelNotFoundError } from '../utils/httpErrors.js';
import type { Config } from '../config/config.js';
import type { ReadAgentSelectionDefaults } from '../provider/model/modelSelector.js';
import { isAgentTask } from '../tasks/unified-task.js';
import { RESOLVED_AGENT_REASONING, type LocalAgentDefinition } from './types.js';
import {
  modelConfigFromGeneration,
  normalizeLlmGenerationConfig,
  type LlmGenerationConfig,
} from '../config/generation-config.js';

export function readAgentSelectionDefaults(
  config: Pick<Config, 'taskRegistry' | 'getAgentRegistry'>,
  { agentId, agentType }: Parameters<ReadAgentSelectionDefaults>[0],
  purpose: 'task' | 'fork' = 'task',
): ReturnType<ReadAgentSelectionDefaults> {
  if (!agentType) return undefined;
  const task = agentId ? config.taskRegistry?.get(`a-${agentId}`) : undefined;
  const key =
    task && isAgentTask(task) && task.agentType === agentType
      ? task.resolvedModel
      : undefined;
  // Agent fork 使用合成定义，只读取启动时登记的模型，不读取普通 Agent 配置。
  if (purpose === 'fork') return key ? { key } : undefined;
  const definition = config.getAgentRegistry?.()?.getDefinition(agentType);
  if (!definition || definition.kind !== 'local') return undefined;
  const reasoning = definition[RESOLVED_AGENT_REASONING];
  // 仅预算的内部继承规则仍走原兼容入口，本轮不改其 effort 语义。
  if (
    reasoning?.thinkingBudget !== undefined &&
    reasoning.reasoningEffort === undefined
  )
    return undefined;
  return {
    key,
    config: modelConfigFromGeneration(
      generationOverridesFromDefinition(definition),
      reasoning?.reasoningEffort,
    ),
  };
}

/** Reasoning 由 registry 归一化；这里只投影 Agent 显式声明的生成配置。 */
export function generationOverridesFromDefinition(
  definition: LocalAgentDefinition,
): LlmGenerationConfig | undefined {
  const config = definition.modelConfig.generateContentConfig;
  if (!config) return undefined;
  return normalizeLlmGenerationConfig({
    temperature: config.temperature,
    topP: config.topP,
    topK: config.topK,
    maxTokens: config.maxOutputTokens,
  });
}

/** Resolve agent input names without changing the provider's key-only contract. */
export async function resolveConfiguredAgentModel(
  resolver: ModelResolver,
  name: string,
): Promise<Model | undefined> {
  const { model, ambiguous } = resolveModelName(
    await resolver.listModels(),
    name,
  );
  if (ambiguous) {
    throw new ModelNotFoundError(
      `configured model "${name}" is ambiguous. Use a model ID: ${ambiguous.map((model) => model.key).join(', ')}.`,
    );
  }
  // Resolve catalog names (including case-insensitive keys) before provider
  // lookup, which may otherwise choose the first ambiguous key. Keep unlisted
  // provider routing keys, such as utility models, available as a fallback.
  return model ?? resolver.getModel(name);
}

/** Model and generation settings declared by an agent definition or override. */
export interface AgentModelConfig {
  model?: string;
  generateContentConfig?: GenerateContentConfig;
  reasoningEffort?: ReasoningEffortLevel;
}

function isPlainObject(item: unknown): item is Record<string, unknown> {
  return !!item && typeof item === 'object' && !Array.isArray(item);
}

/** Objects merge recursively; arrays and scalars are replaced. */
function deepMerge(
  base: Record<string, unknown> | undefined,
  override: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value)
        ? deepMerge(current, value)
        : value;
  }
  return merged;
}

/** Layers an override onto an agent model config. */
export function mergeAgentModelConfig(
  base: AgentModelConfig,
  override: AgentModelConfig,
): AgentModelConfig {
  return {
    model: override.model ?? base.model,
    generateContentConfig: deepMerge(
      base.generateContentConfig as Record<string, unknown> | undefined,
      override.generateContentConfig as Record<string, unknown> | undefined,
    ) as GenerateContentConfig,
    reasoningEffort: override.reasoningEffort ?? base.reasoningEffort,
  };
}

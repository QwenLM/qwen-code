/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseModelReasoningCapabilities,
  REASONING_EFFORT_TIERS,
  type Config,
  type ContentGeneratorConfig,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

export type ModelReasoningConfiguration =
  | {
      readonly thinking: true;
      readonly toggleOnly: true;
      readonly canDisable?: false;
    }
  | {
      readonly thinking: true;
      readonly toggleOnly?: false;
      readonly efforts: readonly ReasoningEffort[];
      readonly defaultEffort?: ReasoningEffort;
      readonly canDisable?: false;
    };

const MODEL_CONFIGURATIONS: Readonly<
  Record<string, { readonly reasoning?: ModelReasoningConfiguration }>
> = {
  'qwen3.5-plus': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.6-plus': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.6-flash': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.7-plus': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.7-max': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.8-max': {
    reasoning: {
      thinking: true,
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
    },
  },
};

export const REASONING_EFFORT_DEFAULT = 'default';
export const REASONING_EFFORT_NONE = 'none';

export type ReasoningSelection =
  | ReasoningEffort
  | typeof REASONING_EFFORT_NONE
  | typeof REASONING_EFFORT_DEFAULT;

export const PERSIST_REASONING_SELECTION_META_KEY =
  'qwenCode/persistReasoningSelection';
export const REASONING_SELECTION_PERSISTED_META_KEY =
  'qwenCode/reasoningSelectionPersisted';

export const REASONING_EFFORT_NAMES: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

export type ModelReasoningConfigState = {
  enabled?: boolean;
  effort?: ReasoningEffort;
  thinkingMandatory?: boolean;
};

export function resolvePersistedReasoningConfigState(
  modelId: string | undefined,
  value: unknown,
  thinkingMandatory = false,
  reasoning?: ModelReasoningConfiguration,
): ModelReasoningConfigState {
  const selection = parseReasoningSelection(value);
  if (
    !selection ||
    selection === REASONING_EFFORT_DEFAULT ||
    !isReasoningSelectionSupported(
      modelId,
      selection,
      thinkingMandatory,
      reasoning,
    )
  ) {
    return { thinkingMandatory };
  }
  return selection === REASONING_EFFORT_NONE
    ? { enabled: false, thinkingMandatory }
    : { enabled: true, effort: selection, thinkingMandatory };
}

export function getModelConfiguration(
  modelId: string | undefined,
  reasoning?: ModelReasoningConfiguration,
):
  | {
      readonly reasoning?: ModelReasoningConfiguration;
    }
  | undefined {
  const configured = parseModelReasoningCapabilities(reasoning);
  return configured
    ? { reasoning: configured }
    : modelId
      ? MODEL_CONFIGURATIONS[modelId]
      : undefined;
}

export function getConfiguredModelReasoning(
  config: Config,
  modelId = config.getModel?.(),
  fallbackToManifest = true,
): ModelReasoningConfiguration | undefined {
  const generation = config.getContentGeneratorConfig?.();
  const authType = generation?.authType ?? config.getAuthType?.();
  const baseUrl =
    generation?.baseUrl ??
    config.getCurrentModelRegistryBaseUrl?.() ??
    undefined;
  const configured = authType
    ? config.getResolvedModelConfig?.(authType, modelId, baseUrl)
    : undefined;
  const reasoning = parseModelReasoningCapabilities(
    configured?.capabilities?.reasoning,
  );
  return (
    reasoning ??
    (fallbackToManifest ? getModelConfiguration(modelId)?.reasoning : undefined)
  );
}

export function getReasoningEffortsForConfig(
  config: Config,
): readonly ReasoningEffort[] {
  const modelId = config.getModel?.();
  const reasoning = getConfiguredModelReasoning(config, modelId, false);
  if (reasoning) return reasoning.toggleOnly ? [] : reasoning.efforts;
  return REASONING_EFFORT_TIERS;
}

export function parseReasoningSelection(
  value: unknown,
): ReasoningSelection | undefined {
  if (value === REASONING_EFFORT_NONE || value === REASONING_EFFORT_DEFAULT) {
    return value;
  }
  return REASONING_EFFORT_TIERS.find((tier) => tier === value);
}

export function isReasoningSelectionSupported(
  modelId: string | undefined,
  selection: ReasoningSelection,
  thinkingMandatory = false,
  configuredReasoning?: ModelReasoningConfiguration,
): boolean {
  if (!modelId) return false;
  const reasoning = getModelConfiguration(
    modelId,
    configuredReasoning,
  )?.reasoning;
  if (!reasoning?.thinking) {
    const normalized = modelId.toLowerCase();
    if (normalized.startsWith('qwen') || normalized === 'coder-model')
      return false;
  }
  if (selection === REASONING_EFFORT_DEFAULT) return true;
  if (selection === REASONING_EFFORT_NONE) {
    return reasoning?.canDisable !== false && !thinkingMandatory;
  }
  return reasoning?.thinking
    ? !reasoning.toggleOnly && reasoning.efforts?.includes(selection) === true
    : REASONING_EFFORT_TIERS.includes(selection);
}

export function clearReasoningRequestOverrides(
  generation: ContentGeneratorConfig,
): void {
  for (const source of ['extra_body', 'samplingParams'] as const) {
    const layer = generation[source];
    if (!layer) continue;
    const next = { ...layer };
    delete next['enable_thinking'];
    delete next['reasoning_effort'];
    delete next['thinking_budget'];
    generation[source] = next;
  }
}

export function applyReasoningSelection(
  config: Config,
  selection: ReasoningSelection,
  defaultReasoning?: ContentGeneratorConfig['reasoning'],
): void {
  const apply = (
    generation: Partial<ContentGeneratorConfig> | undefined,
  ): void => {
    if (!generation) return;
    if (selection === REASONING_EFFORT_NONE) {
      generation.reasoning = false;
      return;
    }
    if (selection === REASONING_EFFORT_DEFAULT) {
      if (defaultReasoning !== undefined) {
        generation.reasoning = defaultReasoning
          ? { ...defaultReasoning }
          : false;
        return;
      }
      if (!generation.reasoning) {
        generation.reasoning = undefined;
        return;
      }
      const next = { ...generation.reasoning };
      delete next.effort;
      generation.reasoning = Object.keys(next).length > 0 ? next : undefined;
      return;
    }
    generation.reasoning = {
      ...(generation.reasoning || defaultReasoning || {}),
      effort: selection,
    };
  };

  const live = config.getContentGeneratorConfig?.();
  apply(live);
  const modelsConfig = config.getModelsConfig?.();
  const rebuildable = modelsConfig?.getGenerationConfig?.();
  if (rebuildable !== live) apply(rebuildable);
}

export function buildModelReasoningConfigOption(
  modelId: string | undefined,
  state: ModelReasoningConfigState = {},
  configuredReasoning?: ModelReasoningConfiguration,
): SessionConfigOption | undefined {
  const reasoning = getModelConfiguration(
    modelId,
    configuredReasoning,
  )?.reasoning;
  if (!reasoning?.thinking) return undefined;
  const canDisable =
    reasoning.canDisable !== false && state.thinkingMandatory !== true;

  const currentValue =
    state.enabled === false && canDisable
      ? REASONING_EFFORT_NONE
      : reasoning.toggleOnly
        ? REASONING_EFFORT_DEFAULT
        : (reasoning.efforts?.find((effort) => effort === state.effort) ??
          reasoning.defaultEffort ??
          REASONING_EFFORT_DEFAULT);

  return {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    description: `Thinking and reasoning effort for ${modelId}`,
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: [
      ...(canDisable
        ? [
            {
              value: REASONING_EFFORT_NONE,
              name: 'Thinking off',
              description: 'Disable thinking for this session',
            },
          ]
        : []),
      ...(reasoning.toggleOnly
        ? [
            {
              value: REASONING_EFFORT_DEFAULT,
              name: 'Thinking on',
              description: 'Use the model or provider thinking default',
            },
          ]
        : [
            ...(reasoning.defaultEffort
              ? []
              : [
                  {
                    value: REASONING_EFFORT_DEFAULT,
                    name: 'Default',
                    description: 'Use the model or provider default',
                  },
                ]),
            ...reasoning.efforts.map((effort) => ({
              value: effort,
              name: REASONING_EFFORT_NAMES[effort],
              description: 'Apply this effort to the next request',
            })),
          ]),
    ],
    _meta: {
      'qwenCode/reasoning': reasoning.toggleOnly
        ? {
            toggleOnly: true,
            ...(canDisable ? {} : { thinkingMandatory: true }),
          }
        : {
            ...(reasoning.defaultEffort
              ? { defaultEffort: reasoning.defaultEffort }
              : {}),
            ...(canDisable ? {} : { thinkingMandatory: true }),
          },
    },
  };
}

export function buildModelReasoningConfigPreview(
  modelId: string | undefined,
  state: ModelReasoningConfigState = {},
  configuredReasoning?: ModelReasoningConfiguration,
): SessionConfigOption[] | undefined {
  const reasoning = getModelConfiguration(
    modelId,
    configuredReasoning,
  )?.reasoning;
  if (!reasoning?.thinking) return undefined;
  const option = buildModelReasoningConfigOption(
    modelId,
    state,
    configuredReasoning,
  );
  return option ? [option] : undefined;
}

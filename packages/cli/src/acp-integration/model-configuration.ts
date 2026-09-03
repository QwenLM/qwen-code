/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  REASONING_EFFORT_TIERS,
  resolveModelReasoningConfiguration,
  supportsGenericReasoningEffort,
  type Config,
  type ContentGeneratorConfig,
  type ModelReasoningConfiguration,
  type ModelReasoningConfigInput,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

export type { ModelReasoningConfiguration, ModelReasoningConfigInput };

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
  input: ModelReasoningConfigInput,
  value: unknown,
  thinkingMandatory = false,
): ModelReasoningConfigState {
  const selection = parseReasoningSelection(value);
  if (
    !selection ||
    selection === REASONING_EFFORT_DEFAULT ||
    !isReasoningSelectionSupported(input, selection, thinkingMandatory)
  ) {
    return { thinkingMandatory };
  }
  return selection === REASONING_EFFORT_NONE
    ? { enabled: false, thinkingMandatory }
    : { enabled: true, effort: selection, thinkingMandatory };
}

export function getModelConfiguration(input: ModelReasoningConfigInput):
  | {
      readonly reasoning?: ModelReasoningConfiguration;
    }
  | undefined {
  const reasoning = resolveModelReasoningConfiguration(input);
  return reasoning ? { reasoning } : undefined;
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
  input: ModelReasoningConfigInput,
  selection: ReasoningSelection,
  thinkingMandatory = false,
): boolean {
  const modelId = input.modelId;
  if (!modelId) return false;
  const reasoning = resolveModelReasoningConfiguration(input);
  if (!reasoning?.thinking) {
    if (thinkingMandatory) return false;
    if (!supportsGenericReasoningEffort(modelId)) return false;
  }
  if (selection === REASONING_EFFORT_DEFAULT) return true;
  if (selection === REASONING_EFFORT_NONE) {
    return reasoning?.canDisable !== false && !thinkingMandatory;
  }
  return reasoning?.thinking
    ? !reasoning.toggleOnly && reasoning.efforts.includes(selection)
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
  if (typeof config.setReasoningDisabled === 'function') {
    if (selection === REASONING_EFFORT_NONE) {
      config.setReasoningDisabled(true);
      return;
    }
    if (selection !== REASONING_EFFORT_DEFAULT) {
      config.setReasoningDisabled(false);
      config.setReasoningEffort(selection);
      return;
    }
    config.setReasoningDisabled(false);
  }
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
  input: ModelReasoningConfigInput,
  state: ModelReasoningConfigState = {},
): SessionConfigOption | undefined {
  const reasoning = resolveModelReasoningConfiguration(input);
  if (!reasoning?.thinking) return undefined;
  const canDisable =
    reasoning.canDisable !== false && state.thinkingMandatory !== true;

  const currentValue =
    state.enabled === false && canDisable
      ? REASONING_EFFORT_NONE
      : reasoning.toggleOnly
        ? REASONING_EFFORT_DEFAULT
        : (reasoning.efforts.find((effort) => effort === state.effort) ??
          reasoning.defaultEffort);

  return {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    description: `Thinking and reasoning effort for ${input.modelId}`,
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
        : reasoning.efforts.map((effort) => ({
            value: effort,
            name: REASONING_EFFORT_NAMES[effort],
            description: 'Apply this effort to the next request',
          }))),
    ],
    _meta: {
      'qwenCode/reasoning': reasoning.toggleOnly
        ? {
            toggleOnly: true,
            ...(canDisable ? {} : { canDisable: false }),
          }
        : {
            defaultEffort: reasoning.defaultEffort,
            ...(canDisable ? {} : { canDisable: false }),
          },
    },
  };
}

export function buildModelReasoningConfigPreview(
  input: ModelReasoningConfigInput,
  state: ModelReasoningConfigState = {},
): SessionConfigOption[] | undefined {
  const reasoning = resolveModelReasoningConfiguration(input);
  if (!reasoning?.thinking) return undefined;
  const option = buildModelReasoningConfigOption(input, state);
  return option ? [option] : undefined;
}

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  normalizeModelReasoningEffort,
  REASONING_EFFORT_TIERS,
  resolveModelReasoningConfiguration,
  type AuthType,
  type Config,
  type ContentGeneratorConfig,
  type ModelReasoningConfiguration,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

export { normalizeModelReasoningEffort };
export type { ModelReasoningConfiguration };

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
  route?: { readonly authType?: AuthType; readonly baseUrl?: string },
): ModelReasoningConfigState {
  const selection = parseReasoningSelection(value);
  if (
    !selection ||
    selection === REASONING_EFFORT_DEFAULT ||
    !isReasoningSelectionSupported(modelId, selection, thinkingMandatory, route)
  ) {
    return { thinkingMandatory };
  }
  return selection === REASONING_EFFORT_NONE
    ? { enabled: false, thinkingMandatory }
    : { enabled: true, effort: selection, thinkingMandatory };
}

export function getModelConfiguration(
  modelId: string | undefined,
  route?: { readonly authType?: AuthType; readonly baseUrl?: string },
):
  | {
      readonly reasoning?: ModelReasoningConfiguration;
    }
  | undefined {
  const reasoning = resolveModelReasoningConfiguration({
    modelId,
    authType: route?.authType,
    baseUrl: route?.baseUrl,
  });
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
  modelId: string | undefined,
  selection: ReasoningSelection,
  thinkingMandatory = false,
  route?: { readonly authType?: AuthType; readonly baseUrl?: string },
): boolean {
  if (!modelId) return false;
  const reasoning = getModelConfiguration(modelId, route)?.reasoning;
  if (!reasoning?.thinking) {
    const normalized = modelId.toLowerCase();
    if (normalized.startsWith('qwen') || normalized === 'coder-model')
      return false;
  }
  if (selection === REASONING_EFFORT_DEFAULT) return true;
  if (selection === REASONING_EFFORT_NONE) {
    return (
      !thinkingMandatory &&
      (!reasoning?.thinking ||
        reasoning.toggleOnly ||
        reasoning.canDisable !== false)
    );
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
  route?: { readonly authType?: AuthType; readonly baseUrl?: string },
): SessionConfigOption | undefined {
  const reasoning = getModelConfiguration(modelId, route)?.reasoning;
  if (!reasoning?.thinking) return undefined;
  const providerCanDisable =
    reasoning.toggleOnly || reasoning.canDisable !== false;
  const thinkingMandatory = state.thinkingMandatory === true;
  const canDisable = providerCanDisable && !thinkingMandatory;

  const currentValue =
    state.enabled === false && canDisable
      ? REASONING_EFFORT_NONE
      : reasoning.toggleOnly
        ? REASONING_EFFORT_DEFAULT
        : (normalizeModelReasoningEffort(reasoning, state.effort) ??
          reasoning.defaultEffort);

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
        : reasoning.efforts.map((effort) => ({
            value: effort,
            name: REASONING_EFFORT_NAMES[effort],
            description: 'Apply this effort to the next request',
          }))),
    ],
    _meta: {
      'qwenCode/reasoning': {
        ...(reasoning.toggleOnly
          ? { toggleOnly: true }
          : { defaultEffort: reasoning.defaultEffort }),
        ...(!providerCanDisable ? { canDisable: false } : {}),
        ...(thinkingMandatory ? { thinkingMandatory: true } : {}),
      },
    },
  };
}

export function buildModelReasoningConfigPreview(
  modelId: string | undefined,
  state: ModelReasoningConfigState = {},
  route?: { readonly authType?: AuthType; readonly baseUrl?: string },
): SessionConfigOption[] | undefined {
  const reasoning = getModelConfiguration(modelId, route)?.reasoning;
  if (!reasoning?.thinking) return undefined;
  const option = buildModelReasoningConfigOption(modelId, state, route);
  return option ? [option] : undefined;
}

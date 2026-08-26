/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReasoningEffort } from '@qwen-code/qwen-code-core';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

export type ModelReasoningConfiguration =
  | {
      readonly thinking: true;
      readonly toggleOnly: true;
    }
  | {
      readonly thinking: true;
      readonly toggleOnly?: false;
      readonly efforts: ReadonlyArray<{
        readonly value: string;
        readonly name: string;
      }>;
      readonly defaultEffort: string;
    };

const MODEL_CONFIGURATIONS: Readonly<
  Record<string, { readonly reasoning?: ModelReasoningConfiguration }>
> = {
  'qwen3.5-plus': {
    reasoning: { thinking: true, toggleOnly: true },
  },
  'qwen3.6-plus': {
    reasoning: { thinking: true, toggleOnly: true },
  },
  'qwen3.6-flash': {
    reasoning: { thinking: true, toggleOnly: true },
  },
  'qwen3.7-plus': {
    reasoning: { thinking: true, toggleOnly: true },
  },
  'qwen3.7-max': {
    reasoning: { thinking: true, toggleOnly: true },
  },
  'qwen3.8-max': {
    reasoning: {
      thinking: true,
      efforts: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'xhigh', name: 'Extra High' },
      ],
      defaultEffort: 'xhigh',
    },
  },
};

export const REASONING_EFFORT_DEFAULT = 'default';
export const REASONING_EFFORT_NONE = 'none';

export const REASONING_EFFORT_NAMES: Record<ReasoningEffort, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra High',
  max: 'Max',
};

export function getModelConfiguration(modelId: string | undefined):
  | {
      readonly reasoning?: ModelReasoningConfiguration;
    }
  | undefined {
  return modelId ? MODEL_CONFIGURATIONS[modelId] : undefined;
}

export function resolveReasoningPreviewState(
  preference: false | string | undefined,
  modelDefault: false | { effort?: string } | undefined,
): { enabled?: boolean; effort?: string } | undefined {
  const reasoning = preference === undefined ? modelDefault : preference;
  if (reasoning === false) return { enabled: false };
  const effort = typeof reasoning === 'string' ? reasoning : reasoning?.effort;
  if (typeof effort !== 'string' || !effort.trim()) return undefined;
  return effort === REASONING_EFFORT_NONE
    ? { enabled: false }
    : { enabled: true, effort };
}

export function buildModelReasoningConfigOption(
  modelId: string | undefined,
  state: { enabled?: boolean; effort?: string } = {},
): SessionConfigOption | undefined {
  const reasoning = getModelConfiguration(modelId)?.reasoning;
  if (!reasoning?.thinking) return undefined;

  const configuredEffort =
    !reasoning.toggleOnly &&
    typeof state.effort === 'string' &&
    state.effort?.trim() &&
    state.effort !== REASONING_EFFORT_NONE &&
    state.effort !== REASONING_EFFORT_DEFAULT
      ? state.effort
      : undefined;
  const matchedEffort = reasoning.toggleOnly
    ? undefined
    : reasoning.efforts.find((effort) => effort.value === configuredEffort);
  const customEffort =
    configuredEffort && !matchedEffort
      ? { value: configuredEffort, name: configuredEffort }
      : undefined;

  const currentValue =
    state.enabled === false
      ? REASONING_EFFORT_NONE
      : reasoning.toggleOnly
        ? REASONING_EFFORT_DEFAULT
        : state.effort === REASONING_EFFORT_DEFAULT
          ? REASONING_EFFORT_DEFAULT
          : (matchedEffort?.value ??
            customEffort?.value ??
            reasoning.defaultEffort);

  return {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    description: `Thinking and reasoning effort for ${modelId}`,
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: [
      {
        value: REASONING_EFFORT_NONE,
        name: 'Thinking off',
        description: 'Disable thinking for this session',
      },
      ...(reasoning.toggleOnly
        ? [
            {
              value: REASONING_EFFORT_DEFAULT,
              name: 'Thinking on',
              description: 'Use the model or provider thinking default',
            },
          ]
        : [
            {
              value: REASONING_EFFORT_DEFAULT,
              name: 'Default',
              description: 'Use the model or provider thinking default',
            },
            ...[
              ...reasoning.efforts,
              ...(customEffort ? [customEffort] : []),
            ].map((effort) => ({
              value: effort.value,
              name: effort.name,
              description: 'Apply this effort to the next request',
            })),
          ]),
    ],
    _meta: {
      'qwenCode/reasoning': reasoning.toggleOnly
        ? { toggleOnly: true }
        : { defaultEffort: reasoning.defaultEffort },
    },
  };
}

export function buildModelReasoningConfigPreview(
  modelId: string | undefined,
  state: { enabled?: boolean; effort?: string } = {},
): SessionConfigOption[] | undefined {
  const reasoning = getModelConfiguration(modelId)?.reasoning;
  if (!reasoning?.thinking || reasoning.toggleOnly) return undefined;
  const option = buildModelReasoningConfigOption(modelId, state);
  return option ? [option] : undefined;
}

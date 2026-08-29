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
      readonly efforts: readonly ReasoningEffort[];
      readonly defaultEffort: ReasoningEffort;
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
      efforts: ['low', 'medium', 'xhigh'],
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
  xhigh: 'Extra high',
  max: 'Max',
};

type ModelReasoningConfigState = {
  enabled?: boolean;
  effort?: ReasoningEffort;
  thinkingMandatory?: boolean;
};

export function getModelConfiguration(modelId: string | undefined):
  | {
      readonly reasoning?: ModelReasoningConfiguration;
    }
  | undefined {
  return modelId ? MODEL_CONFIGURATIONS[modelId] : undefined;
}

export function buildModelReasoningConfigOption(
  modelId: string | undefined,
  state: ModelReasoningConfigState = {},
): SessionConfigOption | undefined {
  const reasoning = getModelConfiguration(modelId)?.reasoning;
  if (!reasoning?.thinking) return undefined;
  const thinkingMandatory = state.thinkingMandatory === true;

  const currentValue =
    state.enabled === false && !thinkingMandatory
      ? REASONING_EFFORT_NONE
      : reasoning.toggleOnly
        ? REASONING_EFFORT_DEFAULT
        : (reasoning.efforts.find((effort) => effort === state.effort) ??
          reasoning.defaultEffort);

  return {
    id: 'reasoning_effort',
    name: 'Reasoning effort',
    description: `Thinking and reasoning effort for ${modelId}`,
    category: 'thought_level',
    type: 'select',
    currentValue,
    options: [
      ...(thinkingMandatory
        ? []
        : [
            {
              value: REASONING_EFFORT_NONE,
              name: 'Thinking off',
              description: 'Disable thinking for this session',
            },
          ]),
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
            ...(thinkingMandatory ? { thinkingMandatory: true } : {}),
          }
        : {
            defaultEffort: reasoning.defaultEffort,
            ...(thinkingMandatory ? { thinkingMandatory: true } : {}),
          },
    },
  };
}

export function buildModelReasoningConfigPreview(
  modelId: string | undefined,
  state: ModelReasoningConfigState = {},
): SessionConfigOption[] | undefined {
  const reasoning = getModelConfiguration(modelId)?.reasoning;
  if (!reasoning?.thinking || reasoning.toggleOnly) return undefined;
  const option = buildModelReasoningConfigOption(modelId, state);
  return option ? [option] : undefined;
}

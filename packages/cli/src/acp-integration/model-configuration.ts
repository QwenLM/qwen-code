/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  normalizeModelReasoningEffort,
  resolveModelReasoningConfiguration,
  type AuthType,
  type ModelReasoningConfiguration,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core';
import type { SessionConfigOption } from '@agentclientprotocol/sdk';

export { normalizeModelReasoningEffort };
export type { ModelReasoningConfiguration };

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
): SessionConfigOption[] | undefined {
  const reasoning = getModelConfiguration(modelId)?.reasoning;
  if (!reasoning?.thinking || reasoning.toggleOnly) return undefined;
  const option = buildModelReasoningConfigOption(modelId, state);
  return option ? [option] : undefined;
}

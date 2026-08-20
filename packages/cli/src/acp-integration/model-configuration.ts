/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReasoningEffort } from '@qwen-code/qwen-code-core';

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

export function getModelConfiguration(modelId: string | undefined):
  | {
      readonly reasoning?: ModelReasoningConfiguration;
    }
  | undefined {
  return modelId ? MODEL_CONFIGURATIONS[modelId] : undefined;
}

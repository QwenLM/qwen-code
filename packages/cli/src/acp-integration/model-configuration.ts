/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ReasoningEffort } from '@qwen-code/qwen-code-core';

export interface ModelReasoningConfiguration {
  readonly thinking: true;
  readonly efforts: readonly ReasoningEffort[];
  readonly defaultEffort: ReasoningEffort;
}

const MODEL_CONFIGURATIONS = {
  'qwen3.8-max': {
    reasoning: {
      thinking: true,
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
    },
  },
} as const satisfies Record<
  string,
  { reasoning?: ModelReasoningConfiguration }
>;

export function getModelConfiguration(modelId: string | undefined):
  | {
      readonly reasoning?: ModelReasoningConfiguration;
    }
  | undefined {
  return modelId === 'qwen3.8-max' ? MODEL_CONFIGURATIONS[modelId] : undefined;
}

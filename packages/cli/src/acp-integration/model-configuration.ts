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
} from '@qwen-code/qwen-code-core';

export { normalizeModelReasoningEffort };
export type { ModelReasoningConfiguration };

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

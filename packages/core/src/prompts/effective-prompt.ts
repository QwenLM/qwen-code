/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AgentDefinitionLike } from './types.js';

export type ResolvedPromptSource =
  | {
      readonly source: 'override' | 'agent' | 'custom';
      readonly fixedBody: string;
    }
  | {
      readonly source: 'default';
      readonly fixedBody?: never;
    };

export interface ResolveEffectivePromptSourceOptions {
  readonly overrideSystemPrompt?: string;
  readonly mainThreadAgentDefinition?: AgentDefinitionLike;
  readonly customSystemPrompt?: string;
}

export function resolveEffectivePromptSource(
  options: ResolveEffectivePromptSourceOptions,
): ResolvedPromptSource {
  if (options.overrideSystemPrompt !== undefined) {
    return { source: 'override', fixedBody: options.overrideSystemPrompt };
  }
  if (options.mainThreadAgentDefinition) {
    return {
      source: 'agent',
      fixedBody: options.mainThreadAgentDefinition.getSystemPrompt(),
    };
  }
  if (options.customSystemPrompt !== undefined) {
    return { source: 'custom', fixedBody: options.customSystemPrompt };
  }
  return { source: 'default' };
}

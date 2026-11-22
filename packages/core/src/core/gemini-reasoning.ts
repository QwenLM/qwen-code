/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from './contentGenerator.js';
import type { ResolvedReasoning } from './reasoning-overrides.js';
import { normalize } from './tokenLimits.js';
import { AuthType } from '../utils/auth-type.js';

export function getBuiltinGeminiReasoning(
  config: Partial<ContentGeneratorConfig>,
): ResolvedReasoning | undefined {
  if (
    config.authType !== AuthType.USE_GEMINI &&
    config.authType !== AuthType.USE_VERTEX_AI
  ) {
    return undefined;
  }
  if (!/^gemini-4/.test(normalize(config.model ?? ''))) return undefined;
  return {
    profile: 'gemini',
    thinking: true,
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'high',
    disableField: 'thinking',
    ...(config.thinkingMandatory ? { canDisable: false } : {}),
  };
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from './contentGenerator.js';
import type { ResolvedReasoning } from './reasoning-overrides.js';
import { normalize } from './tokenLimits.js';
import { AuthType } from '../utils/auth-type.js';

const GEMINI_4_XHIGH_PATTERN = /^gemini-4-(?:neon|hydrogen)(?:-|$)/;

export function supportsGeminiXhigh(model: string | undefined): boolean {
  return GEMINI_4_XHIGH_PATTERN.test(normalize(model ?? ''));
}

export function getBuiltinGeminiReasoning(
  config: Partial<ContentGeneratorConfig>,
): ResolvedReasoning | undefined {
  if (
    config.authType !== AuthType.USE_GEMINI &&
    config.authType !== AuthType.USE_VERTEX_AI
  ) {
    return undefined;
  }
  const normalized = normalize(config.model ?? '');
  if (!/^gemini-4/.test(normalized)) return undefined;
  return {
    profile: 'gemini',
    thinking: true,
    efforts: GEMINI_4_XHIGH_PATTERN.test(normalized)
      ? ['low', 'medium', 'high', 'xhigh']
      : ['low', 'medium', 'high'],
    defaultEffort: 'high',
    disableField: 'thinking',
    ...(config.thinkingMandatory ? { canDisable: false } : {}),
  };
}

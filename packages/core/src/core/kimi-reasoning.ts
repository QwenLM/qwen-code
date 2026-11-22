/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { KIMI_K3_GENERATION } from '../models/constants.js';
import { AuthType } from '../utils/auth-type.js';
import type { ContentGeneratorConfig } from './contentGenerator.js';
import type { ResolvedReasoning } from './reasoning-overrides.js';
import { normalize } from './tokenLimits.js';

export function getBuiltinKimiK3Reasoning(
  config: Partial<ContentGeneratorConfig>,
): ResolvedReasoning | undefined {
  if (
    config.authType !== AuthType.USE_OPENAI ||
    !KIMI_K3_GENERATION.test(normalize(config.model ?? ''))
  )
    return undefined;
  return {
    profile: 'openai-effort',
    thinking: true,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
    canDisable: false,
    disableField: 'reasoning_effort',
  };
}

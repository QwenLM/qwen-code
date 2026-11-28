/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../utils/auth-type.js';
import type { ContentGeneratorConfig } from './contentGenerator.js';
import { isOpenRouterHostname } from './openaiContentGenerator/provider/openrouter.js';
import type { ResolvedReasoning } from './reasoning-overrides.js';
import { normalize } from './tokenLimits.js';

const KIMI_K3_REASONING =
  /^(?:kimi-)?k3(?:$|-256k$|[.-]\d+(?:\.\d+)?(?:-pro(?:-(?:highspeed|high-speed))?)?$)/;

export function getBuiltinKimiK3Reasoning(
  config: Partial<ContentGeneratorConfig>,
): ResolvedReasoning | undefined {
  const model = normalize(config.model ?? '', config.baseUrl);
  if (config.authType !== AuthType.USE_OPENAI || !KIMI_K3_REASONING.test(model))
    return undefined;
  return {
    profile: isOpenRouterHostname(config)
      ? 'openai-reasoning'
      : 'openai-effort',
    thinking: true,
    efforts: ['low', 'high', 'max'],
    defaultEffort: 'max',
    canDisable: false,
    disableField: 'reasoning_effort',
  };
}

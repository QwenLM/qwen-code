/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateContentConfig } from '@google/genai';
import { getCurrentAgentDepth } from './agent-context.js';

export const AGENT_DEPTH_LABEL = 'agent_depth';

export function withAgentDepthLabel(
  config: GenerateContentConfig,
): GenerateContentConfig {
  const agentDepth = getCurrentAgentDepth();
  if (agentDepth <= 0) {
    return config;
  }

  return {
    ...config,
    labels: {
      ...(config.labels ?? {}),
      [AGENT_DEPTH_LABEL]: agentDepth.toString(),
    },
  };
}

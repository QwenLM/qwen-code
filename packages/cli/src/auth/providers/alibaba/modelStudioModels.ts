/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface AlibabaModelStudioModelSpec {
  id: string;
  contextWindowSize: number;
  enableThinking?: boolean;
  description?: string;
}

export const ALIBABA_MODELSTUDIO_MODELS: readonly AlibabaModelStudioModelSpec[] =
  [
    { id: 'qwen3.5-plus', contextWindowSize: 1000000, enableThinking: true },
    {
      id: 'qwen3.6-plus',
      description: 'Currently available to Pro subscribers only.',
      contextWindowSize: 1000000,
      enableThinking: true,
    },
    { id: 'glm-5', contextWindowSize: 202752, enableThinking: true },
    { id: 'kimi-k2.5', contextWindowSize: 262144, enableThinking: true },
    { id: 'MiniMax-M2.5', contextWindowSize: 196608, enableThinking: true },
    { id: 'qwen3-coder-plus', contextWindowSize: 1000000 },
    { id: 'qwen3-coder-next', contextWindowSize: 262144 },
    {
      id: 'qwen3-max-2026-01-23',
      contextWindowSize: 262144,
      enableThinking: true,
    },
    { id: 'glm-4.7', contextWindowSize: 202752, enableThinking: true },
  ];

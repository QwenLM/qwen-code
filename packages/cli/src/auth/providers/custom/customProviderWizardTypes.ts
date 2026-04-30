/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthType } from '@qwen-code/qwen-code-core';

export interface CustomProviderGenerationConfigInput {
  enableThinking?: boolean;
  multimodal?: {
    image?: boolean;
    video?: boolean;
    audio?: boolean;
  };
  maxTokens?: number;
}

export interface CustomProviderInstallInput {
  protocol: AuthType;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  envKey: string;
  generationConfig?: CustomProviderGenerationConfigInput;
}

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '../../providerConfig.js';

export const zaiProvider: ProviderConfig = {
  id: 'zai',
  label: 'Z.AI API Key',
  description: 'Quick setup for Z.AI models',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'standard-api-key',
      label: 'Standard API Key',
      url: 'https://api.z.ai/api/paas/v4',
      documentationUrl: 'https://docs.z.ai/',
    },
    {
      id: 'coding-plan',
      label: 'Coding Plan',
      url: 'https://api.z.ai/api/coding/paas/v4',
      documentationUrl: 'https://docs.z.ai/',
    },
  ],
  envKey: 'ZAI_API_KEY',
  authMethod: 'input',
  models: [
    { id: 'GLM-5.1', contextWindowSize: 204800, enableThinking: true },
    { id: 'GLM-5', contextWindowSize: 204800 },
    { id: 'GLM-5-Turbo', contextWindowSize: 204800 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'Z.AI',
  uiGroup: 'third-party',
};

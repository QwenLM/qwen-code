/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineApiKeyProvider } from '../../setupMethods/apiKey/defineApiKeyProvider.js';

export type ZaiApiKeyRegion = 'standard-api-key' | 'coding-plan';

export const ZAI_STANDARD_API_KEY_BASE_URL = 'https://api.z.ai/api/paas/v4';
export const ZAI_CODING_PLAN_BASE_URL = 'https://api.z.ai/api/coding/paas/v4';

export const ZAI_API_KEY_PROVIDER = defineApiKeyProvider<ZaiApiKeyRegion>({
  id: 'zai',
  option: 'ZAI_API_KEY',
  title: 'Z.AI API Key',
  description: 'Quick setup for Z.AI models',
  envKey: 'ZAI_API_KEY',
  modelNamePrefix: 'Z.AI',
  defaultModelIds: 'GLM-5.1,GLM-5,GLM-5-Turbo',
  regions: [
    {
      id: 'standard-api-key',
      title: 'Standard API Key',
      endpoint: ZAI_STANDARD_API_KEY_BASE_URL,
      documentationUrl: 'https://docs.z.ai/',
    },
    {
      id: 'coding-plan',
      title: 'Coding Plan',
      endpoint: ZAI_CODING_PLAN_BASE_URL,
      documentationUrl: 'https://docs.z.ai/',
    },
  ],
});

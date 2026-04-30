/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineApiKeyProvider } from '../../setupMethods/apiKey/defineApiKeyProvider.js';

export const ZAI_API_KEY_PROVIDER = defineApiKeyProvider({
  id: 'zai',
  option: 'ZAI_API_KEY',
  title: 'Z.AI API Key',
  description: 'Quick setup for Z.AI models',
  envKey: 'ZAI_API_KEY',
  modelNamePrefix: 'Z.AI',
  endpoint: 'https://api.z.ai/api/paas/v4',
  defaultModelIds: 'glm-4.6,glm-4.5',
  documentationUrl: 'https://docs.z.ai/',
});

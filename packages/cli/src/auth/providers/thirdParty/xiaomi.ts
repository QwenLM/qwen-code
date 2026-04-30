/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineApiKeyProvider } from '../../setupMethods/apiKey/defineApiKeyProvider.js';

export const XIAOMI_API_KEY_PROVIDER = defineApiKeyProvider({
  id: 'xiaomi',
  option: 'XIAOMI_API_KEY',
  title: 'Xiaomi API Key',
  description: 'Quick setup for Xiaomi models',
  envKey: 'XIAOMI_API_KEY',
  modelNamePrefix: 'Xiaomi',
  endpoint: 'https://api.ai.mi.com/v1',
  defaultModelIds: 'xmodel-1',
  documentationUrl: 'https://ai.mi.com/',
});

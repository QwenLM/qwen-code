/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineApiKeyProvider } from '../../setupMethods/apiKey/defineApiKeyProvider.js';

export const OPENAI_API_KEY_PROVIDER = defineApiKeyProvider({
  id: 'openai',
  option: 'OPENAI_API_KEY',
  title: 'OpenAI API Key',
  description: 'Quick setup for OpenAI-compatible OpenAI models',
  envKey: 'OPENAI_API_KEY',
  modelNamePrefix: 'OpenAI',
  endpoint: 'https://api.openai.com/v1',
  defaultModelIds: 'gpt-4.1,gpt-4.1-mini',
  documentationUrl: 'https://platform.openai.com/api-keys',
});

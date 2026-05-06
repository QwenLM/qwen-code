/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineApiKeyProvider } from '../../setupMethods/apiKey/defineApiKeyProvider.js';

export const DEEPSEEK_API_KEY_PROVIDER = defineApiKeyProvider({
  id: 'deepseek',
  option: 'DEEPSEEK_API_KEY',
  title: 'DeepSeek API Key',
  description: 'Quick setup for DeepSeek (deepseek-v4-flash, deepseek-v4-pro)',
  envKey: 'DEEPSEEK_API_KEY',
  modelNamePrefix: 'DeepSeek',
  endpoint: 'https://api.deepseek.com',
  defaultModelIds: 'deepseek-v4-flash,deepseek-v4-pro',
  documentationUrl: 'https://api-docs.deepseek.com/zh-cn/',
});

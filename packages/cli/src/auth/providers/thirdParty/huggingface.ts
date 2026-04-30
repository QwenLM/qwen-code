/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineApiKeyProvider } from '../../setupMethods/apiKey/defineApiKeyProvider.js';

export const HUGGINGFACE_API_KEY_PROVIDER = defineApiKeyProvider({
  id: 'huggingface',
  option: 'HUGGINGFACE_API_KEY',
  title: 'Hugging Face API Key',
  description: 'Quick setup for Hugging Face Inference Providers',
  envKey: 'HUGGINGFACE_API_KEY',
  modelNamePrefix: 'Hugging Face',
  endpoint: 'https://router.huggingface.co/v1',
  defaultModelIds: 'Qwen/Qwen3-Coder-480B-A35B-Instruct',
  documentationUrl: 'https://huggingface.co/settings/tokens',
});

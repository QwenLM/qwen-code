/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { defineApiKeyProvider } from '../../setupMethods/apiKey/defineApiKeyProvider.js';

export const MINIMAX_API_KEY_PROVIDER = defineApiKeyProvider({
  id: 'minimax',
  option: 'MINIMAX_API_KEY',
  title: 'MiniMax API Key',
  description: 'Quick setup for MiniMax models',
  envKey: 'MINIMAX_API_KEY',
  modelNamePrefix: 'MiniMax',
  endpoint: 'https://api.minimax.io/v1',
  defaultModelIds: 'MiniMax-M2.5',
  documentationUrl:
    'https://platform.minimaxi.com/user-center/basic-information/interface-key',
});

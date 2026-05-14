/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '../../providerConfig.js';

export const minimaxProvider: ProviderConfig = {
  id: 'minimax',
  label: 'MiniMax API Key',
  description: 'Quick setup for MiniMax models',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'international',
      label: 'International',
      url: 'https://api.minimax.io/v1',
      documentationUrl: 'https://www.minimax.io/platform',
    },
    {
      id: 'china',
      label: 'China',
      url: 'https://api.minimaxi.com/v1',
      documentationUrl: 'https://platform.minimaxi.com',
    },
  ],
  envKey: 'MINIMAX_API_KEY',
  authMethod: 'input',
  models: [
    { id: 'MiniMax-M2.7', contextWindowSize: 204800 },
    { id: 'MiniMax-M2.7-highspeed', contextWindowSize: 204800 },
    { id: 'MiniMax-M2.5', contextWindowSize: 196608 },
    { id: 'MiniMax-M2.5-highspeed', contextWindowSize: 196608 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'MiniMax',
  uiGroup: 'third-party',
};

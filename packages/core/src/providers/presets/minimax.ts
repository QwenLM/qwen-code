/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

export const minimaxProvider: ProviderConfig = {
  id: 'minimax',
  label: 'MiniMax API Key',
  description: 'Quick setup for MiniMax models',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'global-standard',
      label: 'Global (Standard)',
      url: 'https://api.minimax.io/v1',
      documentationUrl: 'https://platform.minimax.io/docs',
    },
    {
      id: 'global-messages',
      label: 'Global (Messages)',
      url: 'https://api.minimax.io/anthropic',
      protocol: AuthType.USE_ANTHROPIC,
      documentationUrl: 'https://platform.minimax.io/docs',
    },
    {
      id: 'china-standard',
      label: 'China (Standard)',
      url: 'https://api.minimaxi.com/v1',
      documentationUrl: 'https://platform.minimaxi.com/docs',
    },
    {
      id: 'china-messages',
      label: 'China (Messages)',
      url: 'https://api.minimaxi.com/anthropic',
      protocol: AuthType.USE_ANTHROPIC,
      documentationUrl: 'https://platform.minimaxi.com/docs',
    },
  ],
  envKey: 'MINIMAX_API_KEY',
  models: [
    {
      id: 'MiniMax-M3',
      contextWindowSize: 1000000,
      adaptiveThinking: true,
      modalities: { image: true, video: true },
    },
    {
      id: 'MiniMax-M2.7',
      contextWindowSize: 204800,
      thinkingMandatory: true,
    },
    { id: 'MiniMax-M2.7-highspeed', contextWindowSize: 204800 },
    { id: 'MiniMax-M2.5', contextWindowSize: 196608 },
    { id: 'MiniMax-M2.5-highspeed', contextWindowSize: 196608 },
    { id: 'image-01', imageOnly: true },
    { id: 'image-01-live', imageOnly: true },
  ],
  modelsEditable: true,
  modelNamePrefix: 'MiniMax',
  uiGroup: 'third-party',
};

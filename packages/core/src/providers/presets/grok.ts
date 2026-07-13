/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

export const GROK_ENV_KEY = 'XAI_API_KEY';
export const GROK_BASE_URL = 'https://api.x.ai/v1';

export const grokProvider: ProviderConfig = {
  id: 'grok',
  label: 'Grok (xAI) API Key',
  description: 'Quick setup for xAI Grok models (grok-4, grok-3)',
  protocol: AuthType.USE_OPENAI,
  baseUrl: GROK_BASE_URL,
  envKey: GROK_ENV_KEY,
  // xAI's API follows the standard OpenAI format and takes no custom
  // parameters — Grok reasoning models think by default, with no
  // enable_thinking toggle — so models carry only their context window.
  models: [
    { id: 'grok-4', contextWindowSize: 256000 },
    { id: 'grok-4-heavy', contextWindowSize: 256000 },
    { id: 'grok-3', contextWindowSize: 131072 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'Grok',
  documentationUrl: 'https://docs.x.ai/docs',
  uiGroup: 'third-party',
};

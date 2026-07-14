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
  description: 'Quick setup for xAI Grok chat & code models',
  protocol: AuthType.USE_OPENAI,
  baseUrl: GROK_BASE_URL,
  envKey: GROK_ENV_KEY,
  // xAI's API follows the standard OpenAI format. Grok models reason by
  // default (grok-4.5 exposes an optional reasoning_effort knob, default
  // high) and have no Qwen-style enable_thinking toggle, so the preset
  // carries only each model's context window.
  models: [
    { id: 'grok-4.5', contextWindowSize: 500000 },
    { id: 'grok-4.3', contextWindowSize: 1000000 },
    { id: 'grok-4.20-0309-reasoning', contextWindowSize: 1000000 },
    { id: 'grok-4.20-0309-non-reasoning', contextWindowSize: 1000000 },
    { id: 'grok-4.20-multi-agent-0309', contextWindowSize: 1000000 },
    { id: 'grok-build-0.1', contextWindowSize: 256000 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'Grok',
  documentationUrl: 'https://docs.x.ai/docs',
  uiGroup: 'third-party',
};

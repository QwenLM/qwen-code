/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import { COPILOT_SENTINEL_BASE_URL } from '../../copilot/copilot-fetch.js';
import type { ProviderConfig } from '../types.js';

export const COPILOT_ENV_KEY = 'GITHUB_COPILOT_TOKEN';

export const copilotProvider: ProviderConfig = {
  id: 'copilot',
  label: 'GitHub Copilot',
  description:
    'Route claude-* / gpt-5* via Copilot CAPI (uses your GitHub token)',
  protocol: AuthType.USE_COPILOT,
  baseUrl: COPILOT_SENTINEL_BASE_URL,
  envKey: COPILOT_ENV_KEY,
  models: [
    { id: 'claude-opus-4.7', contextWindowSize: 200000, enableThinking: true },
    {
      id: 'claude-sonnet-4.6',
      contextWindowSize: 200000,
      enableThinking: true,
    },
    { id: 'gpt-5.2', contextWindowSize: 200000 },
    { id: 'gpt-5.4', contextWindowSize: 200000 },
  ],
  modelsEditable: true,
  modelNamePrefix: 'Copilot',
  showAdvancedConfig: true,
  uiGroup: 'copilot',
  uiLabels: { flowTitle: 'Set up GitHub Copilot' },
};

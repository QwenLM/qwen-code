/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

export const moonshotProvider: ProviderConfig = {
  id: 'moonshot',
  label: 'Kimi (Moonshot AI) API Key',
  description: 'Quick setup for Kimi models',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'international',
      label: 'International',
      url: 'https://api.moonshot.ai/v1',
      documentationUrl: 'https://platform.kimi.ai/docs',
    },
    {
      id: 'china',
      label: 'China',
      url: 'https://api.moonshot.cn/v1',
      documentationUrl: 'https://platform.moonshot.cn/docs',
    },
  ],
  envKey: 'MOONSHOT_API_KEY',
  models: [
    {
      id: 'kimi-k3',
      capabilities: {
        reasoning: {
          thinking: true,
          efforts: ['low', 'high', 'max'],
          defaultEffort: 'max',
          canDisable: false,
          disableField: 'reasoning_effort',
        },
      },
      contextWindowSize: 1000000,
      // K3 always thinks: the API exposes `reasoning_effort` but no way to
      // turn thinking off, so never emit a disable shape on the wire.
      thinkingMandatory: true,
      modalities: { image: true, video: true },
    },
    {
      id: 'kimi-k2.7-code',
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          canDisable: false,
          disableField: 'thinking',
        },
      },
      contextWindowSize: 262144,
      modalities: { image: true, video: true },
      thinkingMandatory: true,
    },
    {
      id: 'kimi-k2.7-code-highspeed',
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          canDisable: false,
          disableField: 'thinking',
        },
      },
      contextWindowSize: 262144,
      modalities: { image: true, video: true },
      thinkingMandatory: true,
    },
    {
      id: 'kimi-k2.6',
      capabilities: {
        reasoning: {
          thinking: true,
          toggleOnly: true,
          disableField: 'thinking',
        },
      },
      contextWindowSize: 262144,
      modalities: { image: true, video: true },
    },
  ],
  modelsEditable: true,
  modelNamePrefix: 'Kimi',
  uiGroup: 'third-party',
};

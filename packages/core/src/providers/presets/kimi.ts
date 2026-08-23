/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig, ProviderModelConfig } from '../types.js';
import { normalizeBaseUrlForMatching } from '../provider-config.js';

export const KIMI_API_ENV_KEY = 'MOONSHOT_API_KEY';
export const KIMI_CODE_BASE_URL = 'https://api.kimi.com/coding/v1';
export const KIMI_CODE_ENV_KEY = 'KIMI_CODE_API_KEY';

const KIMI_CODE_MODELS = [
  {
    id: 'k3-256k',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true },
  },
  {
    id: 'k3',
    contextWindowSize: 1048576,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-for-coding',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-for-coding-highspeed',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
];

const KIMI_API_MODELS = [
  {
    id: 'kimi-k3',
    contextWindowSize: 1048576,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-k2.7-code',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-k2.7-code-highspeed',
    contextWindowSize: 262144,
    thinkingMandatory: true,
    modalities: { image: true, video: true },
  },
  {
    id: 'kimi-k2.6',
    contextWindowSize: 262144,
    // Explicit capability declaration (K2.6 is multimodal per Moonshot's
    // model docs) rather than inheritance from the heuristic table.
    modalities: { image: true, video: true },
  },
];

function isKimiCode(baseUrl: string): boolean {
  return (
    normalizeBaseUrlForMatching(baseUrl) ===
    normalizeBaseUrlForMatching(KIMI_CODE_BASE_URL)
  );
}

function ownsKimiModel(model: ProviderModelConfig): boolean {
  if (model.envKey === KIMI_CODE_ENV_KEY) {
    return model.name?.startsWith('[Kimi Code] ') === true;
  }
  if (model.envKey === KIMI_API_ENV_KEY) {
    return model.name?.startsWith('[Kimi API] ') === true;
  }
  return false;
}

export const kimiProvider: ProviderConfig = {
  id: 'kimi',
  label: 'Kimi',
  description: 'Choose Kimi Code or a regional Kimi API endpoint',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'coding-plan',
      label: 'Coding Plan',
      url: KIMI_CODE_BASE_URL,
      models: KIMI_CODE_MODELS,
      documentationUrl: 'https://www.kimi.com/code/docs/en/',
    },
    {
      id: 'api-china',
      label: 'API Key (China)',
      url: 'https://api.moonshot.cn/v1',
      models: KIMI_API_MODELS,
      documentationUrl: 'https://platform.kimi.com/docs/api/overview',
    },
    {
      id: 'api-international',
      label: 'API Key (International)',
      url: 'https://api.moonshot.ai/v1',
      models: KIMI_API_MODELS,
      documentationUrl: 'https://platform.kimi.ai/docs/api/overview',
    },
  ],
  envKey: (_protocol, baseUrl) =>
    isKimiCode(baseUrl) ? KIMI_CODE_ENV_KEY : KIMI_API_ENV_KEY,
  models: [...KIMI_CODE_MODELS, ...KIMI_API_MODELS],
  modelsEditable: true,
  modelNamePrefix: (baseUrl) =>
    isKimiCode(baseUrl) ? 'Kimi Code' : 'Kimi API',
  documentationUrl: (baseUrl) =>
    isKimiCode(baseUrl)
      ? 'https://www.kimi.com/code/docs/en/'
      : normalizeBaseUrlForMatching(baseUrl) ===
          normalizeBaseUrlForMatching('https://api.moonshot.cn/v1')
        ? 'https://platform.kimi.com/docs/api/overview'
        : 'https://platform.kimi.ai/docs/api/overview',
  ownsModel: ownsKimiModel,
  // Kimi owns both its Coding Plan and API credential domains. Install plans
  // scope this predicate to the selected endpoint so resubmitting one model
  // list can remove omitted entries without deleting a sibling endpoint.
  mergeModelsByIdentity: true,
  uiGroup: 'third-party',
  uiLabels: { baseUrlStepTitle: 'Access type' },
};

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig, ProviderModelConfig } from '../types.js';
import { normalizeBaseUrlForMatching } from '../provider-config.js';

export const XIAOMI_MIMO_ENV_KEY = 'MIMO_API_KEY';
export const XIAOMI_MIMO_TOKEN_ENV_KEY = 'MIMO_TOKEN_PLAN_API_KEY';

const XIAOMI_MIMO_PAYGO_BASE_URL = 'https://api.xiaomimimo.com/v1';

function isPayAsYouGo(baseUrl: string): boolean {
  return (
    normalizeBaseUrlForMatching(baseUrl) ===
    normalizeBaseUrlForMatching(XIAOMI_MIMO_PAYGO_BASE_URL)
  );
}

function ownsXiaomiMimoModel(model: ProviderModelConfig): boolean {
  return (
    (model.envKey === XIAOMI_MIMO_ENV_KEY ||
      model.envKey === XIAOMI_MIMO_TOKEN_ENV_KEY) &&
    model.name?.startsWith('[Xiaomi MiMo] ') === true
  );
}

export const xiaomiMimoProvider: ProviderConfig = {
  id: 'xiaomi-mimo',
  label: 'Xiaomi MiMo API Key',
  description: 'Pay-as-you-go API or Token Plan access to Xiaomi MiMo',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'pay-as-you-go',
      label: 'Pay-as-you-go API',
      url: XIAOMI_MIMO_PAYGO_BASE_URL,
      documentationUrl:
        'https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call',
    },
    {
      id: 'token-plan-china',
      label: 'Token Plan (China)',
      url: 'https://token-plan-cn.xiaomimimo.com/v1',
      documentationUrl: 'https://mimo.mi.com/docs/tokenplan/subscription',
    },
    {
      id: 'token-plan-singapore',
      label: 'Token Plan (Singapore)',
      url: 'https://token-plan-sgp.xiaomimimo.com/v1',
      documentationUrl: 'https://mimo.mi.com/docs/tokenplan/subscription',
    },
    {
      id: 'token-plan-europe',
      label: 'Token Plan (Europe)',
      url: 'https://token-plan-ams.xiaomimimo.com/v1',
      documentationUrl: 'https://mimo.mi.com/docs/tokenplan/subscription',
    },
  ],
  envKey: (_protocol, baseUrl) =>
    isPayAsYouGo(baseUrl) ? XIAOMI_MIMO_ENV_KEY : XIAOMI_MIMO_TOKEN_ENV_KEY,
  models: [
    { id: 'mimo-v2.5-pro', contextWindowSize: 1048576 },
    {
      id: 'mimo-v2.5',
      contextWindowSize: 1048576,
      modalities: { image: true, video: true, audio: true },
    },
  ],
  modelsEditable: true,
  modelNamePrefix: 'Xiaomi MiMo',
  apiKeyPlaceholder: 'sk-... or tp-...',
  documentationUrl: (baseUrl) =>
    isPayAsYouGo(baseUrl)
      ? 'https://mimo.mi.com/docs/en-US/quick-start/summary/first-api-call'
      : 'https://mimo.mi.com/docs/tokenplan/subscription',
  ownsModel: ownsXiaomiMimoModel,
  mergeModelsByIdentity: true,
  uiGroup: 'third-party',
};

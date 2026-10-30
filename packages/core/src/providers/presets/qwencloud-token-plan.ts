/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';
import { QWENCLOUD_MODELS } from './qwencloud-standard.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const QWENCLOUD_TOKEN_PLAN_ENV_KEY = 'QWENCLOUD_TOKEN_PLAN_API_KEY';
/** 千问AI平台 (China) Token Plan — dedicated subscription endpoint. */
export const QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL =
  'https://token-plan.maas.qianwenaiapi.com/compatible-mode/v1';
/** QwenCloud (International) Token Plan — dedicated subscription endpoint. */
export const QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL =
  'https://token-plan.maas.qwencloudapi.com/compatible-mode/v1';

export const QWENCLOUD_TOKEN_PLAN_CHINA_DOC_URL =
  'https://platform.qianwenai.com/docs/token-plan/overview';
export const QWENCLOUD_TOKEN_PLAN_GLOBAL_DOC_URL =
  'https://docs.qwencloud.com/token-plan/overview';

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

// kimi-k3 returns model_not_found on Token Plan; catalog omissions alone do not
// establish unavailability (deepseek-v4-pro-0813 remains callable).
const QWENCLOUD_TOKEN_PLAN_MODELS = QWENCLOUD_MODELS.filter(
  (model) => model.id !== 'kimi-k3',
);

export const qwencloudTokenPlanProvider: ProviderConfig = {
  id: 'qwencloud-token-plan',
  label: 'Token Plan',
  description:
    'Subscription with a monthly Credit quota · Dedicated endpoint (Personal and Team editions)',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'cn-qianwenai',
      label: 'China — 千问AI平台',
      url: QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL,
      documentationUrl: QWENCLOUD_TOKEN_PLAN_CHINA_DOC_URL,
      apiKeyUrl: QWENCLOUD_TOKEN_PLAN_CHINA_DOC_URL,
    },
    {
      id: 'intl-qwencloud',
      label: 'International — QwenCloud',
      url: QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL,
      documentationUrl: QWENCLOUD_TOKEN_PLAN_GLOBAL_DOC_URL,
      apiKeyUrl: QWENCLOUD_TOKEN_PLAN_GLOBAL_DOC_URL,
    },
  ],
  envKey: QWENCLOUD_TOKEN_PLAN_ENV_KEY,
  // The plan docs do not enumerate which chat models a tier unlocks, so the
  // seeded catalog is only the offline fallback; discovery reads `/models`.
  models: QWENCLOUD_TOKEN_PLAN_MODELS,
  modelsEditable: true,
  supportsModelDiscovery: true,
  modelNamePrefix: (baseUrl) =>
    baseUrl === QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL
      ? 'QwenCloud Token Plan for Global/Intl'
      : 'QwenCloud Token Plan',
  apiKeyPlaceholder: 'sk-sp-...',
  // Token Plan keys are issued with a dedicated `sk-sp-` prefix; a plain
  // pay-as-you-go key cannot draw down the subscription quota.
  validateApiKey: (key) =>
    key.startsWith('sk-sp-')
      ? null
      : 'Invalid API key. Token Plan API keys start with "sk-sp-". Generate one from the Token Plan console, or use the Standard API Key entry for a pay-as-you-go key.',
  ownsModel: (model) =>
    model.envKey === QWENCLOUD_TOKEN_PLAN_ENV_KEY &&
    typeof model.baseUrl === 'string' &&
    (model.baseUrl === QWENCLOUD_TOKEN_PLAN_CHINA_BASE_URL ||
      model.baseUrl === QWENCLOUD_TOKEN_PLAN_GLOBAL_BASE_URL),
  // Same server-side Harness tools as the pay-as-you-go endpoints. The plan
  // docs scope them to models served over the Responses API; a Chat
  // Completions-only model will not invoke them.
  webSearch: { backend: 'dashscope' },
  uiGroup: 'qwencloud',
  uiLabels: {
    flowTitle: 'QwenCloud',
    baseUrlStepTitle: 'Platform',
  },
};

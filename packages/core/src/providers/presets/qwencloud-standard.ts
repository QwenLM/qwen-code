/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig, ModelSpec } from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const QWENCLOUD_ENV_KEY = 'QWENCLOUD_API_KEY';
/** 千问AI平台 (China) — https://platform.qianwenai.com */
export const QWENCLOUD_CHINA_BASE_URL =
  'https://maas.qianwenaiapi.com/compatible-mode/v1';
/** QwenCloud (International) — https://docs.qwencloud.com */
export const QWENCLOUD_GLOBAL_BASE_URL =
  'https://maas.qwencloudapi.com/compatible-mode/v1';

export const QWENCLOUD_CHINA_API_KEY_URL =
  'https://platform.qianwenai.com/docs/developer-guides/administration/api-keys';
export const QWENCLOUD_GLOBAL_API_KEY_URL =
  'https://docs.qwencloud.com/developer-guides/administration/api-keys';

/** Chat models from the platform's own model-selection page. */
export const QWENCLOUD_MODELS: ModelSpec[] = [
  {
    id: 'qwen3.8-max',
    contextWindowSize: 1000000,
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ['low', 'medium', 'xhigh'],
        defaultEffort: 'xhigh',
        disableField: 'reasoning_effort',
      },
    },
    modalities: { image: true, video: true },
  },
  {
    id: 'qwen3.7-plus',
    contextWindowSize: 1000000,
    enableThinking: true,
    capabilities: {
      reasoning: {
        thinking: true,
        toggleOnly: true,
        disableField: 'enable_thinking',
      },
    },
    modalities: { image: true, video: true },
  },
  {
    id: 'qwen3.8-flash',
    contextWindowSize: 1000000,
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ['low', 'medium', 'xhigh'],
        defaultEffort: 'xhigh',
        disableField: 'reasoning_effort',
      },
    },
    modalities: { image: true, video: true },
  },
  {
    id: 'deepseek-v4-pro-0813',
    contextWindowSize: 1000000,
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
        disableField: 'enable_thinking',
      },
    },
  },
  {
    // The platform documents this model's 1M window and image input but not
    // its thinking parameter; reasoning shape follows deepseek-v4-flash.
    id: 'deepseek-v4.1-flash',
    contextWindowSize: 1000000,
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'high',
        disableField: 'enable_thinking',
      },
    },
    modalities: { image: true },
  },
  {
    id: 'kimi-k3',
    thinkingMandatory: true,
    contextWindowSize: 1000000,
    capabilities: {
      reasoning: {
        thinking: true,
        efforts: ['low', 'high', 'max'],
        defaultEffort: 'max',
        canDisable: false,
        disableField: 'reasoning_effort',
      },
    },
    modalities: { image: true },
  },
  // The platform documents three reasoning effort levels for glm-5.3 without
  // naming them, so this follows the glm-5.1/5.2 toggle-only shape.
  { id: 'glm-5.3', contextWindowSize: 1000000, enableThinking: true },
];

// ---------------------------------------------------------------------------
// Provider config
// ---------------------------------------------------------------------------

export const qwencloudStandardProvider: ProviderConfig = {
  id: 'qwencloud-standard',
  label: 'Standard API Key',
  description: 'Pay-as-you-go · Connect with an existing platform API key',
  protocol: AuthType.USE_OPENAI,
  baseUrl: [
    {
      id: 'cn-qianwenai',
      label: 'China — 千问AI平台',
      url: QWENCLOUD_CHINA_BASE_URL,
      documentationUrl: QWENCLOUD_CHINA_API_KEY_URL,
      apiKeyUrl: QWENCLOUD_CHINA_API_KEY_URL,
    },
    {
      id: 'intl-qwencloud',
      label: 'International — QwenCloud',
      url: QWENCLOUD_GLOBAL_BASE_URL,
      documentationUrl: QWENCLOUD_GLOBAL_API_KEY_URL,
      apiKeyUrl: QWENCLOUD_GLOBAL_API_KEY_URL,
    },
  ],
  envKey: QWENCLOUD_ENV_KEY,
  models: QWENCLOUD_MODELS,
  modelsEditable: true,
  supportsModelDiscovery: true,
  modelNamePrefix: 'QwenCloud Standard',
  apiKeyPlaceholder: 'sk-...',
  validateApiKey: (key) =>
    key.startsWith('sk-') && !key.startsWith('sk-sp-')
      ? null
      : 'Invalid API key. Pay-as-you-go keys start with "sk-" or "sk-ws-". Token Plan keys ("sk-sp-") need the Token Plan entry instead.',
  // The Responses API on these endpoints serves the server-side `web_search`
  // / `web_extractor` tools with the same key.
  webSearch: { backend: 'dashscope' },
  ownsModel: (model) =>
    model.envKey === QWENCLOUD_ENV_KEY &&
    typeof model.baseUrl === 'string' &&
    (model.baseUrl === QWENCLOUD_CHINA_BASE_URL ||
      model.baseUrl === QWENCLOUD_GLOBAL_BASE_URL),
  uiGroup: 'qwencloud',
  uiLabels: {
    flowTitle: 'QwenCloud',
    baseUrlStepTitle: 'Platform',
  },
};

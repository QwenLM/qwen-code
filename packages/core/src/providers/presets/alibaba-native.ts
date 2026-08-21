/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../../core/contentGenerator.js';
import type { ProviderConfig } from '../types.js';

/**
 * `modelNamePrefix: 'ModelStudio Native'` MUST differ from
 * `alibabaStandardProvider`'s `'ModelStudio Standard'` — both share
 * `DASHSCOPE_API_KEY`, and `resolveOwnsModel` (provider-config.ts)
 * disambiguates ownership by envKey + name prefix; a collision would let
 * installing this preset delete a user's existing compat-mode models.
 *
 * Deliberately NOT set: `enableThinking` (qwen3.8-max thinks by default; the
 * flag would inject a redundant `enable_thinking` extra_body knob that the
 * native converter never emits), `thinkingMandatory` (`reasoning_effort:
 * 'none'` is a verified working off-switch). Model metadata needs no new
 * registry entries — `tokenLimits.ts` already gives `qwen3.x` models 1M
 * context / 64k output, and `modalityDefaults.ts` already maps
 * `qwen3.8-max` to image support.
 */
export const alibabaNativeProvider: ProviderConfig = {
  id: 'alibabaNative',
  label: 'Native DashScope API',
  description:
    'Native DashScope API — explicit prompt caching and raw reasoning stream',
  protocol: AuthType.USE_DASHSCOPE,
  baseUrl: [
    {
      id: 'sg-singapore',
      label: 'Singapore',
      url: 'https://dashscope-intl.aliyuncs.com/api/v1',
    },
    {
      id: 'cn-beijing',
      label: 'China (Beijing)',
      url: 'https://dashscope.aliyuncs.com/api/v1',
    },
    {
      id: 'us-virginia',
      label: 'US (Virginia)',
      url: 'https://dashscope-us.aliyuncs.com/api/v1',
    },
  ],
  envKey: 'DASHSCOPE_API_KEY',
  models: [{ id: 'qwen3.8-max', contextWindowSize: 1_000_000 }],
  modelsEditable: true,
  modelNamePrefix: 'ModelStudio Native',
  uiGroup: 'alibaba',
  uiLabels: {
    flowTitle: 'Alibaba ModelStudio (Native API)',
    baseUrlStepTitle: 'Region',
  },
};

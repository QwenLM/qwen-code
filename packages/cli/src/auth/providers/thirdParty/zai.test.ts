/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  ZAI_API_KEY_PROVIDER,
  ZAI_CODING_PLAN_BASE_URL,
  ZAI_STANDARD_API_KEY_BASE_URL,
} from './zai.js';

describe('ZAI_API_KEY_PROVIDER', () => {
  it('offers standard API key and Coding Plan endpoints', () => {
    expect(ZAI_API_KEY_PROVIDER).toEqual({
      id: 'zai',
      option: 'ZAI_API_KEY',
      title: 'Z.AI API Key',
      description: 'Quick setup for Z.AI models',
      envKey: 'ZAI_API_KEY',
      modelNamePrefix: 'Z.AI',
      defaultModelIds: 'GLM-5.1,GLM-5,GLM-5-Turbo',
      regions: [
        {
          id: 'standard-api-key',
          title: 'Standard API Key',
          endpoint: ZAI_STANDARD_API_KEY_BASE_URL,
          documentationUrl: 'https://docs.z.ai/',
        },
        {
          id: 'coding-plan',
          title: 'Coding Plan',
          endpoint: ZAI_CODING_PLAN_BASE_URL,
          documentationUrl: 'https://docs.z.ai/',
        },
      ],
    });
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  MINIMAX_API_KEY_PROVIDER,
  MINIMAX_CHINA_BASE_URL,
  MINIMAX_INTERNATIONAL_BASE_URL,
} from './minimax.js';

describe('MINIMAX_API_KEY_PROVIDER', () => {
  it('offers international and China standard API endpoints', () => {
    expect(MINIMAX_API_KEY_PROVIDER).toEqual({
      id: 'minimax',
      option: 'MINIMAX_API_KEY',
      title: 'MiniMax API Key',
      description: 'Quick setup for MiniMax models',
      envKey: 'MINIMAX_API_KEY',
      modelNamePrefix: 'MiniMax',
      defaultModelIds:
        'MiniMax-M2.7,MiniMax-M2.7-highspeed,MiniMax-M2.5,MiniMax-M2.5-highspeed',
      regions: [
        {
          id: 'international',
          title: 'International',
          endpoint: MINIMAX_INTERNATIONAL_BASE_URL,
          documentationUrl: 'https://www.minimax.io/platform',
        },
        {
          id: 'china',
          title: 'China',
          endpoint: MINIMAX_CHINA_BASE_URL,
          documentationUrl: 'https://platform.minimaxi.com',
        },
      ],
    });
  });
});

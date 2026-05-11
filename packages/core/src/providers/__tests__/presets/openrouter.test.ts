/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { openRouterProvider } from '@qwen-code/qwen-code-core';

describe('openRouterProvider', () => {
  it('owns models by OpenRouter base URL', () => {
    expect(
      openRouterProvider.ownsModel?.({
        id: 'openrouter-model',
        baseUrl: 'https://openrouter.ai/api/v1',
      }),
    ).toBe(true);
    expect(
      openRouterProvider.ownsModel?.({
        id: 'other-model',
        baseUrl: 'https://api.example.com/v1',
      }),
    ).toBe(false);
  });
});

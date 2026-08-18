/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getModelConfiguration } from './model-configuration.js';

describe('model configuration manifest', () => {
  it('registers the exact stable qwen3.8-max reasoning controls', () => {
    expect(getModelConfiguration('qwen3.8-max')).toEqual({
      reasoning: {
        thinking: true,
        efforts: ['low', 'medium', 'xhigh'],
        defaultEffort: 'xhigh',
      },
    });
  });

  it.each([
    undefined,
    'qwen3.8-max-preview',
    'qwen3.8-max-latest',
    'qwen3.8-max-2026-08-12',
    'vendor/qwen3.8-max',
  ])('does not broaden the manifest to %s', (modelId) => {
    expect(getModelConfiguration(modelId)).toBeUndefined();
  });
});

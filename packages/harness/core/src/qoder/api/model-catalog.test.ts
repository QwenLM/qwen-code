/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  QoderModelCatalogError,
  mapQoderModelCatalog,
} from './model-catalog.js';

describe('mapQoderModelCatalog', () => {
  it('maps capabilities, context tiers, and defaults', () => {
    const models = mapQoderModelCatalog({
      qcode: [
        {
          key: 'auto',
          display_name: 'Auto',
          is_default: true,
        },
        {
          key: 'qwen-max',
          display_name: 'Qwen Max',
          is_vl: true,
          is_reasoning: true,
          max_input_tokens: 180_000,
          max_output_tokens: 32_000,
          context_config: {
            '200K': { token_count: 200_000 },
            '1M': { token_count: 1_000_000, is_default: true },
          },
          thinking_config: {
            disabled: { description: 'off' },
            enabled: {
              efforts: {
                low: { is_default: true },
                high: {},
              },
            },
          },
        },
        { key: 'disabled-model', enable: false },
        { display_name: 'no key' },
      ],
    });

    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      key: 'auto',
      displayName: 'Auto',
      isDefault: true,
      isVision: false,
      isReasoning: false,
      contextWindows: [],
    });
    expect(models[1]).toEqual({
      key: 'qwen-max',
      displayName: 'Qwen Max',
      enabled: true,
      isDefault: false,
      isVision: true,
      isReasoning: true,
      contextWindows: [200_000, 1_000_000],
      defaultContextWindow: 1_000_000,
      maxInputTokens: 180_000,
      maxOutputTokens: 32_000,
      reasoning: {
        efforts: ['low', 'high'],
        defaultEffort: 'low',
        canDisable: true,
      },
    });
  });

  it('throws on an invalid response shape', () => {
    expect(() => mapQoderModelCatalog({ models: [] })).toThrow(
      QoderModelCatalogError,
    );
  });
});

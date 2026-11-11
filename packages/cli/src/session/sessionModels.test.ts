/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { parseSessionModels } from './sessionModels.js';

describe('parseSessionModels', () => {
  it.each([
    ['system', 'system'],
    ['user', 'user'],
    ['organization', 'organization'],
    ['custom', 'custom'],
    ['unknown', 'system'],
    [undefined, 'system'],
  ] as const)('normalizes source=%s to %s', (source, expected) => {
    const [model] = parseSessionModels([
      {
        value: 'gateway/model-a',
        displayName: 'Model A',
        source,
        tags: ['custom-provider'],
      },
    ])!;
    expect(model.source).toBe(expected);
    expect(model.tags).toEqual(['custom-provider']);
  });

  it('accepts SDK model value as a modelId alias', () => {
    expect(
      parseSessionModels([
        {
          value: 'model-sdk',
          displayName: 'SDK Model',
          description: 'Reasoning',
          descriptionEn: 'Reasoning model',
        },
      ]),
    ).toEqual([
      {
        value: 'model-sdk',
        modelId: 'model-sdk',
        displayName: 'SDK Model',
        description: 'Reasoning',
        descriptionEn: 'Reasoning model',
        source: 'system',
      },
    ]);
  });

  it('preserves explicitly empty model descriptions', () => {
    expect(
      parseSessionModels([
        {
          value: 'model-without-description',
          displayName: 'Model',
          description: '',
          descriptionEn: '',
        },
      ])?.[0],
    ).toMatchObject({ description: '', descriptionEn: '' });
  });

  it('preserves public model attributes', () => {
    const result = parseSessionModels([
      {
        modelId: 'ultimate',
        displayName: 'Ultimate',
        isEnabled: true,
        isNew: true,
        isFree: true,
        priceFactor: 1.6,
      },
    ]);

    expect(result?.[0]).toMatchObject({
      value: 'ultimate',
      modelId: 'ultimate',
      displayName: 'Ultimate',
      isEnabled: true,
      isNew: true,
    });
    expect(result?.[0]).not.toHaveProperty('isFree');
    expect(result?.[0]).not.toHaveProperty('priceFactor');
  });

  it('preserves rich catalog fields end-to-end', () => {
    const result = parseSessionModels([
      {
        modelId: 'ultimate',
        displayName: 'Ultimate',
        source: 'organization',
        isReasoning: true,
        isVl: true,
        maxInputTokens: 200_000,
        maxOutputTokens: 8_192,
        originalPriceFactor: 1.6,
        defaultEffort: 'high',
        tags: ['DogFooding'],
        strategies: [
          { tag: 'C4', enabled: false, disabled_message_key: 'reason' },
        ],
        format: 'openai',
        scene: 'chat',
        serverScene: 'organization_models',
        icon: 'https://cdn.example.com/icons/ultimate.svg',
        url: 'https://api.example.com',
        model: 'gpt-5',
        provider: 'openai',
        context_config: { '200K': { token_count: 200_000, is_default: true } },
        thinking_config: { disabled: { description: 'off' } },
        promotion: {
          active: true,
          badge: { en: 'Off-Peak 50% off' },
          discount_factor: 0.5,
          before_promotion_price_factor: 1.6,
          timezone: 'Asia/Shanghai',
          rule_id: 'night_qmodel',
          window_start: '20:00',
          window_end: '08:00',
        },
        serverModel: {
          key: 'ultimate',
          display_name: 'Ultimate',
          future_field: { enabled: true },
          nested: {
            parameters: { target: 'safe-target' },
            keep: 'ok',
          },
        },
        function_switches: [
          {
            key: 'highspeed',
            type: 'bool',
            options: {
              false: { actions: [], is_default: true },
              true: {
                actions: [
                  {
                    type: 'replace_model_key',
                    parameters: { target: 'ultimate-highspeed' },
                  },
                ],
              },
            },
          },
        ],
      },
    ]);

    expect(result?.[0]).toMatchObject({
      modelId: 'ultimate',
      source: 'organization',
      isReasoning: true,
      isVl: true,
      maxInputTokens: 200_000,
      maxOutputTokens: 8_192,
      defaultEffort: 'high',
      tags: ['DogFooding'],
      strategies: [
        { tag: 'C4', enabled: false, disabled_message_key: 'reason' },
      ],
      format: 'openai',
      scene: 'chat',
      serverScene: 'organization_models',
      icon: 'https://cdn.example.com/icons/ultimate.svg',
      url: 'https://api.example.com',
      model: 'gpt-5',
      provider: 'openai',
      context_config: { '200K': { token_count: 200_000, is_default: true } },
      thinking_config: { disabled: { description: 'off' } },
      serverModel: {
        key: 'ultimate',
        display_name: 'Ultimate',
        future_field: { enabled: true },
        nested: { parameters: { target: 'safe-target' }, keep: 'ok' },
      },
    });
    expect(result?.[0]).not.toHaveProperty('function_switches');
    expect(result?.[0]).not.toHaveProperty('originalPriceFactor');
    expect(result?.[0]).not.toHaveProperty('promotion');
  });

  it('drops strategy entries missing a tag and applies safe defaults', () => {
    const result = parseSessionModels([
      {
        modelId: 'm',
        displayName: 'M',
        strategies: [
          { tag: 'C4' },
          { enabled: true, disabled_message_key: 'x' },
          'not-an-object',
          { tag: 'C5', enabled: true, disabled_message_key: 'y' },
        ],
      },
    ]);

    expect(result?.[0].strategies).toEqual([
      { tag: 'C4', enabled: false, disabled_message_key: '' },
      { tag: 'C5', enabled: true, disabled_message_key: 'y' },
    ]);
  });
});

/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  buildModelReasoningConfigOption,
  buildModelReasoningConfigPreview,
  getModelConfiguration,
  resolveReasoningPreviewState,
} from './model-configuration.js';

describe('model configuration manifest', () => {
  it('registers the exact stable qwen3.8-max reasoning controls', () => {
    expect(getModelConfiguration('qwen3.8-max')).toEqual({
      reasoning: {
        thinking: true,
        efforts: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'xhigh', name: 'Extra High' },
        ],
        defaultEffort: 'xhigh',
      },
    });
  });

  it('builds the stable qwen3.8-max default reasoning option', () => {
    expect(buildModelReasoningConfigOption('qwen3.8-max')).toMatchObject({
      id: 'reasoning_effort',
      currentValue: 'xhigh',
      options: [
        { value: 'none' },
        { value: 'default', name: 'Default' },
        { value: 'low' },
        { value: 'medium' },
        { value: 'xhigh' },
      ],
      _meta: {
        'qwenCode/reasoning': { defaultEffort: 'xhigh' },
      },
    });
  });

  it.each([
    undefined,
    'qwen3.7-plus',
    'qwen3.8-max-preview',
    'qwen3.8-max-latest',
    'qwen3.8-max-2026-08-12',
    'qwen-route:v1:stable',
    '$runtime|qwen-oauth|qwen3.8-max',
  ])('does not project a tiered welcome preview for %s', (modelId) => {
    expect(buildModelReasoningConfigPreview(modelId)).toBeUndefined();
  });

  it('wraps the stable default option for workspace preview', () => {
    expect(buildModelReasoningConfigPreview('qwen3.8-max')).toEqual([
      buildModelReasoningConfigOption('qwen3.8-max'),
    ]);
  });

  it('projects the loaded reasoning effort in workspace preview', () => {
    expect(
      buildModelReasoningConfigPreview('qwen3.8-max', {
        enabled: true,
        effort: 'medium',
      }),
    ).toMatchObject([{ currentValue: 'medium' }]);
  });

  it('projects disabled reasoning in workspace preview', () => {
    expect(
      buildModelReasoningConfigPreview('qwen3.8-max', {
        enabled: false,
        effort: 'medium',
      }),
    ).toMatchObject([{ currentValue: 'none' }]);
  });

  it('projects a model-default none effort as disabled reasoning', () => {
    const state = resolveReasoningPreviewState(undefined, { effort: 'none' });

    expect(state).toEqual({ enabled: false });
    expect(
      buildModelReasoningConfigPreview('qwen3.8-max', state),
    ).toMatchObject([{ currentValue: 'none' }]);
  });

  it('ignores a malformed non-string model-default effort', () => {
    expect(
      resolveReasoningPreviewState(undefined, { effort: 3 as never }),
    ).toBeUndefined();
  });

  it.each(['None', ' none '])(
    'keeps the model-default effort %j opaque',
    (effort) => {
      expect(resolveReasoningPreviewState(undefined, { effort })).toEqual({
        enabled: true,
        effort,
      });
    },
  );

  it('ignores a malformed non-string live effort', () => {
    expect(() =>
      buildModelReasoningConfigOption('qwen3.8-max', {
        enabled: true,
        effort: 0 as never,
      }),
    ).not.toThrow();
  });

  it('keeps an opaque configured effort visible in workspace preview', () => {
    expect(
      buildModelReasoningConfigPreview('qwen3.8-max', {
        enabled: true,
        effort: 'vendor.ultra',
      }),
    ).toMatchObject([
      {
        currentValue: 'vendor.ultra',
        options: expect.arrayContaining([
          expect.objectContaining({
            value: 'vendor.ultra',
            name: 'vendor.ultra',
          }),
        ]),
      },
    ]);
  });

  it('shows a literal default effort without duplicating the ACP clear option', () => {
    const option = buildModelReasoningConfigOption('qwen3.8-max', {
      enabled: true,
      effort: 'default',
    });

    expect(option?.currentValue).toBe('default');
    expect(
      option?.options.filter(
        (candidate) => 'value' in candidate && candidate.value === 'default',
      ),
    ).toHaveLength(1);
  });

  it('preserves model-specific effort values and display names', () => {
    const reasoning = getModelConfiguration('qwen3.8-max')?.reasoning;
    if (!reasoning || reasoning.toggleOnly) {
      throw new Error('Expected tiered qwen3.8-max reasoning configuration');
    }
    const mutable = reasoning as unknown as {
      efforts: Array<{ value: string; name: string }>;
    };
    mutable.efforts.push({ value: 'ultra', name: 'Ultra thinking' });
    try {
      expect(
        buildModelReasoningConfigOption('qwen3.8-max', {
          enabled: true,
          effort: 'ultra',
        }),
      ).toMatchObject({
        currentValue: 'ultra',
        options: expect.arrayContaining([
          expect.objectContaining({
            value: 'ultra',
            name: 'Ultra thinking',
          }),
        ]),
      });
    } finally {
      mutable.efforts.pop();
    }
  });

  it.each([
    'qwen3.5-plus',
    'qwen3.6-plus',
    'qwen3.6-flash',
    'qwen3.7-plus',
    'qwen3.7-max',
  ])('registers toggle-only reasoning for %s', (modelId) => {
    expect(getModelConfiguration(modelId)).toEqual({
      reasoning: {
        thinking: true,
        toggleOnly: true,
      },
    });
  });

  it.each([
    undefined,
    'qwen3.8-max-preview',
    'qwen3.8-max-latest',
    'qwen3.8-max-2026-08-12',
    'vendor/qwen3.8-max',
    'qwen3.7-plus-latest',
    'vendor/qwen3.7-plus',
    'QWEN3.7-PLUS',
    'qwen3-max-2026-01-23',
    'qwen3-coder-plus',
    'qwen3-coder-next',
  ])('does not broaden the manifest to %s', (modelId) => {
    expect(getModelConfiguration(modelId)).toBeUndefined();
  });
});

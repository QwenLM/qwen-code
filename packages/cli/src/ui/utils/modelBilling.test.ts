/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { formatModelCost, getModelBillingBreakdown } from './modelBilling.js';
import type { ModelMetricsCore } from '@qwen-code/qwen-code-core';

const metrics = (overrides?: Partial<ModelMetricsCore>): ModelMetricsCore => ({
  api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 100 },
  tokens: {
    prompt: 1_000_000,
    candidates: 500_000,
    total: 1_500_000,
    cached: 250_000,
    thoughts: 0,
    tool: 0,
  },
  ...overrides,
});

describe('modelBilling', () => {
  it('calculates uncached input, cached input, and output costs separately', () => {
    const breakdown = getModelBillingBreakdown(
      {
        currency: 'USD',
        modelPrices: {
          'openai:gpt-4o': { input: 5, cachedInput: 1, output: 15 },
        },
      },
      'gpt-4o',
      metrics(),
      ['openai'],
    );

    expect(breakdown).toMatchObject({
      priceKey: 'openai:gpt-4o',
      uncachedInputTokens: 750_000,
      cachedInputTokens: 250_000,
      outputTokens: 500_000,
      inputCost: 3.75,
      cachedInputCost: 0.25,
      outputCost: 7.5,
      totalCost: 11.5,
    });
  });

  it('falls back to input price when cachedInput is not configured', () => {
    const breakdown = getModelBillingBreakdown(
      {
        modelPrices: {
          'gpt-4o': { input: 5, output: 15 },
        },
      },
      'gpt-4o',
      metrics(),
    );

    expect(breakdown?.cachedInputCost).toBe(1.25);
    expect(breakdown?.totalCost).toBe(12.5);
  });

  it('supports input-only pricing without requiring output pricing', () => {
    const breakdown = getModelBillingBreakdown(
      {
        modelPrices: {
          'gpt-4o': { input: 5 },
        },
      },
      'gpt-4o',
      metrics(),
    );

    expect(breakdown).toMatchObject({
      inputCost: 3.75,
      cachedInputCost: 1.25,
      outputCost: 0,
      totalCost: 5,
    });
  });

  it('supports output-only pricing without requiring input pricing', () => {
    const breakdown = getModelBillingBreakdown(
      {
        modelPrices: {
          'gpt-4o': { output: 15 },
        },
      },
      'gpt-4o',
      metrics(),
    );

    expect(breakdown).toMatchObject({
      inputCost: 0,
      cachedInputCost: 0,
      outputCost: 7.5,
      totalCost: 7.5,
    });
  });

  it('ignores empty or invalid pricing entries', () => {
    expect(
      getModelBillingBreakdown(
        {
          modelPrices: {
            'gpt-4o': {},
          },
        },
        'gpt-4o',
        metrics(),
      ),
    ).toBeUndefined();

    expect(
      getModelBillingBreakdown(
        {
          modelPrices: {
            'gpt-4o': { input: -1, output: 15 },
          },
        },
        'gpt-4o',
        metrics(),
      ),
    ).toBeUndefined();

    expect(
      getModelBillingBreakdown(
        {
          modelPrices: {
            'gpt-4o': { input: Number.NaN, output: 15 },
          },
        },
        'gpt-4o',
        metrics(),
      ),
    ).toBeUndefined();
  });

  it('does not create a billing row for priced models with no billable tokens', () => {
    const breakdown = getModelBillingBreakdown(
      {
        modelPrices: {
          'gpt-4o': { input: 5, output: 15 },
        },
      },
      'gpt-4o',
      metrics({
        tokens: {
          prompt: 0,
          candidates: 0,
          total: 0,
          cached: 0,
          thoughts: 0,
          tool: 0,
        },
      }),
    );

    expect(breakdown).toBeUndefined();
  });

  it('applies discounts to uncached input, cached input, and output prices', () => {
    const breakdown = getModelBillingBreakdown(
      {
        modelPrices: {
          'gpt-4o': {
            input: 12,
            cachedInput: 4,
            output: 24,
            discounts: {
              input: 0.25,
              cachedInput: 0.5,
              output: 0.25,
            },
          },
        },
      },
      'gpt-4o',
      metrics(),
    );

    expect(breakdown).toMatchObject({
      inputCost: 2.25,
      cachedInputCost: 0.5,
      outputCost: 3,
      totalCost: 5.75,
    });
  });

  it('uses input discount for cached tokens when cached input pricing is omitted', () => {
    const breakdown = getModelBillingBreakdown(
      {
        modelPrices: {
          'gpt-4o': {
            input: 10,
            output: 20,
            discounts: {
              input: 0.5,
            },
          },
        },
      },
      'gpt-4o',
      metrics(),
    );

    expect(breakdown?.inputCost).toBe(3.75);
    expect(breakdown?.cachedInputCost).toBe(1.25);
    expect(breakdown?.outputCost).toBe(10);
  });

  it('does not apply provider-specific prices when auth type is ambiguous', () => {
    const breakdown = getModelBillingBreakdown(
      {
        modelPrices: {
          'openai:gpt-4o': { input: 5, output: 15 },
        },
      },
      'gpt-4o',
      metrics(),
      ['openai', 'anthropic'],
    );

    expect(breakdown).toBeUndefined();
  });

  it('sums provider-specific prices when per-auth metrics are available', () => {
    const openaiMetrics = metrics({
      tokens: {
        prompt: 1_000_000,
        candidates: 0,
        total: 1_000_000,
        cached: 0,
        thoughts: 0,
        tool: 0,
      },
    });
    const anthropicMetrics = metrics({
      tokens: {
        prompt: 2_000_000,
        candidates: 500_000,
        total: 2_500_000,
        cached: 0,
        thoughts: 0,
        tool: 0,
      },
    });

    const breakdown = getModelBillingBreakdown(
      {
        currency: 'CNY',
        modelPrices: {
          'openai:gpt-4o': { input: 1, output: 10 },
          'anthropic:gpt-4o': { input: 2, output: 20 },
        },
      },
      'gpt-4o',
      metrics({
        api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 200 },
        tokens: {
          prompt: 3_000_000,
          candidates: 500_000,
          total: 3_500_000,
          cached: 0,
          thoughts: 0,
          tool: 0,
        },
      }),
      ['openai', 'anthropic'],
      {
        openai: openaiMetrics,
        anthropic: anthropicMetrics,
      },
    );

    expect(breakdown).toMatchObject({
      currency: 'CNY',
      inputCost: 5,
      outputCost: 10,
      totalCost: 15,
    });
  });

  it('formats small USD costs with enough precision', () => {
    expect(formatModelCost(0.0001234, 'USD')).toBe('$0.000123');
    expect(formatModelCost(1.5, 'CNY')).toBe('CNY 1.5');
  });
});

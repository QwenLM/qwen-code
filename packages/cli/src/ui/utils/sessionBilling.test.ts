/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getCurrentSessionBillingTotal } from './sessionBilling.js';
import type { SessionMetrics } from '@qwen-code/qwen-code-core';

const sessionMetrics = (tokens: {
  prompt: number;
  candidates: number;
  total: number;
  cached?: number;
}): SessionMetrics => ({
  models: {
    'gpt-4o': {
      api: {
        totalRequests: 1,
        totalErrors: 0,
        totalLatencyMs: 0,
      },
      tokens: {
        prompt: tokens.prompt,
        candidates: tokens.candidates,
        total: tokens.total,
        cached: tokens.cached ?? 0,
        thoughts: 0,
        tool: 0,
      },
      bySource: {},
    },
  },
  tools: {
    totalCalls: 0,
    totalSuccess: 0,
    totalFail: 0,
    totalDurationMs: 0,
    totalDecisions: {
      accept: 0,
      reject: 0,
      modify: 0,
      auto_accept: 0,
    },
    byName: {},
  },
  files: {
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
  },
});

describe('sessionBilling', () => {
  it('calculates the current session total from configured model prices', () => {
    expect(
      getCurrentSessionBillingTotal(
        {
          currency: 'USD',
          modelPrices: {
            'gpt-4o': { input: 5, cachedInput: 1, output: 15 },
          },
        },
        sessionMetrics({
          prompt: 1_000_000,
          candidates: 500_000,
          total: 1_500_000,
          cached: 250_000,
        }),
      ),
    ).toMatchObject({
      currency: 'USD',
      totalCost: 11.5,
    });
  });

  it('uses auth-specific prices for current session totals', () => {
    const metrics = sessionMetrics({
      prompt: 1_000_000,
      candidates: 500_000,
      total: 1_500_000,
    });
    const modelMetrics = metrics.models['gpt-4o'];
    modelMetrics.authTypes = ['openai'];
    modelMetrics.byAuthType = {
      openai: {
        api: modelMetrics.api,
        tokens: modelMetrics.tokens,
      },
    };

    expect(
      getCurrentSessionBillingTotal(
        {
          currency: 'CNY',
          modelPrices: {
            'openai:gpt-4o': { input: 10, output: 20 },
          },
        },
        metrics,
      ),
    ).toMatchObject({
      currency: 'CNY',
      totalCost: 20,
    });
  });

  it('returns undefined for current sessions without priced models', () => {
    expect(
      getCurrentSessionBillingTotal(
        {
          currency: 'USD',
          modelPrices: {
            'other-model': { input: 5, output: 15 },
          },
        },
        sessionMetrics({
          prompt: 1_000_000,
          candidates: 500_000,
          total: 1_500_000,
        }),
      ),
    ).toBeUndefined();
  });
});

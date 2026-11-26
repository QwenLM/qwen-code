/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForkedAgentCompletion } from '../core/forkedAgent.js';
import { cloneUsage } from '../protocol/provider/empty-usage.js';
import type { ModelRequestCompletedSnapshot } from './types.js';
import { getForkCompletionBilling } from './credit-usage.js';

const mocks = vi.hoisted(() => ({
  runLogger: {
    debug: vi.fn(),
  },
}));

vi.mock('../utils/runLogger.js', () => ({
  runLogger: mocks.runLogger,
}));

function request(
  requestId: string,
  metering: {
    credits?: number;
    original_credits?: number;
    billable?: boolean;
  },
  usage: Partial<ModelRequestCompletedSnapshot['usage']> = {},
  thinkingTokens = 0,
): ModelRequestCompletedSnapshot {
  return {
    requestId,
    model: 'test-model',
    ttftMs: 10,
    durationMs: 20,
    usage: { ...cloneUsage(), ...metering, ...usage },
    thinkingTokens,
    finishReason: 'end_turn',
  };
}

function completion(
  modelRequests: ModelRequestCompletedSnapshot[],
  totalUsage = cloneUsage(),
): Pick<ForkedAgentCompletion, 'modelRequests' | 'totalUsage'> {
  return { modelRequests, totalUsage };
}

describe('getForkCompletionBilling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sums credits and classifies requests from credits or billable', () => {
    expect(
      getForkCompletionBilling(
        completion([
          request('charged-by-credit', { credits: 1.25, billable: false }),
          request('charged-by-flag', { billable: true }),
          request('free', { credits: 0, billable: false }),
          request('missing', {}),
        ]),
      ),
    ).toEqual({
      credits: 1.25,
      billableRequestCount: 2,
      nonBillableRequestCount: 1,
      requestDetails: [
        {
          request_id: 'charged-by-credit',
          model: 'test-model',
          credits: 1.25,
          billable: false,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          thinking_tokens: 0,
          total_tokens: 0,
        },
        {
          request_id: 'charged-by-flag',
          model: 'test-model',
          billable: true,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          thinking_tokens: 0,
          total_tokens: 0,
        },
        {
          request_id: 'free',
          model: 'test-model',
          credits: 0,
          billable: false,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          thinking_tokens: 0,
          total_tokens: 0,
        },
        {
          request_id: 'missing',
          model: 'test-model',
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          thinking_tokens: 0,
          total_tokens: 0,
        },
      ],
    });
  });

  it('does not turn missing server metering into zero cost', () => {
    expect(
      getForkCompletionBilling(
        completion([request('missing', {})]),
      ),
    ).toEqual({
        credits: undefined,
        billableRequestCount: 0,
        nonBillableRequestCount: 0,
        requestDetails: [
          {
            request_id: 'missing',
            model: 'test-model',
            input_tokens: 0,
            output_tokens: 0,
            cache_read_tokens: 0,
            cache_write_tokens: 0,
            thinking_tokens: 0,
            total_tokens: 0,
          },
        ],
      });
  });

  it('falls back to terminal usage when no completed snapshot has billing', () => {
    expect(
      getForkCompletionBilling(
        completion([], {
          ...cloneUsage(),
          credits: 2,
          billable: false,
        }),
      ),
    ).toEqual({
      credits: 2,
      billableRequestCount: 1,
      nonBillableRequestCount: 0,
      requestDetails: [],
    });
  });

  it('logs each request calculation and the final reported credits source', () => {
    getForkCompletionBilling(
      completion(
        [
          request('charged', {
            credits: 1.25,
            original_credits: 2.5,
            billable: false,
          }),
          request('invalid-credit', { credits: -1, billable: true }),
        ],
        {
          ...cloneUsage(),
          credits: 9,
          original_credits: 10,
          billable: true,
        },
      ),
    );

    const messages = mocks.runLogger.debug.mock.calls.map(([message]) =>
      String(message),
    );
    expect(messages).toEqual([
      '[ForkCompletionBilling] requestIndex=0, requestId=charged, model=test-model, credits=1.25, originalCredits=2.5, billable=false, creditCalculation=included, creditsBefore=0, creditsAdded=1.25, creditsAfter=1.25, classification=billable',
      '[ForkCompletionBilling] requestIndex=1, requestId=invalid-credit, model=test-model, credits=-1, originalCredits=missing, billable=true, creditCalculation=ignored_invalid, creditsBefore=1.25, creditsAdded=0, creditsAfter=1.25, classification=billable',
      '[ForkCompletionBilling] summary requestCount=2, uniqueRequestIdCount=2, duplicateRequestIdCount=0, totalUsageCredits=9, totalUsageOriginalCredits=10, totalUsageBillable=true, totalUsageCreditCalculation=not_used_request_credits_available, creditSource=model_requests, reportedCredits=1.25, classificationSource=model_requests, billableRequestCount=2, nonBillableRequestCount=0',
    ]);
  });

  it('counts a repeated request ID only once', () => {
    expect(
      getForkCompletionBilling(
        completion([
          request('repeated', { credits: 1 }),
          request('repeated', { credits: 1 }),
        ]),
      ),
    ).toEqual({
      credits: 1,
      billableRequestCount: 1,
      nonBillableRequestCount: 0,
      requestDetails: [
        {
          request_id: 'repeated',
          model: 'test-model',
          credits: 1,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          thinking_tokens: 0,
          total_tokens: 0,
        },
      ],
    });

    const messages = mocks.runLogger.debug.mock.calls.map(([message]) =>
      String(message),
    );
    expect(messages[0]).toContain(
      '[ForkCompletionBilling] dedup requestIndex=1, requestId=repeated',
    );
    expect(messages[0]).toContain(
      'action=ignored_duplicate_request_id',
    );
    expect(messages.at(-1)).toContain(
      'requestCount=2, uniqueRequestIdCount=1, duplicateRequestIdCount=1',
    );
  });

  it('does not let a duplicate request change billable classification', () => {
    expect(
      getForkCompletionBilling(
        completion([
          request('repeated', { credits: 0, billable: false }),
          request('repeated', { credits: 9, billable: true }),
        ]),
      ),
    ).toEqual({
      credits: 0,
      billableRequestCount: 0,
      nonBillableRequestCount: 1,
      requestDetails: [
        {
          request_id: 'repeated',
          model: 'test-model',
          credits: 0,
          billable: false,
          input_tokens: 0,
          output_tokens: 0,
          cache_read_tokens: 0,
          cache_write_tokens: 0,
          thinking_tokens: 0,
          total_tokens: 0,
        },
      ],
    });
  });

  it('reports all request-level billing and token fields', () => {
    expect(
      getForkCompletionBilling(
        completion([
          request(
            'request-with-usage',
            { credits: 1.25, original_credits: 2.5, billable: true },
            {
              input_tokens: 120,
              output_tokens: 30,
              cache_read_input_tokens: 80,
              cache_creation_input_tokens: 10,
            },
            14,
          ),
        ]),
      ).requestDetails,
    ).toEqual([
      {
        request_id: 'request-with-usage',
        model: 'test-model',
        credits: 1.25,
        original_credits: 2.5,
        billable: true,
        input_tokens: 120,
        output_tokens: 30,
        cache_read_tokens: 80,
        cache_write_tokens: 10,
        thinking_tokens: 14,
        total_tokens: 150,
      },
    ]);
  });
});

/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { FinishReason } from '@google/genai';
import {
  convertDashScopeResponseToGemini,
  convertToolCallToFunctionCallPart,
  mapDashScopeFinishReason,
} from './response-converter.js';
import type { DashScopeResponsePayload, DashScopeToolCall } from './types.js';

describe('mapDashScopeFinishReason', () => {
  it.each([
    ['stop', FinishReason.STOP],
    ['length', FinishReason.MAX_TOKENS],
    ['tool_calls', FinishReason.STOP],
    ['content_filter', FinishReason.SAFETY],
  ] as const)('maps %s to %s', (raw, expected) => {
    expect(mapDashScopeFinishReason(raw)).toBe(expected);
  });

  it.each([['null'], [''], [null], [undefined]] as const)(
    'treats %s as still generating (undefined)',
    (raw) => {
      expect(mapDashScopeFinishReason(raw)).toBeUndefined();
    },
  );

  it('falls back to STOP for an unrecognized value', () => {
    expect(mapDashScopeFinishReason('something_new')).toBe(FinishReason.STOP);
  });
});

describe('convertToolCallToFunctionCallPart', () => {
  it('parses arguments and preserves id/name', () => {
    const call: DashScopeToolCall = {
      id: 'call_abc',
      type: 'function',
      function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
    };

    expect(convertToolCallToFunctionCallPart(call)).toEqual({
      functionCall: {
        id: 'call_abc',
        name: 'get_weather',
        args: { city: 'Paris' },
      },
    });
  });

  it('treats empty id/arguments as undefined id and empty args', () => {
    const call: DashScopeToolCall = {
      id: '',
      type: 'function',
      function: { arguments: '' },
    };

    expect(convertToolCallToFunctionCallPart(call)).toEqual({
      functionCall: { id: undefined, name: undefined, args: {} },
    });
  });
});

describe('convertDashScopeResponseToGemini', () => {
  it('orders parts: thought -> text -> functionCall', () => {
    const payload: DashScopeResponsePayload = {
      output: {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              reasoning_content: 'thinking...',
              content: [{ text: 'here is the answer' }],
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Paris"}',
                  },
                },
              ],
            },
          },
        ],
      },
      request_id: 'req-1',
    };

    const response = convertDashScopeResponseToGemini(payload, 'qwen3.8-max');

    expect(response.candidates?.[0]?.content?.parts).toEqual([
      { text: 'thinking...', thought: true },
      { text: 'here is the answer' },
      {
        functionCall: {
          id: 'call_1',
          name: 'get_weather',
          args: { city: 'Paris' },
        },
      },
    ]);
    expect(response.responseId).toBe('req-1');
    expect(response.modelVersion).toBe('qwen3.8-max');
  });

  it('tolerates missing message/content (empty parts, STOP fallback)', () => {
    const response = convertDashScopeResponseToGemini({}, 'qwen3.8-max');

    expect(response.candidates?.[0]?.content?.parts).toEqual([]);
    expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
  });

  it('yields functionCall parts even when finish_reason is "stop" (never infer from finish_reason)', () => {
    const payload: DashScopeResponsePayload = {
      output: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              content: [],
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'get_weather', arguments: '{}' },
                },
              ],
            },
          },
        ],
      },
    };

    const response = convertDashScopeResponseToGemini(payload, 'qwen3.8-max');

    expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    expect(response.candidates?.[0]?.content?.parts).toContainEqual({
      functionCall: { id: 'call_1', name: 'get_weather', args: {} },
    });
  });

  it('withholds tool calls when finish_reason is "length"', () => {
    const payload: DashScopeResponsePayload = {
      output: {
        choices: [
          {
            finish_reason: 'length',
            message: {
              role: 'assistant',
              content: [{ text: 'partial response' }],
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'lookup_user',
                    arguments: '{"name":"Alexander',
                  },
                },
              ],
            },
          },
        ],
      },
    };

    const response = convertDashScopeResponseToGemini(payload, 'qwen3.8-max');

    expect(response.candidates?.[0]?.finishReason).toBe(
      FinishReason.MAX_TOKENS,
    );
    expect(response.candidates?.[0]?.content?.parts).toEqual([
      { text: 'partial response' },
    ]);
  });

  it('skips empty reasoning_content and empty text blocks', () => {
    const payload: DashScopeResponsePayload = {
      output: {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              role: 'assistant',
              reasoning_content: '',
              content: [{ text: '' }, { text: 'hello' }],
            },
          },
        ],
      },
    };

    const response = convertDashScopeResponseToGemini(payload, 'qwen3.8-max');

    expect(response.candidates?.[0]?.content?.parts).toEqual([
      { text: 'hello' },
    ]);
  });

  it('attaches usageMetadata built via buildDashScopeUsageMetadata', () => {
    const payload: DashScopeResponsePayload = {
      output: {
        choices: [
          {
            finish_reason: 'stop',
            message: { role: 'assistant', content: [] },
          },
        ],
      },
      usage: {
        input_tokens: 1581,
        output_tokens: 9,
        prompt_tokens_details: { cached_tokens: 1564 },
      },
    };

    const response = convertDashScopeResponseToGemini(payload, 'qwen3.8-max');

    expect(response.usageMetadata?.promptTokenCount).toBe(1581);
    expect(response.usageMetadata?.cachedContentTokenCount).toBe(1564);
  });
});

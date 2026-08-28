/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { FinishReason } from './genai-compat.js';
import { StreamEventType } from './llm-chat.js';
import { ModelStreamAttemptState } from './model-stream-attempt-state.js';

describe('ModelStreamAttemptState', () => {
  it('clears all attempt state on a fresh retry', () => {
    const state = new ModelStreamAttemptState();
    state.accept({
      type: StreamEventType.CHUNK,
      value: {
        responseId: 'old-response',
        candidates: [
          {
            content: {
              parts: [
                { text: 'old text' },
                { text: 'old thought', thought: true },
              ],
            },
            finishReason: FinishReason.MAX_TOKENS,
          },
        ],
        functionCalls: [{ id: 'old-call', name: 'old_tool', args: {} }],
        usageMetadata: { promptTokenCount: 10 },
      } as GenerateContentResponse,
    });

    const transition = state.accept({ type: StreamEventType.RETRY });

    expect(transition).toMatchObject({
      type: 'attempt_reset',
      reason: 'retry',
      preserveText: false,
    });
    expect(state.snapshot()).toEqual({
      text: '',
      thoughtText: '',
      functionCalls: [],
      wasOutputTruncated: false,
    });
  });

  it('preserves text only for continuation retries', () => {
    const state = new ModelStreamAttemptState();
    state.accept({
      type: StreamEventType.CHUNK,
      value: {
        responseId: 'old-response',
        candidates: [
          {
            content: {
              parts: [
                { text: 'first half ' },
                { text: 'thinking ', thought: true },
              ],
            },
          },
        ],
        functionCalls: [{ id: 'old-call', name: 'old_tool', args: {} }],
        usageMetadata: { promptTokenCount: 10 },
      } as GenerateContentResponse,
    });

    state.accept({ type: StreamEventType.RETRY, isContinuation: true });

    expect(state.snapshot()).toEqual({
      text: 'first half ',
      thoughtText: 'thinking ',
      functionCalls: [],
      wasOutputTruncated: false,
    });
  });

  it('treats model fallback as a fresh attempt', () => {
    const state = new ModelStreamAttemptState();
    state.accept({
      type: StreamEventType.CHUNK,
      value: {
        candidates: [{ content: { parts: [{ text: 'old' }] } }],
      } as GenerateContentResponse,
    });

    const transition = state.accept({
      type: StreamEventType.MODEL_FALLBACK,
      info: {
        fromModel: 'primary',
        toModel: 'fallback',
        fallbackIndex: 1,
      },
    });

    expect(transition).toMatchObject({
      type: 'attempt_reset',
      reason: 'model_fallback',
      preserveText: false,
    });
    expect(state.snapshot().text).toBe('');
  });
});

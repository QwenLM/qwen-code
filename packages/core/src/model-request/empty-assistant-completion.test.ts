/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  EMPTY_ASSISTANT_COMPLETION_CODE,
  EmptyAssistantCompletionError,
  isEmptyAssistantCompletionError,
} from './empty-assistant-completion.js';

describe('EmptyAssistantCompletionError', () => {
  it('carries a stable semantic code and structured diagnostics', () => {
    const error = new EmptyAssistantCompletionError({
      reason: 'reasoning_only',
      finishReason: 'end_turn',
      contentBlockCount: 1,
      reasoningBlockCount: 1,
      textCharacterCount: 0,
      model: 'test-model',
      transport: 'external-openai',
      serverRequestId: 'server-1',
    });

    expect(error).toMatchObject({
      name: 'EmptyAssistantCompletionError',
      code: EMPTY_ASSISTANT_COMPLETION_CODE,
      retryable: true,
      reason: 'reasoning_only',
      finishReason: 'end_turn',
      model: 'test-model',
      transport: 'external-openai',
      serverRequestId: 'server-1',
    });
    expect(isEmptyAssistantCompletionError(error)).toBe(true);
  });
});

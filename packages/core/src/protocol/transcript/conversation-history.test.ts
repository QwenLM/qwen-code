/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { stripThoughtSignaturesFromMessages } from './conversation-history.js';
import { cloneUsage } from '../provider/empty-usage.js';
import { createAssistantMessage, createUserMessage } from './conversions.js';

describe('stripThoughtSignaturesFromMessages', () => {
  it('没有需要清除的签名时保留消息和数组身份', () => {
    const user = createUserMessage('hello');
    const messages = [user];

    expect(stripThoughtSignaturesFromMessages(messages)).toBe(messages);
    expect(messages[0]).toBe(user);
    const readonlyMessages = Object.freeze([user]);
    expect(stripThoughtSignaturesFromMessages(readonlyMessages)).toBe(
      readonlyMessages,
    );
  });

  it('strips thinking signatures from runtime assistant messages', () => {
    const assistant = createAssistantMessage({
      messageId: 'msg-2',

      model: 'test-model',
      stopReason: 'end_turn',

      usage: ((value) => ({
        inputTokens: value.input_tokens,
        outputTokens: value.output_tokens,
        cacheReadInputTokens: value.cache_read_input_tokens,
        cacheCreationInputTokens: value.cache_creation_input_tokens,
      }))(cloneUsage()),
      blocks: [
        {
          type: 'thinking',
          thinking: 'private reasoning',
          signature: 'sig-1',
        },
        { type: 'text', text: 'visible output' },
      ],
    });

    Object.freeze(assistant.message.content[0]);
    Object.freeze(assistant.message.content);
    Object.freeze(assistant.message);
    Object.freeze(assistant);
    const messages = Object.freeze([assistant]);
    const sanitized = stripThoughtSignaturesFromMessages(messages);
    expect(sanitized).not.toBe(messages);
    const thinkingBlock =
      sanitized[0]?.type === 'assistant'
        ? sanitized[0].message.content[0]
        : undefined;

    expect(thinkingBlock).toEqual({
      type: 'thinking',
      thinking: 'private reasoning',
      signature: '',
    });
    expect(sanitized[0]).not.toBe(assistant);
    expect(assistant.message.content[0]).toEqual({
      type: 'thinking',
      thinking: 'private reasoning',
      signature: 'sig-1',
    });
  });
});

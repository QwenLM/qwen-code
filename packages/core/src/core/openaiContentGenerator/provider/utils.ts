/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ExtendedChatCompletionAssistantMessageParam } from '../converter.js';

// Some thinking-mode OpenAI-compatible APIs require `reasoning_content` to be
// replayed on every prior assistant turn, even when the model returned no
// visible reasoning text for that turn.
export function ensureReasoningContentOnAssistantMessage(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'assistant') {
    return message;
  }

  const assistant = message as ExtendedChatCompletionAssistantMessageParam;
  if (typeof assistant.reasoning_content === 'string') {
    return message;
  }

  return {
    ...assistant,
    reasoning_content: '',
  } as OpenAI.Chat.ChatCompletionMessageParam;
}

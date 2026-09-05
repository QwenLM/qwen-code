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

// Some strict OpenAI-compatible endpoints (Mistral, Cerebras) reject the
// non-standard `reasoning_content` field on input with HTTP 400. Shared
// conversation history must stay intact for providers that require the
// replay; remove the field only at the outbound request boundary.
export function stripReasoningContent(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (!('reasoning_content' in message)) {
    return message;
  }

  const next = { ...(message as unknown as Record<string, unknown>) };
  delete next['reasoning_content'];
  return next as unknown as OpenAI.Chat.ChatCompletionMessageParam;
}

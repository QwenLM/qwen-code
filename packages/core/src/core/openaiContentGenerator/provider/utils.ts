/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import { retryContext } from '../../../utils/retryContext.js';
import type { ExtendedChatCompletionAssistantMessageParam } from '../converter.js';

const ISOLATED_MODEL_REQUEST_FIELDS = new Set([
  'model',
  'models',
  'messages',
  'input',
  'instructions',
  'prompt',
  'conversation',
  'previous_response_id',
  'tools',
  'tool_choice',
  'parallel_tool_calls',
  'functions',
  'function_call',
  'web_search_options',
  'enable_search',
  'search_options',
  'plugins',
  'n',
  'background',
  'stream',
  'stream_options',
]);

export function filterIsolatedModelOverrides<T extends Record<string, unknown>>(
  overrides: T | undefined,
): Partial<T> | undefined {
  // Mod completions have a single-attempt context even on the active model.
  if (!overrides || !retryContext.getStore()?.singleAttempt) return overrides;
  return Object.fromEntries(
    Object.entries(overrides).filter(
      ([key]) => !ISOLATED_MODEL_REQUEST_FIELDS.has(key),
    ),
  ) as Partial<T>;
}

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
// replay; remove the field only at the outbound request boundary, omitting
// reasoning-only segments that would otherwise become empty assistant messages.
export function stripReasoningContent(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (!('reasoning_content' in message)) {
    return [message];
  }

  const next = { ...(message as unknown as Record<string, unknown>) };
  const reasoningContent = next['reasoning_content'];
  delete next['reasoning_content'];
  if (
    message.role === 'assistant' &&
    typeof reasoningContent === 'string' &&
    reasoningContent.length > 0 &&
    Object.entries(next).every(
      ([key, value]) =>
        key === 'role' ||
        key === 'name' ||
        value === undefined ||
        value === null ||
        value === '' ||
        (Array.isArray(value) && value.length === 0),
    )
  ) {
    return [];
  }
  return [next as unknown as OpenAI.Chat.ChatCompletionMessageParam];
}

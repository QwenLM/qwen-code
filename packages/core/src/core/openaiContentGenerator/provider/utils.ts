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

// Servers that type `tools[].function.parameters` as a required field reject a
// request whose parameterless tool omits it (Pydantic `Field required`, e.g.
// TabbyAPI). The converter omits the field on purpose (#11431) because llama.cpp
// / LM Studio / vLLM reject the shapes that replace it (#11410), so callers here
// decide per route. Running at the outbound boundary is also what lets an empty
// `properties` reach the wire at all: `relaxSchemaForFunctionCalling` strips it
// during conversion.
//
// The checks below are runtime guards rather than narrowings: openai's types
// admit only function tools, but `generationConfig.extra_body` is a user knob
// merged into the request ahead of this repair, so a grammar or custom tool can
// reach the map and has no `function` to dereference — and a hand-written entry
// in the flat Responses shape claims `type: 'function'` while still lacking the
// `function` object.
export function withEmptyToolParameters(
  request: OpenAI.Chat.ChatCompletionCreateParams,
): OpenAI.Chat.ChatCompletionCreateParams {
  if (!request.tools) return request;

  return {
    ...request,
    tools: request.tools.map((tool) =>
      tool.type === 'function' &&
      tool.function !== undefined &&
      tool.function.parameters === undefined
        ? {
            ...tool,
            function: {
              ...tool.function,
              parameters: { type: 'object', properties: {} },
            },
          }
        : tool,
    ),
  };
}

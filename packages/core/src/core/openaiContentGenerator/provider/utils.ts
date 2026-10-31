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

// Servers that type `tools[].function.parameters` as a required field reject a
// request whose parameterless tool omits it: serde-based routers report `missing
// field parameters` (#11956), Pydantic-typed ones report `Field required`. The
// converter omits the field on purpose (#11431): #10080 keeps an empty
// `properties` off older llama.cpp grammars. That shape returns HTTP 200 on the
// three llama.cpp builds #10080 verified (b10068/b10745/b10425) and LM Studio's
// validator accepts it, but the rejection behind that relaxation was never
// reproduced live and no wider engine survey exists. The 400 in #11410 was the
// bare `{"type":"object"}` shape lacking `properties`, not this one. So callers
// here decide per route. Running at the outbound boundary is also what lets an
// empty `properties` reach the wire at all: `relaxSchemaForFunctionCalling`
// strips it during conversion.
//
// The checks below are runtime guards rather than narrowings: openai's types
// admit only function tools, but `generationConfig.extra_body` is a user knob
// merged into the request ahead of this repair, so a grammar or custom tool can
// reach the map and has no `function` to dereference — and a hand-written entry
// in the flat Responses shape claims `type: 'function'` while still carrying a
// missing or null `function`. A nullish entry is left exactly as written: this
// repair rewrites tool schemas, it does not vet a user's own list.
export function withEmptyToolParameters(
  request: OpenAI.Chat.ChatCompletionCreateParams,
): OpenAI.Chat.ChatCompletionCreateParams {
  if (!request.tools) return request;

  return {
    ...request,
    tools: request.tools.map((tool) =>
      tool != null &&
      tool.type === 'function' &&
      tool.function != null &&
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

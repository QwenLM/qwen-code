/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import type {
  Message,
  AssistantMessage,
  ContentBlock,
  TextBlockParam,
  ImageBlockParam,
} from '../protocol/transcript/message.js';
import type {
  ModelInputContentBlock,
  ModelStreamMessage,
  ModelStreamTool,
} from '../provider/modelStreamRequest.js';
import type { ModelContentBlock } from '../provider/event/modelCompleteEvent.js';
import {
  normalizeMessagesForAPI,
  type NormalizeMessagesForAPIOptions,
} from '../protocol/provider/request-converter.js';
import type { NonNullableUsage } from '../protocol/schemas/common.js';
import type { SystemPrompt } from '../prompts/types.js';
import {
  estimateTextTokens,
  IMAGE_TOKEN_ESTIMATE,
} from './tokenCalculation.js';

export interface RequestTokenInput {
  model: string;
  messages: readonly Message[];
  systemPrompt?: SystemPrompt;
  tools?: readonly ModelStreamTool[];
  projectionOptions?: NormalizeMessagesForAPIOptions;
  /** Private persisted usage; reusable only for the exact latest response ID. */
  latestUsage?: NonNullableUsage | null;
  /** Exact provider projection, when the caller already built it. */
  normalizedMessages?: readonly ModelStreamMessage[];
}

export interface RequestTokenCount {
  tokens: number;
  source: 'usage' | 'estimate';
}

/** Shared content rules for request counting and context breakdowns. */
export function estimateRequestBlockTokens(
  block:
    | ModelInputContentBlock
    | ModelContentBlock
    | ContentBlock
    | TextBlockParam
    | ImageBlockParam,
): number {
  switch (block.type) {
    case 'text':
      return estimateTextTokens(block.text);
    case 'thinking':
      return estimateTextTokens(block.thinking);
    case 'redacted_thinking':
      return estimateTextTokens(block.data);
    case 'image':
      return IMAGE_TOKEN_ESTIMATE;
    case 'tool_use':
      return estimateTextTokens(JSON.stringify(block));
    default:
      throw new Error('不支持的模型内容块');
  }
}

function estimateMessages(messages: readonly ModelStreamMessage[]): number {
  return messages.reduce((total, message) => {
    const contentTokens =
      typeof message.content === 'string'
        ? estimateTextTokens(message.content)
        : message.content.reduce(
            (sum, block) => sum + estimateRequestBlockTokens(block),
            0,
          );
    const toolTokens =
      message.role === 'assistant'
        ? (message.toolCalls ?? []).reduce(
            (sum, call) =>
              sum +
              estimateTextTokens(call.id) +
              estimateTextTokens(call.name) +
              estimateTextTokens(call.arguments),
            0,
          )
        : 0;
    return total + contentTokens + toolTokens;
  }, 0);
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requestFingerprint(
  input: RequestTokenInput,
  messages: readonly ModelStreamMessage[],
): string {
  return fingerprint([
    input.model,
    input.projectionOptions ?? { targetModel: input.model },
    input.systemPrompt ?? [],
    input.tools ?? [],
    messages,
  ]);
}

/** Capture immutable input identity before sampling; bind the full response later. */
export function createRequestTokenAnchor(
  input: RequestTokenInput,
): (
  responseContent: AssistantMessage['message']['content'],
  requestId?: string,
) => NonNullable<AssistantMessage['requestTokenAnchor']> {
  const request = requestFingerprint(
    input,
    input.normalizedMessages ??
      normalizeMessagesForAPI(
        input.messages,
        input.projectionOptions ?? { targetModel: input.model },
      ),
  );
  return (responseContent, requestId) => ({
    request,
    response: fingerprint(responseContent),
    ...(requestId ? { requestId } : {}),
  });
}

/**
 * Count the next provider request. Reuse server usage only when the model,
 * projection, fixed overhead, previous input and response are unchanged.
 * Cache usage is a subset of input_tokens and must never be added again.
 * Responses without a verifiable anchor or bound usage use full estimation.
 *
 * Model identity is verified through the anchor's request fingerprint (bound
 * at request time with the session's canonical model key), never through
 * `message.model`: providers echo aliases such as `auto` in completion
 * payloads, and comparing that string against the canonical key would disable
 * usage anchoring for every request of such models.
 */
export function countRequestTokens(
  input: RequestTokenInput,
): RequestTokenCount {
  const { messages } = input;
  const projectionOptions = input.projectionOptions ?? {
    targetModel: input.model,
  };
  for (let last = messages.length - 1; last >= 0; last--) {
    const message = messages[last];
    if (message.type !== 'assistant') continue;
    const usage =
      message.message.usage && message.message.usage.input_tokens > 0
        ? message.message.usage
        : message.requestTokenAnchor?.requestId &&
            message.requestTokenAnchor.requestId ===
              input.latestUsage?.request_id
          ? input.latestUsage
          : undefined;
    const anchor = message.requestTokenAnchor;
    if (
      !anchor ||
      !usage ||
      usage.input_tokens <= 0 ||
      message.isApiErrorMessage
    )
      break;
    let first = last;
    while (first > 0) {
      const prior = messages[first - 1];
      if (prior.type !== 'assistant' || prior.message.id !== message.message.id)
        break;
      first--;
    }
    const responseContent = messages
      .slice(first, last + 1)
      .flatMap((part) =>
        part.type === 'assistant' ? part.message.content : [],
      );
    if (
      anchor.request ===
        requestFingerprint(
          input,
          normalizeMessagesForAPI(messages.slice(0, first), projectionOptions),
        ) &&
      anchor.response === fingerprint(responseContent) &&
      (!input.normalizedMessages ||
        fingerprint(input.normalizedMessages) ===
          fingerprint(normalizeMessagesForAPI(messages, projectionOptions)))
    ) {
      return {
        tokens: Math.floor(
          usage.input_tokens +
            usage.output_tokens +
            estimateMessages(
              normalizeMessagesForAPI(
                messages.slice(last + 1),
                projectionOptions,
              ),
            ),
        ),
        source: 'usage',
      };
    }
    break;
  }

  const normalized =
    input.normalizedMessages ??
    normalizeMessagesForAPI(messages, projectionOptions);
  const systemTokens = (input.systemPrompt ?? []).reduce(
    (total, block) => total + estimateRequestBlockTokens(block),
    0,
  );
  const toolTokens = input.tools?.length
    ? estimateTextTokens(JSON.stringify(input.tools))
    : 0;
  return {
    tokens: Math.floor(
      estimateMessages(normalized) + systemTokens + toolTokens,
    ),
    source: 'estimate',
  };
}

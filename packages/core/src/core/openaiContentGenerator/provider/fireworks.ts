/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

const FIREWORKS_API_HOST = 'api.fireworks.ai';

/**
 * Hostname-only detection: Fireworks serves third-party model names
 * (`accounts/fireworks/models/qwen3p8-max`), so a model-name fallback
 * would misroute other providers' models.
 */
export function isFireworksProvider(config: ContentGeneratorConfig): boolean {
  const baseUrl = config.baseUrl ?? '';
  if (!baseUrl) return false;

  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === FIREWORKS_API_HOST ||
      hostname.endsWith(`.${FIREWORKS_API_HOST}`)
    );
  } catch {
    return false;
  }
}

/**
 * Fireworks' OpenAI-compatible endpoint accepts the non-standard
 * `messages[].reasoning_content` field on input but rejects the mirrored
 * `reasoning` field with HTTP 400 (`Extra inputs are not permitted, field:
 * 'messages[N].reasoning'`, issue #11657). The default provider mirrors
 * `reasoning_content` into `reasoning` for any model whose name contains
 * "qwen3" — a family match that does not establish the endpoint accepts
 * the extra field — so multi-turn tool-call continuation with Qwen3
 * thinking models fails on Fireworks. Undo the mirror at the outbound
 * request boundary, exactly where the default provider applies it; shared
 * conversation history is never mutated and `reasoning_content` (which
 * Fireworks documents for reasoning replay) is preserved.
 */
export class FireworksOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isFireworksProvider = isFireworksProvider;

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    return {
      ...baseRequest,
      messages: baseRequest.messages.map(unmirrorReasoningField),
    };
  }
}

type AssistantMessageWithReasoningFields = {
  reasoning_content?: string | null;
  reasoning?: string | null;
};

// The mirror the default provider added is recognizable by construction:
// `reasoning` is a non-empty string equal to `reasoning_content` on an
// assistant message. Only that exact copy is dropped; a `reasoning` field
// the caller set itself (distinct value) is left alone, and empty/null
// mirrors are harmless on the wire but removed for shape parity with what
// Fireworks would have received had the mirror never run.
function unmirrorReasoningField(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'assistant') {
    return message;
  }

  const assistant = message as typeof message &
    AssistantMessageWithReasoningFields;
  if (assistant.reasoning !== assistant.reasoning_content) {
    return message;
  }
  if (typeof assistant.reasoning !== 'string') {
    return message;
  }

  const { reasoning: _drop, ...rest } = assistant as typeof assistant & {
    reasoning?: string;
  };
  return rest as OpenAI.Chat.ChatCompletionMessageParam;
}

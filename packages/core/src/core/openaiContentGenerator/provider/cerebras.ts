/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import { stripReasoningContent } from './utils.js';

const CEREBRAS_API_HOST = 'api.cerebras.ai';

/**
 * Hostname-only detection: Cerebras serves third-party model names
 * (`qwen-3.8-27b`, `gpt-oss-120b`, `llama-*`), so a model-name fallback
 * would misroute other providers' models.
 */
export function isCerebrasProvider(config: ContentGeneratorConfig): boolean {
  const baseUrl = config.baseUrl ?? '';
  if (!baseUrl) return false;

  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === CEREBRAS_API_HOST ||
      hostname.endsWith(`.${CEREBRAS_API_HOST}`)
    );
  } catch {
    return false;
  }
}

/**
 * Cerebras' OpenAI-compatible endpoint rejects the non-standard
 * `messages[].reasoning_content` field on input with HTTP 400
 * (`wrong_api_format`), so every multi-turn request that replays a
 * thinking turn fails (issue #11045). Keep shared conversation history
 * intact and remove the field only at the outbound request boundary,
 * matching the Mistral handling.
 */
export class CerebrasOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isCerebrasProvider = isCerebrasProvider;

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    return {
      ...baseRequest,
      messages: baseRequest.messages.map(stripReasoningContent),
    };
  }
}

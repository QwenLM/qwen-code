/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

const MISTRAL_API_HOST = 'api.mistral.ai';
const MISTRAL_MODEL_MARKERS = [
  'mistral',
  'mixtral',
  'codestral',
  'ministral',
  'pixtral',
  'magistral',
  'devstral',
] as const;

function isMistralHostname(config: ContentGeneratorConfig): boolean {
  const baseUrl = config.baseUrl ?? '';
  if (!baseUrl) return false;

  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === MISTRAL_API_HOST || hostname.endsWith(`.${MISTRAL_API_HOST}`)
    );
  } catch {
    return false;
  }
}

export function isMistralProvider(config: ContentGeneratorConfig): boolean {
  if (isMistralHostname(config)) return true;

  const model = config.model?.toLowerCase() ?? '';
  return MISTRAL_MODEL_MARKERS.some((marker) => model.includes(marker));
}

/**
 * Mistral's OpenAI-compatible endpoint rejects non-standard
 * `messages[].reasoning_content` fields. Keep shared conversation history
 * intact and remove the field only at the outbound request boundary.
 */
export class MistralOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isMistralProvider = isMistralProvider;

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

function stripReasoningContent(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (!('reasoning_content' in message)) {
    return message;
  }

  const next = { ...(message as unknown as Record<string, unknown>) };
  delete next['reasoning_content'];
  return next as unknown as OpenAI.Chat.ChatCompletionMessageParam;
}

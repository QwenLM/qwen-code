/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

export function isMistralHostname(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  const baseUrl = contentGeneratorConfig.baseUrl ?? '';
  if (!baseUrl) return false;
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return (
      hostname === 'api.mistral.ai' || hostname.endsWith('.api.mistral.ai')
    );
  } catch {
    return false;
  }
}

export function isMistralProvider(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  if (isMistralHostname(contentGeneratorConfig)) return true;
  const model = contentGeneratorConfig.model ?? '';
  return model.toLowerCase().includes('mistral');
}

export class MistralOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  static isMistralProvider = isMistralProvider;
  static isMistralHostname = isMistralHostname;

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);
    if (!baseRequest.messages?.length) {
      return baseRequest;
    }

    let changed = false;
    const messages = baseRequest.messages.map((message) => {
      const sanitized = stripReasoningContent(message);
      if (sanitized !== message) {
        changed = true;
      }
      return sanitized;
    });

    if (!changed) {
      return baseRequest;
    }

    return {
      ...baseRequest,
      messages,
    };
  }
}

function stripReasoningContent(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'assistant') {
    return message;
  }

  const record = message as OpenAI.Chat.ChatCompletionMessageParam &
    Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, 'reasoning_content')) {
    return message;
  }

  const sanitized = { ...record };
  delete sanitized['reasoning_content'];
  return sanitized as OpenAI.Chat.ChatCompletionMessageParam;
}

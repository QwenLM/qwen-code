/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { ExtendedChatCompletionAssistantMessageParam } from '../converter.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

export function isMiMoProvider(
  contentGeneratorConfig: ContentGeneratorConfig,
): boolean {
  const baseUrl = contentGeneratorConfig.baseUrl ?? '';
  if (baseUrl) {
    try {
      const hostname = new URL(baseUrl).hostname.toLowerCase();
      if (
        hostname === 'xiaomimimo.com' ||
        hostname.endsWith('.xiaomimimo.com')
      ) {
        return true;
      }
    } catch {
      // Invalid custom URLs fall through to model-name detection.
    }
  }

  const model = contentGeneratorConfig.model ?? '';
  return model.toLowerCase().startsWith('mimo-');
}

export class MiMoOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  static isMiMoProvider = isMiMoProvider;

  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);
    if (!baseRequest.messages?.length) {
      return baseRequest;
    }

    return {
      ...baseRequest,
      messages: baseRequest.messages.map(ensureReasoningContentOnToolCalls),
    };
  }

  getRequestContextOverrides(): { splitToolMedia?: boolean } {
    return {
      splitToolMedia: this.contentGeneratorConfig.splitToolMedia ?? true,
    };
  }
}

function ensureReasoningContentOnToolCalls(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'assistant') {
    return message;
  }

  const assistant = message as ExtendedChatCompletionAssistantMessageParam;
  if (!assistant.tool_calls?.length) {
    return message;
  }

  if (typeof assistant.reasoning_content === 'string') {
    return message;
  }

  return {
    ...assistant,
    reasoning_content: '',
  } as OpenAI.Chat.ChatCompletionMessageParam;
}

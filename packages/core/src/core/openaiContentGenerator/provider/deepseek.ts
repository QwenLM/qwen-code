/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { GenerateContentConfig } from '@google/genai';

export class DeepSeekOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  static isDeepSeekProvider(
    contentGeneratorConfig: ContentGeneratorConfig,
  ): boolean {
    const baseUrl = contentGeneratorConfig.baseUrl ?? '';

    return baseUrl.toLowerCase().includes('api.deepseek.com');
  }

  /**
   * DeepSeek's API requires message content to be a plain string, not an
   * array of content parts. Flatten any text-part arrays into joined strings
   * and reject non-text parts that DeepSeek cannot handle.
   */
  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);
    if (!baseRequest.messages?.length) {
      return baseRequest;
    }

    const messages = baseRequest.messages.map((message) => {
      if (!('content' in message)) {
        return message;
      }

      const { content } = message;

      if (
        typeof content === 'string' ||
        content === null ||
        content === undefined
      ) {
        return message;
      }

      if (!Array.isArray(content)) {
        return message;
      }

      const text = content
        .map((part) => {
          if (typeof part === 'string') {
            return part;
          }
          if (part.type === 'text') {
            return part.text ?? '';
          }
          return `[Unsupported content type: ${part.type}]`;
        })
        .join('\n\n');

      return {
        ...message,
        content: text,
      } as OpenAI.Chat.ChatCompletionMessageParam;
    });

    return {
      ...baseRequest,
      messages,
    };
  }

  override getDefaultGenerationConfig(): GenerateContentConfig {
    return {
      temperature: 0,
    };
  }
}

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
    if (baseUrl.toLowerCase().includes('api.deepseek.com')) {
      return true;
    }

    // DeepSeek models served behind any OpenAI-compatible endpoint (sglang,
    // vllm, ollama, etc.) share the same content-format constraint that the
    // official api.deepseek.com endpoint has. Detect them by model name so
    // the buildRequest flattening below kicks in.
    // See https://github.com/QwenLM/qwen-code/issues/3613
    const model = contentGeneratorConfig.model ?? '';
    return model.toLowerCase().includes('deepseek');
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
      const flattened = flattenContentParts(message);
      return ensureReasoningContentOnToolCalls(flattened);
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

function flattenContentParts(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
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
}

// DeepSeek's thinking mode requires reasoning_content to be replayed on every
// prior assistant turn that carried tool_calls. The model may legitimately
// return a tool round without reasoning text, so the field can be missing
// when we rebuild the request. Send an empty string in that case so the API
// contract is satisfied. https://github.com/QwenLM/qwen-code/issues/3695
function ensureReasoningContentOnToolCalls(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'assistant') {
    return message;
  }
  if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) {
    return message;
  }
  const extended = message as ExtendedChatCompletionAssistantMessageParam;
  if (
    typeof extended.reasoning_content === 'string' &&
    extended.reasoning_content.length > 0
  ) {
    return message;
  }
  return {
    ...extended,
    reasoning_content: '',
  } as OpenAI.Chat.ChatCompletionMessageParam;
}

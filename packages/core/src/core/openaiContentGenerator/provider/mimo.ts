/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import type { OpenAIRequestContextOverrides } from './types.js';
import { ensureReasoningContentOnAssistantMessage } from './utils.js';

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
      // Non-MiMo URLs fall through to model-name detection.
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
      messages: baseRequest.messages.map(
        ensureReasoningContentOnAssistantMessage,
      ),
    };
  }

  getRequestContextOverrides(): OpenAIRequestContextOverrides {
    // Respect explicit user configuration; default to true for MiMo compatibility.
    return {
      splitToolMedia: this.contentGeneratorConfig.splitToolMedia ?? true,
    };
  }
}

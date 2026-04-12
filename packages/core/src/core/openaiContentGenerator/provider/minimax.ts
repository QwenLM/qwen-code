/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

const MINIMAX_DEFAULT_BASE_URL = 'https://api.minimax.io/v1';

/**
 * Provider for MiniMax API (OpenAI-compatible interface).
 *
 * MiniMax-specific constraints:
 * - temperature must be in the range (0.0, 1.0]; 0 is not allowed, default is 1.0
 * - response_format is not supported and must be removed from requests
 */
export class MiniMaxOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
    // Use MiniMax default base URL if not explicitly configured
    if (!this.contentGeneratorConfig.baseUrl) {
      this.contentGeneratorConfig = {
        ...this.contentGeneratorConfig,
        baseUrl: MINIMAX_DEFAULT_BASE_URL,
      };
    }
  }

  /**
   * Checks if the configuration targets the MiniMax API.
   */
  static isMiniMaxProvider(config: ContentGeneratorConfig): boolean {
    const baseUrl = config.baseUrl ?? '';
    return (
      baseUrl.includes('api.minimax.io') || baseUrl.includes('api.minimaxi.com')
    );
  }

  /**
   * MiniMax default generation config.
   * Temperature defaults to 1.0 because MiniMax does not accept temperature = 0.
   */
  override getDefaultGenerationConfig(): GenerateContentConfig {
    return {
      temperature: 1.0,
    };
  }

  /**
   * Build a MiniMax-compatible request by:
   * 1. Ensuring temperature is within the allowed range (0.0, 1.0]
   * 2. Removing unsupported `response_format` parameter
   */
  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: any = { ...baseRequest };

    // MiniMax does not support temperature = 0; default to 1.0
    if (result.temperature === 0 || result.temperature === undefined) {
      result.temperature = 1.0;
    }

    // MiniMax does not support response_format
    if ('response_format' in result) {
      delete result.response_format;
    }

    return result as OpenAI.Chat.ChatCompletionCreateParams;
  }
}

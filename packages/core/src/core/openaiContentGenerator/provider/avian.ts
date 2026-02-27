/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

/**
 * Avian provider for the Avian LLM API.
 *
 * Avian (https://avian.io) is an OpenAI-compatible LLM inference provider
 * offering models like DeepSeek-V3.2, Kimi-K2.5, GLM-5, and MiniMax-M2.5.
 *
 * API Base URL: https://api.avian.io/v1
 * Auth: Bearer token via AVIAN_API_KEY environment variable
 */
export class AvianOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  static isAvianProvider(
    contentGeneratorConfig: ContentGeneratorConfig,
  ): boolean {
    const baseURL = contentGeneratorConfig.baseUrl || '';
    return baseURL.includes('api.avian.io');
  }

  override buildHeaders(): Record<string, string | undefined> {
    const baseHeaders = super.buildHeaders();

    return {
      ...baseHeaders,
      'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
      'X-Avian-Title': 'Qwen Code',
    };
  }
}

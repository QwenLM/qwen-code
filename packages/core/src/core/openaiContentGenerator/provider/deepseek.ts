/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

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

  override getDefaultGenerationConfig(): GenerateContentConfig {
    return {
      temperature: 0,
    };
  }
}

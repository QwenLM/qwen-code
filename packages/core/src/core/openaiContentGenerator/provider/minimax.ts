/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { OpenAIResponseParsingOptions } from '../responseParsingOptions.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

const MINIMAX_OPENAI_COMPATIBLE_HOSTS = new Set([
  'api.minimaxi.com',
  'api.minimax.io',
]);

export class MiniMaxOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isMiniMaxProvider(config: ContentGeneratorConfig): boolean {
    if (!config.baseUrl) return false;

    try {
      const hostname = new URL(config.baseUrl).hostname.toLowerCase();
      return MINIMAX_OPENAI_COMPATIBLE_HOSTS.has(hostname);
    } catch {
      return false;
    }
  }

  getResponseParsingOptions(): OpenAIResponseParsingOptions {
    return { taggedThinkingTags: true };
  }
}

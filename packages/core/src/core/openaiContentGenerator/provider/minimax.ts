/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { OpenAIResponseParsingOptions } from '../responseParsingOptions.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

/** Suffix patterns for MiniMax OpenAI-compatible API hosts. */
const MINIMAX_HOST_SUFFIXES = ['.minimaxi.com', '.minimax.io'] as const;

export class MiniMaxOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isMiniMaxProvider(config: ContentGeneratorConfig): boolean {
    if (!config.baseUrl) return false;

    try {
      const hostname = new URL(config.baseUrl).hostname.toLowerCase();
      return MINIMAX_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    } catch {
      return false;
    }
  }

  getResponseParsingOptions(): OpenAIResponseParsingOptions {
    return { taggedThinkingTags: true };
  }
}

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import type { OpenAIResponseParsingOptions } from '../responseParsingOptions.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

/** Well-known MiniMax API hostnames for exact matching. */
const MINIMAX_KNOWN_HOSTS = ['api.minimaxi.com', 'api.minimax.io'] as const;

/**
 * Suffix patterns for custom MiniMax OpenAI-compatible API hosts.
 * Note: suffix matching is intentionally permissive — it enables
 * tagged thinking parsing for any subdomain under minimaxi.com /
 * minimax.io. If a user configures a proxy at a minimaxi subdomain
 * that points to a non-MiniMax backend, tagged thinking parsing
 * could be incorrectly enabled. The known-host exact match above
 * covers official endpoints; the suffix fallback exists for custom
 * MiniMax deployments.
 */
const MINIMAX_HOST_SUFFIXES = ['.minimaxi.com', '.minimax.io'] as const;

export class MiniMaxOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  static isMiniMaxProvider(config: ContentGeneratorConfig): boolean {
    if (!config.baseUrl) return false;

    try {
      const hostname = new URL(config.baseUrl).hostname.toLowerCase();
      if ((MINIMAX_KNOWN_HOSTS as readonly string[]).includes(hostname)) {
        return true;
      }
      return MINIMAX_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix));
    } catch {
      return false;
    }
  }

  getResponseParsingOptions(): OpenAIResponseParsingOptions {
    return { taggedThinkingTags: true };
  }
}

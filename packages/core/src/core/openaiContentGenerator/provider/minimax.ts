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

  /**
   * Also matches routings whose hostname gives no MiniMax hint: aggregating
   * gateways proxy MiniMax backends under their own host and forward the
   * `invalid params, function parameters is empty (2013)` rejection verbatim,
   * leaving the model id as the only usable signal (#11834).
   *
   * `wireModel` is the model actually sent (`request.model ||
   * contentGeneratorConfig.model`). A request-level override decides which
   * backend answers, so gating on the config model alone would desync from
   * the request — same reasoning as the `enable_thinking` gate in pipeline.ts.
   */
  static isMiniMaxRouting(
    config: ContentGeneratorConfig,
    wireModel?: string,
  ): boolean {
    return (
      MiniMaxOpenAICompatibleProvider.isMiniMaxProvider(config) ||
      /minimax/i.test(wireModel ?? config.model ?? '')
    );
  }

  override getResponseParsingOptions(): OpenAIResponseParsingOptions {
    return { taggedThinkingTags: true };
  }
}

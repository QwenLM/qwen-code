/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type OpenAI from 'openai';
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
   * MiniMax rejects a function tool that carries no `parameters` at all
   * (#11834: `400 invalid params, function parameters is empty (2013)`), so
   * zero-argument tools get an empty object schema injected here.
   *
   * This deliberately reverses the converter's invariant one layer down:
   * converter.ts sets `parameters = undefined` for parameterless tools
   * (#11431), because the default-provider endpoints #10080 was written for
   * (llama.cpp, LM Studio, vLLM) reject the empty-object shape. Keep this
   * MiniMax-scoped: do not hoist it into DefaultOpenAICompatibleProvider,
   * and do not move it into the converter ahead of
   * `relaxSchemaForFunctionCalling`, which strips empty `properties` and
   * would emit the bare `{"type":"object"}` that #11410 reports as a 400.
   */
  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);
    baseRequest.tools = baseRequest.tools?.map((tool) =>
      tool.function.parameters === undefined
        ? {
            ...tool,
            function: {
              ...tool.function,
              parameters: { type: 'object', properties: {} },
            },
          }
        : tool,
    );
    return baseRequest;
  }

  override getResponseParsingOptions(): OpenAIResponseParsingOptions {
    return { taggedThinkingTags: true };
  }
}

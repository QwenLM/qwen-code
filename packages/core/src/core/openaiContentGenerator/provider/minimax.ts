/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './default.js';
import {
  DEFAULT_MINIMAX_BASE_URL,
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
} from '../constants.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';

/** Hostnames that identify the MiniMax API (global and domestic mirror). */
const MINIMAX_HOSTNAMES = new Set(['api.minimax.io', 'api.minimaxi.com']);

/**
 * Provider for MiniMax API (OpenAI-compatible interface).
 *
 * MiniMax-specific constraints:
 * - temperature must be in the range (0.0, 1.0]; 0 and null are not allowed,
 *   defaults to 1.0
 * - response_format is not supported and must be removed from requests
 */
export class MiniMaxOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  /**
   * Checks if the configuration targets the MiniMax API.
   * Uses hostname comparison to avoid substring-match false positives.
   */
  static isMiniMaxProvider(config: ContentGeneratorConfig): boolean {
    const baseUrl = config.baseUrl;
    if (!baseUrl) return false;
    try {
      const { hostname } = new URL(baseUrl);
      return MINIMAX_HOSTNAMES.has(hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  /**
   * Override buildClient to apply the MiniMax default base URL when none is
   * configured, matching the pattern used by sibling providers (DashScope, etc.).
   */
  override buildClient(): OpenAI {
    const {
      apiKey,
      baseUrl = DEFAULT_MINIMAX_BASE_URL,
      timeout = DEFAULT_TIMEOUT,
      maxRetries = DEFAULT_MAX_RETRIES,
    } = this.contentGeneratorConfig;
    const defaultHeaders = this.buildHeaders();
    const runtimeOptions = buildRuntimeFetchOptions(
      'openai',
      this.cliConfig.getProxy(),
    );
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
      ...(runtimeOptions || {}),
    });
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
   * 1. Removing the unsupported `response_format` parameter
   * 2. Ensuring temperature is within the allowed range (0.0, 1.0]
   */
  override buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const baseRequest = super.buildRequest(request, userPromptId);

    // Remove unsupported response_format via typed destructuring (no `any` cast)
    const { response_format: _rf, ...rest } = baseRequest;

    // MiniMax does not accept temperature = 0 or null; default to 1.0
    const temperature =
      rest.temperature == null || rest.temperature === 0
        ? 1.0
        : rest.temperature;

    return { ...rest, temperature };
  }
}

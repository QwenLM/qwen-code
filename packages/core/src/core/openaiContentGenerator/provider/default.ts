import OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';
import type { OpenAICompatibleProvider } from './types.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import {
  tokenLimit,
  CAPPED_DEFAULT_MAX_TOKENS,
  hasExplicitOutputLimit,
} from '../../tokenLimits.js';

/**
 * Default provider for standard OpenAI-compatible APIs
 */
export class DefaultOpenAICompatibleProvider
  implements OpenAICompatibleProvider
{
  protected contentGeneratorConfig: ContentGeneratorConfig;
  protected cliConfig: Config;

  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    this.cliConfig = cliConfig;
    this.contentGeneratorConfig = contentGeneratorConfig;
  }

  buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { customHeaders } = this.contentGeneratorConfig;
    const defaultHeaders = {
      'User-Agent': userAgent,
    };

    return customHeaders
      ? { ...defaultHeaders, ...customHeaders }
      : defaultHeaders;
  }

  buildClient(): OpenAI {
    const {
      apiKey,
      baseUrl,
      timeout = DEFAULT_TIMEOUT,
      maxRetries = DEFAULT_MAX_RETRIES,
    } = this.contentGeneratorConfig;
    const defaultHeaders = this.buildHeaders();
    // Configure fetch options to ensure user-configured timeout works as expected
    // bodyTimeout is always disabled (0) to let OpenAI SDK timeout control the request
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

  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    _userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const extraBody = this.contentGeneratorConfig.extra_body;

    // Apply output token limits to ensure max_tokens is set appropriately
    // This prevents occupying too much context window with output reservation
    const requestWithTokenLimits = this.applyOutputTokenLimit(request);

    return {
      ...requestWithTokenLimits,
      ...(extraBody ? extraBody : {}),
    };
  }

  getDefaultGenerationConfig(): GenerateContentConfig {
    return {};
  }

  /**
   * Apply output token limit to a request's max_tokens parameter.
   *
   * Purpose:
   * Some APIs (e.g., OpenAI-compatible) default to a very small max_tokens value,
   * which can cause responses to be truncated mid-output. This function ensures
   * a reasonable default is set while respecting user configuration.
   *
   * Logic:
   * 1. If user explicitly configured max_tokens:
   *    - For known models (in OUTPUT_PATTERNS): use the user's value, but cap at
   *      model's max output limit to avoid API errors
   *      (input + max_output > contextWindowSize would cause 400 errors on some APIs)
   *    - For unknown models (deployment aliases, self-hosted): respect user's
   *      configured value entirely (backend may support larger limits)
   * 2. If user didn't configure max_tokens:
   *    - Check QWEN_CODE_MAX_OUTPUT_TOKENS env var first
   *    - Otherwise use min(modelLimit, CAPPED_DEFAULT_MAX_TOKENS=8K)
   *    - Requests hitting the 8K cap get one clean retry at 64K (geminiChat.ts)
   * 3. If model has no specific limit (tokenLimit returns default):
   *    - Still apply CAPPED_DEFAULT_MAX_TOKENS as safeguard
   *
   * Examples:
   * - User sets 4K, known model limit 64K → uses 4K (respects user preference)
   * - User sets 100K, known model limit 64K → uses 64K (capped to avoid API error)
   * - User sets 100K, unknown model → uses 100K (respects user, backend may support it)
   * - User not set, model limit 64K → uses 8K (capped default for slot optimization)
   * - User not set, model limit 4K → uses 4K (model limit is lower)
   * - User not set, env QWEN_CODE_MAX_OUTPUT_TOKENS=16000 -> uses 16K
   *
   * @param request - The chat completion request parameters
   * @returns The request with max_tokens adjusted according to the logic
   */
  protected applyOutputTokenLimit<
    T extends { max_tokens?: number | null; model: string },
  >(request: T): T {
    // When samplingParams is set, it is the source of truth for the wire shape.
    // Don't inject a max_tokens default — honor the user's explicit choice.
    if (this.contentGeneratorConfig.samplingParams !== undefined) {
      return request;
    }

    const userMaxTokens = request.max_tokens;

    // Get model-specific output limit and check if model is known
    const modelLimit = tokenLimit(request.model, 'output');
    const isKnownModel = hasExplicitOutputLimit(request.model);

    // Determine the effective max_tokens
    let effectiveMaxTokens: number;

    if (userMaxTokens !== undefined && userMaxTokens !== null) {
      // User explicitly configured max_tokens
      if (isKnownModel) {
        // Known model: respect user config but cap at model limit to avoid API errors
        effectiveMaxTokens = Math.min(userMaxTokens, modelLimit);
      } else {
        // Unknown model (deployment aliases, self-hosted): respect user's value
        // The backend may support larger limits than our default
        effectiveMaxTokens = userMaxTokens;
      }
    } else {
      // No explicit user config — check env var, then use capped default.
      // Capped default (8K) reduces GPU slot over-reservation by ~4×.
      // Requests hitting the cap get one clean retry at 64K (geminiChat.ts).
      const envVal = process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'];
      const envMaxTokens = envVal ? parseInt(envVal, 10) : NaN;
      if (!isNaN(envMaxTokens) && envMaxTokens > 0) {
        effectiveMaxTokens = isKnownModel
          ? Math.min(envMaxTokens, modelLimit)
          : envMaxTokens;
      } else {
        effectiveMaxTokens = Math.min(modelLimit, CAPPED_DEFAULT_MAX_TOKENS);
      }
    }

    return {
      ...request,
      max_tokens: effectiveMaxTokens,
    };
  }
}

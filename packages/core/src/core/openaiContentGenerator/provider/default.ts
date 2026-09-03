import OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { DEFAULT_MAX_RETRIES, resolveRequestTimeout } from '../constants.js';
import type { OpenAICompatibleProvider } from './types.js';
import type { OpenAIResponseParsingOptions } from '../responseParsingOptions.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import {
  tokenLimit,
  hasExplicitOutputLimit,
  defaultOutputCeiling,
  parsePositiveIntegerEnvValue,
} from '../../tokenLimits.js';
import type { ReasoningEffort } from '../../reasoning-effort.js';
import {
  REASONING_EFFORT_TIERS,
  clampReasoningEffort,
} from '../../reasoning-effort.js';
import { createDebugLogger } from '../../../utils/debugLogger.js';
import { wrapFetchWithSessionId } from '../../outbound-session-id.js';

const debugLogger = createDebugLogger('DefaultOpenAICompatibleProvider');

/**
 * Tiers a generic OpenAI-compatible endpoint accepts. `max` is a vendor
 * extension rather than part of the shared contract: DeepSeek, GLM-5.2+ and
 * newer Anthropic models take it natively, but a generic endpoint's ladder
 * stops at `xhigh` and 400s on anything above it. Matches the OpenAI column
 * of the effort ladder in
 * docs/design/2026-06-30-unified-reasoning-effort-cli.md. Subclasses whose
 * endpoint does accept `max` override `supportedReasoningEfforts`.
 */
const OPENAI_COMPATIBLE_EFFORTS: readonly ReasoningEffort[] = [
  'low',
  'medium',
  'high',
  'xhigh',
];

type AssistantMessageWithReasoningFields =
  OpenAI.Chat.ChatCompletionAssistantMessageParam & {
    reasoning_content?: string | null;
    reasoning?: string | null;
  };

function isQwen3Model(model: string): boolean {
  return model.toLowerCase().includes('qwen3');
}

function mirrorReasoningContentToReasoning(
  message: OpenAI.Chat.ChatCompletionMessageParam,
): OpenAI.Chat.ChatCompletionMessageParam {
  if (message.role !== 'assistant') {
    return message;
  }

  const assistant = message as AssistantMessageWithReasoningFields;
  if (
    typeof assistant.reasoning_content !== 'string' ||
    assistant.reasoning_content.length === 0 ||
    typeof assistant.reasoning === 'string'
  ) {
    return message;
  }

  return {
    ...assistant,
    reasoning: assistant.reasoning_content,
  } as OpenAI.Chat.ChatCompletionMessageParam;
}

/**
 * Default provider for standard OpenAI-compatible APIs
 */
export class DefaultOpenAICompatibleProvider
  implements OpenAICompatibleProvider
{
  protected contentGeneratorConfig: ContentGeneratorConfig;
  protected cliConfig: Config;
  /**
   * Latch so an effort-clamp warning fires once per provider lifetime. Shared
   * with subclasses that clamp on their own wire shape (see DashScope) so one
   * provider instance never repeats the notice.
   */
  protected effortClampWarned = false;

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
      maxRetries = DEFAULT_MAX_RETRIES,
    } = this.contentGeneratorConfig;
    const timeout = resolveRequestTimeout(this.contentGeneratorConfig.timeout);
    const defaultHeaders = this.buildHeaders();
    // Configure fetch options for proxy support and timeout handling.
    // With proxy, dispatcher timeouts are disabled so SDK timeout controls the
    // request; without proxy, no custom dispatcher is installed.
    const runtimeOptions = buildRuntimeFetchOptions(
      'openai',
      this.cliConfig.getProxy(),
    );
    const baseFetch =
      (runtimeOptions?.fetch as typeof fetch | undefined) ?? globalThis.fetch;
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
      ...(runtimeOptions || {}),
      fetch: wrapFetchWithSessionId(baseFetch, this.cliConfig),
    });
  }

  /**
   * Effort tiers this endpoint accepts for `model`. Takes the wire model
   * rather than reading the configured one, because a request may override it
   * (`pipeline.ts` resolves `request.model || contentGeneratorConfig.model`),
   * and a capability answered for the wrong model is how an unaccepted tier
   * reaches the wire. Override in a subclass whose endpoint takes `max`; the
   * clamp calls it through `this`, so a subclass answer applies even on the
   * `super.buildRequest` path.
   */
  protected supportedReasoningEffortsFor(
    _model: string | undefined,
  ): readonly ReasoningEffort[] {
    return OPENAI_COMPATIBLE_EFFORTS;
  }

  /**
   * Cap the pipeline-injected `reasoning.effort` at what this endpoint accepts.
   * The tier is configured once (`/effort`) and persisted, so an unaccepted
   * value is not a one-off rejection: it 400s every later request in the
   * session too.
   *
   * Only the pipeline-injected tier is capped. A `reasoning` object the user
   * put in `samplingParams` ships verbatim (the pipeline hands those keys
   * straight to the wire and skips the injection entirely), and `extra_body`
   * merges after this, so both explicit overrides survive unchanged.
   */
  protected clampConfiguredReasoningEffort<T extends object>(request: T): T {
    if (
      this.contentGeneratorConfig.samplingParams?.['reasoning'] !== undefined
    ) {
      return request;
    }
    const loose = request as unknown as Record<string, unknown>;
    const reasoning = loose['reasoning'] as { effort?: unknown } | undefined;
    const effort = reasoning?.effort;
    if (
      typeof effort !== 'string' ||
      !REASONING_EFFORT_TIERS.includes(effort as ReasoningEffort)
    ) {
      return request;
    }
    const clamped = clampReasoningEffort(
      effort as ReasoningEffort,
      this.supportedReasoningEffortsFor(
        (loose['model'] as string | undefined) ??
          this.contentGeneratorConfig.model,
      ),
    );
    if (clamped === effort) {
      return request;
    }
    if (!this.effortClampWarned) {
      debugLogger.warn(
        `reasoning.effort='${effort}' is not accepted by this ` +
          `OpenAI-compatible endpoint; using '${clamped}'.`,
      );
      this.effortClampWarned = true;
    }
    return {
      ...loose,
      reasoning: { ...reasoning, effort: clamped },
    } as unknown as T;
  }

  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    _userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    const extraBody = this.contentGeneratorConfig.extra_body;

    // Apply output token limits to ensure max_tokens is set appropriately
    // This prevents occupying too much context window with output reservation
    const requestWithTokenLimits = this.clampConfiguredReasoningEffort(
      this.applyOutputTokenLimit(request),
    );
    const messages = isQwen3Model(request.model)
      ? requestWithTokenLimits.messages.map(mirrorReasoningContentToReasoning)
      : requestWithTokenLimits.messages;

    return {
      ...requestWithTokenLimits,
      messages,
      ...(extraBody ? extraBody : {}),
    };
  }

  getDefaultGenerationConfig(): GenerateContentConfig {
    return {};
  }

  getResponseParsingOptions(model?: string): OpenAIResponseParsingOptions {
    // Hybrid-thinking models occasionally bypass the reasoning channel and
    // emit their thinking as literal <think>/<thinking> tags inside content
    // (observed in production on qwen3-class models, issue #6666).
    return {
      contentOnlyThinkingTagLeaks: true,
      ...(model && isQwen3Model(model)
        ? { taggedThinkingTagsAfterReasoning: true }
        : {}),
    };
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
   *    - Otherwise use the model's output limit, clipped to
   *      OUTPUT_TOKEN_CEILING (64K)
   * 3. If model has no specific limit (tokenLimit returns default):
   *    - Use DEFAULT_OUTPUT_TOKEN_LIMIT
   *
   * Examples:
   * - User sets 4K, known model limit 64K → uses 4K (respects user preference)
   * - User sets 100K, known model limit 64K → uses 64K (capped to avoid API error)
   * - User sets 100K, unknown model → uses 100K (respects user, backend may support it)
   * - User not set, model limit 64K → uses 64K
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
      // No explicit user config — check env var, then use the model limit
      // clipped to the flat output ceiling (models advertising huge output
      // limits must not request the whole window; users who need more set
      // max_tokens explicitly).
      const envMaxTokens = parsePositiveIntegerEnvValue(
        process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'],
      );
      if (envMaxTokens !== undefined) {
        effectiveMaxTokens = isKnownModel
          ? Math.min(envMaxTokens, modelLimit)
          : envMaxTokens;
      } else {
        effectiveMaxTokens = defaultOutputCeiling(request.model);
      }
    }

    return {
      ...request,
      max_tokens: effectiveMaxTokens,
    };
  }
}

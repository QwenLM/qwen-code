import OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import {
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_DASHSCOPE_BASE_URL,
} from '../constants.js';
import type {
  OpenAICompatibleProvider,
  DashScopeRequestMetadata,
  ChatCompletionContentPartTextWithCache,
  ChatCompletionContentPartWithCache,
  ChatCompletionToolWithCache,
} from './types.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import { tokenLimit } from '../../tokenLimits.js';

export class DashScopeOpenAICompatibleProvider
  implements OpenAICompatibleProvider
{
  private contentGeneratorConfig: ContentGeneratorConfig;
  private cliConfig: Config;

  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    this.cliConfig = cliConfig;
    this.contentGeneratorConfig = contentGeneratorConfig;
  }

  static isDashScopeProvider(
    contentGeneratorConfig: ContentGeneratorConfig,
  ): boolean {
    const authType = contentGeneratorConfig.authType;
    const baseUrl = contentGeneratorConfig.baseUrl;
    return (
      authType === AuthType.QWEN_OAUTH ||
      baseUrl === 'https://dashscope.aliyuncs.com/compatible-mode/v1' ||
      baseUrl === 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' ||
      !baseUrl
    );
  }

  buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { authType, customHeaders } = this.contentGeneratorConfig;
    const defaultHeaders = {
      'User-Agent': userAgent,
      'X-DashScope-CacheControl': 'enable',
      'X-DashScope-UserAgent': userAgent,
      'X-DashScope-AuthType': authType,
    };

    return customHeaders
      ? { ...defaultHeaders, ...customHeaders }
      : defaultHeaders;
  }

  buildClient(): OpenAI {
    const {
      apiKey,
      baseUrl = DEFAULT_DASHSCOPE_BASE_URL,
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
    // Type assertion needed because Bun-specific timeout: false is not in OpenAI ClientOptions
    // but is handled correctly at runtime
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
      ...(runtimeOptions || {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  /**
   * Build and configure the request for DashScope API.
   *
   * This method applies DashScope-specific configurations including:
   * - Cache control for the system message, last tool message (when tools are configured),
   *   and the latest history message
   * - Output token limits based on model capabilities
   * - Vision model specific parameters (vl_high_resolution_images)
   * - Request metadata for session tracking
   *
   * @param request - The original chat completion request parameters
   * @param userPromptId - Unique identifier for the user prompt for session tracking
   * @returns Configured request with DashScope-specific parameters applied
   */
  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams {
    let messages = request.messages;
    let tools = request.tools;

    // Apply DashScope cache control if enabled (default is enabled).
    if (this.shouldEnableCacheControl()) {
      const { messages: updatedMessages, tools: updatedTools } =
        this.addDashScopeCacheControl(
          request,
          request.stream ? 'all' : 'system_only',
        );
      messages = updatedMessages;
      tools = updatedTools;
    }

    // Apply output token limits based on model capabilities
    // This ensures max_tokens doesn't exceed the model's maximum output limit
    const requestWithTokenLimits = this.applyOutputTokenLimit(request);

    const extraBody = this.contentGeneratorConfig.extra_body;

    if (this.isVisionModel(request.model)) {
      return {
        ...requestWithTokenLimits,
        messages,
        ...(tools ? { tools } : {}),
        ...(this.buildMetadata(userPromptId) || {}),
        /* @ts-expect-error dashscope exclusive */
        vl_high_resolution_images: true,
        ...(extraBody ? extraBody : {}),
      } as OpenAI.Chat.ChatCompletionCreateParams;
    }

    return {
      ...requestWithTokenLimits, // Preserve all original parameters including sampling params and adjusted max_tokens
      messages,
      ...(tools ? { tools } : {}),
      ...(this.buildMetadata(userPromptId) || {}),
      ...(extraBody ? extraBody : {}),
    } as OpenAI.Chat.ChatCompletionCreateParams;
  }

  buildMetadata(userPromptId: string): DashScopeRequestMetadata {
    const channel = this.cliConfig.getChannel?.();

    return {
      metadata: {
        sessionId: this.cliConfig.getSessionId?.(),
        promptId: userPromptId,
        ...(channel ? { channel } : {}),
      },
    };
  }

  getDefaultGenerationConfig(): GenerateContentConfig {
    return {
      temperature: 0.3,
    };
  }

  /**
   * Add cache control flag to specified message(s) for DashScope providers
   */
  private addDashScopeCacheControl(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    cacheControl: 'system_only' | 'all',
  ): {
    messages: OpenAI.Chat.ChatCompletionMessageParam[];
    tools?: ChatCompletionToolWithCache[];
  } {
    const messages = request.messages;

    const systemIndex = messages.findIndex((msg) => msg.role === 'system');
    const lastIndex = messages.length - 1;

    const updatedMessages =
      messages.length === 0
        ? messages
        : messages.map((message, index) => {
            const shouldAddCacheControl = Boolean(
              (index === systemIndex && systemIndex !== -1) ||
                (index === lastIndex && cacheControl === 'all'),
            );

            if (
              !shouldAddCacheControl ||
              !('content' in message) ||
              message.content === null ||
              message.content === undefined
            ) {
              return message;
            }

            return {
              ...message,
              content: this.addCacheControlToContent(message.content),
            } as OpenAI.Chat.ChatCompletionMessageParam;
          });

    const updatedTools =
      cacheControl === 'all' && request.tools?.length
        ? this.addCacheControlToTools(request.tools)
        : (request.tools as ChatCompletionToolWithCache[] | undefined);

    return {
      messages: updatedMessages,
      tools: updatedTools,
    };
  }

  private addCacheControlToTools(
    tools: OpenAI.Chat.ChatCompletionTool[],
  ): ChatCompletionToolWithCache[] {
    if (tools.length === 0) {
      return tools as ChatCompletionToolWithCache[];
    }

    const updatedTools = [...tools] as ChatCompletionToolWithCache[];
    const lastToolIndex = tools.length - 1;
    updatedTools[lastToolIndex] = {
      ...updatedTools[lastToolIndex],
      cache_control: { type: 'ephemeral' },
    };

    return updatedTools;
  }

  /**
   * Add cache control to message content, handling both string and array formats
   */
  private addCacheControlToContent(
    content: NonNullable<OpenAI.Chat.ChatCompletionMessageParam['content']>,
  ): ChatCompletionContentPartWithCache[] {
    // Convert content to array format if it's a string
    const contentArray = this.normalizeContentToArray(content);

    // Add cache control to the last text item or create one if needed
    return this.addCacheControlToContentArray(contentArray);
  }

  /**
   * Normalize content to array format
   */
  private normalizeContentToArray(
    content: NonNullable<OpenAI.Chat.ChatCompletionMessageParam['content']>,
  ): ChatCompletionContentPartWithCache[] {
    if (typeof content === 'string') {
      return [
        {
          type: 'text',
          text: content,
        } as ChatCompletionContentPartTextWithCache,
      ];
    }
    return [...content] as ChatCompletionContentPartWithCache[];
  }

  /**
   * Add cache control to the content array
   */
  private addCacheControlToContentArray(
    contentArray: ChatCompletionContentPartWithCache[],
  ): ChatCompletionContentPartWithCache[] {
    if (contentArray.length === 0) {
      return contentArray;
    }

    // Add cache_control to the last text item
    const lastItem = contentArray[contentArray.length - 1];
    contentArray[contentArray.length - 1] = {
      ...lastItem,
      cache_control: { type: 'ephemeral' },
    } as ChatCompletionContentPartTextWithCache;

    return contentArray;
  }

  private isVisionModel(model: string | undefined): boolean {
    if (!model) {
      return false;
    }

    const normalized = model.toLowerCase();

    if (normalized === 'vision-model') {
      return true;
    }

    if (normalized.startsWith('qwen-vl')) {
      return true;
    }

    if (normalized.startsWith('qwen3-vl-plus')) {
      return true;
    }

    return false;
  }

  /**
   * Apply output token limit to a request's max_tokens parameter.
   *
   * Ensures that existing max_tokens parameters don't exceed the model's maximum output
   * token limit. Only modifies max_tokens when already present in the request.
   *
   * @param request - The chat completion request parameters
   * @returns The request with max_tokens adjusted to respect the model's limits (if present)
   */
  private applyOutputTokenLimit<
    T extends { max_tokens?: number | null; model: string },
  >(request: T): T {
    const currentMaxTokens = request.max_tokens;

    // Only process if max_tokens is already present in the request
    if (currentMaxTokens === undefined || currentMaxTokens === null) {
      return request; // No max_tokens parameter, return unchanged
    }

    // Dynamically calculate output token limit using tokenLimit function
    // This ensures we always use the latest model-specific limits without relying on user configuration
    const modelLimit = tokenLimit(request.model, 'output');

    // If max_tokens exceeds the model limit, cap it to the model's limit
    if (currentMaxTokens > modelLimit) {
      return {
        ...request,
        max_tokens: modelLimit,
      };
    }

    // If max_tokens is within the limit, return the request unchanged
    return request;
  }

  /**
   * Check if cache control should be disabled based on configuration.
   *
   * @returns true if cache control should be enabled, false otherwise
   */
  private shouldEnableCacheControl(): boolean {
    // Cache control is enabled by default (when enableCacheControl is undefined or true).
    return (
      this.cliConfig.getContentGeneratorConfig()?.enableCacheControl !== false
    );
  }
}

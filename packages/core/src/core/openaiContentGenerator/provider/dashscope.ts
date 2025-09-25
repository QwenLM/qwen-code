import OpenAI from 'openai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';
import { tokenLimit } from '../../tokenLimits.js';
import type {
  OpenAICompatibleProvider,
  DashScopeRequestMetadata,
  ChatCompletionContentPartTextWithCache,
  ChatCompletionContentPartWithCache,
} from './types.js';

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
      baseUrl === 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1'
    );
  }

  buildHeaders(): Record<string, string | undefined> {
    const version = this.cliConfig.getCliVersion() || 'unknown';
    const userAgent = `QwenCode/${version} (${process.platform}; ${process.arch})`;
    const { authType } = this.contentGeneratorConfig;
    return {
      'User-Agent': userAgent,
      'X-DashScope-CacheControl': 'enable',
      'X-DashScope-UserAgent': userAgent,
      'X-DashScope-AuthType': authType,
    };
  }

  buildClient(): OpenAI {
    const {
      apiKey,
      baseUrl,
      timeout = DEFAULT_TIMEOUT,
      maxRetries = DEFAULT_MAX_RETRIES,
    } = this.contentGeneratorConfig;
    const defaultHeaders = this.buildHeaders();
    return new OpenAI({
      apiKey,
      baseURL: baseUrl,
      timeout,
      maxRetries,
      defaultHeaders,
    });
  }

  /**
   * Build and configure the request for DashScope API.
   *
   * This method applies DashScope-specific configurations including:
   * - Cache control for system and user messages
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

    // Apply DashScope cache control only if not disabled
    if (!this.shouldDisableCacheControl()) {
      // Add cache control to system and last messages for DashScope providers
      // Only add cache control to system message for non-streaming requests
      const cacheTarget = request.stream ? 'both' : 'system';
      messages = this.addDashScopeCacheControl(messages, cacheTarget);
    }

    // Apply output token limits based on model capabilities
    // This ensures max_tokens doesn't exceed the model's maximum output limit
    const requestWithTokenLimits = this.applyOutputTokenLimit(
      request,
      request.model,
    );

    if (this.isVisionModel(request.model)) {
      return {
        ...requestWithTokenLimits,
        messages,
        ...(this.buildMetadata(userPromptId) || {}),
        /* @ts-expect-error dashscope exclusive */
        vl_high_resolution_images: true,
      } as OpenAI.Chat.ChatCompletionCreateParams;
    }

    return {
      ...requestWithTokenLimits, // Preserve all original parameters including sampling params and adjusted max_tokens
      messages,
      ...(this.buildMetadata(userPromptId) || {}),
    } as OpenAI.Chat.ChatCompletionCreateParams;
  }

  buildMetadata(userPromptId: string): DashScopeRequestMetadata {
    return {
      metadata: {
        sessionId: this.cliConfig.getSessionId?.(),
        promptId: userPromptId,
      },
    };
  }

  /**
   * Add cache control flag to specified message(s) for DashScope providers
   */
  private addDashScopeCacheControl(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    target: 'system' | 'last' | 'both' = 'both',
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    if (messages.length === 0) {
      return messages;
    }

    let updatedMessages = [...messages];

    // Add cache control to system message if requested
    if (target === 'system' || target === 'both') {
      updatedMessages = this.addCacheControlToMessage(
        updatedMessages,
        'system',
      );
    }

    // Add cache control to last message if requested
    if (target === 'last' || target === 'both') {
      updatedMessages = this.addCacheControlToMessage(updatedMessages, 'last');
    }

    return updatedMessages;
  }

  /**
   * Helper method to add cache control to a specific message
   */
  private addCacheControlToMessage(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    target: 'system' | 'last',
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    const updatedMessages = [...messages];
    const messageIndex = this.findTargetMessageIndex(messages, target);

    if (messageIndex === -1) {
      return updatedMessages;
    }

    const message = updatedMessages[messageIndex];

    // Only process messages that have content
    if (
      'content' in message &&
      message.content !== null &&
      message.content !== undefined
    ) {
      const updatedContent = this.addCacheControlToContent(message.content);
      updatedMessages[messageIndex] = {
        ...message,
        content: updatedContent,
      } as OpenAI.Chat.ChatCompletionMessageParam;
    }

    return updatedMessages;
  }

  /**
   * Find the index of the target message (system or last)
   */
  private findTargetMessageIndex(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
    target: 'system' | 'last',
  ): number {
    if (target === 'system') {
      return messages.findIndex((msg) => msg.role === 'system');
    } else {
      return messages.length - 1;
    }
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
      return [
        {
          type: 'text',
          text: '',
          cache_control: { type: 'ephemeral' },
        } as ChatCompletionContentPartTextWithCache,
      ];
    }

    const lastItem = contentArray[contentArray.length - 1];

    if (lastItem.type === 'text') {
      // Add cache_control to the last text item
      contentArray[contentArray.length - 1] = {
        ...lastItem,
        cache_control: { type: 'ephemeral' },
      } as ChatCompletionContentPartTextWithCache;
    } else {
      // If the last item is not text, add a new text item with cache_control
      contentArray.push({
        type: 'text',
        text: '',
        cache_control: { type: 'ephemeral' },
      } as ChatCompletionContentPartTextWithCache);
    }

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
   * @param model - The model name to get the output token limit for
   * @returns The request with max_tokens adjusted to respect the model's limits (if present)
   */
  private applyOutputTokenLimit<T extends { max_tokens?: number | null }>(
    request: T,
    model: string,
  ): T {
    const currentMaxTokens = request.max_tokens;

    // Only process if max_tokens is already present in the request
    if (currentMaxTokens === undefined || currentMaxTokens === null) {
      return request; // No max_tokens parameter, return unchanged
    }

    const modelLimit = tokenLimit(model, 'output');

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
   * @returns true if cache control should be disabled, false otherwise
   */
  private shouldDisableCacheControl(): boolean {
    return (
      this.cliConfig.getContentGeneratorConfig()?.disableCacheControl === true
    );
  }
}

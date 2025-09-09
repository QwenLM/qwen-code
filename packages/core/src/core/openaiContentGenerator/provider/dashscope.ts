import OpenAI from 'openai';
import { Config } from '../../../config/config.js';
import { AuthType, ContentGeneratorConfig } from '../../contentGenerator.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';
import {
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

    return {
      ...request, // Preserve all original parameters including sampling params
      messages,
      ...(this.buildMetadata(userPromptId) || {}),
    };
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

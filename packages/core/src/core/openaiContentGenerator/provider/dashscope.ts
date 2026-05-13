import OpenAI from 'openai';
import type { GenerateContentConfig } from '@google/genai';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import {
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_DASHSCOPE_BASE_URL,
  DASHSCOPE_PROXY_BASE_URL,
} from '../constants.js';
import type {
  DashScopeRequestMetadata,
  ChatCompletionContentPartTextWithCache,
  ChatCompletionContentPartWithCache,
  ChatCompletionToolWithCache,
} from './types.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import { createDebugLogger } from '../../../utils/debugLogger.js';
import { DefaultOpenAICompatibleProvider } from './default.js';

const debugLogger = createDebugLogger('DashScopeOpenAICompatibleProvider');

export class DashScopeOpenAICompatibleProvider extends DefaultOpenAICompatibleProvider {
  constructor(
    contentGeneratorConfig: ContentGeneratorConfig,
    cliConfig: Config,
  ) {
    super(contentGeneratorConfig, cliConfig);
  }

  static isDashScopeProvider(
    contentGeneratorConfig: ContentGeneratorConfig,
  ): boolean {
    const { authType, baseUrl } = contentGeneratorConfig;

    if (authType === AuthType.QWEN_OAUTH) return true;
    if (!baseUrl) return true;

    const normalizedBaseUrl = baseUrl.endsWith('/')
      ? baseUrl.slice(0, -1)
      : baseUrl;

    // Parse the URL and check hostname instead of regex to avoid ReDoS on
    // attacker-controlled baseUrl and to reject path-only matches like
    // https://evil.example/dashscope.aliyuncs.com/...
    let hostname: string | null = null;
    try {
      hostname = new URL(normalizedBaseUrl).hostname.toLowerCase();
    } catch {
      hostname = null;
    }

    // Matches: dashscope.aliyuncs.com, *.dashscope.aliyuncs.com,
    // dashscope-intl.aliyuncs.com, or *.dashscope-intl.aliyuncs.com
    const isDashscopeOrigin =
      hostname !== null &&
      (hostname === 'dashscope.aliyuncs.com' ||
        hostname === 'dashscope-intl.aliyuncs.com' ||
        hostname.endsWith('.dashscope.aliyuncs.com') ||
        hostname.endsWith('.dashscope-intl.aliyuncs.com'));

    // Check if proxy is configured and matches
    const normalizedProxyUrl = DASHSCOPE_PROXY_BASE_URL?.endsWith('/')
      ? DASHSCOPE_PROXY_BASE_URL.slice(0, -1)
      : DASHSCOPE_PROXY_BASE_URL;

    const isProxyMatch = Boolean(
      normalizedProxyUrl &&
        normalizedBaseUrl.toLowerCase() === normalizedProxyUrl.toLowerCase(),
    );

    if (normalizedProxyUrl && !isDashscopeOrigin && !isProxyMatch) {
      debugLogger.debug(
        `DASHSCOPE_PROXY_BASE_URL is configured but the request baseUrl does not match. DashScope headers/cache control will be skipped.`,
      );
    }

    return isDashscopeOrigin || isProxyMatch;
  }

  override buildHeaders(): Record<string, string | undefined> {
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

  override buildClient(): OpenAI {
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
  override buildRequest(
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

    // Apply output token limits using parent class logic
    // Uses capped default (min of model limit and CAPPED_DEFAULT_MAX_TOKENS=8K)
    // Requests hitting the cap get one clean retry at 64K (geminiChat.ts)
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

  override getDefaultGenerationConfig(): GenerateContentConfig {
    return {};
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

  /**
   * Vision-capable model patterns.
   * Supports exact matches and prefix patterns for easy extension.
   */
  private static readonly VISION_MODEL_EXACT_MATCHES = new Set(['coder-model']);

  private static readonly VISION_MODEL_PREFIX_PATTERNS = [
    'qwen-vl', // qwen-vl-max, qwen-vl-max-latest, etc.
    'qwen3-vl-plus', // qwen3-vl-plus variants
    'qwen3.5-plus', // qwen3.5-plus (has built-in vision capabilities)
  ];

  private isVisionModel(model: string | undefined): boolean {
    if (!model) {
      return false;
    }

    const normalized = model.toLowerCase();

    // Check exact matches
    if (
      DashScopeOpenAICompatibleProvider.VISION_MODEL_EXACT_MATCHES.has(
        normalized,
      )
    ) {
      return true;
    }

    // Check prefix patterns
    for (const prefix of DashScopeOpenAICompatibleProvider.VISION_MODEL_PREFIX_PATTERNS) {
      if (normalized.startsWith(prefix)) {
        return true;
      }
    }

    return false;
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

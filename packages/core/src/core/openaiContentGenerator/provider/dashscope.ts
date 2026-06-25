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

  /**
   * Determines whether to use the DashScope-compatible provider.
   * Covers dashscope.aliyuncs.com, dashscope-intl.aliyuncs.com,
   * Token Plan endpoints under token-plan.<region>.maas.aliyuncs.com,
   * internal Alibaba domains (*.alibaba-inc.com, *.aliyun-inc.com),
   * and proxy matches.
   *
   * Note: any *.alibaba-inc.com / *.aliyun-inc.com host is treated as a
   * DashScope-compatible endpoint by design. Keep this generic and avoid
   * embedding individual private gateway hostnames in provider detection.
   */
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

    const isTokenPlanOrigin =
      hostname !== null &&
      hostname.startsWith('token-plan.') &&
      hostname.endsWith('.maas.aliyuncs.com');

    // Internal Alibaba domains proxying to DashScope-compatible APIs.
    // Covers *.alibaba-inc.com and *.aliyun-inc.com.
    const isInternalOrigin =
      hostname !== null &&
      (hostname.endsWith('.alibaba-inc.com') ||
        hostname.endsWith('.aliyun-inc.com'));

    // Check if proxy is configured and matches
    const normalizedProxyUrl = DASHSCOPE_PROXY_BASE_URL?.endsWith('/')
      ? DASHSCOPE_PROXY_BASE_URL.slice(0, -1)
      : DASHSCOPE_PROXY_BASE_URL;

    const isProxyMatch = Boolean(
      normalizedProxyUrl &&
        normalizedBaseUrl.toLowerCase() === normalizedProxyUrl.toLowerCase(),
    );

    if (
      normalizedProxyUrl &&
      !isDashscopeOrigin &&
      !isTokenPlanOrigin &&
      !isInternalOrigin &&
      !isProxyMatch
    ) {
      debugLogger.debug(
        `DASHSCOPE_PROXY_BASE_URL is configured but the request baseUrl does not match. DashScope headers/cache control will be skipped.`,
      );
    }

    if (isInternalOrigin) {
      debugLogger.debug(
        `DashScope provider activated via internal origin: ${hostname}`,
      );
    }

    return (
      isDashscopeOrigin || isTokenPlanOrigin || isInternalOrigin || isProxyMatch
    );
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
    // Configure fetch options for proxy support and timeout handling.
    // With proxy, dispatcher timeouts are disabled so SDK timeout controls the
    // request; without proxy, no custom dispatcher is installed.
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

    // glm-* models served via DashScope only parse structured "content parts"
    // arrays when the request is in function-calling mode. A tool-less request
    // (e.g. web_fetch's side-query: system + user, no tools, no tool messages)
    // with array content has its prompt silently dropped server-side —
    // prompt_tokens collapses and the model answers from an empty prompt. This
    // is glm-specific; other DashScope models read array content fine. Caching
    // is also moot for these one-shot side-queries, so for glm tool-less
    // requests we skip cache control and collapse content to plain strings (the
    // only form glm reliably reads here). Every other case keeps the existing
    // cache-control path unchanged.
    const flattenPlainTextForGlm =
      this.isGlmModel(request.model) &&
      !this.hasFunctionCallingContext(request);

    if (flattenPlainTextForGlm) {
      messages = this.flattenTextContent(messages);
    } else if (this.shouldEnableCacheControl()) {
      // Apply DashScope cache control if enabled (default is enabled).
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
        // Default-on for supported reasoning models; user extra_body wins.
        // Several vision models (e.g. qwen3.6-plus, qwen3.7-plus) are reasoning
        // models that need this flag for multi-turn reasoning continuity.
        // (No @ts-expect-error needed: TS flags only the first excess property
        // in this cast, already suppressed on vl_high_resolution_images above.)
        preserve_thinking: true,
        ...(extraBody ? extraBody : {}),
      } as OpenAI.Chat.ChatCompletionCreateParams;
    }

    return {
      ...requestWithTokenLimits, // Preserve all original parameters including sampling params and adjusted max_tokens
      messages,
      ...(tools ? { tools } : {}),
      ...(this.buildMetadata(userPromptId) || {}),
      // Default-on for supported reasoning models; user extra_body wins.
      /* @ts-expect-error dashscope exclusive */
      preserve_thinking: true,
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
   * True for glm-* models (e.g. glm-4.5, glm-5.2). Uses the same `^glm-` prefix
   * convention as the GLM matchers in tokenLimits.ts, keeping model detection
   * consistent across the codebase.
   */
  private isGlmModel(model: string | undefined): boolean {
    return !!model && model.toLowerCase().startsWith('glm-');
  }

  /**
   * Whether the request is in "function-calling mode" — it declares `tools`, or
   * its history already contains a tool result / assistant tool_call. glm needs
   * one of these present to parse structured content-part arrays.
   */
  private hasFunctionCallingContext(
    request: OpenAI.Chat.ChatCompletionCreateParams,
  ): boolean {
    if (request.tools && request.tools.length > 0) {
      return true;
    }
    return request.messages.some((message) => {
      if (message.role === 'tool') {
        return true;
      }
      if (message.role === 'assistant') {
        const toolCalls = (message as { tool_calls?: unknown[] }).tool_calls;
        return Array.isArray(toolCalls) && toolCalls.length > 0;
      }
      return false;
    });
  }

  /**
   * Collapse text-only content arrays back to a plain string, leaving
   * media-bearing parts (image/audio/...) as arrays. Used for glm tool-less
   * requests, where the array form would otherwise be dropped server-side.
   * Multiple text parts are joined with a blank line, matching the DeepSeek
   * provider's flattening (separate parts read as separate blocks).
   * Only called on the flatten branch, which skips cache control, so no part
   * here carries a `cache_control` marker.
   */
  private flattenTextContent(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): OpenAI.Chat.ChatCompletionMessageParam[] {
    return messages.map((message) => {
      if (!('content' in message) || !Array.isArray(message.content)) {
        return message;
      }
      const parts = message.content as Array<{ type?: string; text?: string }>;
      if (parts.length === 0) {
        return message;
      }
      const isTextOnly = parts.every((part) => part && part.type === 'text');
      if (!isTextOnly) {
        return message;
      }
      const text = parts.map((part) => part.text ?? '').join('\n\n');
      return {
        ...message,
        content: text,
      } as OpenAI.Chat.ChatCompletionMessageParam;
    });
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
    'qwen3.6-plus', // qwen3.6-plus (multimodal)
    'qwen3.7-plus', // qwen3.7-plus (multimodal)
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

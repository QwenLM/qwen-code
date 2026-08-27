/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  type MockedFunction,
} from 'vitest';
import OpenAI from 'openai';
import {
  DashScopeOpenAICompatibleProvider,
  selectDashScopeThinkingKnob,
} from './dashscope.js';
import { determineProvider } from '../index.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import type { ChatCompletionToolWithCache } from './types.js';
import {
  DEFAULT_TIMEOUT,
  DEFAULT_MAX_RETRIES,
  DISABLED_REQUEST_TIMEOUT_MS,
} from '../constants.js';
import { buildRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';
import type { OpenAIRuntimeFetchOptions } from '../../../utils/runtimeFetchOptions.js';

const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../../../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => mockDebugLogger),
}));

// Mock OpenAI
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation((config) => ({
    config,
    chat: {
      completions: {
        create: vi.fn(),
      },
    },
  })),
}));

vi.mock('../../../utils/runtimeFetchOptions.js', () => ({
  buildRuntimeFetchOptions: vi.fn(),
}));

// Mock DASHSCOPE_PROXY_BASE_URL so tests can control its value, while
// delegating every other constant (timeouts, sentinel, resolveRequestTimeout)
// to the real module so the mock cannot drift from the implementation.
vi.mock('../constants.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../constants.js')>();
  return {
    ...actual,
    get DASHSCOPE_PROXY_BASE_URL() {
      return process.env['DASHSCOPE_PROXY_BASE_URL'];
    },
  };
});

describe('DashScopeOpenAICompatibleProvider', () => {
  let provider: DashScopeOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    const mockedBuildRuntimeFetchOptions =
      buildRuntimeFetchOptions as unknown as MockedFunction<
        (sdkType: 'openai', proxyUrl?: string) => OpenAIRuntimeFetchOptions
      >;
    mockedBuildRuntimeFetchOptions.mockReturnValue(undefined);

    // Mock ContentGeneratorConfig
    mockContentGeneratorConfig = {
      apiKey: 'test-api-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      timeout: 60000,
      maxRetries: 2,
      model: 'qwen-max',
      authType: AuthType.QWEN_OAUTH,
    } as ContentGeneratorConfig;

    // Mock Config
    mockCliConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        enableCacheControl: true,
      }),
      getProxy: vi.fn().mockReturnValue(undefined),
    } as unknown as Config;

    provider = new DashScopeOpenAICompatibleProvider(
      mockContentGeneratorConfig,
      mockCliConfig,
    );
  });

  describe('constructor', () => {
    it('should initialize with provided configs', () => {
      expect(provider).toBeInstanceOf(DashScopeOpenAICompatibleProvider);
    });
  });

  it('enables content-only thinking-tag leak detection', () => {
    expect(provider.getResponseParsingOptions()).toEqual({
      contentOnlyThinkingTagLeaks: true,
    });
  });

  describe('isDashScopeProvider', () => {
    it('should return true for QWEN_OAUTH auth type', () => {
      const config = {
        authType: AuthType.QWEN_OAUTH,
        baseUrl: 'https://api.openai.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for DashScope domestic URL', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for DashScope international URL', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for DashScope US regional URL', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://dashscope-us.aliyuncs.com/compatible-mode/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for DashScope coding plan URL', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://coding.dashscope.aliyuncs.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for DashScope international coding plan URL', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://coding-intl.dashscope-intl.aliyuncs.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for Token Plan URL', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for internal alibaba-inc.com subdomain', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://gateway.alibaba-inc.com/dashscope/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'DashScope provider activated via internal origin: gateway.alibaba-inc.com',
      );
    });

    it('should return true for internal aliyun-inc.com subdomain', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://model-gateway.aliyun-inc.com/dashscope/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for multi-level internal subdomain', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://a.b.alibaba-inc.com/dashscope/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for port-bearing internal URL', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://gateway.alibaba-inc.com:8443/dashscope/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return true for alicloudapi.com subdomain', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://api-id.cn-hangzhou.alicloudapi.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'DashScope provider activated via alicloudapi origin: api-id.cn-hangzhou.alicloudapi.com',
      );
    });

    it('should return true for port-bearing alicloudapi.com URL', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://gateway.alicloudapi.com:8443/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return false for bare alicloudapi.com domain', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://alicloudapi.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(false);
    });

    it('should return false for bare alibaba-inc.com domain', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://alibaba-inc.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(false);
    });

    it('should return false for bare aliyun-inc.com domain', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://aliyun-inc.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(false);
    });

    it('should return false for lookalike internal domains without dot boundary', () => {
      const configs = [
        'https://notalibaba-inc.com/v1',
        'https://notaliyun-inc.com/v1',
        'https://alibaba-inc.com.evil.com/v1',
        'https://aliyun-inc.com.evil.com/v1',
        'https://not-token-plan.cn-beijing.maas.aliyuncs.com/v1',
        'https://token-plan.cn-beijing.maas.aliyuncs.com.evil.com/v1',
        'https://notalicloudapi.com/v1',
        'https://alicloudapi.com.evil.com/v1',
      ];

      configs.forEach((baseUrl) => {
        const result = DashScopeOpenAICompatibleProvider.isDashScopeProvider({
          authType: AuthType.USE_OPENAI,
          baseUrl,
        } as ContentGeneratorConfig);
        expect(result).toBe(false);
      });
    });

    it('should return false for non-DashScope configurations', () => {
      const configs = [
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://api.openai.com/v1',
        },
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://api.anthropic.com/v1',
        },
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'https://openrouter.ai/api/v1',
        },
      ];

      configs.forEach((config) => {
        const result = DashScopeOpenAICompatibleProvider.isDashScopeProvider(
          config as ContentGeneratorConfig,
        );
        expect(result).toBe(false);
      });
    });

    it('should return false when the dashscope domain only appears in the URL path', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://evil.example.com/dashscope.aliyuncs.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(false);
    });

    it('should return false for a domain that only ends with dashscope.aliyuncs.com as a suffix without a dot', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://notdashscope.aliyuncs.com/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(false);
    });

    it('should return false for an unparseable baseUrl', () => {
      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'not a url',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(false);
    });

    it('should return true when baseUrl matches DASHSCOPE_PROXY_BASE_URL', () => {
      vi.stubEnv(
        'DASHSCOPE_PROXY_BASE_URL',
        'https://your-proxy.com/dashscope',
      );

      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://your-proxy.com/dashscope',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });

    it('should return false when baseUrl does not match DASHSCOPE_PROXY_BASE_URL', () => {
      vi.stubEnv(
        'DASHSCOPE_PROXY_BASE_URL',
        'https://your-proxy.com/dashscope',
      );

      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://other-proxy.com/dashscope',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(false);
    });

    it('should debug log when baseUrl does not match DASHSCOPE_PROXY_BASE_URL', () => {
      vi.stubEnv(
        'DASHSCOPE_PROXY_BASE_URL',
        'https://your-proxy.com/dashscope',
      );

      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://other-proxy.com/dashscope',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);

      expect(result).toBe(false);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining(
          'DASHSCOPE_PROXY_BASE_URL is configured but the request baseUrl does not match',
        ),
      );
    });

    it('should log internal-origin activation instead of proxy mismatch for internal domains', () => {
      vi.stubEnv(
        'DASHSCOPE_PROXY_BASE_URL',
        'https://your-proxy.com/dashscope',
      );

      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://gateway.alibaba-inc.com/dashscope/v1',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);

      expect(result).toBe(true);
      expect(mockDebugLogger.debug).toHaveBeenCalledWith(
        'DashScope provider activated via internal origin: gateway.alibaba-inc.com',
      );
      expect(mockDebugLogger.debug).not.toHaveBeenCalledWith(
        expect.stringContaining(
          'DASHSCOPE_PROXY_BASE_URL is configured but the request baseUrl does not match',
        ),
      );
    });

    it('should return true when baseUrl matches DASHSCOPE_PROXY_BASE_URL with trailing slash', () => {
      vi.stubEnv(
        'DASHSCOPE_PROXY_BASE_URL',
        'https://your-proxy.com/dashscope',
      );

      const config = {
        authType: AuthType.USE_OPENAI,
        baseUrl: 'https://your-proxy.com/dashscope/',
      } as ContentGeneratorConfig;

      const result =
        DashScopeOpenAICompatibleProvider.isDashScopeProvider(config);
      expect(result).toBe(true);
    });
  });

  // Guards the full acceptance path end-to-end: an alicloudapi.com base URL
  // must route through the DashScope provider so buildRequest injects the
  // session-tracking metadata into the request body.
  describe('determineProvider routing for alicloudapi.com', () => {
    const alicloudapiConfig = {
      authType: AuthType.USE_OPENAI,
      baseUrl: 'https://api-id.cn-hangzhou.alicloudapi.com/v1',
      model: 'qwen-max',
    } as ContentGeneratorConfig;

    it('routes alicloudapi.com base URLs to the DashScope provider', () => {
      const routed = determineProvider(alicloudapiConfig, mockCliConfig);
      expect(routed).toBeInstanceOf(DashScopeOpenAICompatibleProvider);
    });

    it('injects session-tracking metadata into the request body', () => {
      const routed = determineProvider(
        alicloudapiConfig,
        mockCliConfig,
      ) as DashScopeOpenAICompatibleProvider;

      const result = routed.buildRequest(
        {
          model: 'qwen-max',
          messages: [{ role: 'user', content: 'Hello!' }],
        },
        'test-prompt-id',
      );

      expect(result.metadata).toEqual({
        sessionId: 'test-session-id',
        promptId: 'test-prompt-id',
      });
    });
  });

  describe('buildHeaders', () => {
    it('should build DashScope-specific headers', () => {
      const headers = provider.buildHeaders();

      expect(headers).toEqual({
        'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
        'X-DashScope-CacheControl': 'enable',
        'X-DashScope-UserAgent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
        'X-DashScope-AuthType': AuthType.QWEN_OAUTH,
      });
    });

    it('should merge custom headers with DashScope defaults', () => {
      const providerWithCustomHeaders = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          customHeaders: {
            'X-Custom': '1',
            'X-DashScope-CacheControl': 'disable',
          },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );

      const headers = providerWithCustomHeaders.buildHeaders();

      expect(headers['User-Agent']).toContain('QwenCode/1.0.0');
      expect(headers['X-DashScope-UserAgent']).toContain('QwenCode/1.0.0');
      expect(headers['X-DashScope-AuthType']).toBe(AuthType.QWEN_OAUTH);
      expect(headers['X-Custom']).toBe('1');
      expect(headers['X-DashScope-CacheControl']).toBe('disable');
    });

    it('should handle unknown CLI version', () => {
      (
        mockCliConfig.getCliVersion as MockedFunction<
          typeof mockCliConfig.getCliVersion
        >
      ).mockReturnValue(undefined);

      const headers = provider.buildHeaders();

      expect(headers['User-Agent']).toBe(
        `QwenCode/unknown (${process.platform}; ${process.arch})`,
      );
      expect(headers['X-DashScope-UserAgent']).toBe(
        `QwenCode/unknown (${process.platform}; ${process.arch})`,
      );
    });
  });

  describe('buildClient', () => {
    it('should create OpenAI client with DashScope configuration', () => {
      const client = provider.buildClient();

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'test-api-key',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          timeout: 60000,
          maxRetries: 2,
          defaultHeaders: {
            'User-Agent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
            'X-DashScope-CacheControl': 'enable',
            'X-DashScope-UserAgent': `QwenCode/1.0.0 (${process.platform}; ${process.arch})`,
            'X-DashScope-AuthType': AuthType.QWEN_OAUTH,
          },
        }),
      );

      expect(client).toBeDefined();
    });

    it('should use default timeout and maxRetries when not provided', () => {
      mockContentGeneratorConfig.timeout = undefined;
      mockContentGeneratorConfig.maxRetries = undefined;

      provider.buildClient();

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'test-api-key',
          baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
          timeout: DEFAULT_TIMEOUT,
          maxRetries: DEFAULT_MAX_RETRIES,
          defaultHeaders: expect.any(Object),
        }),
      );
    });

    it('should disable the timeout when configured to 0', () => {
      mockContentGeneratorConfig.timeout = 0;

      provider.buildClient();

      expect(OpenAI).toHaveBeenCalledWith(
        expect.objectContaining({
          timeout: DISABLED_REQUEST_TIMEOUT_MS,
        }),
      );
    });
  });

  describe('buildMetadata', () => {
    it('should build metadata with session and prompt IDs', () => {
      const userPromptId = 'test-prompt-id';
      const metadata = provider.buildMetadata(userPromptId);

      expect(metadata).toEqual({
        metadata: {
          sessionId: 'test-session-id',
          promptId: 'test-prompt-id',
        },
      });
    });

    it('should handle missing session ID', () => {
      // Mock the method to not exist (simulate optional chaining returning undefined)
      delete (mockCliConfig as unknown as Record<string, unknown>)[
        'getSessionId'
      ];

      const userPromptId = 'test-prompt-id';
      const metadata = provider.buildMetadata(userPromptId);

      expect(metadata).toEqual({
        metadata: {
          sessionId: undefined,
          promptId: 'test-prompt-id',
        },
      });
    });
  });

  describe('buildRequest', () => {
    const baseRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'qwen-max',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' },
      ],
      temperature: 0.7,
    };

    it('should add cache control to system message only for non-streaming requests', () => {
      const request = { ...baseRequest, stream: false };
      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.messages).toHaveLength(2);

      // System message should have cache control
      const systemMessage = result.messages[0];
      expect(systemMessage.role).toBe('system');
      expect(systemMessage.content).toEqual([
        {
          type: 'text',
          text: 'You are a helpful assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ]);

      // Last message should NOT have cache control for non-streaming requests
      const lastMessage = result.messages[1];
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toBe('Hello!');
    });

    it('sends enable_thinking:true on a qwen model when a reasoning effort is set', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          reasoning: { effort: 'high' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;
      expect(result['enable_thinking']).toBe(true);
    });

    it('rejects a provider-specific effort on a toggle-only qwen model', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          reasoning: { effort: 'vendor.ultra' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );

      expect(() =>
        generator.buildRequest({ ...baseRequest }, 'test-prompt-id'),
      ).toThrow(
        'Unsupported model.reasoningEffort "vendor.ultra" for toggle-only Qwen model "qwen-max". Change or clear model.reasoningEffort before using this model.',
      );
    });

    describe.each(['qwen3.8-max', 'qwen3.8-max-preview'])(
      '%s reasoning effort',
      (model) => {
        it.each(['low', 'medium', 'high', 'xhigh'] as const)(
          'passes %s through as reasoning_effort',
          (effort) => {
            const generator = new DashScopeOpenAICompatibleProvider(
              {
                ...mockContentGeneratorConfig,
                model,
                reasoning: { effort },
              } as ContentGeneratorConfig,
              mockCliConfig,
            );
            const requestWithReasoning = {
              ...baseRequest,
              model,
              reasoning: { effort },
            } as unknown as Parameters<typeof generator.buildRequest>[0];

            const result = generator.buildRequest(
              requestWithReasoning,
              'test-prompt-id',
            ) as unknown as Record<string, unknown>;

            expect(result['reasoning_effort']).toBe(effort);
            expect(result['enable_thinking']).toBeUndefined();
            expect(result['reasoning']).toBeUndefined();
          },
        );

        it.each(['minimal', 'ultra', 'vendor.custom'])(
          'passes provider-specific value %s through verbatim',
          (effort) => {
            const generator = new DashScopeOpenAICompatibleProvider(
              {
                ...mockContentGeneratorConfig,
                model,
                reasoning: { effort },
              } as ContentGeneratorConfig,
              mockCliConfig,
            );

            const result = generator.buildRequest(
              {
                ...baseRequest,
                model,
                reasoning: { effort },
              } as unknown as Parameters<typeof generator.buildRequest>[0],
              'test-prompt-id',
            ) as unknown as Record<string, unknown>;

            expect(result['reasoning_effort']).toBe(effort);
            expect(result['enable_thinking']).toBeUndefined();
            expect(result['reasoning']).toBeUndefined();
          },
        );
      },
    );

    describe.each([
      'qwen3.8-max',
      'qwen3.8-max-preview',
      'qwen3.8-max-latest',
      'qwen3.8-max-2026-01-15',
    ])('%s reasoning effort ceiling', (model) => {
      it('warns once however many requests the same provider builds', () => {
        const generator = new DashScopeOpenAICompatibleProvider(
          {
            ...mockContentGeneratorConfig,
            model,
            reasoning: { effort: 'max' },
          } as ContentGeneratorConfig,
          mockCliConfig,
        );
        const request = {
          ...baseRequest,
          model,
          reasoning: { effort: 'max' },
        } as unknown as Parameters<typeof generator.buildRequest>[0];

        generator.buildRequest(request, 'first');
        generator.buildRequest(request, 'second');

        const clampWarnings = mockDebugLogger.warn.mock.calls.filter(
          (call: unknown[]) =>
            typeof call[0] === 'string' &&
            call[0].includes('tiered-effort family'),
        );
        expect(clampWarnings).toHaveLength(1);
      });

      it('clamps the max tier to xhigh, the strongest tier DashScope accepts', () => {
        const generator = new DashScopeOpenAICompatibleProvider(
          {
            ...mockContentGeneratorConfig,
            model,
            reasoning: { effort: 'max' },
          } as ContentGeneratorConfig,
          mockCliConfig,
        );

        const result = generator.buildRequest(
          {
            ...baseRequest,
            model,
            reasoning: { effort: 'max' },
          } as unknown as Parameters<typeof generator.buildRequest>[0],
          'test-prompt-id',
        ) as unknown as Record<string, unknown>;

        expect(result['reasoning_effort']).toBe('xhigh');
      });
    });

    it('caps a non-qwen model on a DashScope host at the generic ceiling', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'vendor-compatible-model',
          reasoning: { effort: 'max' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );

      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'vendor-compatible-model',
          reasoning: { effort: 'max' },
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning']).toEqual({ effort: 'xhigh' });
    });

    it('caps a GLM model served over DashScope, which is not a Z.ai host', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'glm-5.2',
          reasoning: { effort: 'max' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );

      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'glm-5.2',
          reasoning: { effort: 'max' },
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning']).toEqual({ effort: 'xhigh' });
    });

    it('lets extra_body override qwen3.8-max reasoning_effort', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'low' },
          extra_body: { reasoning_effort: 'max' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          reasoning: { effort: 'low' },
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('max');
    });

    it('preserves a request-level qwen3.8-max reasoning_effort override', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'low' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          reasoning_effort: 'max',
          reasoning: { effort: 'low' },
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('max');
      expect(result['reasoning']).toBeUndefined();
    });

    it.each([
      {
        name: 'extra_body thinking_budget over request-level effort',
        extraBody: { enable_thinking: true, thinking_budget: 4096 },
        requestFields: { reasoning_effort: 'max' },
        configuredReasoning: false,
        expectedEffort: undefined,
        expectedBudget: 4096,
        expectedThinking: true,
      },
      {
        name: 'request-level thinking_budget over configured effort',
        extraBody: undefined,
        requestFields: { thinking_budget: 2048 },
        configuredReasoning: true,
        expectedEffort: undefined,
        expectedBudget: 2048,
        expectedThinking: undefined,
      },
      {
        name: 'extra_body thinking_budget over configured effort',
        extraBody: { thinking_budget: 3072 },
        requestFields: {},
        configuredReasoning: true,
        expectedEffort: undefined,
        expectedBudget: 3072,
        expectedThinking: undefined,
      },
      {
        name: 'extra_body effort over request-level thinking_budget',
        extraBody: { reasoning_effort: 'max' },
        requestFields: { thinking_budget: 2048 },
        configuredReasoning: false,
        expectedEffort: 'max',
        expectedBudget: undefined,
        expectedThinking: undefined,
      },
      {
        name: 'request-level effort over a same-layer thinking_budget',
        extraBody: undefined,
        requestFields: {
          reasoning_effort: 'high',
          thinking_budget: 1024,
        },
        configuredReasoning: false,
        expectedEffort: 'high',
        expectedBudget: undefined,
        expectedThinking: undefined,
      },
      {
        name: 'null extra_body thinking_budget falls through to configured effort',
        extraBody: { thinking_budget: null },
        requestFields: {},
        configuredReasoning: true,
        expectedEffort: 'low',
        expectedBudget: undefined,
        expectedThinking: undefined,
      },
      {
        name: 'null extra_body reasoning_effort falls through to configured effort',
        extraBody: { reasoning_effort: null },
        requestFields: {},
        configuredReasoning: true,
        expectedEffort: 'low',
        expectedBudget: undefined,
        expectedThinking: undefined,
      },
      {
        name: 'null request-level thinking_budget falls through to configured effort',
        extraBody: undefined,
        requestFields: { thinking_budget: null },
        configuredReasoning: true,
        expectedEffort: 'low',
        expectedBudget: undefined,
        expectedThinking: undefined,
      },
      {
        name: 'null request-level reasoning_effort falls through to configured effort',
        extraBody: undefined,
        requestFields: { reasoning_effort: null },
        configuredReasoning: true,
        expectedEffort: 'low',
        expectedBudget: undefined,
        expectedThinking: undefined,
      },
      {
        name: 'null extra_body enable_thinking is omitted without a configured effort',
        extraBody: { enable_thinking: null },
        requestFields: {},
        configuredReasoning: false,
        expectedEffort: undefined,
        expectedBudget: undefined,
        expectedThinking: undefined,
      },
      {
        name: 'null request-level enable_thinking is omitted without a configured effort',
        extraBody: undefined,
        requestFields: { enable_thinking: null },
        configuredReasoning: false,
        expectedEffort: undefined,
        expectedBudget: undefined,
        expectedThinking: undefined,
      },
    ])('resolves $name', (testCase) => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max-preview',
          ...(testCase.configuredReasoning
            ? { reasoning: { effort: 'low' as const } }
            : {}),
          extra_body: testCase.extraBody,
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max-preview',
          ...testCase.requestFields,
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      if (testCase.expectedEffort === undefined) {
        expect(result['reasoning_effort']).toBeUndefined();
      } else {
        expect(result['reasoning_effort']).toBe(testCase.expectedEffort);
      }
      if (testCase.expectedBudget === undefined) {
        expect(result['thinking_budget']).toBeUndefined();
      } else {
        expect(result['thinking_budget']).toBe(testCase.expectedBudget);
      }
      if (testCase.expectedThinking === undefined) {
        expect(result['enable_thinking']).toBeUndefined();
      } else {
        expect(result['enable_thinking']).toBe(testCase.expectedThinking);
      }
      expect(result['reasoning']).toBeUndefined();
    });

    it('warns that the dropped budget came from a request-level same-layer pair', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max-preview',
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max-preview',
          reasoning_effort: 'high',
          thinking_budget: 1024,
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      );

      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max-preview',
          reasoningEffort: 'high',
          dropped: ['thinking_budget'],
        },
      );
    });

    it('drops the preset enable_thinking when an effort tier ships on qwen3.8-max-preview', () => {
      // The Token Plan preset ships qwen3.8-max-preview with enableThinking,
      // which provider-config.ts turns into extra_body.enable_thinking; the
      // provider merges that extra_body last. With an effort tier selected
      // the wire body must carry reasoning_effort alone — not both competing
      // thinking knobs.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max-preview',
          reasoning: { effort: 'high' },
          extra_body: { enable_thinking: true },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max-preview',
          reasoning: { effort: 'high' },
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('high');
      expect(result['enable_thinking']).toBeUndefined();
      expect(result['reasoning']).toBeUndefined();
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max-preview',
          reasoningEffort: 'high',
          dropped: ['enable_thinking'],
        },
      );

      // The conflict is persistent for this generator; the warn fires once,
      // not on every request.
      generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max-preview',
          reasoning: { effort: 'high' },
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id-2',
      );
      expect(mockDebugLogger.warn).toHaveBeenCalledTimes(1);
    });

    it('keeps enable_thinking when a request-level reasoning_effort override ships on a legacy qwen model', () => {
      // Legacy hybrids read enable_thinking, not reasoning_effort; the
      // override passes through as an opaque parameter and must not delete
      // the thinking switch, or the wire would carry no thinking signal.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.7-max',
          reasoning: { effort: 'high' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.7-max',
          reasoning_effort: 'max',
          reasoning: { effort: 'high' },
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('max');
      expect(result['enable_thinking']).toBe(true);
    });

    it('drops the inert reasoning_effort when it conflicts with thinking_budget on a legacy qwen model', () => {
      // DashScope rejects the reasoning_effort + thinking_budget pair.
      // Legacy hybrids read enable_thinking/thinking_budget, not
      // reasoning_effort, so the inert field goes and the knobs the model
      // reads survive.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.7-max',
          reasoning: { effort: 'high' },
          extra_body: { thinking_budget: 1024 },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.7-max',
          reasoning_effort: 'max',
          reasoning: { effort: 'high' },
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['enable_thinking']).toBe(true);
      expect(result['thinking_budget']).toBe(1024);
    });

    it('drops the inert reasoning_effort for a legacy qwen model with only a user thinking_budget', () => {
      // No config tier: the wire would otherwise carry a single ignored
      // parameter (reasoning_effort) with the meaningful thinking_budget
      // deleted. The user's budget must survive.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.7-max',
          extra_body: { thinking_budget: 4096, reasoning_effort: 'max' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen3.7-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['thinking_budget']).toBe(4096);
      expect(result['enable_thinking']).toBeUndefined();
    });

    it('keeps every knob for a non-qwen model with an extra_body enable_thinking and reasoning_effort', () => {
      // glm/kimi presets inject enable_thinking via extra_body; a user
      // reasoning_effort override is an opaque sampling override there, not
      // a thinking switch, and must not delete the preset's switch.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'glm-5.2',
          extra_body: { enable_thinking: true, reasoning_effort: 'high' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'glm-5.2' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['enable_thinking']).toBe(true);
      expect(result['reasoning_effort']).toBe('high');
      expect(mockDebugLogger.warn).not.toHaveBeenCalled();
    });

    it('keeps every knob for a non-qwen model with an extra_body thinking_budget and reasoning_effort', () => {
      // The family gate's observable effect for non-qwen models: a user
      // thinking_budget survives alongside an opaque reasoning_effort
      // override (mutation check: deleting the gate's early return drops
      // the budget here).
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'glm-5.2',
          extra_body: { reasoning_effort: 'high', thinking_budget: 1024 },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'glm-5.2' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('high');
      expect(result['thinking_budget']).toBe(1024);
      expect(mockDebugLogger.warn).not.toHaveBeenCalled();
    });

    it('keeps the thinking knobs when reasoning_effort is the none disable value', () => {
      // 'none' is an explicit disable that stays on the wire (pipeline
      // semantics), not a tier that overrides the thinking knobs.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'high' },
          extra_body: { enable_thinking: true, reasoning_effort: 'none' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen3.8-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('none');
      expect(result['enable_thinking']).toBe(true);
    });

    it('honours an explicit extra_body enable_thinking: false over the tier on qwen3.8-max', () => {
      // The off-switch arrives through the documented extra_body escape
      // hatch; deleting it would silently turn thinking back on. Translate
      // it into the family's canonical disable instead.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'high' },
          extra_body: { enable_thinking: false },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen3.8-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('none');
      expect(result['enable_thinking']).toBeUndefined();
    });

    it('honours samplingParams enable_thinking: false over the configured tier', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'high' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          enable_thinking: false,
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('none');
      expect(result['enable_thinking']).toBeUndefined();
    });

    it('keeps extra_body effort over a lower-priority samplingParams disable', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'high' },
          extra_body: { reasoning_effort: 'max' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          enable_thinking: false,
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('max');
      expect(result['enable_thinking']).toBeUndefined();
    });

    it('keeps the tier over a lower-priority samplingParams disable when extra_body enables thinking', () => {
      // Regression: selection used to register only `enable_thinking ===
      // false`, so the lower-priority disable won cross-layer resolution
      // and rewrote the shipping tier to `none` — inverting the documented
      // extra_body > samplingParams precedence.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'high' },
          extra_body: { enable_thinking: true },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          enable_thinking: false,
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('high');
      expect(result['enable_thinking']).toBeUndefined();
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max',
          reasoningEffort: 'high',
          dropped: ['enable_thinking'],
        },
      );
    });

    it('keeps a higher-priority extra_body enable_thinking over a samplingParams disable without a tier', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          extra_body: { enable_thinking: true },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          enable_thinking: false,
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['enable_thinking']).toBe(true);
      expect(result['reasoning_effort']).toBeUndefined();
      expect(mockDebugLogger.warn).not.toHaveBeenCalled();
    });

    it('keeps a samplingParams budget over the configured tier under an extra_body on-switch', () => {
      // The on-switch blocks lower-priority off-switches but does not choose
      // a value, so the next value-bearing layer still wins over reasoning.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'high' },
          extra_body: { enable_thinking: true },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          thinking_budget: 2048,
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['enable_thinking']).toBe(true);
      expect(result['thinking_budget']).toBe(2048);
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max',
          reasoningEffort: 'high',
          dropped: ['reasoning_effort'],
        },
      );
    });

    it('keeps higher-priority extra_body thinking knobs over a configured tier', () => {
      // Both extra_body fields outrank the configured reasoning effort, so
      // the lower-priority tier is removed without discarding user knobs.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'high' },
          extra_body: { enable_thinking: true, thinking_budget: 1024 },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen3.8-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['enable_thinking']).toBe(true);
      expect(result['thinking_budget']).toBe(1024);
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max',
          reasoningEffort: 'high',
          dropped: ['reasoning_effort'],
        },
      );
    });

    it('keeps a higher-priority budget over a request-level none sentinel', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          extra_body: { thinking_budget: 4096 },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          reasoning_effort: 'none',
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['thinking_budget']).toBe(4096);
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max',
          reasoningEffort: 'none',
          dropped: ['reasoning_effort'],
        },
      );
    });

    it('keeps a higher-priority budget over a request-level disable', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          extra_body: { thinking_budget: 4096 },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          enable_thinking: false,
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['enable_thinking']).toBeUndefined();
      expect(result['thinking_budget']).toBe(4096);
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max',
          reasoningEffort: undefined,
          dropped: ['enable_thinking'],
        },
      );
    });

    it.each([
      {
        name: 'extra_body disable over a request-level budget',
        extraBody: { enable_thinking: false },
        requestFields: { thinking_budget: 4096 },
      },
      {
        name: 'same-layer extra_body disable and budget',
        extraBody: { enable_thinking: false, thinking_budget: 1024 },
        requestFields: {},
      },
      {
        name: 'same-layer request-level disable and budget',
        extraBody: undefined,
        requestFields: { enable_thinking: false, thinking_budget: 2048 },
      },
    ])('canonicalizes $name without a configured tier', (testCase) => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          extra_body: testCase.extraBody,
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          ...testCase.requestFields,
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('none');
      expect(result['enable_thinking']).toBeUndefined();
      expect(result['thinking_budget']).toBeUndefined();
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max',
          reasoningEffort: undefined,
          dropped: ['enable_thinking', 'thinking_budget'],
        },
      );
    });

    it('keeps a legacy Qwen budget over an opaque none effort', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.7-max',
          extra_body: { thinking_budget: 4096, reasoning_effort: 'none' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen3.7-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['thinking_budget']).toBe(4096);
    });

    it('drops every conflicting knob when extra_body explicitly disables thinking', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          reasoning: { effort: 'high' },
          extra_body: { enable_thinking: false, thinking_budget: 1024 },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen3.8-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('none');
      expect(result['enable_thinking']).toBeUndefined();
      expect(result['thinking_budget']).toBeUndefined();
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max',
          reasoningEffort: 'high',
          dropped: ['enable_thinking', 'thinking_budget'],
        },
      );
    });

    it('drops an explicit budget when none disables thinking', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          extra_body: { enable_thinking: false, thinking_budget: 1024 },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen3.8-max',
          reasoning_effort: 'none',
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('none');
      expect(result['enable_thinking']).toBeUndefined();
      expect(result['thinking_budget']).toBeUndefined();
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max',
          reasoningEffort: 'none',
          dropped: ['enable_thinking', 'thinking_budget'],
        },
      );
    });

    it.each(['qwen3.8-max-2026-01-15', 'qwen3.8-max-latest'])(
      'passes effort through and drops the preset enable_thinking for the %s snapshot/alias id',
      (model) => {
        const generator = new DashScopeOpenAICompatibleProvider(
          {
            ...mockContentGeneratorConfig,
            model,
            reasoning: { effort: 'xhigh' },
            extra_body: { enable_thinking: true },
          } as ContentGeneratorConfig,
          mockCliConfig,
        );
        const result = generator.buildRequest(
          { ...baseRequest, model },
          'test-prompt-id',
        ) as unknown as Record<string, unknown>;

        expect(result['reasoning_effort']).toBe('xhigh');
        expect(result['enable_thinking']).toBeUndefined();
      },
    );

    it('reports cross-layer and same-layer drops together', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          extra_body: {
            enable_thinking: true,
            reasoning_effort: 'high',
            thinking_budget: 1024,
          },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen3.8-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('high');
      expect(result['enable_thinking']).toBeUndefined();
      expect(result['thinking_budget']).toBeUndefined();
      expect(mockDebugLogger.warn).toHaveBeenCalledWith(
        'DashScope: dropped conflicting thinking knobs',
        {
          model: 'qwen3.8-max',
          reasoningEffort: 'high',
          dropped: ['thinking_budget', 'enable_thinking'],
        },
      );
    });

    it('does not warn about an undefined thinking_budget key', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.8-max',
          extra_body: {
            reasoning_effort: 'high',
            thinking_budget: undefined,
          },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen3.8-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('high');
      expect(result['thinking_budget']).toBeUndefined();
      expect(mockDebugLogger.warn).not.toHaveBeenCalled();
    });

    it('keeps thinking_budget alongside enable_thinking on legacy qwen models', () => {
      // thinking_budget + enable_thinking is a valid pair on hybrid models;
      // only the reasoning_effort combination is rejected.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen3.7-max',
          reasoning: { effort: 'high' },
          extra_body: { thinking_budget: 1024 },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen3.7-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['enable_thinking']).toBe(true);
      expect(result['thinking_budget']).toBe(1024);
    });

    it('vision model: keeps enable_thinking when extra_body ships a reasoning_effort override', () => {
      // qwen-vl-max is a legacy hybrid that reads enable_thinking; the
      // vision branch merges extra_body last like the text path, and the
      // override must not delete the thinking switch there either.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen-vl-max',
          reasoning: { effort: 'high' },
          extra_body: { reasoning_effort: 'max' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'qwen-vl-max' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBe('max');
      expect(result['enable_thinking']).toBe(true);
      expect(result['vl_high_resolution_images']).toBe(true);
    });

    it('vision model: drops the inert reasoning_effort against a thinking_budget on the vision branch too', () => {
      // qwen-vl-max is a legacy hybrid; the vision branch resolves the
      // budget conflict the same way as the text path — the inert
      // reasoning_effort goes, the knobs the model reads survive.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen-vl-max',
          reasoning: { effort: 'high' },
          extra_body: { thinking_budget: 2048 },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        {
          ...baseRequest,
          model: 'qwen-vl-max',
          reasoning_effort: 'max',
        } as unknown as Parameters<typeof generator.buildRequest>[0],
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;

      expect(result['reasoning_effort']).toBeUndefined();
      expect(result['enable_thinking']).toBe(true);
      expect(result['thinking_budget']).toBe(2048);
      expect(result['vl_high_resolution_images']).toBe(true);
    });

    it('strips the pipeline-injected nested reasoning when enable_thinking is added on a qwen model', () => {
      // The pipeline injects a nested `reasoning: { effort }` object for
      // OpenAI-compatible endpoints. qwen drives thinking via `enable_thinking`,
      // so shipping both would send two competing knobs — the nested form must
      // be dropped (mirrors deepseek.ts / zai.ts).
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          reasoning: { effort: 'high' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const requestWithReasoning = {
        ...baseRequest,
        reasoning: { effort: 'high' },
      } as unknown as Parameters<typeof generator.buildRequest>[0];
      const result = generator.buildRequest(
        requestWithReasoning,
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;
      expect(result['enable_thinking']).toBe(true);
      expect(result['reasoning']).toBeUndefined();
    });

    it('vision model: injects enable_thinking and strips nested reasoning on a qwen-vl model', () => {
      // The vision branch of buildRequest duplicates the enable_thinking / strip
      // logic; exercise it directly so a divergence from the text path is caught.
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'qwen-vl-max',
          reasoning: { effort: 'high' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const requestWithReasoning = {
        ...baseRequest,
        model: 'qwen-vl-max',
        reasoning: { effort: 'high' },
      } as unknown as Parameters<typeof generator.buildRequest>[0];
      const result = generator.buildRequest(
        requestWithReasoning,
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;
      expect(result['enable_thinking']).toBe(true);
      expect(result['reasoning']).toBeUndefined();
      expect(result['vl_high_resolution_images']).toBe(true);
    });

    it('keeps the nested reasoning for a non-qwen wire model (no enable_thinking, no strip)', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'glm-4.6',
          reasoning: { effort: 'high' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const requestWithReasoning = {
        ...baseRequest,
        model: 'glm-4.6',
        reasoning: { effort: 'high' },
      } as unknown as Parameters<typeof generator.buildRequest>[0];
      const result = generator.buildRequest(
        requestWithReasoning,
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;
      expect(result['enable_thinking']).toBeUndefined();
      expect(result['reasoning']).toEqual({ effort: 'high' });
    });

    it('omits enable_thinking when no reasoning effort is set', () => {
      const result = provider.buildRequest(
        { ...baseRequest },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;
      expect(result['enable_thinking']).toBeUndefined();
    });

    it('does not send enable_thinking for a non-qwen wire model even with effort set', () => {
      const generator = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          model: 'glm-4.6',
          reasoning: { effort: 'high' },
        } as ContentGeneratorConfig,
        mockCliConfig,
      );
      const result = generator.buildRequest(
        { ...baseRequest, model: 'glm-4.6' },
        'test-prompt-id',
      ) as unknown as Record<string, unknown>;
      expect(result['enable_thinking']).toBeUndefined();
    });

    it('should add cache control to system message only for non-streaming requests with tools', () => {
      const requestWithTool: OpenAI.Chat.ChatCompletionCreateParams = {
        ...baseRequest,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          {
            role: 'tool',
            content: 'First tool output',
            tool_call_id: 'call_1',
          },
          {
            role: 'tool',
            content: 'Second tool output',
            tool_call_id: 'call_2',
          },
          { role: 'user', content: 'Hello!' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'mockTool',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
        stream: false,
      };

      const result = provider.buildRequest(requestWithTool, 'test-prompt-id');

      expect(result.messages).toHaveLength(4);

      const systemMessage = result.messages[0];
      expect(systemMessage.content).toEqual([
        {
          type: 'text',
          text: 'You are a helpful assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ]);

      // Tool messages should remain unchanged
      const firstToolMessage = result.messages[1];
      expect(firstToolMessage.role).toBe('tool');
      expect(firstToolMessage.content).toBe('First tool output');

      const secondToolMessage = result.messages[2];
      expect(secondToolMessage.role).toBe('tool');
      expect(secondToolMessage.content).toBe('Second tool output');

      // Last message should NOT have cache control for non-streaming requests
      const lastMessage = result.messages[3];
      expect(lastMessage.role).toBe('user');
      expect(lastMessage.content).toBe('Hello!');

      // Tools should NOT have cache control for non-streaming requests
      const tools = result.tools as ChatCompletionToolWithCache[];
      expect(tools).toBeDefined();
      expect(tools).toHaveLength(1);
      expect(tools[0].cache_control).toBeUndefined();
    });

    it('should add cache control to system, last history message, and last tool definition for streaming requests', () => {
      const request = { ...baseRequest, stream: true };
      const requestWithToolMessage: OpenAI.Chat.ChatCompletionCreateParams = {
        ...request,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          {
            role: 'tool',
            content: 'First tool output',
            tool_call_id: 'call_1',
          },
          {
            role: 'tool',
            content: 'Second tool output',
            tool_call_id: 'call_2',
          },
          { role: 'user', content: 'Hello!' },
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: 'mockTool',
              parameters: { type: 'object', properties: {} },
            },
          },
        ],
      };

      const result = provider.buildRequest(
        requestWithToolMessage,
        'test-prompt-id',
      );

      expect(result.messages).toHaveLength(4);

      // System message should have cache control
      const systemMessage = result.messages[0];
      expect(systemMessage.content).toEqual([
        {
          type: 'text',
          text: 'You are a helpful assistant.',
          cache_control: { type: 'ephemeral' },
        },
      ]);

      // Tool messages should remain unchanged
      const firstToolMessage = result.messages[1];
      expect(firstToolMessage.role).toBe('tool');
      expect(firstToolMessage.content).toBe('First tool output');

      const secondToolMessage = result.messages[2];
      expect(secondToolMessage.role).toBe('tool');
      expect(secondToolMessage.content).toBe('Second tool output');

      // Last message should also have cache control
      const lastMessage = result.messages[3];
      expect(lastMessage.content).toEqual([
        {
          type: 'text',
          text: 'Hello!',
          cache_control: { type: 'ephemeral' },
        },
      ]);

      const tools = result.tools as ChatCompletionToolWithCache[];
      expect(tools).toBeDefined();
      expect(tools).toHaveLength(1);
      expect(tools[0].cache_control).toEqual({ type: 'ephemeral' });
    });

    it('should not add cache control to tool messages when request.tools is undefined', () => {
      const requestWithoutConfiguredTools: OpenAI.Chat.ChatCompletionCreateParams =
        {
          ...baseRequest,
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            {
              role: 'tool',
              content: 'Tool output',
              tool_call_id: 'call_1',
            },
            { role: 'user', content: 'Hello!' },
          ],
        };

      const result = provider.buildRequest(
        requestWithoutConfiguredTools,
        'test-prompt-id',
      );

      expect(result.messages).toHaveLength(3);

      const toolMessage = result.messages[1];
      expect(toolMessage.role).toBe('tool');
      expect(toolMessage.content).toBe('Tool output');

      expect(result.tools).toBeUndefined();
    });

    it('should include metadata in the request', () => {
      const result = provider.buildRequest(baseRequest, 'test-prompt-id');

      expect(result.metadata).toEqual({
        sessionId: 'test-session-id',
        promptId: 'test-prompt-id',
      });
    });

    it('should preserve all original request parameters', () => {
      const complexRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        ...baseRequest,
        temperature: 0.8,
        max_tokens: 1000,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        stop: ['END'],
        user: 'test-user',
      };

      const result = provider.buildRequest(complexRequest, 'test-prompt-id');

      expect(result.model).toBe('qwen-max');
      expect(result.temperature).toBe(0.8);
      expect(result.max_tokens).toBe(1000);
      expect(result.top_p).toBe(0.9);
      expect(result.frequency_penalty).toBe(0.1);
      expect(result.presence_penalty).toBe(0.2);
      expect(result.stop).toEqual(['END']);
      expect(result.user).toBe('test-user');
    });

    it('should skip cache control when disabled', () => {
      (
        mockCliConfig.getContentGeneratorConfig as MockedFunction<
          typeof mockCliConfig.getContentGeneratorConfig
        >
      ).mockReturnValue({
        model: 'qwen-max',
        enableCacheControl: false,
      });

      const result = provider.buildRequest(baseRequest, 'test-prompt-id');

      // Messages should remain as strings (not converted to array format)
      expect(result.messages[0].content).toBe('You are a helpful assistant.');
      expect(result.messages[1].content).toBe('Hello!');
    });

    it('should handle messages with array content for streaming requests', () => {
      const requestWithArrayContent: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        stream: true, // This will trigger cache control on last message
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Hello' },
              { type: 'text', text: 'World' },
            ],
          },
        ],
      };

      const result = provider.buildRequest(
        requestWithArrayContent,
        'test-prompt-id',
      );

      const message = result.messages[0];
      expect(Array.isArray(message.content)).toBe(true);
      const content =
        message.content as OpenAI.Chat.ChatCompletionContentPart[];
      expect(content).toHaveLength(2);
      expect(content[1]).toEqual({
        type: 'text',
        text: 'World',
        cache_control: { type: 'ephemeral' },
      });
    });

    // glm-* on DashScope drop array-form content on tool-less ("plain") chat
    // requests. For glm models with no function-calling context the provider
    // skips cache control and collapses text content to plain strings, so
    // side-queries like web_fetch aren't silently emptied. Other models and
    // tool-bearing requests keep the existing cache-control path untouched.
    describe('glm array-drop fix (plain-text flatten)', () => {
      it('should flatten system and user text content to strings for a glm tool-less request', () => {
        const request: OpenAI.Chat.ChatCompletionCreateParams = {
          model: 'glm-5.2',
          stream: false,
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            {
              role: 'user',
              content: [{ type: 'text', text: 'Summarize this page.' }],
            },
          ],
        };

        const result = provider.buildRequest(request, 'test-prompt-id');

        // No cache_control is applied; both messages become plain strings.
        expect(result.messages[0].content).toBe('You are a helpful assistant.');
        expect(result.messages[1].content).toBe('Summarize this page.');
      });

      it('should join multi-part text-only array content with blank lines', () => {
        const request: OpenAI.Chat.ChatCompletionCreateParams = {
          model: 'glm-5.2',
          stream: false,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'First block' },
                { type: 'text', text: 'Second block' },
              ],
            },
          ],
        };

        const result = provider.buildRequest(request, 'test-prompt-id');

        expect(result.messages[0].content).toBe('First block\n\nSecond block');
      });

      it('should flatten the streamed last message too for a glm tool-less request', () => {
        const request: OpenAI.Chat.ChatCompletionCreateParams = {
          model: 'glm-5.2',
          stream: true,
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'Hello' }] },
          ],
        };

        const result = provider.buildRequest(request, 'test-prompt-id');

        expect(result.messages[0].content).toBe('Hello');
      });

      it('should NOT flatten array content that contains a non-text (media) part', () => {
        const request: OpenAI.Chat.ChatCompletionCreateParams = {
          model: 'glm-5.2',
          stream: false,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'What is this?' },
                {
                  type: 'image_url',
                  image_url: { url: 'https://example.com/x.jpg' },
                },
              ],
            },
          ],
        };

        const result = provider.buildRequest(request, 'test-prompt-id');

        // The whole message is left untouched (cannot be a plain string).
        expect(result.messages[0].content).toEqual([
          { type: 'text', text: 'What is this?' },
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/x.jpg' },
          },
        ]);
      });

      it('should leave an empty content array unchanged for a glm tool-less request', () => {
        const request: OpenAI.Chat.ChatCompletionCreateParams = {
          model: 'glm-5.2',
          stream: false,
          messages: [{ role: 'user', content: [] }],
        };

        const result = provider.buildRequest(request, 'test-prompt-id');

        expect(result.messages[0].content).toEqual([]);
      });

      it('should flatten glm content even when cache control is disabled', () => {
        (
          mockCliConfig.getContentGeneratorConfig as MockedFunction<
            typeof mockCliConfig.getContentGeneratorConfig
          >
        ).mockReturnValue({
          model: 'glm-5.2',
          enableCacheControl: false,
        });

        const request: OpenAI.Chat.ChatCompletionCreateParams = {
          model: 'glm-5.2',
          stream: false,
          messages: [
            { role: 'system', content: [{ type: 'text', text: 'Sys' }] },
            { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          ],
        };

        const result = provider.buildRequest(request, 'test-prompt-id');

        expect(result.messages[0].content).toBe('Sys');
        expect(result.messages[1].content).toBe('Hi');
      });

      // Any function-calling signal (a tools field, an assistant tool_call, or a
      // tool result in history) keeps glm out of the flatten path: cache control
      // is applied and array content is preserved.
      const functionCallingCases: Array<{
        name: string;
        extraMessages: OpenAI.Chat.ChatCompletionMessageParam[];
        tools?: OpenAI.Chat.ChatCompletionTool[];
        userIndex: number;
      }> = [
        {
          name: 'declares tools',
          extraMessages: [],
          tools: [
            {
              type: 'function',
              function: {
                name: 'noop',
                parameters: { type: 'object', properties: {} },
              },
            },
          ],
          userIndex: 1,
        },
        {
          name: 'has an assistant turn with tool_calls',
          extraMessages: [
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'noop', arguments: '{}' },
                },
              ],
            },
          ],
          userIndex: 2,
        },
        {
          name: 'has tool-result history',
          extraMessages: [
            { role: 'tool', content: 'tool result', tool_call_id: 'call_1' },
          ],
          userIndex: 2,
        },
      ];

      it.each(functionCallingCases)(
        'should keep cache control and array content for a glm request that $name',
        ({ extraMessages, tools, userIndex }) => {
          const request: OpenAI.Chat.ChatCompletionCreateParams = {
            model: 'glm-5.2',
            stream: false,
            messages: [
              { role: 'system', content: 'Sys' },
              ...extraMessages,
              { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
            ],
            ...(tools ? { tools } : {}),
          };

          const result = provider.buildRequest(request, 'test-prompt-id');

          expect(result.messages[0].content).toEqual([
            { type: 'text', text: 'Sys', cache_control: { type: 'ephemeral' } },
          ]);
          expect(Array.isArray(result.messages[userIndex].content)).toBe(true);
        },
      );

      it('should NOT flatten content for a non-glm tool-less request', () => {
        const request: OpenAI.Chat.ChatCompletionCreateParams = {
          model: 'qwen-max',
          stream: false,
          messages: [
            { role: 'system', content: 'Sys' },
            { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
          ],
        };

        const result = provider.buildRequest(request, 'test-prompt-id');

        // Non-glm: existing behavior — system cached as array, user untouched.
        expect(result.messages[0].content).toEqual([
          { type: 'text', text: 'Sys', cache_control: { type: 'ephemeral' } },
        ]);
        expect(result.messages[1].content).toEqual([
          { type: 'text', text: 'Hi' },
        ]);
      });
    });

    it('should handle empty messages array', () => {
      const emptyRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        messages: [],
      };

      const result = provider.buildRequest(emptyRequest, 'test-prompt-id');

      expect(result.messages).toEqual([]);
      expect(result.metadata).toBeDefined();
    });

    it('should handle messages without content for streaming requests', () => {
      const requestWithoutContent: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        stream: true, // This will trigger cache control on last message
        messages: [
          { role: 'assistant', content: null },
          { role: 'user', content: 'Hello' },
        ],
      };

      const result = provider.buildRequest(
        requestWithoutContent,
        'test-prompt-id',
      );

      // First message should remain unchanged
      expect(result.messages[0].content).toBeNull();

      // Second message should have cache control (it's the last message in streaming)
      expect(result.messages[1].content).toEqual([
        {
          type: 'text',
          text: 'Hello',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('should add cache control to last text item in mixed content for streaming requests', () => {
      const requestWithMixedContent: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        stream: true, // This will trigger cache control on last message
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at this image:' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/image.jpg' },
              },
              { type: 'text', text: 'What do you see?' },
            ],
          },
        ],
      };

      const result = provider.buildRequest(
        requestWithMixedContent,
        'test-prompt-id',
      );

      const content = result.messages[0]
        .content as OpenAI.Chat.ChatCompletionContentPart[];
      expect(content).toHaveLength(3);

      // Last text item should have cache control
      expect(content[2]).toEqual({
        type: 'text',
        text: 'What do you see?',
        cache_control: { type: 'ephemeral' },
      });

      // Image item should remain unchanged
      expect(content[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/image.jpg' },
      });
    });

    it('should add cache control to last item even if not text for streaming requests', () => {
      const requestWithNonTextLast: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        stream: true, // This will trigger cache control on last message
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at this:' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/image.jpg' },
              },
            ],
          },
        ],
      };

      const result = provider.buildRequest(
        requestWithNonTextLast,
        'test-prompt-id',
      );

      const content = result.messages[0]
        .content as OpenAI.Chat.ChatCompletionContentPart[];
      expect(content).toHaveLength(2);

      // Cache control should be added to the last item (image)
      expect(content[1]).toEqual({
        type: 'image_url',
        image_url: { url: 'https://example.com/image.jpg' },
        cache_control: { type: 'ephemeral' },
      });
    });
  });

  describe('cache control edge cases', () => {
    it('should handle request with only system message', () => {
      const systemOnlyRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        messages: [{ role: 'system', content: 'System prompt' }],
      };

      const result = provider.buildRequest(systemOnlyRequest, 'test-prompt-id');

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].content).toEqual([
        {
          type: 'text',
          text: 'System prompt',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('should handle request without system message for streaming requests', () => {
      const noSystemRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        stream: true, // This will trigger cache control on last message
        messages: [
          { role: 'user', content: 'First message' },
          { role: 'assistant', content: 'Response' },
          { role: 'user', content: 'Second message' },
        ],
      };

      const result = provider.buildRequest(noSystemRequest, 'test-prompt-id');

      expect(result.messages).toHaveLength(3);

      // Only last message should have cache control (no system message to modify)
      expect(result.messages[0].content).toBe('First message');
      expect(result.messages[1].content).toBe('Response');
      expect(result.messages[2].content).toEqual([
        {
          type: 'text',
          text: 'Second message',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });

    it('should handle empty content array for streaming requests', () => {
      const emptyContentRequest: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-max',
        stream: true, // This will trigger cache control on last message
        messages: [
          {
            role: 'user',
            content: [],
          },
        ],
      };

      const result = provider.buildRequest(
        emptyContentRequest,
        'test-prompt-id',
      );

      const content = result.messages[0]
        .content as OpenAI.Chat.ChatCompletionContentPart[];
      // Empty content array should remain empty
      expect(content).toEqual([]);
    });
  });

  describe('output token limits', () => {
    it('should limit max_tokens when it exceeds model limit', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100000, // Exceeds the model's output limit
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(32768); // Should be limited to model's output limit (32K)
    });

    it('should not modify max_tokens when it is within model limit', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1000, // Within the model's output limit
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(1000); // Should remain unchanged
    });

    it('should set model max_tokens default when not present in request', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'Hello' }],
        // No max_tokens parameter
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(32768);
    });

    it('should set model max_tokens when null is provided', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: null as unknown as undefined,
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(32768);
    });

    it('should respect user max_tokens for unknown models', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 40000, // User explicitly sets 40K
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      // Unknown models: respect user's configuration (backend may support it)
      expect(result.max_tokens).toBe(40000);
    });

    it('should preserve other request parameters when limiting max_tokens', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100000, // Will be limited
        temperature: 0.8,
        top_p: 0.9,
        frequency_penalty: 0.1,
        presence_penalty: 0.2,
        stop: ['END'],
        user: 'test-user',
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      // max_tokens should be limited
      expect(result.max_tokens).toBe(32768); // Limited to model's output limit (32K)

      // Other parameters should be preserved
      expect(result.temperature).toBe(0.8);
      expect(result.top_p).toBe(0.9);
      expect(result.frequency_penalty).toBe(0.1);
      expect(result.presence_penalty).toBe(0.2);
      expect(result.stop).toEqual(['END']);
      expect(result.user).toBe('test-user');
    });

    it('should set high resolution flag for the coder-model model', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'coder-model',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Alias payload' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/alias.png' },
              },
            ],
          },
        ],
        max_tokens: 100000, // Exceeds the 64K limit
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(65536); // Limited to model's output limit (64K)
      expect(
        (result as { vl_high_resolution_images?: boolean })
          .vl_high_resolution_images,
      ).toBe(true);
    });

    it('should handle streaming requests with output token limits', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-max',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100000, // Exceeds the model's output limit
        stream: true,
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(32768); // Should be limited to model's output limit (32K)
      expect(result.stream).toBe(true); // Streaming should be preserved
    });

    it('should merge extra_body into the request', () => {
      const providerWithExtraBody = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          extra_body: {
            custom_param: 'custom_value',
            nested: { key: 'value' },
          },
        },
        mockCliConfig,
      );

      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = providerWithExtraBody.buildRequest(
        request,
        'test-prompt-id',
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).custom_param).toBe('custom_value');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).nested).toEqual({ key: 'value' });
    });

    it('should merge extra_body into vision model requests', () => {
      const providerWithExtraBody = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          extra_body: {
            custom_param: 'custom_value',
          },
        },
        mockCliConfig,
      );

      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-vl-max',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = providerWithExtraBody.buildRequest(
        request,
        'test-prompt-id',
      );

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).custom_param).toBe('custom_value');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).vl_high_resolution_images).toBe(true);
    });

    it('should not include extra_body when not configured', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result).not.toHaveProperty('custom_param');
    });

    it('should default preserve_thinking to true on the request', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3.7-max',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).preserve_thinking).toBe(true);
    });

    it('should let user extra_body.preserve_thinking override the default', () => {
      const providerWithOptOut = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          extra_body: {
            preserve_thinking: false,
          },
        },
        mockCliConfig,
      );

      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3.7-max',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = providerWithOptOut.buildRequest(request, 'test-prompt-id');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).preserve_thinking).toBe(false);
    });

    it('should default preserve_thinking to true on vision model requests', () => {
      // qwen3.7-plus is a reasoning model routed through the vision path
      // (matches VISION_MODEL_PREFIX_PATTERNS); it still needs the flag.
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3.7-plus',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).preserve_thinking).toBe(true);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).vl_high_resolution_images).toBe(true);
    });

    it('should let user extra_body.preserve_thinking override the default on vision models', () => {
      const providerWithOptOut = new DashScopeOpenAICompatibleProvider(
        {
          ...mockContentGeneratorConfig,
          extra_body: {
            preserve_thinking: false,
          },
        },
        mockCliConfig,
      );

      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3.7-plus',
        messages: [{ role: 'user', content: 'Hello' }],
      };

      const result = providerWithOptOut.buildRequest(request, 'test-prompt-id');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((result as any).preserve_thinking).toBe(false);
    });
  });
});

describe('selectDashScopeThinkingKnob', () => {
  const model = 'qwen3.8-max';

  it('returns undefined for non-tiered or missing models', () => {
    expect(
      selectDashScopeThinkingKnob(
        'qwen3-max',
        { enable_thinking: false },
        { thinking_budget: 100 },
        'high',
      ),
    ).toBeUndefined();
    expect(
      selectDashScopeThinkingKnob(
        undefined,
        { reasoning_effort: 'high' },
        undefined,
        undefined,
      ),
    ).toBeUndefined();
  });

  it('matches the tiered family case-insensitively', () => {
    expect(
      selectDashScopeThinkingKnob(
        'QWEN3.8-MAX-preview',
        undefined,
        undefined,
        'high',
      ),
    ).toEqual({
      source: 'reasoning',
      field: 'reasoning_effort',
      value: 'high',
    });
  });

  it('returns undefined when no layer carries a knob', () => {
    expect(
      selectDashScopeThinkingKnob(model, undefined, undefined, undefined),
    ).toBeUndefined();
  });

  it('falls back to the unified reasoning tier', () => {
    expect(
      selectDashScopeThinkingKnob(model, undefined, undefined, 'high'),
    ).toEqual({
      source: 'reasoning',
      field: 'reasoning_effort',
      value: 'high',
    });
  });

  it('lets an extra_body disable win over same-layer values and lower layers', () => {
    expect(
      selectDashScopeThinkingKnob(
        model,
        { enable_thinking: false, reasoning_effort: 'low' },
        { thinking_budget: 100 },
        'high',
      ),
    ).toEqual({
      source: 'extra_body',
      field: 'enable_thinking',
      value: false,
    });
  });

  it('lets an extra_body budget win over lower-priority layers', () => {
    expect(
      selectDashScopeThinkingKnob(
        model,
        { thinking_budget: 300 },
        { reasoning_effort: 'low' },
        'high',
      ),
    ).toEqual({
      source: 'extra_body',
      field: 'thinking_budget',
      value: 300,
    });
  });

  it('keeps reasoning_effort over an explicit same-layer thinking_budget', () => {
    expect(
      selectDashScopeThinkingKnob(
        model,
        { reasoning_effort: 'low', thinking_budget: 300 },
        undefined,
        undefined,
      ),
    ).toEqual({
      source: 'extra_body',
      field: 'reasoning_effort',
      value: 'low',
    });
    expect(
      selectDashScopeThinkingKnob(
        model,
        undefined,
        { reasoning_effort: 'low', thinking_budget: 100 },
        undefined,
      ),
    ).toEqual({
      source: 'samplingParams',
      field: 'reasoning_effort',
      value: 'low',
    });
  });

  it('ignores nullish extra_body knobs', () => {
    expect(
      selectDashScopeThinkingKnob(
        model,
        {
          enable_thinking: null,
          reasoning_effort: null,
          thinking_budget: undefined,
        },
        undefined,
        'high',
      ),
    ).toEqual({
      source: 'reasoning',
      field: 'reasoning_effort',
      value: 'high',
    });
  });

  describe('extra_body on-switch', () => {
    it('lets a samplingParams value decide', () => {
      expect(
        selectDashScopeThinkingKnob(
          model,
          { enable_thinking: true },
          { thinking_budget: 200 },
          'high',
        ),
      ).toEqual({
        source: 'samplingParams',
        field: 'thinking_budget',
        value: 200,
      });
    });

    it('lets the reasoning tier decide when samplingParams has no value', () => {
      expect(
        selectDashScopeThinkingKnob(
          model,
          { enable_thinking: true },
          undefined,
          'high',
        ),
      ).toEqual({
        source: 'reasoning',
        field: 'reasoning_effort',
        value: 'high',
      });
    });

    it('is itself the selection when nothing below carries a value', () => {
      expect(
        selectDashScopeThinkingKnob(
          model,
          { enable_thinking: true },
          undefined,
          undefined,
        ),
      ).toEqual({
        source: 'extra_body',
        field: 'enable_thinking',
        value: true,
      });
    });

    it('blocks a lower-priority samplingParams disable', () => {
      expect(
        selectDashScopeThinkingKnob(
          model,
          { enable_thinking: true },
          { enable_thinking: false },
          'high',
        ),
      ).toEqual({
        source: 'reasoning',
        field: 'reasoning_effort',
        value: 'high',
      });
    });
  });

  it('lets a samplingParams disable win over the reasoning tier', () => {
    expect(
      selectDashScopeThinkingKnob(
        model,
        undefined,
        { enable_thinking: false },
        'high',
      ),
    ).toEqual({
      source: 'samplingParams',
      field: 'enable_thinking',
      value: false,
    });
  });

  it('lets a samplingParams budget win over the reasoning tier', () => {
    expect(
      selectDashScopeThinkingKnob(
        model,
        undefined,
        { thinking_budget: 128 },
        'high',
      ),
    ).toEqual({
      source: 'samplingParams',
      field: 'thinking_budget',
      value: 128,
    });
  });

  it('lets the reasoning tier decide under a samplingParams on-switch', () => {
    expect(
      selectDashScopeThinkingKnob(
        model,
        undefined,
        { enable_thinking: true },
        'high',
      ),
    ).toEqual({
      source: 'reasoning',
      field: 'reasoning_effort',
      value: 'high',
    });
  });

  it('keeps a lone samplingParams on-switch as the selection', () => {
    expect(
      selectDashScopeThinkingKnob(
        model,
        undefined,
        { enable_thinking: true },
        undefined,
      ),
    ).toEqual({
      source: 'samplingParams',
      field: 'enable_thinking',
      value: true,
    });
  });
});

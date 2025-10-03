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
import { DashScopeOpenAICompatibleProvider } from './dashscope.js';
import type { Config } from '../../../config/config.js';
import type { ContentGeneratorConfig } from '../../contentGenerator.js';
import { AuthType } from '../../contentGenerator.js';
import type { ChatCompletionToolWithCache } from './types.js';
import { DEFAULT_TIMEOUT, DEFAULT_MAX_RETRIES } from '../constants.js';

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

describe('DashScopeOpenAICompatibleProvider', () => {
  let provider: DashScopeOpenAICompatibleProvider;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

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
        disableCacheControl: false,
      }),
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

      expect(OpenAI).toHaveBeenCalledWith({
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
      });

      expect(client).toBeDefined();
    });

    it('should use default timeout and maxRetries when not provided', () => {
      mockContentGeneratorConfig.timeout = undefined;
      mockContentGeneratorConfig.maxRetries = undefined;

      provider.buildClient();

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-api-key',
        baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        timeout: DEFAULT_TIMEOUT,
        maxRetries: DEFAULT_MAX_RETRIES,
        defaultHeaders: expect.any(Object),
      });
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
        disableCacheControl: true,
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

    it('should add empty text item with cache control if last item is not text for streaming requests', () => {
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
      expect(content).toHaveLength(3);

      // Should add empty text item with cache control
      expect(content[2]).toEqual({
        type: 'text',
        text: '',
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
      expect(content).toEqual([
        {
          type: 'text',
          text: '',
          cache_control: { type: 'ephemeral' },
        },
      ]);
    });
  });

  describe('output token limits', () => {
    it('should limit max_tokens when it exceeds model limit for qwen3-coder-plus', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100000, // Exceeds the 65536 limit
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(65536); // Should be limited to model's output limit
    });

    it('should limit max_tokens when it exceeds model limit for qwen-vl-max-latest', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-vl-max-latest',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 20000, // Exceeds the 8192 limit
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(8192); // Should be limited to model's output limit
    });

    it('should not modify max_tokens when it is within model limit', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 1000, // Within the 65536 limit
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(1000); // Should remain unchanged
    });

    it('should not add max_tokens when not present in request', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: 'Hello' }],
        // No max_tokens parameter
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBeUndefined(); // Should remain undefined
    });

    it('should handle null max_tokens parameter', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: null,
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBeNull(); // Should remain null
    });

    it('should use default output limit for unknown models', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'unknown-model',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10000, // Exceeds the default 4096 limit
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(4096); // Should be limited to default output limit
    });

    it('should preserve other request parameters when limiting max_tokens', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-coder-plus',
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
      expect(result.max_tokens).toBe(65536);

      // Other parameters should be preserved
      expect(result.temperature).toBe(0.8);
      expect(result.top_p).toBe(0.9);
      expect(result.frequency_penalty).toBe(0.1);
      expect(result.presence_penalty).toBe(0.2);
      expect(result.stop).toEqual(['END']);
      expect(result.user).toBe('test-user');
    });

    it('should work with vision models and output token limits', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen-vl-max-latest',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Look at this image:' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/image.jpg' },
              },
            ],
          },
        ],
        max_tokens: 20000, // Exceeds the 8192 limit
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(8192); // Should be limited
      expect(
        (result as { vl_high_resolution_images?: boolean })
          .vl_high_resolution_images,
      ).toBe(true); // Vision-specific parameter should be preserved
    });

    it('should set high resolution flag for qwen3-vl-plus', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-vl-plus',
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Please inspect the image.' },
              {
                type: 'image_url',
                image_url: { url: 'https://example.com/vl.jpg' },
              },
            ],
          },
        ],
        max_tokens: 50000,
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(32768);
      expect(
        (result as { vl_high_resolution_images?: boolean })
          .vl_high_resolution_images,
      ).toBe(true);
    });

    it('should set high resolution flag for the vision-model alias', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'vision-model',
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
        max_tokens: 9000,
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(8192);
      expect(
        (result as { vl_high_resolution_images?: boolean })
          .vl_high_resolution_images,
      ).toBe(true);
    });

    it('should handle streaming requests with output token limits', () => {
      const request: OpenAI.Chat.ChatCompletionCreateParams = {
        model: 'qwen3-coder-plus',
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 100000, // Exceeds the 65536 limit
        stream: true,
      };

      const result = provider.buildRequest(request, 'test-prompt-id');

      expect(result.max_tokens).toBe(65536); // Should be limited
      expect(result.stream).toBe(true); // Streaming should be preserved
    });
  });
});

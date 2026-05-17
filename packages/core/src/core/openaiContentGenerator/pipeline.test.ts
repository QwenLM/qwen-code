/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type OpenAI from 'openai';
import type { GenerateContentParameters } from '@google/genai';
import { GenerateContentResponse, Type, FinishReason } from '@google/genai';
import type { ErrorHandler, PipelineConfig } from './types.js';
import { ContentGenerationPipeline, StreamContentError } from './pipeline.js';
import { OpenAIContentConverter } from './converter.js';
import { openaiRequestCaptureContext } from './requestCaptureContext.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig, AuthType } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';

// Mock dependencies
vi.mock('./converter.js', () => ({
  OpenAIContentConverter: {
    convertGeminiRequestToOpenAI: vi.fn(),
    convertOpenAIResponseToGemini: vi.fn(),
    convertOpenAIChunkToGemini: vi.fn(),
    convertGeminiToolsToOpenAI: vi.fn(),
  },
}));
vi.mock('openai');

describe('ContentGenerationPipeline', () => {
  let pipeline: ContentGenerationPipeline;
  let mockConfig: PipelineConfig;
  let mockProvider: OpenAICompatibleProvider;
  let mockClient: OpenAI;
  let mockConverter: typeof OpenAIContentConverter;
  let mockErrorHandler: ErrorHandler;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock OpenAI client
    mockClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as unknown as OpenAI;

    // Mock converter methods. The pipeline now snapshots request-scoped state
    // into context and calls the stateless converter namespace directly.
    mockConverter = OpenAIContentConverter;

    // Mock provider
    mockProvider = {
      buildClient: vi.fn().mockReturnValue(mockClient),
      buildRequest: vi.fn().mockImplementation((req) => req),
      buildHeaders: vi.fn().mockReturnValue({}),
      getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
    };

    // Mock error handler
    mockErrorHandler = {
      handle: vi.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
      shouldSuppressErrorLogging: vi.fn().mockReturnValue(false),
    } as unknown as ErrorHandler;

    // Mock configs
    mockCliConfig = {} as Config;
    mockContentGeneratorConfig = {
      model: 'test-model',
      authType: 'openai' as AuthType,
      samplingParams: {
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 1000,
      },
    } as ContentGeneratorConfig;

    mockConfig = {
      cliConfig: mockCliConfig,
      provider: mockProvider,
      contentGeneratorConfig: mockContentGeneratorConfig,
      errorHandler: mockErrorHandler,
    };

    pipeline = new ContentGenerationPipeline(mockConfig);
  });

  describe('constructor', () => {
    it('should initialize with correct configuration', () => {
      expect(mockProvider.buildClient).toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('should successfully execute non-streaming request', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = {
        id: 'response-id',
        choices: [
          { message: { content: 'Hello response' }, finish_reason: 'stop' },
        ],
        created: Date.now(),
        model: 'test-model',
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      // Act
      const result = await pipeline.execute(request, userPromptId);

      // Assert
      expect(result).toBe(mockGeminiResponse);
      expect(mockConverter.convertGeminiRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: 'test-model',
          modalities: {},
        }),
      );
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          messages: mockMessages,
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 1000,
        }),
        expect.objectContaining({
          signal: undefined,
        }),
      );
      expect(mockConverter.convertOpenAIResponseToGemini).toHaveBeenCalledWith(
        mockOpenAIResponse,
        expect.objectContaining({
          model: 'test-model',
          modalities: {},
        }),
      );
    });

    it('should use request.model when provided', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'override-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = {
        id: 'response-id',
        choices: [
          { message: { content: 'Hello response' }, finish_reason: 'stop' },
        ],
        created: Date.now(),
        model: 'override-model',
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      // Act
      const result = await pipeline.execute(request, userPromptId);

      // Assert — request.model takes precedence over contentGeneratorConfig.model
      expect(result).toBe(mockGeminiResponse);
      expect(mockConverter.convertGeminiRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: 'override-model',
        }),
      );
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'override-model',
        }),
        expect.any(Object),
      );
    });

    it('should fall back to configured model when request.model is empty', async () => {
      // Arrange — empty model string is falsy, should fall back to contentGeneratorConfig.model
      const request: GenerateContentParameters = {
        model: '',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = {
        id: 'response-id',
        choices: [
          { message: { content: 'Hello response' }, finish_reason: 'stop' },
        ],
        created: Date.now(),
        model: 'test-model',
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      // Act
      const result = await pipeline.execute(request, userPromptId);

      // Assert — falls back to contentGeneratorConfig.model
      expect(result).toBe(mockGeminiResponse);
      expect(mockConverter.convertGeminiRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: 'test-model',
        }),
      );
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
        }),
        expect.any(Object),
      );
    });

    it('should handle tools in request', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: {
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'test-function',
                  description: 'Test function',
                  parameters: { type: Type.OBJECT, properties: {} },
                },
              ],
            },
          ],
        },
      };
      const userPromptId = 'test-prompt-id';

      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockTools = [
        { type: 'function', function: { name: 'test-function' } },
      ] as OpenAI.Chat.ChatCompletionTool[];
      const mockOpenAIResponse = {
        id: 'response-id',
        choices: [
          { message: { content: 'Hello response' }, finish_reason: 'stop' },
        ],
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertGeminiToolsToOpenAI as Mock).mockResolvedValue(
        mockTools,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      // Act
      const result = await pipeline.execute(request, userPromptId);

      // Assert
      expect(result).toBe(mockGeminiResponse);
      expect(mockConverter.convertGeminiRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          model: 'test-model',
        }),
      );
      expect(mockConverter.convertGeminiToolsToOpenAI).toHaveBeenCalledWith(
        request.config!.tools,
        'auto',
      );
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: mockTools,
        }),
        expect.objectContaining({
          signal: undefined,
        }),
      );
    });

    it('should skip empty tools array in request', async () => {
      // Arrange — tools: [] should NOT be included in the API request
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { tools: [] },
      };
      const userPromptId = 'test-prompt-id';

      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = {
        id: 'response-id',
        choices: [{ message: { content: 'Response' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      // Act
      await pipeline.execute(request, userPromptId);

      // Assert — tools should NOT be in the request
      expect(mockConverter.convertGeminiToolsToOpenAI).not.toHaveBeenCalled();
      const apiCall = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(apiCall.tools).toBeUndefined();
    });

    it('should override enable_thinking when thinkingConfig disables it', async () => {
      // Arrange — provider injects enable_thinking: true via extra_body,
      // but request explicitly disables thinking
      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        enable_thinking: true, // Simulates extra_body injection
      }));

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Suggest next' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };
      const userPromptId = 'forked_query';

      const mockMessages = [
        { role: 'user', content: 'Suggest next' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = {
        id: 'response-id',
        choices: [
          {
            message: { content: '{"suggestion":"run tests"}' },
            finish_reason: 'stop',
          },
        ],
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      // Act
      await pipeline.execute(request, userPromptId);

      // Assert — enable_thinking should be overridden to false
      const apiCall = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(apiCall.enable_thinking).toBe(false);
    });

    it('should strip reasoning key from extra_body when thinking is disabled', async () => {
      // Arrange — provider injects reasoning via extra_body
      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        reasoning: { effort: 'high' },
      }));

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Suggest next' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      const mockMessages = [
        { role: 'user', content: 'Suggest next' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = {
        id: 'response-id',
        choices: [{ message: { content: 'run tests' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      // Act
      await pipeline.execute(request, 'forked_query');

      // Assert — reasoning should be stripped
      const apiCall = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(apiCall.reasoning).toBeUndefined();
    });

    it('should preserve enable_thinking when thinking is not explicitly disabled', async () => {
      // Arrange — normal request (not forked query), enable_thinking should be preserved
      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        enable_thinking: true,
      }));

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        // No thinkingConfig — normal request
      };

      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = {
        id: 'response-id',
        choices: [{ message: { content: 'Hi there' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      // Act
      await pipeline.execute(request, 'main');

      // Assert — enable_thinking should be PRESERVED (not disabled)
      const apiCall = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(apiCall.enable_thinking).toBe(true);
    });

    it('emits thinking:disabled on DeepSeek hostname when includeThoughts is false', async () => {
      // DeepSeek V4+ defaults thinking.type to 'enabled' — just stripping
      // the effort knob keeps thinking on, leaking latency/cost into side
      // queries. Verify the explicit disable signal is emitted.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Suggest next' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Suggest next' },
      ]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'r',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletion);

      await pipeline.execute(request, 'forked_query');

      const apiCall = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(apiCall.thinking).toEqual({ type: 'disabled' });
    });

    it('emits thinking:disabled on DeepSeek hostname when reasoning is configured to false', async () => {
      // Config-level opt-out should also disable DeepSeek thinking, not
      // just remove the effort knob.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://api.deepseek.com/v1',
        model: 'deepseek-v4-pro',
        reasoning: false,
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Hello' },
      ]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'r',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletion);

      await pipeline.execute(request, 'main');

      const apiCall = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(apiCall.thinking).toEqual({ type: 'disabled' });
    });

    it('does NOT emit thinking:disabled on a non-DeepSeek hostname', async () => {
      // The disable shape is DeepSeek-specific. Pushing it at strict
      // OpenAI-compat backends could trip an unknown-key 400.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://api.openai.com/v1',
        model: 'gpt-5',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Suggest' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Suggest' },
      ]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'r',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletion);

      await pipeline.execute(request, 'forked_query');

      const apiCall = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(apiCall.thinking).toBeUndefined();
    });

    it('does NOT emit thinking:disabled on self-hosted DeepSeek (model-name fallback only)', async () => {
      // Mirror of the round-7 reasoning_effort decision: the broader
      // model-name detection covers self-hosted DeepSeek for content
      // flattening, but the V4 thinking param is a wire-shape that
      // self-hosted infra (sglang/vllm) may not accept. Hostname-only.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://my-sglang.example.com:8000/v1',
        model: 'deepseek-v4-pro',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Suggest' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Suggest' },
      ]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'r',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletion);

      await pipeline.execute(request, 'forked_query');

      const apiCall = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(apiCall.thinking).toBeUndefined();
    });

    it('should handle errors and log them', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';
      const testError = new Error('API Error');

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockRejectedValue(testError);

      // Act & Assert
      await expect(pipeline.execute(request, userPromptId)).rejects.toThrow(
        'API Error',
      );

      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        testError,
        expect.any(Object),
        request,
      );
    });

    it('should redact proxy credentials before request errors reach the error handler', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';
      const testError = new Error(
        'connect ECONNREFUSED token@proxy.local:8080',
      );

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockRejectedValue(testError);

      await expect(pipeline.execute(request, userPromptId)).rejects.toThrow(
        'connect ECONNREFUSED <redacted>@proxy.local:8080',
      );

      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'connect ECONNREFUSED <redacted>@proxy.local:8080',
        }),
        expect.any(Object),
        request,
      );
      expect(testError.message).not.toContain('token@');
    });

    it('should pass abort signal to OpenAI client when provided', async () => {
      const abortController = new AbortController();
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { abortSignal: abortController.signal },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        choices: [{ message: { content: 'response' } }],
      });

      await pipeline.execute(request, 'test-id');

      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: abortController.signal }),
      );
    });
  });

  describe('executeStream', () => {
    it('should successfully execute streaming request', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      const mockChunk1 = {
        id: 'chunk-1',
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }],
      } as OpenAI.Chat.ChatCompletionChunk;
      const mockChunk2 = {
        id: 'chunk-2',
        choices: [{ delta: { content: ' response' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletionChunk;

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield mockChunk1;
          yield mockChunk2;
        },
      };

      const mockGeminiResponse1 = new GenerateContentResponse();
      const mockGeminiResponse2 = new GenerateContentResponse();
      mockGeminiResponse1.candidates = [
        { content: { parts: [{ text: 'Hello' }], role: 'model' } },
      ];
      mockGeminiResponse2.candidates = [
        { content: { parts: [{ text: ' response' }], role: 'model' } },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock)
        .mockReturnValueOnce(mockGeminiResponse1)
        .mockReturnValueOnce(mockGeminiResponse2);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      // Act
      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }

      // Assert
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(mockGeminiResponse1);
      expect(results[1]).toBe(mockGeminiResponse2);
      const [, firstChunkContext] = (
        mockConverter.convertOpenAIChunkToGemini as Mock
      ).mock.calls[0];
      const [, secondChunkContext] = (
        mockConverter.convertOpenAIChunkToGemini as Mock
      ).mock.calls[1];
      expect(firstChunkContext).toEqual(
        expect.objectContaining({
          model: 'test-model',
          modalities: {},
          toolCallParser: expect.any(StreamingToolCallParser),
        }),
      );
      expect(secondChunkContext.toolCallParser).toBe(
        firstChunkContext.toolCallParser,
      );
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: true,
          stream_options: { include_usage: true },
        }),
        expect.objectContaining({
          signal: undefined,
        }),
      );
    });

    it('should filter empty responses', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      const mockChunk1 = {
        id: 'chunk-1',
        choices: [{ delta: { content: '' }, finish_reason: null }],
      } as OpenAI.Chat.ChatCompletionChunk;
      const mockChunk2 = {
        id: 'chunk-2',
        choices: [
          { delta: { content: 'Hello response' }, finish_reason: 'stop' },
        ],
      } as OpenAI.Chat.ChatCompletionChunk;

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield mockChunk1;
          yield mockChunk2;
        },
      };

      const mockEmptyResponse = new GenerateContentResponse();
      mockEmptyResponse.candidates = [
        { content: { parts: [], role: 'model' } },
      ];

      const mockValidResponse = new GenerateContentResponse();
      mockValidResponse.candidates = [
        { content: { parts: [{ text: 'Hello response' }], role: 'model' } },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock)
        .mockReturnValueOnce(mockEmptyResponse)
        .mockReturnValueOnce(mockValidResponse);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      // Act
      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }

      // Assert
      expect(results).toHaveLength(1); // Empty response should be filtered out
      expect(results[0]).toBe(mockValidResponse);
    });

    it('should handle streaming errors and reset tool calls', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';
      const testError = new Error('Stream Error');

      const mockStream = {
        /* eslint-disable-next-line */
        async *[Symbol.asyncIterator]() {
          throw testError;
        },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      // Act
      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );

      // Assert
      // The stream should handle the error internally - errors during iteration don't propagate to the consumer
      // Instead, they are handled internally by the pipeline
      const results = [];
      try {
        for await (const result of resultGenerator) {
          results.push(result);
        }
      } catch (error) {
        // This is expected - the error should propagate from the stream processing
        expect(error).toBe(testError);
      }

      expect(results).toHaveLength(0); // No results due to error
      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        testError,
        expect.any(Object),
        request,
      );
    });

    it('should redact proxy credentials from stream creation errors', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';
      const testError = new Error('407 via http://user:pass@proxy.local');

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockRejectedValue(testError);

      await expect(
        pipeline.executeStream(request, userPromptId),
      ).rejects.toThrow('407 via http://<redacted>@proxy.local');

      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          message: '407 via http://<redacted>@proxy.local',
        }),
        expect.any(Object),
        request,
      );
      expect(testError.message).not.toContain('user:pass');
    });

    it('should redact proxy credentials before stream errors reach the error handler', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';
      const testError = new Error(
        'connect ECONNREFUSED token@proxy.local:8080',
      );

      const mockStream = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn().mockRejectedValue(testError),
        }),
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );

      await expect(async () => {
        for await (const _ of resultGenerator) {
          // consume stream
        }
      }).rejects.toThrow('connect ECONNREFUSED <redacted>@proxy.local:8080');

      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'connect ECONNREFUSED <redacted>@proxy.local:8080',
        }),
        expect.any(Object),
        request,
      );
      expect(testError.message).not.toContain('token@');
    });

    it('should throw StreamContentError when stream chunk contains error_finish', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'chunk-1',
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: 'test-model',
            choices: [
              {
                index: 0,
                delta: { content: 'Throttling: TPM(1/1)' },
                finish_reason: 'error_finish',
              },
            ],
          } as unknown as OpenAI.Chat.ChatCompletionChunk;
        },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );

      await expect(async () => {
        for await (const _ of resultGenerator) {
          // consume stream
        }
      }).rejects.toThrow(StreamContentError);

      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
      expect(mockConverter.convertOpenAIChunkToGemini).not.toHaveBeenCalled();
    });

    it('should redact proxy credentials from StreamContentError messages', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            choices: [
              {
                delta: {
                  content: 'connect ECONNREFUSED token@proxy.local:8080',
                },
                finish_reason: 'error_finish',
              },
            ],
          } as unknown as OpenAI.Chat.ChatCompletionChunk;
        },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'prompt-id',
      );

      await expect(async () => {
        for await (const _ of resultGenerator) {
          // consume stream
        }
      }).rejects.toThrow('connect ECONNREFUSED <redacted>@proxy.local:8080');

      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('should pass abort signal to OpenAI client for streaming requests', async () => {
      const abortController = new AbortController();
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { abortSignal: abortController.signal },
      };

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'chunk-1',
            choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }],
          };
        },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(request, 'test-id');
      for await (const _result of resultGenerator) {
        // Consume stream
      }

      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: abortController.signal }),
      );
    });

    it('should merge finishReason and usageMetadata from separate chunks', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      // Content chunk
      const mockChunk1 = {
        id: 'chunk-1',
        choices: [
          { delta: { content: 'Hello response' }, finish_reason: null },
        ],
      } as OpenAI.Chat.ChatCompletionChunk;

      // Finish reason chunk (empty content, has finish_reason)
      const mockChunk2 = {
        id: 'chunk-2',
        choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletionChunk;

      // Usage metadata chunk (empty candidates, has usage)
      const mockChunk3 = {
        id: 'chunk-3',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'test-model',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      } as OpenAI.Chat.ChatCompletionChunk;

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield mockChunk1;
          yield mockChunk2;
          yield mockChunk3;
        },
      };

      // Mock converter responses
      const mockContentResponse = new GenerateContentResponse();
      mockContentResponse.candidates = [
        { content: { parts: [{ text: 'Hello response' }], role: 'model' } },
      ];

      const mockFinishResponse = new GenerateContentResponse();
      mockFinishResponse.candidates = [
        {
          content: { parts: [], role: 'model' },
          finishReason: FinishReason.STOP,
        },
      ];

      const mockUsageResponse = new GenerateContentResponse();
      mockUsageResponse.candidates = [];
      mockUsageResponse.usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      };

      // Expected merged response (finishReason + usageMetadata combined)
      const mockMergedResponse = new GenerateContentResponse();
      mockMergedResponse.candidates = [
        {
          content: { parts: [], role: 'model' },
          finishReason: FinishReason.STOP,
        },
      ];
      mockMergedResponse.usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock)
        .mockReturnValueOnce(mockContentResponse)
        .mockReturnValueOnce(mockFinishResponse)
        .mockReturnValueOnce(mockUsageResponse);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      // Act
      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }

      // Assert
      expect(results).toHaveLength(2); // Content chunk + merged finish/usage chunk
      expect(results[0]).toBe(mockContentResponse);

      // The last result should have both finishReason and usageMetadata
      const lastResult = results[1];
      expect(lastResult.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(lastResult.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      });
    });

    it('should handle ideal case where last chunk has both finishReason and usageMetadata', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      // Content chunk
      const mockChunk1 = {
        id: 'chunk-1',
        choices: [
          { delta: { content: 'Hello response' }, finish_reason: null },
        ],
      } as OpenAI.Chat.ChatCompletionChunk;

      // Final chunk with both finish_reason and usage (ideal case)
      const mockChunk2 = {
        id: 'chunk-2',
        choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      } as OpenAI.Chat.ChatCompletionChunk;

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield mockChunk1;
          yield mockChunk2;
        },
      };

      // Mock converter responses
      const mockContentResponse = new GenerateContentResponse();
      mockContentResponse.candidates = [
        { content: { parts: [{ text: 'Hello response' }], role: 'model' } },
      ];

      const mockFinalResponse = new GenerateContentResponse();
      mockFinalResponse.candidates = [
        {
          content: { parts: [], role: 'model' },
          finishReason: FinishReason.STOP,
        },
      ];
      mockFinalResponse.usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock)
        .mockReturnValueOnce(mockContentResponse)
        .mockReturnValueOnce(mockFinalResponse);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      // Act
      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }

      // Assert
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(mockContentResponse);
      expect(results[1]).toBe(mockFinalResponse);

      // The last result should have both finishReason and usageMetadata
      const lastResult = results[1];
      expect(lastResult.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(lastResult.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      });
    });

    it('should handle providers that send zero usage in finish chunk (like modelscope)', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      // Content chunk with zero usage (typical for modelscope)
      const mockChunk1 = {
        id: 'chunk-1',
        choices: [
          { delta: { content: 'Hello response' }, finish_reason: null },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as OpenAI.Chat.ChatCompletionChunk;

      // Finish chunk with zero usage (has finishReason but usage is all zeros)
      const mockChunk2 = {
        id: 'chunk-2',
        choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as OpenAI.Chat.ChatCompletionChunk;

      // Final usage chunk with actual usage data
      const mockChunk3 = {
        id: 'chunk-3',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'test-model',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      } as OpenAI.Chat.ChatCompletionChunk;

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield mockChunk1;
          yield mockChunk2;
          yield mockChunk3;
        },
      };

      // Mock converter responses
      const mockContentResponse = new GenerateContentResponse();
      mockContentResponse.candidates = [
        { content: { parts: [{ text: 'Hello response' }], role: 'model' } },
      ];
      // Content chunk has zero usage metadata (should be filtered or ignored)
      mockContentResponse.usageMetadata = {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
      };

      const mockFinishResponseWithZeroUsage = new GenerateContentResponse();
      mockFinishResponseWithZeroUsage.candidates = [
        {
          content: { parts: [], role: 'model' },
          finishReason: FinishReason.STOP,
        },
      ];
      // Finish chunk has zero usage metadata (should be treated as no usage)
      mockFinishResponseWithZeroUsage.usageMetadata = {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
      };

      const mockUsageResponse = new GenerateContentResponse();
      mockUsageResponse.candidates = [];
      mockUsageResponse.usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock)
        .mockReturnValueOnce(mockContentResponse)
        .mockReturnValueOnce(mockFinishResponseWithZeroUsage)
        .mockReturnValueOnce(mockUsageResponse);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      // Act
      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }

      // Assert
      expect(results).toHaveLength(2); // Content chunk + merged finish/usage chunk
      expect(results[0]).toBe(mockContentResponse);

      // The last result should have both finishReason and valid usageMetadata
      const lastResult = results[1];
      expect(lastResult.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(lastResult.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      });
    });

    it('should handle providers that send finishReason and valid usage in same chunk', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      // Content chunk with zero usage
      const mockChunk1 = {
        id: 'chunk-1',
        choices: [
          { delta: { content: 'Hello response' }, finish_reason: null },
        ],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      } as OpenAI.Chat.ChatCompletionChunk;

      // Finish chunk with both finishReason and valid usage in same chunk
      const mockChunk2 = {
        id: 'chunk-2',
        choices: [{ delta: { content: '' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      } as OpenAI.Chat.ChatCompletionChunk;

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield mockChunk1;
          yield mockChunk2;
        },
      };

      // Mock converter responses
      const mockContentResponse = new GenerateContentResponse();
      mockContentResponse.candidates = [
        { content: { parts: [{ text: 'Hello response' }], role: 'model' } },
      ];
      mockContentResponse.usageMetadata = {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0,
      };

      const mockFinalResponse = new GenerateContentResponse();
      mockFinalResponse.candidates = [
        {
          content: { parts: [], role: 'model' },
          finishReason: FinishReason.STOP,
        },
      ];
      mockFinalResponse.usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock)
        .mockReturnValueOnce(mockContentResponse)
        .mockReturnValueOnce(mockFinalResponse);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      // Act
      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }

      // Assert
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(mockContentResponse);
      expect(results[1]).toBe(mockFinalResponse);

      // The last result should have both finishReason and valid usageMetadata
      const lastResult = results[1];
      expect(lastResult.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(lastResult.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      });
    });

    it('should not duplicate function calls when trailing chunks arrive after finish+usage merge', async () => {
      // Reproduces the real-world bug: some providers (e.g. bailian/glm-5)
      // send trailing empty chunks AFTER the finish+usage pair. Before the
      // fix, each trailing chunk re-triggered the merge logic and yielded
      // the finish response again (with the same function-call parts),
      // causing duplicate tool-call execution in the UI.
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      // Chunk 1: content text
      const mockChunk1 = {
        id: 'chunk-1',
        choices: [
          { delta: { content: 'I will create a todo' }, finish_reason: null },
        ],
      } as OpenAI.Chat.ChatCompletionChunk;

      // Chunk 2: finish reason (with tool calls)
      const mockChunk2 = {
        id: 'chunk-2',
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
      } as OpenAI.Chat.ChatCompletionChunk;

      // Chunk 3: usage metadata only
      const mockChunk3 = {
        id: 'chunk-3',
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      // Chunk 4: trailing empty chunk (the problematic one)
      const mockChunk4 = {
        id: 'chunk-4',
        choices: [],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield mockChunk1;
          yield mockChunk2;
          yield mockChunk3;
          yield mockChunk4;
        },
      };

      // Converter output for chunk 1: text content
      const mockContentResponse = new GenerateContentResponse();
      mockContentResponse.candidates = [
        {
          content: {
            parts: [{ text: 'I will create a todo' }],
            role: 'model',
          },
        },
      ];

      // Converter output for chunk 2: finish + function call
      const mockFinishResponse = new GenerateContentResponse();
      mockFinishResponse.candidates = [
        {
          content: {
            parts: [
              {
                functionCall: {
                  name: 'todoWrite',
                  args: { text: 'buy milk' },
                },
              },
            ],
            role: 'model',
          },
          finishReason: FinishReason.STOP,
        },
      ];

      // Converter output for chunk 3: usage only
      const mockUsageResponse = new GenerateContentResponse();
      mockUsageResponse.candidates = [];
      mockUsageResponse.usageMetadata = {
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      };

      // Converter output for chunk 4: trailing empty
      const mockTrailingResponse = new GenerateContentResponse();
      mockTrailingResponse.candidates = [];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock)
        .mockReturnValueOnce(mockContentResponse)
        .mockReturnValueOnce(mockFinishResponse)
        .mockReturnValueOnce(mockUsageResponse)
        .mockReturnValueOnce(mockTrailingResponse);
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      // Act
      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }

      // Assert: exactly 2 results — content chunk + ONE merged finish chunk.
      // Before the fix this was 3 (the trailing chunk triggered a duplicate).
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(mockContentResponse);

      // The merged result should have the function call and usage metadata
      const mergedResult = results[1]!;
      expect(mergedResult.candidates?.[0]?.finishReason).toBe(
        FinishReason.STOP,
      );
      expect(
        mergedResult.candidates?.[0]?.content?.parts?.[0]?.functionCall?.name,
      ).toBe('todoWrite');
      expect(mergedResult.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 20,
        totalTokenCount: 30,
      });

      // Count function-call parts across ALL yielded results — must be exactly 1
      let totalFunctionCalls = 0;
      for (const result of results) {
        const parts = result.candidates?.[0]?.content?.parts ?? [];
        totalFunctionCalls += parts.filter(
          (p: { functionCall?: unknown }) => p.functionCall,
        ).length;
      }
      expect(totalFunctionCalls).toBe(1);
    });
  });

  describe('buildRequest', () => {
    it('should build request with sampling parameters', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: {
          temperature: 0.8,
          topP: 0.7,
          maxOutputTokens: 500,
        },
      };
      const userPromptId = 'test-prompt-id';
      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockOpenAIResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'test',
        choices: [{ message: { content: 'response' } }],
      });

      // Act
      await pipeline.execute(request, userPromptId);

      // Assert
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          messages: mockMessages,
          temperature: 0.7, // Config parameter used since request overrides are not being applied in current implementation
          top_p: 0.9, // Config parameter used since request overrides are not being applied in current implementation
          max_tokens: 1000, // Config parameter used since request overrides are not being applied in current implementation
        }),
        expect.objectContaining({
          signal: undefined,
        }),
      );
    });

    it('should use config sampling parameters when request parameters are not provided', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';
      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockOpenAIResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'test',
        choices: [{ message: { content: 'response' } }],
      });

      // Act
      await pipeline.execute(request, userPromptId);

      // Assert
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7, // From config
          top_p: 0.9, // From config
          max_tokens: 1000, // From config
        }),
        expect.objectContaining({
          signal: undefined,
        }),
      );
    });

    it('should allow provider to enhance request', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';
      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      const mockOpenAIResponse = new GenerateContentResponse();

      // Mock provider enhancement
      (mockProvider.buildRequest as Mock).mockImplementation(
        (req: OpenAI.Chat.ChatCompletionCreateParams, promptId: string) => ({
          ...req,
          metadata: { promptId },
        }),
      );

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockOpenAIResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'test',
        choices: [{ message: { content: 'response' } }],
      });

      // Act
      await pipeline.execute(request, userPromptId);

      // Assert
      expect(mockProvider.buildRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          messages: mockMessages,
        }),
        userPromptId,
      );
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { promptId: userPromptId },
        }),
        expect.objectContaining({
          signal: undefined,
        }),
      );
    });

    it('should pass arbitrary samplingParams keys through verbatim (e.g. max_completion_tokens for GPT-5)', async () => {
      // Arrange: user sets a GPT-5 / o-series shape in samplingParams.
      // None of these are typed fields; all must appear on the wire because
      // samplingParams is the source of truth.
      mockContentGeneratorConfig.samplingParams = {
        max_completion_tokens: 4096,
        reasoning_effort: 'medium',
        verbosity: 'low',
      } as ContentGeneratorConfig['samplingParams'];
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { maxOutputTokens: 999 },
      };
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'test',
        choices: [{ message: { content: 'r' } }],
      });

      // Act
      await pipeline.execute(request, 'prompt-id');

      // Assert: the exact samplingParams keys reach the wire; max_tokens is NOT
      // synthesized from request.config.maxOutputTokens.
      const call = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(call).toMatchObject({
        max_completion_tokens: 4096,
        reasoning_effort: 'medium',
        verbosity: 'low',
      });
      expect(call).not.toHaveProperty('max_tokens');
    });

    it('should preserve historical default behavior when samplingParams is absent', async () => {
      // Arrange: no samplingParams — request.config.maxOutputTokens must still
      // fall through to max_tokens on the wire (original behavior unchanged).
      mockContentGeneratorConfig.samplingParams = undefined;
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { temperature: 0.5, topP: 0.6, maxOutputTokens: 2048 },
      };
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'test',
        choices: [{ message: { content: 'r' } }],
      });

      // Act
      await pipeline.execute(request, 'prompt-id');

      // Assert: identical to upstream behavior for existing users
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.5,
          top_p: 0.6,
          max_tokens: 2048,
        }),
        expect.objectContaining({ signal: undefined }),
      );
    });
  });

  describe('createRequestContext', () => {
    it('should create context with correct properties for non-streaming request', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';
      const mockOpenAIResponse = new GenerateContentResponse();

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockOpenAIResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'test',
        choices: [{ message: { content: 'response' } }],
      });

      // Act
      await pipeline.execute(request, userPromptId);

      // Assert
    });

    it('should create context with correct properties for streaming request', async () => {
      // Arrange
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'chunk-1',
            choices: [{ delta: { content: 'Hello' }, finish_reason: 'stop' }],
          };
        },
      };

      const mockGeminiResponse = new GenerateContentResponse();
      mockGeminiResponse.candidates = [
        { content: { parts: [{ text: 'Hello' }], role: 'model' } },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      // Act
      const resultGenerator = await pipeline.executeStream(
        request,
        userPromptId,
      );
      for await (const _result of resultGenerator) {
        // Consume the stream
      }

      // Assert
    });

    it('should collect all OpenAI chunks for logging even when Gemini responses are filtered', async () => {
      // Create chunks that would produce empty Gemini responses (partial tool calls)
      const partialToolCallChunk1: OpenAI.Chat.ChatCompletionChunk = {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_123',
                  type: 'function',
                  function: { name: 'test_function', arguments: '{"par' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };

      const partialToolCallChunk2: OpenAI.Chat.ChatCompletionChunk = {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'am": "value"}' },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      };

      const finishChunk: OpenAI.Chat.ChatCompletionChunk = {
        id: 'chunk-3',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
          },
        ],
      };

      // Mock empty Gemini responses for partial chunks (they get filtered)
      const emptyGeminiResponse1 = new GenerateContentResponse();
      emptyGeminiResponse1.candidates = [
        {
          content: { parts: [], role: 'model' },
          index: 0,
          safetyRatings: [],
        },
      ];

      const emptyGeminiResponse2 = new GenerateContentResponse();
      emptyGeminiResponse2.candidates = [
        {
          content: { parts: [], role: 'model' },
          index: 0,
          safetyRatings: [],
        },
      ];

      // Mock final Gemini response with tool call
      const finalGeminiResponse = new GenerateContentResponse();
      finalGeminiResponse.candidates = [
        {
          content: {
            parts: [
              {
                functionCall: {
                  id: 'call_123',
                  name: 'test_function',
                  args: { param: 'value' },
                },
              },
            ],
            role: 'model',
          },
          finishReason: FinishReason.STOP,
          index: 0,
          safetyRatings: [],
        },
      ];

      // Setup converter mocks
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'test' },
      ]);
      (mockConverter.convertOpenAIChunkToGemini as Mock)
        .mockReturnValueOnce(emptyGeminiResponse1) // First partial chunk -> empty response
        .mockReturnValueOnce(emptyGeminiResponse2) // Second partial chunk -> empty response
        .mockReturnValueOnce(finalGeminiResponse); // Finish chunk -> complete response

      // Mock stream
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield partialToolCallChunk1;
          yield partialToolCallChunk2;
          yield finishChunk;
        },
      };

      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'test' }] }],
      };

      // Collect responses
      const responses: GenerateContentResponse[] = [];
      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );
      for await (const response of resultGenerator) {
        responses.push(response);
      }

      // Should only yield the final response (empty ones are filtered)
      expect(responses).toHaveLength(1);
      expect(responses[0]).toBe(finalGeminiResponse);
    });
  });

  describe('openaiRequestCaptureContext integration', () => {
    it('forwards the provider-enhanced request to the active capture', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };

      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'r',
        choices: [],
        created: 0,
        model: 'test-model',
      } as unknown as OpenAI.Chat.ChatCompletion);

      // Provider injects extra_body and metadata, mimicking real DashScope behavior.
      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        extra_body: { thinking: { type: 'enabled' } },
        metadata: { user_id: 'abc' },
      }));

      let captured: OpenAI.Chat.ChatCompletionCreateParams | undefined;
      await openaiRequestCaptureContext.run(
        (built) => {
          captured = built;
        },
        () => pipeline.execute(request, 'p'),
      );

      expect(captured).toBeDefined();
      // The captured request must be the same object passed to the SDK.
      expect(mockClient.chat.completions.create).toHaveBeenCalledWith(
        captured,
        expect.anything(),
      );
      expect(captured).toEqual(
        expect.objectContaining({
          model: 'test-model',
          messages: mockMessages,
          extra_body: { thinking: { type: 'enabled' } },
          metadata: { user_id: 'abc' },
        }),
      );
    });

    it('captures the streaming request including stream/stream_options', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };

      const mockMessages = [
        { role: 'user', content: 'Hello' },
      ] as OpenAI.Chat.ChatCompletionMessageParam[];
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );

      const fakeStream = (async function* () {
        // empty stream
      })();
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        fakeStream,
      );

      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        extra_body: { enable_thinking: true },
      }));

      let captured: OpenAI.Chat.ChatCompletionCreateParams | undefined;
      await openaiRequestCaptureContext.run(
        (built) => {
          captured = built;
        },
        async () => {
          const stream = await pipeline.executeStream(request, 'p');
          for await (const _ of stream) {
            // drain
          }
        },
      );

      expect(captured).toBeDefined();
      expect(captured).toEqual(
        expect.objectContaining({
          stream: true,
          stream_options: { include_usage: true },
          extra_body: { enable_thinking: true },
        }),
      );
    });

    it('isolates concurrent captures', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'r',
        choices: [],
        created: 0,
        model: 'test-model',
      } as unknown as OpenAI.Chat.ChatCompletion);

      let n = 0;
      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        extra_body: { call_index: ++n },
      }));

      const runOne = async () => {
        let captured: OpenAI.Chat.ChatCompletionCreateParams | undefined;
        await openaiRequestCaptureContext.run(
          (built) => {
            captured = built;
          },
          () => pipeline.execute(request, 'p'),
        );
        return captured;
      };

      const [a, b] = await Promise.all([runOne(), runOne()]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // Each call's capture must have received its own object —
      // the outer AsyncLocalStorage stores must not bleed across awaits.
      const aExtra = (a as unknown as { extra_body: { call_index: number } })
        .extra_body;
      const bExtra = (b as unknown as { extra_body: { call_index: number } })
        .extra_body;
      expect(aExtra).not.toEqual(bExtra);
    });
  });
});

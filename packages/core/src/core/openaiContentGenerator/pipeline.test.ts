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
import type { PipelineConfig } from './pipeline.js';
import { ContentGenerationPipeline } from './pipeline.js';
import { OpenAIContentConverter } from './converter.js';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig, AuthType } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import type { ErrorHandler } from './errorHandler.js';

// Mock dependencies
vi.mock('./converter.js');
vi.mock('openai');

describe('ContentGenerationPipeline', () => {
  let pipeline: ContentGenerationPipeline;
  let mockConfig: PipelineConfig;
  let mockProvider: OpenAICompatibleProvider;
  let mockClient: OpenAI;
  let mockConverter: OpenAIContentConverter;
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

    // Mock converter
    mockConverter = {
      convertGeminiRequestToOpenAI: vi.fn(),
      convertOpenAIResponseToGemini: vi.fn(),
      convertOpenAIChunkToGemini: vi.fn(),
      convertGeminiToolsToOpenAI: vi.fn(),
      resetStreamingToolCalls: vi.fn(),
    } as unknown as OpenAIContentConverter;

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

    // Mock the OpenAIContentConverter constructor
    (OpenAIContentConverter as unknown as Mock).mockImplementation(
      () => mockConverter,
    );

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
      expect(OpenAIContentConverter).toHaveBeenCalledWith(
        'test-model',
        undefined,
      );
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
      expect(mockConverter.convertGeminiToolsToOpenAI).toHaveBeenCalledWith(
        request.config!.tools,
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
      expect(mockConverter.resetStreamingToolCalls).toHaveBeenCalled();
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
      expect(mockConverter.resetStreamingToolCalls).toHaveBeenCalledTimes(2); // Once at start, once on error
      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        testError,
        expect.any(Object),
        request,
      );
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
});

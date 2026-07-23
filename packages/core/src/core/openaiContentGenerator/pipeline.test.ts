/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type OpenAI from 'openai';
import type { GenerateContentParameters } from '@google/genai';
import {
  FinishReason,
  FunctionCallingConfigMode,
  GenerateContentResponse,
  Type,
} from '@google/genai';
import type { ErrorHandler, PipelineConfig } from './types.js';
import {
  ContentGenerationPipeline,
  NonSSEResponseError,
  StreamContentError,
  StreamInactivityTimeoutError,
} from './pipeline.js';
import { OpenAIContentConverter } from './converter.js';
import { openaiRequestCaptureContext } from './requestCaptureContext.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';
import type { Config } from '../../config/config.js';
import { AuthType, type ContentGeneratorConfig } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import { DefaultOpenAICompatibleProvider } from './provider/default.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MAX_STREAM_IDLE_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
} from './constants.js';
import { logProtocolTagSanitized } from '../../telemetry/loggers.js';
import { setToolCallPreparations } from '../tool-call-preparation.js';

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
vi.mock('../../telemetry/loggers.js', () => ({
  logProtocolTagSanitized: vi.fn(),
}));

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
          stream: false,
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

    it('should apply provider request context overrides', async () => {
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
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      mockProvider.getRequestContextOverrides = vi.fn().mockReturnValue({
        splitToolMedia: true,
      });
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      await pipeline.execute(request, userPromptId);

      expect(mockConverter.convertGeminiRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          splitToolMedia: true,
        }),
      );
    });

    it('should let provider request context overrides take precedence over content generator config', async () => {
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
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      mockContentGeneratorConfig.splitToolMedia = true;
      mockProvider.getRequestContextOverrides = vi.fn().mockReturnValue({
        splitToolMedia: false,
      });
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      await pipeline.execute(request, userPromptId);

      expect(mockConverter.convertGeminiRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          splitToolMedia: false,
        }),
      );
    });

    it('should default splitToolMedia to true when neither provider override nor content generator config sets it (issue #4876)', async () => {
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
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      // Neither the provider nor the content generator config sets
      // splitToolMedia — it must default to true so tool-returned images are
      // moved out of the spec-violating `role: "tool"` message (#4876).
      mockProvider.getRequestContextOverrides = vi.fn().mockReturnValue({});
      mockContentGeneratorConfig.splitToolMedia = undefined;
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      await pipeline.execute(request, userPromptId);

      expect(mockConverter.convertGeminiRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          splitToolMedia: true,
        }),
      );
    });

    it('should pass configured tool result content format to the converter', async () => {
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
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      mockProvider.getRequestContextOverrides = vi.fn().mockReturnValue({});
      mockContentGeneratorConfig.toolResultContentFormat = 'string';
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      await pipeline.execute(request, userPromptId);

      expect(mockConverter.convertGeminiRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          toolResultContentFormat: 'string',
        }),
      );
    });

    it('should let provider tool result content format overrides take precedence', async () => {
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
      } as OpenAI.Chat.ChatCompletion;
      const mockGeminiResponse = new GenerateContentResponse();

      mockContentGeneratorConfig.toolResultContentFormat = 'parts';
      mockProvider.getRequestContextOverrides = vi.fn().mockReturnValue({
        toolResultContentFormat: 'string',
      });
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
        mockMessages,
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockOpenAIResponse,
      );

      await pipeline.execute(request, userPromptId);

      expect(mockConverter.convertGeminiRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          toolResultContentFormat: 'string',
        }),
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
      // Arrange — provider injects enable_thinking: true via extra_body
      // (e.g. user configured `enableThinking: true` via setup wizard,
      // see provider-config.ts), but request explicitly disables thinking.
      // DashScope hostname + qwen model name are both required: the gate
      // is hostname + model-name to avoid leaking the qwen-specific
      // `enable_thinking` field to non-qwen routings (off-DashScope, or
      // GLM/DeepSeek on the same DashScope hostname).
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.5-flash',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        enable_thinking: true, // Simulates extra_body injection
      }));

      const request: GenerateContentParameters = {
        model: 'qwen3.5-flash',
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

    it.each([
      {
        name: 'keep thinking for a thinkingMandatory model on Token Plan side queries',
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max-preview',
        extraBody: { enable_thinking: true },
        thinkingMandatory: true,
        reasoning: undefined,
        includeThoughts: false,
        expectedThinking: true,
        expectedToolChoice: undefined,
      },
      {
        name: 'apply thinkingMandatory to any qwen model on any DashScope endpoint',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.9-turbo',
        extraBody: { enable_thinking: true },
        thinkingMandatory: true,
        reasoning: undefined,
        includeThoughts: false,
        expectedThinking: true,
        expectedToolChoice: undefined,
      },
      {
        name: 'never emit the disable even under the reasoning opt-out',
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max-preview',
        extraBody: { enable_thinking: true },
        thinkingMandatory: true,
        reasoning: false,
        includeThoughts: false,
        expectedThinking: true,
        expectedToolChoice: undefined,
      },
      {
        name: 'still force-disable hybrid models that only declare extra_body.enable_thinking',
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.7-max',
        extraBody: { enable_thinking: true },
        thinkingMandatory: undefined,
        reasoning: undefined,
        includeThoughts: false,
        expectedThinking: false,
        expectedToolChoice: 'required',
      },
      {
        name: 'allow automatic tool selection when mandatory thinking stays on',
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max-preview',
        extraBody: { enable_thinking: true },
        thinkingMandatory: true,
        reasoning: undefined,
        includeThoughts: true,
        expectedThinking: true,
        expectedToolChoice: undefined,
      },
      {
        name: 'not inherit mandatory thinking through request.model overrides',
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max-preview',
        requestModel: 'qwen3.7-max',
        extraBody: { enable_thinking: true },
        thinkingMandatory: true,
        reasoning: undefined,
        includeThoughts: false,
        expectedThinking: false,
        expectedToolChoice: 'required',
      },
      {
        name: 'drop a contradictory thinking disable for aliased mandatory models',
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'token-plan-model-alias',
        extraBody: { enable_thinking: false },
        thinkingMandatory: true,
        reasoning: undefined,
        includeThoughts: false,
        expectedThinking: undefined,
        expectedToolChoice: undefined,
      },
    ])('should $name', async (testCase) => {
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: testCase.baseUrl,
        model: testCase.model,
        extra_body: testCase.extraBody,
        thinkingMandatory: testCase.thinkingMandatory,
        reasoning: testCase.reasoning,
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      // Simulate the provider merging user extra_body last (see dashscope.ts).
      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        ...(testCase.extraBody ?? {}),
      }));

      const request: GenerateContentParameters = {
        model:
          ('requestModel' in testCase ? testCase.requestModel : undefined) ??
          testCase.model,
        contents: [{ parts: [{ text: 'Summarize' }], role: 'user' }],
        config: {
          thinkingConfig: { includeThoughts: testCase.includeThoughts },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'respond_in_schema',
                  parameters: { type: Type.OBJECT, properties: {} },
                },
              ],
            },
          ],
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
          },
        },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Summarize' },
      ]);
      (mockConverter.convertGeminiToolsToOpenAI as Mock).mockResolvedValue([
        { type: 'function', function: { name: 'respond_in_schema' } },
      ]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue({
        id: 'r',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
      } as OpenAI.Chat.ChatCompletion);

      await pipeline.execute(request, 'side-query:permissions-classifier');

      const apiCall = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(apiCall.enable_thinking).toBe(testCase.expectedThinking);
      expect(apiCall.tool_choice).toBe(testCase.expectedToolChoice);
    });

    it('learns required thinking from a provider error and retries once', async () => {
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max-preview',
        extra_body: { enable_thinking: true },
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        enable_thinking: true,
      }));
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'What is 2+2?' },
      ]);
      (mockConverter.convertGeminiToolsToOpenAI as Mock).mockResolvedValue([
        { type: 'function', function: { name: 'respond_in_schema' } },
      ]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );

      const requiredThinkingError = Object.assign(
        new Error(
          'The value of the enable_thinking parameter is restricted to True.',
        ),
        { status: 400 },
      );
      (mockClient.chat.completions.create as Mock)
        .mockRejectedValueOnce(requiredThinkingError)
        .mockResolvedValue({
          id: 'r',
          choices: [{ message: { content: '4' }, finish_reason: 'stop' }],
        } as OpenAI.Chat.ChatCompletion);

      const request: GenerateContentParameters = {
        model: 'qwen3.8-max-preview',
        contents: [{ parts: [{ text: 'What is 2+2?' }], role: 'user' }],
        config: {
          thinkingConfig: { includeThoughts: false },
          tools: [
            {
              functionDeclarations: [
                {
                  name: 'respond_in_schema',
                  parameters: { type: Type.OBJECT, properties: {} },
                },
              ],
            },
          ],
          toolConfig: {
            functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
          },
        },
      };

      await pipeline.execute(request, 'forked_query');
      await pipeline.execute(request, 'forked_query');

      const calls = (mockClient.chat.completions.create as Mock).mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls[0][0]).toMatchObject({
        enable_thinking: false,
        tool_choice: 'required',
      });
      expect(calls[1][0].enable_thinking).toBe(true);
      expect(calls[1][0].tool_choice).toBeUndefined();
      expect(calls[2][0].enable_thinking).toBe(true);
      expect(calls[2][0].tool_choice).toBeUndefined();
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('retries without provider-configured thinking opt-outs on non-DashScope endpoints', async () => {
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://llm.example.com/v1',
        model: 'Qwen3.6-27B',
        extra_body: {
          enable_thinking: false,
          chat_template_kwargs: {
            apply_chat_template: true,
            enable_thinking: false,
          },
        },
      } as ContentGeneratorConfig;
      const provider = new DefaultOpenAICompatibleProvider(
        mockContentGeneratorConfig,
        mockCliConfig,
      );
      vi.spyOn(provider, 'buildClient').mockReturnValue(mockClient);
      pipeline = new ContentGenerationPipeline({
        ...mockConfig,
        provider,
        contentGeneratorConfig: mockContentGeneratorConfig,
      });

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'What is 2+2?' },
      ]);
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );

      const requiredThinkingError = Object.assign(
        new Error('enable_thinking must be true for this model'),
        { status: 400 },
      );
      (mockClient.chat.completions.create as Mock)
        .mockRejectedValueOnce(requiredThinkingError)
        .mockResolvedValue({
          id: 'r',
          choices: [{ message: { content: '4' }, finish_reason: 'stop' }],
        } as OpenAI.Chat.ChatCompletion);

      await pipeline.execute(
        {
          model: 'Qwen3.6-27B',
          contents: [{ parts: [{ text: 'What is 2+2?' }], role: 'user' }],
          config: { thinkingConfig: { includeThoughts: false } },
        },
        'forked_query',
      );

      const calls = (mockClient.chat.completions.create as Mock).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].chat_template_kwargs).toEqual({
        apply_chat_template: true,
        enable_thinking: false,
      });
      expect(calls[0][0].enable_thinking).toBeUndefined();
      expect(calls[1][0].chat_template_kwargs).toEqual({
        apply_chat_template: true,
      });
      expect(calls[1][0].enable_thinking).toBeUndefined();
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('handles the retry error when required-thinking retry fails', async () => {
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max-preview',
        extra_body: { enable_thinking: true },
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        enable_thinking: true,
      }));
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'What is 2+2?' },
      ]);

      const requiredThinkingError = Object.assign(
        new Error(
          'The value of the enable_thinking parameter is restricted to True.',
        ),
        { status: 400 },
      );
      const retryError = new Error('retry failed');
      (mockClient.chat.completions.create as Mock)
        .mockRejectedValueOnce(requiredThinkingError)
        .mockRejectedValueOnce(retryError);

      const request: GenerateContentParameters = {
        model: 'qwen3.8-max-preview',
        contents: [{ parts: [{ text: 'What is 2+2?' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      await expect(pipeline.execute(request, 'forked_query')).rejects.toBe(
        retryError,
      );
      expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(2);
      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        retryError,
        expect.any(Object),
        request,
      );
    });

    it('does not retry an unrelated 400 error', async () => {
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max-preview',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Hello' },
      ]);
      const error = Object.assign(new Error('Invalid request parameter.'), {
        status: 400,
      });
      (mockClient.chat.completions.create as Mock).mockRejectedValue(error);

      await expect(
        pipeline.execute(
          {
            model: 'qwen3.8-max-preview',
            contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
            config: { thinkingConfig: { includeThoughts: false } },
          },
          'forked_query',
        ),
      ).rejects.toBe(error);
      expect(mockClient.chat.completions.create).toHaveBeenCalledTimes(1);
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

    it('emits enable_thinking:false on DashScope hostname when includeThoughts is false', async () => {
      // Regression for #4501: qwen3 hybrid models (e.g. qwen3.5-flash)
      // default to thinking-on. Provider buildRequest never auto-injects
      // `enable_thinking`, so a previous guarded `'enable_thinking' in typed`
      // check never fired and side-queries burned reasoning tokens (24-95x
      // output bloat in production). The disable must be emitted explicitly.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.5-flash',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      // Provider passes the request through unchanged — simulates the
      // common case where the user has not configured
      // `extra_body.enable_thinking` (so the field never appears on the
      // wire body unless we add it here).
      const request: GenerateContentParameters = {
        model: 'qwen3.5-flash',
        contents: [{ parts: [{ text: 'Summarize' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Summarize' },
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
      expect(apiCall.enable_thinking).toBe(false);
    });

    it('emits enable_thinking:false on DashScope hostname when reasoning is configured to false', async () => {
      // Config-level opt-out (`reasoning: false`) should also disable
      // qwen3 thinking, mirroring the DeepSeek pair above.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.5-flash',
        reasoning: false,
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'qwen3.5-flash',
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
      expect(apiCall.enable_thinking).toBe(false);
    });

    it('emits enable_thinking:false on QWEN_OAUTH with the default coder-model', async () => {
      // QWEN_OAUTH is the default auth flow for first-time users and
      // ships with `model: 'coder-model'` (DEFAULT_QWEN_MODEL in
      // config/models.ts — aliased to Qwen 3.6 Plus hybrid). The string
      // doesn't start with `qwen`, so the gate must special-case it;
      // otherwise the exact regression that #4501 fixes (side-queries
      // burning reasoning tokens on the default flow) remains live.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        authType: AuthType.QWEN_OAUTH,
        baseUrl: 'https://some-oauth-issued-endpoint.example/v1',
        model: 'coder-model',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'coder-model',
        contents: [{ parts: [{ text: 'Hi' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Hi' },
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
      expect(apiCall.enable_thinking).toBe(false);
    });

    it('emits enable_thinking:false on internal alibaba-inc.com hostname', async () => {
      // Internal Alibaba domains proxy to DashScope-compatible APIs and
      // are treated as DashScope by design (provider/dashscope.ts:75-78).
      // Cover the internal-origin path explicitly so a future tightening
      // of the hostname rules does not silently drop coverage for
      // internal users.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://gateway.alibaba-inc.com/v1',
        model: 'qwen3.5-flash',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'qwen3.5-flash',
        contents: [{ parts: [{ text: 'Hi' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Hi' },
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
      expect(apiCall.enable_thinking).toBe(false);
    });

    it('does NOT emit enable_thinking on a non-DashScope hostname', async () => {
      // `enable_thinking` is a qwen-specific extension. Pushing it at a
      // strict OpenAI-compatible backend could trip an unknown-key 400
      // and would also pollute logs with a meaningless field. Mirror of
      // the DeepSeek negative test above.
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
      expect(apiCall.enable_thinking).toBeUndefined();
    });

    it('disables qwen thinking via chat_template_kwargs on a non-DashScope endpoint (vLLM/SGLang)', async () => {
      // Self-hosted OpenAI-compatible servers render the chat template
      // server-side and read the thinking switch from `chat_template_kwargs`,
      // silently ignoring a top-level `enable_thinking`. A qwen model on such
      // an endpoint must therefore get the switch nested, not top-level — and
      // any top-level `enable_thinking: true` a provider preset injected via
      // extra_body must be stripped so it can't contradict the opt-out.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://llm.example.com/v1',
        model: 'Qwen3.6-27B',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        enable_thinking: true, // Simulates extra_body injection
      }));

      const request: GenerateContentParameters = {
        model: 'Qwen3.6-27B',
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
      expect(apiCall.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(apiCall.enable_thinking).toBeUndefined();
    });

    it('disables coder-model thinking via chat_template_kwargs on a non-DashScope endpoint', async () => {
      // `coder-model` is the QWEN_OAUTH default, but a user can point it at a
      // self-hosted endpoint. The `model === 'coder-model'` arm must reach the
      // non-DashScope chat_template_kwargs path just like a `qwen*` model.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://llm.example.com/v1',
        model: 'coder-model',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'coder-model',
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
      expect(apiCall.chat_template_kwargs).toEqual({ enable_thinking: false });
      expect(apiCall.enable_thinking).toBeUndefined();
    });

    it('merges enable_thinking into pre-existing chat_template_kwargs on a non-DashScope endpoint', async () => {
      // The non-DashScope path spreads any existing `chat_template_kwargs`
      // before appending `enable_thinking: false`. Guard the merge so a future
      // refactor can't silently drop user-configured kwargs.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://llm.example.com/v1',
        model: 'Qwen3.6-27B',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        chat_template_kwargs: { apply_chat_template: true },
      }));

      const request: GenerateContentParameters = {
        model: 'Qwen3.6-27B',
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
      expect(apiCall.chat_template_kwargs).toEqual({
        apply_chat_template: true,
        enable_thinking: false,
      });
    });

    it('does NOT emit enable_thinking on a non-qwen model routed through DashScope', async () => {
      // DashScope's compatible-mode endpoint routes multiple model families
      // (qwen3, GLM, DeepSeek). Hostname alone is not enough — GLM uses
      // `extra_body.thinking.enabled` and DeepSeek-on-DashScope uses
      // `thinking: { type: 'disabled' }`, so sending `enable_thinking` is
      // at best a no-op and at worst forwarded upstream and rejected.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'glm-5',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'glm-5',
        contents: [{ parts: [{ text: 'Summarize' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Summarize' },
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
      expect(apiCall.enable_thinking).toBeUndefined();
    });

    it('gates on the wire model, not config: qwen config + non-qwen request.model does NOT emit', async () => {
      // buildRequest ships `context.model` (= request.model || config.model).
      // A qwen *config* with a non-qwen *request* model must gate on the
      // request model — otherwise the qwen-only field leaks to the non-qwen
      // routing that is actually on the wire (e.g. GLM rejecting it upstream).
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.5-flash',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'glm-5', // request-level override to a non-qwen wire model
        contents: [{ parts: [{ text: 'Summarize' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Summarize' },
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
      expect(apiCall.enable_thinking).toBeUndefined();
    });

    it('gates on the wire model, not config: non-qwen config + qwen request.model emits false', async () => {
      // The mirror direction: a non-qwen *config* with a qwen *request* model
      // must still emit the disable signal, since the wire model is qwen and
      // would otherwise keep thinking-on (the #4501 regression).
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        model: 'glm-5',
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'qwen3.5-flash', // request-level override to a qwen wire model
        contents: [{ parts: [{ text: 'Summarize' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Summarize' },
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
      expect(apiCall.enable_thinking).toBe(false);
    });

    it('emits enable_thinking:false when baseUrl is unset (DashScope default)', async () => {
      // `isDashScopeProvider` treats a missing baseUrl as DashScope
      // (`dashscope.ts:49` returns true for `!baseUrl`). A fresh install
      // that hasn't run the setup wizard hits this path. All other
      // positive tests above explicitly set baseUrl, so pin this
      // implicit-default branch separately to detect future tightening
      // of the `!baseUrl` early-return.
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        model: 'qwen3.5-flash',
      } as ContentGeneratorConfig;
      delete (mockContentGeneratorConfig as { baseUrl?: string }).baseUrl;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'qwen3.5-flash',
        contents: [{ parts: [{ text: 'Summarize' }], role: 'user' }],
        config: { thinkingConfig: { includeThoughts: false } },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'Summarize' },
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
      expect(apiCall.enable_thinking).toBe(false);
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

      // The pipeline wraps the caller's signal in a per-request child
      // to isolate OpenAI SDK listener leaks, so the SDK receives a
      // child AbortSignal, not the original.
      const call = (mockClient.chat.completions.create as Mock).mock.calls[0];
      const sdkSignal = call[1]?.signal;
      expect(sdkSignal).toBeInstanceOf(AbortSignal);
      expect(sdkSignal).not.toBe(abortController.signal);
    });

    it('should propagate parent abort to SDK child signal', async () => {
      const abortController = new AbortController();
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { abortSignal: abortController.signal },
      };

      let capturedSignal: AbortSignal | undefined;
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockImplementation(
        (_req: unknown, opts: { signal: AbortSignal }) => {
          capturedSignal = opts.signal;
          abortController.abort();
          return { choices: [{ message: { content: 'ok' } }] };
        },
      );
      (mockConverter.convertOpenAIResponseToGemini as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );

      await pipeline.execute(request, 'test-id');
      expect(capturedSignal!.aborted).toBe(true);
    });
  });

  describe('executeStream', () => {
    it('retries stream creation when the provider requires thinking', async () => {
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl:
          'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-max-preview',
        extra_body: { enable_thinking: true },
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      pipeline = new ContentGenerationPipeline(mockConfig);

      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        enable_thinking: true,
      }));
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);

      const requiredThinkingError = Object.assign(
        new Error(
          'The value of the enable_thinking parameter is restricted to True.',
        ),
        { status: 400 },
      );
      const stream = {
        async *[Symbol.asyncIterator]() {
          // Empty response is sufficient: this test covers stream creation.
        },
      };
      const failedCreate = Object.assign(Promise.resolve(stream), {
        withResponse: () => Promise.reject(requiredThinkingError),
      });
      const successfulCreate = Object.assign(Promise.resolve(stream), {
        withResponse: () =>
          Promise.resolve({
            data: stream,
            response: new Response(null, {
              headers: { 'content-type': 'text/event-stream' },
            }),
            request_id: 'retry-success',
          }),
      });
      (mockClient.chat.completions.create as Mock)
        .mockReturnValueOnce(failedCreate)
        .mockReturnValueOnce(successfulCreate);

      const result = await pipeline.executeStream(
        {
          model: 'qwen3.8-max-preview',
          contents: [{ parts: [{ text: 'Quick question' }], role: 'user' }],
          config: { thinkingConfig: { includeThoughts: false } },
        },
        'forked_query',
      );
      for await (const _ of result) {
        // Drain the retried stream.
      }

      const calls = (mockClient.chat.completions.create as Mock).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].enable_thinking).toBe(false);
      expect(calls[1][0].enable_thinking).toBe(true);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

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
      mockProvider.getResponseParsingOptions = vi.fn().mockReturnValue({
        contentOnlyThinkingTagLeaks: true,
      });
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
          responseParsingOptions: { contentOnlyThinkingTagLeaks: true },
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
          signal: expect.any(AbortSignal),
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

    it('rejects an unresolved thinking-tag candidate at clean stream EOF', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'response-id',
            choices: [{ delta: { content: '</think>' }, finish_reason: null }],
          } as OpenAI.Chat.ChatCompletionChunk;
        },
      };
      const emptyResponse = new GenerateContentResponse();
      emptyResponse.candidates = [
        { content: { parts: [], role: 'model' }, index: 0 },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
        (_chunk, context) => {
          context.pendingThinkingTagCandidate = {
            text: '</think>',
            closingTagName: 'think',
          };
          return emptyResponse;
        },
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );

      await expect(async () => {
        for await (const _ of resultGenerator) {
          // Consume until EOF validation runs.
        }
      }).rejects.toMatchObject({ type: 'PROTOCOL_TAG_LEAK' });
      expect(logProtocolTagSanitized).not.toHaveBeenCalled();
    });

    it('allows a whitespace-only tag candidate at clean stream EOF', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'response-id',
            choices: [{ delta: { content: ' ' }, finish_reason: null }],
          } as OpenAI.Chat.ChatCompletionChunk;
        },
      };
      const emptyResponse = new GenerateContentResponse();
      emptyResponse.candidates = [
        { content: { parts: [], role: 'model' }, index: 0 },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
        (_chunk, context) => {
          context.pendingThinkingTagCandidate = { text: ' ' };
          return emptyResponse;
        },
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );
      const results = [];
      for await (const result of resultGenerator) results.push(result);

      expect(results).toEqual([]);
    });

    it('flushes held response parts for a whitespace-only candidate at clean EOF', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'response-id',
            choices: [{ delta: { content: ' ' }, finish_reason: null }],
          } as OpenAI.Chat.ChatCompletionChunk;
        },
      };
      const emptyResponse = new GenerateContentResponse();
      emptyResponse.candidates = [
        { content: { parts: [], role: 'model' }, index: 0 },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
        (_chunk, context) => {
          context.pendingThinkingTagCandidate = { text: ' ' };
          context.pendingUntrustedResponseParts = [
            { thought: true, text: 'reasoning' },
          ];
          return emptyResponse;
        },
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );
      const results = [];
      for await (const result of resultGenerator) results.push(result);

      expect(results).toHaveLength(1);
      expect(results[0]?.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'reasoning' },
      ]);
    });

    it('does not log protocol-tag sanitization before a held finish is yielded', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const streamError = new Error('stream failed after finish');
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'finish-chunk',
            choices: [{ delta: {}, finish_reason: 'tool_calls' }],
          } as OpenAI.Chat.ChatCompletionChunk;
          throw streamError;
        },
      };
      const finishResponse = new GenerateContentResponse();
      finishResponse.responseId = 'finish-response';
      finishResponse.candidates = [
        {
          content: { parts: [{ functionCall: { name: 'read_file' } }] },
          finishReason: FinishReason.STOP,
          index: 0,
        },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
        (_chunk, context) => {
          context.protocolTagSanitized = {
            tagName: 'think',
            toolCallCount: 1,
          };
          return finishResponse;
        },
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );

      await expect(async () => {
        for await (const _ of resultGenerator) {
          // Consume until the stream error after the held finish.
        }
      }).rejects.toThrow(streamError);
      expect(logProtocolTagSanitized).not.toHaveBeenCalled();
    });

    it('logs only the accepted finish after duplicate and empty trailing chunks', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const chunks = ['finish-1', 'finish-2', 'trailing-empty'].map(
        (id) =>
          ({
            id,
            choices: [{ delta: {}, finish_reason: null }],
          }) as OpenAI.Chat.ChatCompletionChunk,
      );
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield* chunks;
        },
      };
      const makeFinishResponse = (responseId: string, callId: string) => {
        const response = new GenerateContentResponse();
        response.responseId = responseId;
        response.candidates = [
          {
            content: {
              parts: [{ functionCall: { id: callId, name: 'read_file' } }],
            },
            finishReason: FinishReason.STOP,
            index: 0,
          },
        ];
        return response;
      };
      const firstFinish = makeFinishResponse('finish-1', 'call-1');
      const secondFinish = makeFinishResponse('finish-2', 'call-2');
      const emptyResponse = new GenerateContentResponse();
      emptyResponse.candidates = [
        { content: { parts: [], role: 'model' }, index: 0 },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
        (chunk, context) => {
          if (chunk.id === 'finish-1') {
            context.protocolTagSanitized = {
              tagName: 'think',
              toolCallCount: 1,
            };
            return firstFinish;
          }
          if (chunk.id === 'finish-2') {
            context.protocolTagSanitized = {
              tagName: 'thinking',
              toolCallCount: 2,
            };
            return secondFinish;
          }
          return emptyResponse;
        },
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );
      const results = [];
      for await (const result of resultGenerator) results.push(result);

      expect(results).toEqual([firstFinish]);
      expect(logProtocolTagSanitized).toHaveBeenCalledTimes(1);
      expect(logProtocolTagSanitized).toHaveBeenCalledWith(
        mockCliConfig,
        expect.objectContaining({
          response_id: 'finish-1',
          tag_name: 'think',
          tool_call_count: 1,
        }),
      );
    });

    it('does not attribute sanitization from a discarded duplicate finish', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const chunks = ['finish-1', 'finish-2', 'usage'].map(
        (id) =>
          ({
            id,
            choices: [{ delta: {}, finish_reason: null }],
          }) as OpenAI.Chat.ChatCompletionChunk,
      );
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield* chunks;
        },
      };
      const makeFinishResponse = (responseId: string) => {
        const response = new GenerateContentResponse();
        response.responseId = responseId;
        response.candidates = [
          {
            content: { parts: [{ functionCall: { name: 'read_file' } }] },
            finishReason: FinishReason.STOP,
            index: 0,
          },
        ];
        return response;
      };
      const firstFinish = makeFinishResponse('finish-1');
      const secondFinish = makeFinishResponse('finish-2');
      const usageResponse = new GenerateContentResponse();
      usageResponse.usageMetadata = { totalTokenCount: 1 };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
        (chunk, context) => {
          if (chunk.id === 'finish-1') return firstFinish;
          if (chunk.id === 'finish-2') {
            context.protocolTagSanitized = {
              tagName: 'think',
              toolCallCount: 1,
            };
            return secondFinish;
          }
          return usageResponse;
        },
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );
      for await (const _ of resultGenerator) {
        // Consume the merged finish response.
      }

      expect(logProtocolTagSanitized).not.toHaveBeenCalled();
    });

    it('rejects visible content after a sanitized finish', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const chunks = ['finish', 'trailing-content'].map(
        (id) =>
          ({
            id,
            choices: [{ delta: {}, finish_reason: null }],
          }) as OpenAI.Chat.ChatCompletionChunk,
      );
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield* chunks;
        },
      };
      const finishResponse = new GenerateContentResponse();
      finishResponse.responseId = 'finish';
      finishResponse.candidates = [
        {
          content: { parts: [{ functionCall: { name: 'read_file' } }] },
          finishReason: FinishReason.STOP,
          index: 0,
        },
      ];
      const trailingResponse = new GenerateContentResponse();
      trailingResponse.candidates = [
        {
          content: { parts: [{ text: 'unexpected' }], role: 'model' },
          index: 0,
        },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
        (chunk, context) => {
          if (chunk.id === 'finish') {
            context.protocolTagSanitized = {
              tagName: 'think',
              toolCallCount: 1,
            };
            return finishResponse;
          }
          return trailingResponse;
        },
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );

      await expect(async () => {
        for await (const _ of resultGenerator) {
          // Consume until trailing content validation runs.
        }
      }).rejects.toMatchObject({ type: 'PROTOCOL_TAG_LEAK' });
      expect(logProtocolTagSanitized).not.toHaveBeenCalled();
    });

    it.each(['transport error', 'explicit abort'] as const)(
      'handles a pending closing tag on %s',
      async (termination) => {
        const abortController = new AbortController();
        const streamError = new Error(
          termination === 'explicit abort' ? 'Aborted' : 'socket reset',
        ) as Error & { code?: string };
        if (termination === 'explicit abort') {
          streamError.name = 'AbortError';
        } else {
          streamError.code = 'ECONNRESET';
        }
        const request: GenerateContentParameters = {
          model: 'test-model',
          contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
          config: { abortSignal: abortController.signal },
        };
        const mockStream = {
          async *[Symbol.asyncIterator]() {
            yield {
              id: 'pending-tag',
              choices: [{ delta: {}, finish_reason: null }],
            } as OpenAI.Chat.ChatCompletionChunk;
            if (termination === 'explicit abort') abortController.abort();
            throw streamError;
          },
        };
        const reasoningResponse = new GenerateContentResponse();
        reasoningResponse.candidates = [
          {
            content: {
              parts: [{ thought: true, text: 'reasoning' }],
              role: 'model',
            },
            index: 0,
          },
        ];

        (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue(
          [],
        );
        (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
          (_chunk, context) => {
            context.pendingThinkingTagCandidate = {
              text: '</think>',
              closingTagName: 'think',
            };
            return reasoningResponse;
          },
        );
        (mockClient.chat.completions.create as Mock).mockResolvedValue(
          mockStream,
        );

        const resultGenerator = await pipeline.executeStream(
          request,
          'test-prompt-id',
        );
        const results = [];
        let caught: unknown;
        try {
          for await (const result of resultGenerator) results.push(result);
        } catch (error) {
          caught = error;
        }

        expect(results).toEqual([reasoningResponse]);
        if (termination === 'explicit abort') {
          expect(caught).toBe(streamError);
        } else {
          expect(caught).toMatchObject({ type: 'PROTOCOL_TAG_LEAK' });
        }
      },
    );

    it('preserves a StreamContentError while a closing tag is pending', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'pending-tag',
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: 'test-model',
            choices: [{ index: 0, delta: {}, finish_reason: null }],
          } as OpenAI.Chat.ChatCompletionChunk;
          yield {
            id: 'error',
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
      const emptyResponse = new GenerateContentResponse();
      emptyResponse.candidates = [
        { content: { parts: [], role: 'model' }, index: 0 },
      ];

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
        (_chunk, context) => {
          context.pendingThinkingTagCandidate = {
            text: '</think>',
            closingTagName: 'think',
          };
          return emptyResponse;
        },
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );

      await expect(async () => {
        for await (const _ of resultGenerator) {
          // Consume until the provider error is raised.
        }
      }).rejects.toThrow(StreamContentError);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('should preserve an otherwise empty response with tool preparation metadata', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const mockChunk = {
        id: 'chunk-tool-opener',
        choices: [{ delta: { tool_calls: [] }, finish_reason: null }],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield mockChunk;
        },
      };
      const preparationResponse = new GenerateContentResponse();
      preparationResponse.candidates = [
        { content: { parts: [], role: 'model' } },
      ];
      setToolCallPreparations(preparationResponse, [
        { callId: 'call-1', toolName: 'read_file' },
      ]);

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockReturnValue(
        preparationResponse,
      );
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(
        request,
        'test-prompt-id',
      );
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }

      expect(results).toEqual([preparationResponse]);
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
      // The error propagates to the consumer via the async generator;
      // errorHandler.handle() is also called internally by the pipeline.
      const results = [];
      let caughtError: unknown;
      try {
        for await (const result of resultGenerator) {
          results.push(result);
        }
      } catch (error) {
        caughtError = error;
      }
      expect(caughtError).toBe(testError);

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

    it('should throw NonSSEResponseError when response has non-SSE content-type', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };
      const userPromptId = 'test-prompt-id';

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          // Intentionally yields nothing — simulates an HTML body parsed as SSE
        },
      };

      const mockHttpResponse = {
        headers: new Headers({
          'content-type': 'text/html;charset=UTF-8',
          'x-request-id': 'req-123',
        }),
        status: 200,
        body: null,
      } as unknown as Response;

      // Create a mock API promise that has withResponse()
      const mockApiPromise = Object.assign(Promise.resolve(mockStream), {
        withResponse: () =>
          Promise.resolve({
            data: mockStream,
            response: mockHttpResponse,
            request_id: 'req-123',
          }),
      });

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockReturnValue(
        mockApiPromise,
      );

      let thrownError: NonSSEResponseError | undefined;
      try {
        await pipeline.executeStream(request, userPromptId);
      } catch (e) {
        thrownError = e as NonSSEResponseError;
      }

      expect(thrownError).toBeInstanceOf(NonSSEResponseError);
      expect(thrownError!.httpStatus).toBe(200);
      expect(thrownError!.status).toBe(200);
      expect(thrownError!.requestId).toBe('req-123');
      expect(thrownError!.request_id).toBe('req-123');
    });

    it('should throw NonSSEResponseError for application/json streaming responses', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };

      const jsonBody = '{"error":"gateway blocked streaming request"}';
      const mockStream = {
        async *[Symbol.asyncIterator]() {},
      };

      const bodyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(jsonBody));
          controller.close();
        },
      });

      const mockHttpResponse = {
        headers: new Headers({
          'content-type': 'application/json',
        }),
        status: 200,
        body: bodyStream,
      } as unknown as Response;

      const mockApiPromise = Object.assign(Promise.resolve(mockStream), {
        withResponse: () =>
          Promise.resolve({
            data: mockStream,
            response: mockHttpResponse,
            request_id: 'req-json',
          }),
      });

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockReturnValue(
        mockApiPromise,
      );

      let thrownError: NonSSEResponseError | undefined;
      try {
        await pipeline.executeStream(request, 'test-id');
      } catch (e) {
        thrownError = e as NonSSEResponseError;
      }

      expect(thrownError).toBeInstanceOf(NonSSEResponseError);
      expect(thrownError!.contentType).toBe('application/json');
      expect(thrownError!.bodyPrefix).toContain('gateway blocked');
      expect(thrownError!.requestId).toBe('req-json');
    });

    it('should include body prefix in NonSSEResponseError when body is readable', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };

      const htmlBody = '<html>' + 'x'.repeat(700) + '</html>';
      const mockStream = {
        async *[Symbol.asyncIterator]() {},
      };

      // Create a ReadableStream with the HTML content
      const bodyStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(htmlBody));
          controller.close();
        },
      });

      const mockHttpResponse = {
        headers: new Headers({
          'content-type': 'text/html',
        }),
        status: 200,
        body: bodyStream,
      } as unknown as Response;

      const mockApiPromise = Object.assign(Promise.resolve(mockStream), {
        withResponse: () =>
          Promise.resolve({
            data: mockStream,
            response: mockHttpResponse,
            request_id: null,
          }),
      });

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockReturnValue(
        mockApiPromise,
      );

      let thrownError: NonSSEResponseError | undefined;
      try {
        await pipeline.executeStream(request, 'test-id');
      } catch (e) {
        thrownError = e as NonSSEResponseError;
      }

      expect(thrownError).toBeInstanceOf(NonSSEResponseError);
      expect(thrownError!.contentType).toBe('text/html');
      expect(thrownError!.httpStatus).toBe(200);
      expect(thrownError!.bodyPrefix).toBe(htmlBody.slice(0, 512));
      expect(thrownError!.bodyPrefix).toHaveLength(512);
      expect(thrownError!.requestId).toBeNull();
    });

    it('should still throw NonSSEResponseError when body prefix read fails', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };

      const mockStream = {
        async *[Symbol.asyncIterator]() {},
      };

      const bodyStream = new ReadableStream({
        start(controller) {
          controller.error(new Error('body already consumed'));
        },
      });

      const mockHttpResponse = {
        headers: new Headers({
          'content-type': 'text/html',
        }),
        status: 200,
        body: bodyStream,
      } as unknown as Response;

      const mockApiPromise = Object.assign(Promise.resolve(mockStream), {
        withResponse: () =>
          Promise.resolve({
            data: mockStream,
            response: mockHttpResponse,
            request_id: null,
          }),
      });

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockReturnValue(
        mockApiPromise,
      );

      let thrownError: NonSSEResponseError | undefined;
      try {
        await pipeline.executeStream(request, 'test-id');
      } catch (e) {
        thrownError = e as NonSSEResponseError;
      }

      expect(thrownError).toBeInstanceOf(NonSSEResponseError);
      expect(thrownError!.bodyPrefix).toBe('');
    });

    it('should not throw NonSSEResponseError for text/event-stream content-type', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };

      const mockGeminiResponse = new GenerateContentResponse();
      mockGeminiResponse.candidates = [
        {
          content: { parts: [{ text: 'Hello' }], role: 'model' },
          finishReason: FinishReason.STOP,
        },
      ];

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'chunk-1',
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: 'test-model',
            choices: [
              { index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' },
            ],
          } as OpenAI.Chat.ChatCompletionChunk;
        },
      };

      const mockHttpResponse = {
        headers: new Headers({
          'content-type': 'text/event-stream',
        }),
        status: 200,
        body: null,
      } as unknown as Response;

      const mockApiPromise = Object.assign(Promise.resolve(mockStream), {
        withResponse: () =>
          Promise.resolve({
            data: mockStream,
            response: mockHttpResponse,
            request_id: null,
          }),
      });

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      (mockClient.chat.completions.create as Mock).mockReturnValue(
        mockApiPromise,
      );

      const resultGenerator = await pipeline.executeStream(request, 'test-id');
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }
      expect(results.length).toBeGreaterThan(0);
    });

    it('should fall back to regular await when withResponse is not available', async () => {
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
      };

      const mockGeminiResponse = new GenerateContentResponse();
      mockGeminiResponse.candidates = [
        {
          content: { parts: [{ text: 'Hello' }], role: 'model' },
          finishReason: FinishReason.STOP,
        },
      ];

      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'chunk-1',
            object: 'chat.completion.chunk',
            created: Date.now(),
            model: 'test-model',
            choices: [
              { index: 0, delta: { content: 'Hello' }, finish_reason: 'stop' },
            ],
          } as OpenAI.Chat.ChatCompletionChunk;
        },
      };

      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockReturnValue(
        mockGeminiResponse,
      );
      // Regular mockResolvedValue — no withResponse method
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        mockStream,
      );

      const resultGenerator = await pipeline.executeStream(request, 'test-id');
      const results = [];
      for await (const result of resultGenerator) {
        results.push(result);
      }
      expect(results.length).toBeGreaterThan(0);
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

      // Per-request child signal isolates SDK listener leaks
      const call = (mockClient.chat.completions.create as Mock).mock.calls[0];
      const sdkSignal = call[1]?.signal;
      expect(sdkSignal).toBeInstanceOf(AbortSignal);
      expect(sdkSignal).not.toBe(abortController.signal);
    });

    it('should abort child signal after stream is fully consumed', async () => {
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
      const sdkSignal = (mockClient.chat.completions.create as Mock).mock
        .calls[0][1]?.signal as AbortSignal;
      expect(sdkSignal.aborted).toBe(false);

      for await (const _result of resultGenerator) {
        // Consume stream
      }

      expect(sdkSignal.aborted).toBe(true);
    });

    it('should abort child signal when consumer breaks early', async () => {
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
            choices: [{ delta: { content: 'a' }, finish_reason: null }],
          };
          yield {
            id: 'chunk-2',
            choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }],
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
      const sdkSignal = (mockClient.chat.completions.create as Mock).mock
        .calls[0][1]?.signal as AbortSignal;

      for await (const _result of resultGenerator) {
        break;
      }

      expect(sdkSignal.aborted).toBe(true);
    });

    it('should abort child signal when SDK create() throws', async () => {
      const abortController = new AbortController();
      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { abortSignal: abortController.signal },
      };

      let capturedSignal: AbortSignal | undefined;
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockClient.chat.completions.create as Mock).mockImplementation(
        (_req: unknown, opts: { signal: AbortSignal }) => {
          capturedSignal = opts.signal;
          throw new Error('network failure');
        },
      );

      await expect(
        pipeline.executeStream(request, 'test-id'),
      ).rejects.toThrow();

      expect(capturedSignal!.aborted).toBe(true);
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
          max_tokens: 500, // min(config 1000, request 500): the smaller wins so the window clamp survives samplingParams passthrough
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

    it('should pass arbitrary samplingParams keys through verbatim when the window has room (e.g. max_completion_tokens for GPT-5)', async () => {
      // Arrange: user sets a GPT-5 / o-series shape in samplingParams.
      // None of these are typed fields; all must appear on the wire because
      // samplingParams is the source of truth. maxOutputTokens (32000) leaves
      // room above max_completion_tokens (4096), so the value is not clamped.
      mockContentGeneratorConfig.samplingParams = {
        max_completion_tokens: 4096,
        reasoning_effort: 'medium',
        verbosity: 'low',
      } as ContentGeneratorConfig['samplingParams'];
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { maxOutputTokens: 32000 },
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

      // Assert: the exact samplingParams keys reach the wire unchanged; a
      // separate max_tokens is NOT synthesized (that would double-specify the
      // budget and o-series rejects the pair).
      const call = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(call).toMatchObject({
        max_completion_tokens: 4096,
        reasoning_effort: 'medium',
        verbosity: 'low',
      });
      expect(call).not.toHaveProperty('max_tokens');
    });

    it('should clamp a provider output-budget key to the window without injecting max_tokens', async () => {
      // Arrange: max_completion_tokens (200000) exceeds the window's remaining
      // room (maxOutputTokens 50000). The value must be clamped in place so
      // `prompt + output ≤ window` holds — but NO max_tokens is injected
      // (o-series rejects both keys together).
      mockContentGeneratorConfig.samplingParams = {
        max_completion_tokens: 200000,
        reasoning_effort: 'high',
      } as ContentGeneratorConfig['samplingParams'];
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { maxOutputTokens: 50000 },
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

      // Assert: provider key clamped to the window; other keys verbatim; no
      // max_tokens added.
      const call = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(call).toMatchObject({
        max_completion_tokens: 50000,
        reasoning_effort: 'high',
      });
      expect(call).not.toHaveProperty('max_tokens');
    });

    it('should clamp a provider output-budget key even when max_tokens is also set', async () => {
      // Arrange: config carries BOTH max_tokens and max_completion_tokens.
      // max_tokens resolves via reconcile (min with the request), but the
      // provider key must not escape unclamped through the spread — on
      // backends honoring the larger key, prompt + output would exceed the
      // window.
      mockContentGeneratorConfig.samplingParams = {
        max_tokens: 50000,
        max_completion_tokens: 100000,
      } as ContentGeneratorConfig['samplingParams'];
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { maxOutputTokens: 40000 },
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

      // Assert: both output budgets clamped to the window.
      const call = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(call).toMatchObject({
        max_tokens: 40000,
        max_completion_tokens: 40000,
      });
    });

    it('should inject the window-clamped max_tokens when samplingParams omits it and carries no provider output-budget key', async () => {
      // Arrange: samplingParams is set but specifies no output budget (no
      // max_tokens, no provider-specific key). The window clamp
      // (request.config.maxOutputTokens) must still reach the wire as
      // max_tokens so these users get the same `prompt + max_tokens ≤ window`
      // protection as everyone else, matching the Anthropic path.
      mockContentGeneratorConfig.samplingParams = {
        temperature: 0.7,
      } as ContentGeneratorConfig['samplingParams'];
      pipeline = new ContentGenerationPipeline(mockConfig);

      const request: GenerateContentParameters = {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { maxOutputTokens: 777 },
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

      // Assert: clamped value injected as max_tokens; other keys pass through.
      const call = (mockClient.chat.completions.create as Mock).mock
        .calls[0][0];
      expect(call).toMatchObject({
        temperature: 0.7,
        max_tokens: 777,
      });
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

  describe('stream inactivity timeout', () => {
    // A stream whose `next()` is gated by the test: it stays pending until
    // `push()` / `end()` is called, letting us simulate a silent (stalled)
    // stream under fake timers.
    function gatedStream() {
      let resolveNext:
        | ((r: IteratorResult<OpenAI.Chat.ChatCompletionChunk>) => void)
        | null = null;
      let rejectNext: ((err: unknown) => void) | null = null;
      const buffered: OpenAI.Chat.ChatCompletionChunk[] = [];
      let ended = false;
      let failure: { error: unknown } | null = null;
      let returned = false;
      const deliver = (r: IteratorResult<OpenAI.Chat.ChatCompletionChunk>) => {
        const r2 = resolveNext;
        resolveNext = null;
        rejectNext = null;
        r2?.(r);
      };
      return {
        push(chunk: OpenAI.Chat.ChatCompletionChunk) {
          if (resolveNext) deliver({ done: false, value: chunk });
          else buffered.push(chunk);
        },
        error(error: unknown) {
          failure = { error };
          const reject = rejectNext;
          resolveNext = null;
          rejectNext = null;
          reject?.(error);
        },
        end() {
          ended = true;
          if (resolveNext) deliver({ done: true, value: undefined as never });
        },
        wasReturned() {
          return returned;
        },
        stream: {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<OpenAI.Chat.ChatCompletionChunk>> {
                if (buffered.length) {
                  return Promise.resolve({
                    done: false,
                    value: buffered.shift()!,
                  });
                }
                if (failure) {
                  return Promise.reject(failure.error);
                }
                if (ended) {
                  return Promise.resolve({
                    done: true,
                    value: undefined as never,
                  });
                }
                return new Promise((res, rej) => {
                  resolveNext = res;
                  rejectNext = rej;
                });
              },
              return(): Promise<
                IteratorResult<OpenAI.Chat.ChatCompletionChunk>
              > {
                returned = true;
                ended = true;
                if (resolveNext) {
                  deliver({ done: true, value: undefined as never });
                }
                return Promise.resolve({
                  done: true,
                  value: undefined as never,
                });
              },
            };
          },
        },
      };
    }

    function chunk(text: string): OpenAI.Chat.ChatCompletionChunk {
      return {
        id: 'c',
        choices: [{ delta: { content: text } }],
      } as OpenAI.Chat.ChatCompletionChunk;
    }

    function streamingRequest(signal?: AbortSignal): GenerateContentParameters {
      return {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hi' }], role: 'user' }],
        ...(signal ? { config: { abortSignal: signal } } : {}),
      } as GenerateContentParameters;
    }

    function buildPipeline(streamIdleTimeoutMs?: number) {
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        ...(streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs } : {}),
      } as ContentGeneratorConfig;
      mockConfig = {
        ...mockConfig,
        contentGeneratorConfig: mockContentGeneratorConfig,
      };
      return new ContentGenerationPipeline(mockConfig);
    }

    beforeEach(() => {
      (mockConverter.convertGeminiRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToGemini as Mock).mockImplementation(
        () => {
          const r = new GenerateContentResponse();
          r.candidates = [
            { content: { parts: [{ text: 'x' }], role: 'model' } },
          ];
          return r;
        },
      );
      // Clean baseline: ignore any ambient QWEN_STREAM_IDLE_TIMEOUT_MS from the
      // dev/CI shell so the default-timeout tests aren't silently overridden.
      // Env-specific tests re-stub it; afterEach unstubs everything.
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, undefined);
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    it('aborts and throws ETIMEDOUT when the stream is silent past the idle timeout', async () => {
      const gated = gatedStream(); // never push/end → silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(1000);
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })();
      const captured = consume.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      const err = await captured;
      expect(err).toBeInstanceOf(StreamInactivityTimeoutError);
      expect((err as Error).message).toBe(
        'No stream activity for 1000ms after 0 chunks ' +
          '(stream lifetime: 1000ms). Set QWEN_STREAM_IDLE_TIMEOUT_MS ' +
          'to increase this window (or 0 to disable it).',
      );
      expect(err).toMatchObject({ code: 'ETIMEDOUT' });
      expect((err as StreamInactivityTimeoutError).chunksReceived).toBe(0);
      expect((err as StreamInactivityTimeoutError).streamLifetimeMs).toBe(1000);
      expect(gated.wasReturned()).toBe(true);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('includes the idle detail and env override hint in timeout errors', async () => {
      const gated = gatedStream(); // never push/end → silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(1000);
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      const captured = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      const err = await captured;
      expect(err).toBeInstanceOf(StreamInactivityTimeoutError);
      const message = (err as Error).message;
      expect(message).toContain('No stream activity for 1000ms after 0 chunks');
      expect(message).toContain('QWEN_STREAM_IDLE_TIMEOUT_MS');
    });

    it('uses the default stream idle timeout when no override is configured', async () => {
      const gated = gatedStream(); // never push/end → silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline();
      const gen = await p.executeStream(streamingRequest(), 'id');
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })();
      const captured = consume.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      const err = await captured;
      expect(err).toBeInstanceOf(StreamInactivityTimeoutError);
      expect(err).toMatchObject({
        code: 'ETIMEDOUT',
        idleMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        chunksReceived: 0,
        streamLifetimeMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      });
      expect(gated.wasReturned()).toBe(true);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('swallows the orphaned SDK next() rejection after an idle timeout', async () => {
      const pendingSdkNext: {
        reject?: (err: unknown) => void;
      } = {};
      const stream = {
        [Symbol.asyncIterator]() {
          return {
            next(): Promise<IteratorResult<OpenAI.Chat.ChatCompletionChunk>> {
              return new Promise((_res, rej) => {
                pendingSdkNext.reject = rej;
              });
            },
            return(): Promise<IteratorResult<OpenAI.Chat.ChatCompletionChunk>> {
              return Promise.resolve({
                done: true,
                value: undefined as never,
              });
            },
          };
        },
      };
      (mockClient.chat.completions.create as Mock).mockResolvedValue(stream);
      const unhandled: unknown[] = [];
      const handler = (err: unknown) => unhandled.push(err);
      process.on('unhandledRejection', handler);

      try {
        const p = buildPipeline(1000);
        const gen = await p.executeStream(streamingRequest(), 'id');
        const captured = (async () => {
          for await (const _ of gen) {
            /* drain */
          }
        })().catch((e: unknown) => e);

        await vi.advanceTimersByTimeAsync(1000);
        expect(await captured).toMatchObject({
          code: 'ETIMEDOUT',
          chunksReceived: 0,
        });

        const sdkAbort = new Error('aborted by SDK');
        sdkAbort.name = 'AbortError';
        expect(pendingSdkNext.reject).toBeDefined();
        pendingSdkNext.reject!(sdkAbort);
        pendingSdkNext.reject = undefined;
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', handler);
      }
    });

    it('aborts the SDK signal on idle timeout without a parent abort signal', async () => {
      const gated = gatedStream(); // never push/end → silent
      let sdkSignal: AbortSignal | undefined;
      (mockClient.chat.completions.create as Mock).mockImplementation(
        (_req: unknown, opts: { signal?: AbortSignal }) => {
          sdkSignal = opts.signal;
          return Promise.resolve(gated.stream);
        },
      );
      const p = buildPipeline(1000);
      const gen = await p.executeStream(streamingRequest(), 'id');
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })();
      const captured = consume.catch((e: unknown) => e);
      expect(sdkSignal).toBeInstanceOf(AbortSignal);
      expect(sdkSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await captured).toMatchObject({ code: 'ETIMEDOUT' });
      expect(sdkSignal?.aborted).toBe(true);
      expect(gated.wasReturned()).toBe(true);
    });

    it('delivers chunks then throws ETIMEDOUT when the stream stalls after some output', async () => {
      const gated = gatedStream();
      gated.push(chunk('hello')); // one chunk, then silence
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(1000);
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      const results: GenerateContentResponse[] = [];
      const consume = (async () => {
        for await (const r of gen) results.push(r);
      })();
      const captured = consume.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await captured).toMatchObject({
        code: 'ETIMEDOUT',
        chunksReceived: 1,
      });
      expect(results).toHaveLength(1);
      expect(gated.wasReturned()).toBe(true);
    });

    it('resets the timer on each chunk and completes a slow-but-active stream', async () => {
      const gated = gatedStream();
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(1000);
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      const results: GenerateContentResponse[] = [];
      const consume = (async () => {
        for await (const r of gen) results.push(r);
      })();
      // Three chunks, each 800ms apart (< 1000ms idle) → total 2400ms but
      // never idle for a full second, so the watchdog must not trip.
      await vi.advanceTimersByTimeAsync(800);
      gated.push(chunk('a'));
      await vi.advanceTimersByTimeAsync(800);
      gated.push(chunk('b'));
      await vi.advanceTimersByTimeAsync(800);
      gated.end();
      await consume;
      expect(results).toHaveLength(2);
      // Late advance after completion must not produce a delayed throw.
      await vi.advanceTimersByTimeAsync(5000);
    });

    it('closes the guarded SDK iterator when the consumer breaks early', async () => {
      const gated = gatedStream();
      gated.push(chunk('hello'));
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(1000);
      const gen = await p.executeStream(streamingRequest(), 'id');
      const call = (mockClient.chat.completions.create as Mock).mock.calls[0];
      const sdkSignal = call[1]?.signal;

      for await (const _ of gen) {
        break;
      }

      expect(gated.wasReturned()).toBe(true);
      expect(sdkSignal?.aborted).toBe(true);
    });

    it('propagates mid-stream errors without converting them to ETIMEDOUT', async () => {
      const gated = gatedStream();
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(1000);
      const gen = await p.executeStream(streamingRequest(), 'id');
      const results: GenerateContentResponse[] = [];
      gated.push(chunk('hello'));
      const consume = (async () => {
        for await (const r of gen) results.push(r);
      })();
      const captured = consume.catch((e: unknown) => e);
      const networkError = new Error('network down');
      gated.error(networkError);
      const err = await captured;
      expect(err).toBe(networkError);
      expect(results).toHaveLength(1);
      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        networkError,
        expect.anything(),
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(5000);
    });

    it('propagates a user AbortError (not ETIMEDOUT) when the parent signal is aborted', async () => {
      const ac = new AbortController();
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(1000);
      const gen = await p.executeStream(streamingRequest(ac.signal), 'id');
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })();
      const captured = consume.catch((e: unknown) => e);
      ac.abort();
      await vi.advanceTimersByTimeAsync(1000);
      const err = (await captured) as { name?: string; code?: string };
      expect(err.name).toBe('AbortError');
      expect(err.code).not.toBe('ETIMEDOUT');
      expect(gated.wasReturned()).toBe(true);
    });

    it('is disabled when streamIdleTimeoutMs <= 0 (no timeout fires)', async () => {
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(0);
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(600000);
      expect(settled).toBe(false);
      gated.end(); // unblock so the test doesn't leak a pending stream
      await consume;
    });

    it('honors a custom streamIdleTimeoutMs value', async () => {
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(5000);
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch(() => (settled = true));
      // Not yet at 5000ms → must not have tripped.
      await vi.advanceTimersByTimeAsync(4000);
      expect(settled).toBe(false);
      // Cross 5000ms → trips.
      await vi.advanceTimersByTimeAsync(1000);
      await consume;
      expect(settled).toBe(true);
      expect(gated.wasReturned()).toBe(true);
    });

    it('bypasses the OpenAI error handler so the ETIMEDOUT code survives to the caller', async () => {
      // Faithfully replicate EnhancedErrorHandler.handle's relevant behavior:
      // it detects code 'ETIMEDOUT' as a timeout and re-throws a generic Error
      // WITHOUT the code. If the inactivity timeout were routed through it, the
      // retryable-transport classification (which reads err.code) would be lost.
      (mockErrorHandler.handle as unknown as Mock).mockImplementation(
        (error: unknown) => {
          if ((error as { code?: string })?.code === 'ETIMEDOUT') {
            throw new Error('stripped'); // the production failure mode
          }
          throw error;
        },
      );
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(1000);
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      const captured = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(1000);
      const err = await captured;
      expect(err).toBeInstanceOf(StreamInactivityTimeoutError);
      expect((err as { code?: string }).code).toBe('ETIMEDOUT');
      expect(gated.wasReturned()).toBe(true);
      // Proves the bypass: the handler (which would strip the code) is skipped.
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('honors QWEN_STREAM_IDLE_TIMEOUT_MS when no explicit config is set', async () => {
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '3000');
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(); // no explicit streamIdleTimeoutMs → env applies
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch(() => (settled = true));
      await vi.advanceTimersByTimeAsync(2999);
      expect(settled).toBe(false); // not yet at the env value
      await vi.advanceTimersByTimeAsync(1);
      await consume;
      expect(settled).toBe(true); // tripped at 3000ms from the env
    });

    it('lets an explicit streamIdleTimeoutMs config take precedence over the env', async () => {
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '1000');
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(5000); // config 5000 wins over env 1000
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch(() => (settled = true));
      await vi.advanceTimersByTimeAsync(1000); // env value — must NOT trip
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(4000); // reach the config value (5000)
      await consume;
      expect(settled).toBe(true);
    });

    it('ignores a malformed QWEN_STREAM_IDLE_TIMEOUT_MS and falls back to the default', async () => {
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, 'not-a-number');
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(); // no config; invalid env → default
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch(() => (settled = true));
      // The effective timeout must be the default: not tripped just before it
      // (so a malformed value did not become 0/NaN and fire immediately), and
      // tripped exactly at it (so the default — not some other value — is used).
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await consume;
      expect(settled).toBe(true);
    });

    it('ignores an oversized QWEN_STREAM_IDLE_TIMEOUT_MS (beyond the timer ceiling)', async () => {
      // A value above the JS timer ceiling must be rejected (fall back to the
      // default), not used verbatim. If it were used, the watchdog would be
      // scheduled ~24.8 days out, so advancing only to the default would never
      // trip it — asserting it trips AT the default proves the value was
      // rejected. (In real Node such a delay is silently compressed to 1ms,
      // which would make the watchdog fire almost immediately.)
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '9999999999');
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(); // no config; oversized env → default
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch(() => (settled = true));
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS - 1);
      expect(settled).toBe(false); // not before the default → not used verbatim
      await vi.advanceTimersByTimeAsync(1);
      await consume;
      expect(settled).toBe(true); // trips at the default
    });

    it('rejects a non-decimal QWEN_STREAM_IDLE_TIMEOUT_MS (hex/scientific) and uses the default', async () => {
      // Number('0x10') === 16; a strict decimal-integer check must reject it so
      // a typo can't silently become a 16ms timeout.
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '0x10');
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(); // no config; non-decimal env → default
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch(() => (settled = true));
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS - 1);
      expect(settled).toBe(false); // would have tripped at 16ms if '0x10' parsed
      await vi.advanceTimersByTimeAsync(1);
      await consume;
      expect(settled).toBe(true); // trips at the default
    });

    it('rejects an out-of-range config streamIdleTimeoutMs and falls back', async () => {
      // A config value above the timer ceiling would overflow setTimeout; it
      // must be rejected (fall back to env/default), not used verbatim.
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(MAX_STREAM_IDLE_TIMEOUT_MS + 1); // oversized config
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch(() => (settled = true));
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await consume;
      expect(settled).toBe(true); // trips at the default (config rejected)
    });

    it('accepts the exact MAX_STREAM_IDLE_TIMEOUT_MS boundary value', async () => {
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      // The exact ceiling must be accepted (not rejected as out-of-range).
      // Guards against an off-by-one changing `<=` to `<`.
      const p = buildPipeline(MAX_STREAM_IDLE_TIMEOUT_MS);
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch(() => (settled = true));
      // Must NOT trip at the default (which would mean the ceiling was rejected).
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      expect(settled).toBe(false);
      gated.end();
      await consume;
    });

    it('falls back from an invalid config to the env value (config→env cascade)', async () => {
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '4000');
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      // Config is oversized → rejected; env = 4000 → used (not default).
      const p = buildPipeline(MAX_STREAM_IDLE_TIMEOUT_MS + 1);
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().catch(() => (settled = true));
      await vi.advanceTimersByTimeAsync(3999);
      expect(settled).toBe(false); // not yet at the env value
      await vi.advanceTimersByTimeAsync(1);
      await consume;
      expect(settled).toBe(true); // trips at 4000ms from the env (not default)
    });

    it('disables the watchdog when QWEN_STREAM_IDLE_TIMEOUT_MS=0', async () => {
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '0');
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(); // no config; env=0 → disabled
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().then(
        () => (settled = true),
        () => (settled = true),
      );
      // Well past the default — must NOT trip (watchdog disabled).
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS + 60000);
      expect(settled).toBe(false);
      gated.end();
      await consume;
    });

    it('disables the watchdog with a negative config value', async () => {
      const gated = gatedStream(); // silent
      (mockClient.chat.completions.create as Mock).mockResolvedValue(
        gated.stream,
      );
      const p = buildPipeline(-1); // negative → disabled (idleMs > 0 guard)
      const gen = await p.executeStream(
        streamingRequest(new AbortController().signal),
        'id',
      );
      let settled = false;
      const consume = (async () => {
        for await (const _ of gen) {
          /* drain */
        }
      })().then(
        () => (settled = true),
        () => (settled = true),
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS + 60000);
      expect(settled).toBe(false);
      gated.end();
      await consume;
    });
  });
});

/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import { Config } from '../config/config.js';
import OpenAI from 'openai';
import type {
  GenerateContentParameters,
  CountTokensParameters,
  EmbedContentParameters,
  CallableTool,
  Content,
} from '@google/genai';
import { Type, FinishReason } from '@google/genai';

// Mock OpenAI
vi.mock('openai');

// Mock logger modules
vi.mock('../telemetry/loggers.js', () => ({
  logApiResponse: vi.fn(),
}));

vi.mock('../utils/openaiLogger.js', () => ({
  openaiLogger: {
    logInteraction: vi.fn(),
  },
}));

// Mock tiktoken
vi.mock('tiktoken', () => ({
  get_encoding: vi.fn().mockReturnValue({
    encode: vi.fn().mockReturnValue(new Array(50)), // Mock 50 tokens
    free: vi.fn(),
  }),
}));

describe('OpenAIContentGenerator', () => {
  let generator: OpenAIContentGenerator;
  let mockConfig: Config;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockOpenAIClient: any;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();

    // Mock environment variables
    vi.stubEnv('OPENAI_BASE_URL', '');

    // Mock config
    mockConfig = {
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'openai',
        enableOpenAILogging: false,
        timeout: 120000,
        maxRetries: 3,
        samplingParams: {
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 0.9,
        },
      }),
    } as unknown as Config;

    // Mock OpenAI client
    mockOpenAIClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
      embeddings: {
        create: vi.fn(),
      },
    };

    vi.mocked(OpenAI).mockImplementation(() => mockOpenAIClient);

    // Create generator instance
    generator = new OpenAIContentGenerator('test-key', 'gpt-4', mockConfig);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with basic configuration', () => {
      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseURL: '',
        timeout: 120000,
        maxRetries: 3,
        defaultHeaders: {
          'User-Agent': expect.stringMatching(/^QwenCode/),
        },
      });
    });

    it('should handle custom base URL', () => {
      vi.stubEnv('OPENAI_BASE_URL', 'https://api.custom.com');

      new OpenAIContentGenerator('test-key', 'gpt-4', mockConfig);

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseURL: 'https://api.custom.com',
        timeout: 120000,
        maxRetries: 3,
        defaultHeaders: {
          'User-Agent': expect.stringMatching(/^QwenCode/),
        },
      });
    });

    it('should configure OpenRouter headers when using OpenRouter', () => {
      vi.stubEnv('OPENAI_BASE_URL', 'https://openrouter.ai/api/v1');

      new OpenAIContentGenerator('test-key', 'gpt-4', mockConfig);

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseURL: 'https://openrouter.ai/api/v1',
        timeout: 120000,
        maxRetries: 3,
        defaultHeaders: {
          'User-Agent': expect.stringMatching(/^QwenCode/),
          'HTTP-Referer': 'https://github.com/QwenLM/qwen-code.git',
          'X-Title': 'Qwen Code',
        },
      });
    });

    it('should override timeout settings from config', () => {
      const customConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          timeout: 300000,
          maxRetries: 5,
        }),
      } as unknown as Config;

      new OpenAIContentGenerator('test-key', 'gpt-4', customConfig);

      expect(OpenAI).toHaveBeenCalledWith({
        apiKey: 'test-key',
        baseURL: '',
        timeout: 300000,
        maxRetries: 5,
        defaultHeaders: {
          'User-Agent': expect.stringMatching(/^QwenCode/),
        },
      });
    });
  });

  describe('generateContent', () => {
    it('should generate content successfully', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        object: 'chat.completion',
        created: 1677652288,
        model: 'gpt-4',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'Hello! How can I help you?',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 15,
          total_tokens: 25,
        },
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const result = await generator.generateContent(request, 'test-prompt-id');

      expect(result.candidates).toHaveLength(1);
      if (
        result.candidates &&
        result.candidates.length > 0 &&
        result.candidates[0]
      ) {
        const firstCandidate = result.candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([
            { text: 'Hello! How can I help you?' },
          ]);
        }
      }
      expect(result.usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 15,
        totalTokenCount: 25,
        cachedContentTokenCount: 0,
      });
    });

    it('should handle system instructions', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          systemInstruction: 'You are a helpful assistant.',
        },
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'You are a helpful assistant.' },
            { role: 'user', content: 'Hello' },
          ],
        }),
      );
    });

    it('should handle function calls', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location": "New York"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'What is the weather?' }] }],
        model: 'gpt-4',
        config: {
          tools: [
            {
              callTool: vi.fn(),
              tool: () =>
                Promise.resolve({
                  functionDeclarations: [
                    {
                      name: 'get_weather',
                      description: 'Get weather information',
                      parameters: {
                        type: Type.OBJECT,
                        properties: { location: { type: Type.STRING } },
                      },
                    },
                  ],
                }),
            } as unknown as CallableTool,
          ],
        },
      };

      const result = await generator.generateContent(request, 'test-prompt-id');

      if (
        result.candidates &&
        result.candidates.length > 0 &&
        result.candidates[0]
      ) {
        const firstCandidate = result.candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([
            {
              functionCall: {
                id: 'call_123',
                name: 'get_weather',
                args: { location: 'New York' },
              },
            },
          ]);
        }
      }
    });

    it('should apply sampling parameters from config', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7,
          max_tokens: 1000,
          top_p: 0.9,
        }),
      );
    });

    it('should prioritize request-level parameters over config', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          temperature: 0.5,
          maxOutputTokens: 500,
        },
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7, // From config sampling params (higher priority)
          max_tokens: 1000, // From config sampling params (higher priority)
          top_p: 0.9,
        }),
      );
    });
  });

  describe('generateContentStream', () => {
    it('should handle streaming responses', async () => {
      const mockStream = [
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: { content: 'Hello' },
              finish_reason: null,
            },
          ],
          created: 1677652288,
        },
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: { content: ' there!' },
              finish_reason: 'stop',
            },
          ],
          created: 1677652288,
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      ];

      // Mock async iterable
      mockOpenAIClient.chat.completions.create.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          for (const chunk of mockStream) {
            yield chunk;
          }
        },
      });

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const stream = await generator.generateContentStream(
        request,
        'test-prompt-id',
      );
      const responses = [];
      for await (const response of stream) {
        responses.push(response);
      }

      expect(responses).toHaveLength(2);
      if (
        responses[0]?.candidates &&
        responses[0].candidates.length > 0 &&
        responses[0].candidates[0]
      ) {
        const firstCandidate = responses[0].candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([{ text: 'Hello' }]);
        }
      }
      if (
        responses[1]?.candidates &&
        responses[1].candidates.length > 0 &&
        responses[1].candidates[0]
      ) {
        const secondCandidate = responses[1].candidates[0];
        if (secondCandidate.content) {
          expect(secondCandidate.content.parts).toEqual([{ text: ' there!' }]);
        }
      }
      expect(responses[1].usageMetadata).toEqual({
        promptTokenCount: 10,
        candidatesTokenCount: 5,
        totalTokenCount: 15,
        cachedContentTokenCount: 0,
      });
    });

    it('should handle streaming tool calls', async () => {
      const mockStream = [
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    function: { name: 'get_weather' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
          created: 1677652288,
        },
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"location": "NYC"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          created: 1677652288,
        },
      ];

      mockOpenAIClient.chat.completions.create.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          for (const chunk of mockStream) {
            yield chunk;
          }
        },
      });

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
        model: 'gpt-4',
      };

      const stream = await generator.generateContentStream(
        request,
        'test-prompt-id',
      );
      const responses = [];
      for await (const response of stream) {
        responses.push(response);
      }

      // Tool calls should only appear in the final response
      if (
        responses[0]?.candidates &&
        responses[0].candidates.length > 0 &&
        responses[0].candidates[0]
      ) {
        const firstCandidate = responses[0].candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([]);
        }
      }
      if (
        responses[1]?.candidates &&
        responses[1].candidates.length > 0 &&
        responses[1].candidates[0]
      ) {
        const secondCandidate = responses[1].candidates[0];
        if (secondCandidate.content) {
          expect(secondCandidate.content.parts).toEqual([
            {
              functionCall: {
                id: 'call_123',
                name: 'get_weather',
                args: { location: 'NYC' },
              },
            },
          ]);
        }
      }
    });
  });

  describe('countTokens', () => {
    it('should count tokens using tiktoken', async () => {
      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'gpt-4',
      };

      const result = await generator.countTokens(request);

      expect(result.totalTokens).toBe(50); // Mocked value
    });

    it('should fall back to character approximation if tiktoken fails', async () => {
      // Mock tiktoken to throw error
      vi.doMock('tiktoken', () => ({
        get_encoding: vi.fn().mockImplementation(() => {
          throw new Error('Tiktoken failed');
        }),
      }));

      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'gpt-4',
      };

      const result = await generator.countTokens(request);

      // Should use character approximation (content length / 4)
      expect(result.totalTokens).toBeGreaterThan(0);
    });
  });

  describe('embedContent', () => {
    it('should generate embeddings for text content', async () => {
      const mockEmbedding = {
        data: [{ embedding: [0.1, 0.2, 0.3, 0.4] }],
        model: 'text-embedding-ada-002',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      };

      mockOpenAIClient.embeddings.create.mockResolvedValue(mockEmbedding);

      const request: EmbedContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'text-embedding-ada-002',
      };

      const result = await generator.embedContent(request);

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings?.[0]?.values).toEqual([0.1, 0.2, 0.3, 0.4]);
      expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-ada-002',
        input: 'Hello world',
      });
    });

    it('should handle string content', async () => {
      const mockEmbedding = {
        data: [{ embedding: [0.1, 0.2] }],
      };

      mockOpenAIClient.embeddings.create.mockResolvedValue(mockEmbedding);

      const request: EmbedContentParameters = {
        contents: 'Simple text',
        model: 'text-embedding-ada-002',
      };

      const _result = await generator.embedContent(request);

      expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-ada-002',
        input: 'Simple text',
      });
    });

    it('should handle embedding errors', async () => {
      const error = new Error('Embedding failed');
      mockOpenAIClient.embeddings.create.mockRejectedValue(error);

      const request: EmbedContentParameters = {
        contents: 'Test text',
        model: 'text-embedding-ada-002',
      };

      await expect(generator.embedContent(request)).rejects.toThrow(
        'Embedding failed',
      );
    });
  });

  describe('error handling', () => {
    it('should handle API errors with proper error message', async () => {
      const apiError = new Error('Invalid API key');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(apiError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(
        generator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow('Invalid API key');
    });

    it('should estimate tokens on error for telemetry', async () => {
      const apiError = new Error('API error');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(apiError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      try {
        await generator.generateContent(request, 'test-prompt-id');
      } catch (error) {
        // Error should be thrown but token estimation should have been attempted
        expect(error).toBeInstanceOf(Error);
      }
    });

    it('should preserve error status codes like 429', async () => {
      // Create an error object with status property like OpenAI SDK would
      const apiError = Object.assign(new Error('Rate limit exceeded'), {
        status: 429,
      });
      mockOpenAIClient.chat.completions.create.mockRejectedValue(apiError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      try {
        await generator.generateContent(request, 'test-prompt-id');
        expect.fail('Expected error to be thrown');
      } catch (error: unknown) {
        // Should throw the original error object with status preserved
        expect((error as Error & { status: number }).message).toBe(
          'Rate limit exceeded',
        );
        expect((error as Error & { status: number }).status).toBe(429);
      }
    });
  });

  describe('message conversion', () => {
    it('should convert function responses to tool messages', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [
          { role: 'user', parts: [{ text: 'What is the weather?' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_123',
                  name: 'get_weather',
                  args: { location: 'NYC' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_123',
                  name: 'get_weather',
                  response: { temperature: '72F', condition: 'sunny' },
                },
              },
            ],
          },
        ],
        model: 'gpt-4',
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: expect.arrayContaining([
            { role: 'user', content: 'What is the weather?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"NYC"}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_123',
              content: '{"temperature":"72F","condition":"sunny"}',
            },
          ]),
        }),
      );
    });

    it('should clean up orphaned tool calls', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_orphaned',
                  name: 'orphaned_function',
                  args: {},
                },
              },
            ],
          },
          // No corresponding function response
        ],
        model: 'gpt-4',
      };

      await generator.generateContent(request, 'test-prompt-id');

      // Should not include the orphaned tool call
      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [], // Empty because orphaned tool call was cleaned up
        }),
      );
    });
  });

  describe('finish reason mapping', () => {
    it('should map OpenAI finish reasons to Gemini format', async () => {
      const testCases = [
        { openai: 'stop', expected: FinishReason.STOP },
        { openai: 'length', expected: FinishReason.MAX_TOKENS },
        { openai: 'content_filter', expected: FinishReason.SAFETY },
        { openai: 'function_call', expected: FinishReason.STOP },
        { openai: 'tool_calls', expected: FinishReason.STOP },
      ];

      for (const testCase of testCases) {
        const mockResponse = {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'Response' },
              finish_reason: testCase.openai,
            },
          ],
          created: 1677652288,
          model: 'gpt-4',
        };

        mockOpenAIClient.chat.completions.create.mockResolvedValue(
          mockResponse,
        );

        const request: GenerateContentParameters = {
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
          model: 'gpt-4',
        };

        const result = await generator.generateContent(
          request,
          'test-prompt-id',
        );
        if (
          result.candidates &&
          result.candidates.length > 0 &&
          result.candidates[0]
        ) {
          const firstCandidate = result.candidates[0];
          expect(firstCandidate.finishReason).toBe(testCase.expected);
        }
      }
    });
  });

  describe('logging integration', () => {
    it('should log interactions when enabled', async () => {
      const loggingConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          enableOpenAILogging: true,
        }),
      } as unknown as Config;

      const loggingGenerator = new OpenAIContentGenerator(
        'test-key',
        'gpt-4',
        loggingConfig,
      );

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await loggingGenerator.generateContent(request, 'test-prompt-id');

      // Verify logging was called
      const { openaiLogger } = await import('../utils/openaiLogger.js');
      expect(openaiLogger.logInteraction).toHaveBeenCalled();
    });
  });

  describe('timeout error detection', () => {
    it('should detect various timeout error patterns', async () => {
      const timeoutErrors = [
        new Error('timeout'),
        new Error('Request timed out'),
        new Error('Connection timeout occurred'),
        new Error('ETIMEDOUT'),
        new Error('ESOCKETTIMEDOUT'),
        { code: 'ETIMEDOUT', message: 'Connection timed out' },
        { type: 'timeout', message: 'Request timeout' },
        new Error('deadline exceeded'),
      ];

      for (const error of timeoutErrors) {
        mockOpenAIClient.chat.completions.create.mockRejectedValueOnce(error);

        const request: GenerateContentParameters = {
          contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
          model: 'gpt-4',
        };

        try {
          await generator.generateContent(request, 'test-prompt-id');
          // Should not reach here
          expect(true).toBe(false);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          expect(errorMessage).toMatch(/timeout|Troubleshooting tips/);
        }
      }
    });

    it('should provide timeout-specific error messages', async () => {
      const timeoutError = new Error('Request timeout');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(timeoutError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(
        generator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow(
        /Troubleshooting tips.*Reduce input length.*Increase timeout.*Check network/s,
      );
    });
  });

  describe('streaming error handling', () => {
    it('should handle errors during streaming setup', async () => {
      const setupError = new Error('Streaming setup failed');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(setupError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(
        generator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow('Streaming setup failed');
    });

    it('should handle timeout errors during streaming setup', async () => {
      const timeoutError = new Error('Streaming setup timeout');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(timeoutError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(
        generator.generateContentStream(request, 'test-prompt-id'),
      ).rejects.toThrow(
        /Streaming setup timeout troubleshooting.*Reduce input length/s,
      );
    });

    it('should handle errors during streaming with logging', async () => {
      const loggingConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          enableOpenAILogging: true,
        }),
      } as unknown as Config;

      const loggingGenerator = new OpenAIContentGenerator(
        'test-key',
        'gpt-4',
        loggingConfig,
      );

      // Mock stream that throws an error
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield {
            id: 'chatcmpl-123',
            choices: [
              {
                index: 0,
                delta: { content: 'Hello' },
                finish_reason: null,
              },
            ],
            created: 1677652288,
          };
          throw new Error('Stream error');
        },
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockStream);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const stream = await loggingGenerator.generateContentStream(
        request,
        'test-prompt-id',
      );

      // Consume the stream and expect error
      await expect(async () => {
        for await (const chunk of stream) {
          // Stream will throw during iteration
          console.log('Processing chunk:', chunk); // Use chunk to avoid warning
        }
      }).rejects.toThrow('Stream error');
    });
  });

  describe('tool parameter conversion', () => {
    it('should convert Gemini types to OpenAI JSON Schema types', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        model: 'gpt-4',
        config: {
          tools: [
            {
              callTool: vi.fn(),
              tool: () =>
                Promise.resolve({
                  functionDeclarations: [
                    {
                      name: 'test_function',
                      description: 'Test function',
                      parameters: {
                        type: 'OBJECT',
                        properties: {
                          count: {
                            type: 'INTEGER',
                            minimum: '1',
                            maximum: '100',
                          },
                          name: {
                            type: 'STRING',
                            minLength: '1',
                            maxLength: '50',
                          },
                          score: { type: 'NUMBER', multipleOf: '0.1' },
                          items: {
                            type: 'ARRAY',
                            minItems: '1',
                            maxItems: '10',
                          },
                        },
                      },
                    },
                  ],
                }),
            } as unknown as CallableTool,
          ],
        },
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            {
              type: 'function',
              function: {
                name: 'test_function',
                description: 'Test function',
                parameters: {
                  type: 'object',
                  properties: {
                    count: { type: 'integer', minimum: 1, maximum: 100 },
                    name: { type: 'string', minLength: 1, maxLength: 50 },
                    score: { type: 'number', multipleOf: 0.1 },
                    items: { type: 'array', minItems: 1, maxItems: 10 },
                  },
                },
              },
            },
          ],
        }),
      );
    });

    it('should handle nested parameter objects', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        model: 'gpt-4',
        config: {
          tools: [
            {
              callTool: vi.fn(),
              tool: () =>
                Promise.resolve({
                  functionDeclarations: [
                    {
                      name: 'nested_function',
                      description: 'Function with nested parameters',
                      parameters: {
                        type: 'OBJECT',
                        properties: {
                          config: {
                            type: 'OBJECT',
                            properties: {
                              nested_count: { type: 'INTEGER' },
                              nested_array: {
                                type: 'ARRAY',
                                items: { type: 'STRING' },
                              },
                            },
                          },
                        },
                      },
                    },
                  ],
                }),
            } as unknown as CallableTool,
          ],
        },
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tools: [
            {
              type: 'function',
              function: {
                name: 'nested_function',
                description: 'Function with nested parameters',
                parameters: {
                  type: 'object',
                  properties: {
                    config: {
                      type: 'object',
                      properties: {
                        nested_count: { type: 'integer' },
                        nested_array: {
                          type: 'array',
                          items: { type: 'string' },
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        }),
      );
    });
  });

  describe('message cleanup and conversion', () => {
    it('should handle complex conversation with multiple tool calls', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [
          { role: 'user', parts: [{ text: 'What tools are available?' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'list_tools',
                  args: { category: 'all' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'list_tools',
                  response: { tools: ['calculator', 'weather'] },
                },
              },
            ],
          },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_2',
                  name: 'get_weather',
                  args: { location: 'NYC' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_2',
                  name: 'get_weather',
                  response: { temperature: '22°C', condition: 'sunny' },
                },
              },
            ],
          },
        ],
        model: 'gpt-4',
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'What tools are available?' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'list_tools',
                    arguments: '{"category":"all"}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_1',
              content: '{"tools":["calculator","weather"]}',
            },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_2',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"location":"NYC"}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_2',
              content: '{"temperature":"22°C","condition":"sunny"}',
            },
          ],
        }),
      );
    });

    it('should clean up orphaned tool calls without corresponding responses', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [
          { role: 'user', parts: [{ text: 'Test' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_orphaned',
                  name: 'orphaned_function',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_valid',
                  name: 'valid_function',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_valid',
                  name: 'valid_function',
                  response: { result: 'success' },
                },
              },
            ],
          },
        ],
        model: 'gpt-4',
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'Test' },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_valid',
                  type: 'function',
                  function: {
                    name: 'valid_function',
                    arguments: '{}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'call_valid',
              content: '{"result":"success"}',
            },
          ],
        }),
      );
    });

    it('should merge consecutive assistant messages', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [
          { role: 'user', parts: [{ text: 'Hello' }] },
          { role: 'model', parts: [{ text: 'Part 1' }] },
          { role: 'model', parts: [{ text: 'Part 2' }] },
          { role: 'user', parts: [{ text: 'Continue' }] },
        ],
        model: 'gpt-4',
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Part 1Part 2' },
            { role: 'user', content: 'Continue' },
          ],
        }),
      );
    });
  });

  describe('error suppression functionality', () => {
    it('should allow subclasses to suppress error logging', async () => {
      class TestGenerator extends OpenAIContentGenerator {
        protected shouldSuppressErrorLogging(): boolean {
          return true; // Always suppress for this test
        }
      }

      const testGenerator = new TestGenerator('test-key', 'gpt-4', mockConfig);
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const apiError = new Error('Test error');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(apiError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(
        testGenerator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow();

      // Error logging should be suppressed
      expect(consoleSpy).not.toHaveBeenCalledWith(
        'OpenAI API Error:',
        expect.any(String),
      );

      consoleSpy.mockRestore();
    });

    it('should log errors when not suppressed', async () => {
      const consoleSpy = vi
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      const apiError = new Error('Test error');
      mockOpenAIClient.chat.completions.create.mockRejectedValue(apiError);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await expect(
        generator.generateContent(request, 'test-prompt-id'),
      ).rejects.toThrow();

      // Error logging should occur by default
      expect(consoleSpy).toHaveBeenCalledWith(
        'OpenAI API Error:',
        'Test error',
      );

      consoleSpy.mockRestore();
    });
  });

  describe('edge cases and error scenarios', () => {
    it('should handle malformed tool call arguments', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'test_function',
                    arguments: 'invalid json{',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        model: 'gpt-4',
      };

      const result = await generator.generateContent(request, 'test-prompt-id');

      // Should handle malformed JSON gracefully
      if (
        result.candidates &&
        result.candidates.length > 0 &&
        result.candidates[0]
      ) {
        const firstCandidate = result.candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([
            {
              functionCall: {
                id: 'call_123',
                name: 'test_function',
                args: {}, // Should default to empty object
              },
            },
          ]);
        }
      }
    });

    it('should handle streaming with malformed tool call arguments', async () => {
      const mockStream = [
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_123',
                    function: { name: 'test_function' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
          created: 1677652288,
        },
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: 'invalid json{' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          created: 1677652288,
        },
      ];

      mockOpenAIClient.chat.completions.create.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          for (const chunk of mockStream) {
            yield chunk;
          }
        },
      });

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Test' }] }],
        model: 'gpt-4',
      };

      const stream = await generator.generateContentStream(
        request,
        'test-prompt-id',
      );
      const responses = [];
      for await (const response of stream) {
        responses.push(response);
      }

      // Should handle malformed JSON in streaming gracefully
      const finalResponse = responses[responses.length - 1];
      if (
        finalResponse.candidates &&
        finalResponse.candidates.length > 0 &&
        finalResponse.candidates[0]
      ) {
        const firstCandidate = finalResponse.candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([
            {
              functionCall: {
                id: 'call_123',
                name: 'test_function',
                args: {}, // Should default to empty object
              },
            },
          ]);
        }
      }
    });

    it('should handle empty or null content gracefully', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: null },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [],
        model: 'gpt-4',
      };

      const result = await generator.generateContent(request, 'test-prompt-id');

      expect(result.candidates).toHaveLength(1);
      if (
        result.candidates &&
        result.candidates.length > 0 &&
        result.candidates[0]
      ) {
        const firstCandidate = result.candidates[0];
        if (firstCandidate.content) {
          expect(firstCandidate.content.parts).toEqual([]);
        }
      }
    });

    it('should handle usage metadata estimation when breakdown is missing', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Test response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
        usage: {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 100,
        },
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const result = await generator.generateContent(request, 'test-prompt-id');

      expect(result.usageMetadata).toEqual({
        promptTokenCount: 70, // 70% of 100
        candidatesTokenCount: 30, // 30% of 100
        totalTokenCount: 100,
        cachedContentTokenCount: 0,
      });
    });

    it('should handle cached token metadata', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Test response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
        usage: {
          prompt_tokens: 50,
          completion_tokens: 25,
          total_tokens: 75,
          prompt_tokens_details: {
            cached_tokens: 10,
          },
        },
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const result = await generator.generateContent(request, 'test-prompt-id');

      expect(result.usageMetadata).toEqual({
        promptTokenCount: 50,
        candidatesTokenCount: 25,
        totalTokenCount: 75,
        cachedContentTokenCount: 10,
      });
    });
  });

  describe('request/response logging conversion', () => {
    it('should convert complex Gemini request to OpenAI format for logging', async () => {
      const loggingConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          enableOpenAILogging: true,
          samplingParams: {
            temperature: 0.8,
            max_tokens: 500,
          },
        }),
      } as unknown as Config;

      const loggingGenerator = new OpenAIContentGenerator(
        'test-key',
        'gpt-4',
        loggingConfig,
      );

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'test_function',
                    arguments: '{"param":"value"}',
                  },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
        usage: {
          prompt_tokens: 100,
          completion_tokens: 50,
          total_tokens: 150,
        },
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [
          { role: 'user', parts: [{ text: 'Test complex request' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'prev_call',
                  name: 'previous_function',
                  args: { data: 'test' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'prev_call',
                  name: 'previous_function',
                  response: { result: 'success' },
                },
              },
            ],
          },
        ],
        model: 'gpt-4',
        config: {
          systemInstruction: 'You are a helpful assistant',
          temperature: 0.9,
          tools: [
            {
              callTool: vi.fn(),
              tool: () =>
                Promise.resolve({
                  functionDeclarations: [
                    {
                      name: 'test_function',
                      description: 'Test function',
                      parameters: { type: 'object' },
                    },
                  ],
                }),
            } as unknown as CallableTool,
          ],
        },
      };

      await loggingGenerator.generateContent(request, 'test-prompt-id');

      // Verify that logging was called with properly converted request/response
      const { openaiLogger } = await import('../utils/openaiLogger.js');
      expect(openaiLogger.logInteraction).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4',
          messages: [
            {
              role: 'system',
              content: 'You are a helpful assistant',
            },
            {
              role: 'user',
              content: 'Test complex request',
            },
            {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'prev_call',
                  type: 'function',
                  function: {
                    name: 'previous_function',
                    arguments: '{"data":"test"}',
                  },
                },
              ],
            },
            {
              role: 'tool',
              tool_call_id: 'prev_call',
              content: '{"result":"success"}',
            },
          ],
          temperature: 0.8, // Config override
          max_tokens: 500, // Config override
          top_p: 1, // Default value
          tools: [
            {
              type: 'function',
              function: {
                name: 'test_function',
                description: 'Test function',
                parameters: {
                  type: 'object',
                },
              },
            },
          ],
        }),
        expect.objectContaining({
          id: 'chatcmpl-123',
          object: 'chat.completion',
          created: 1677652288,
          model: 'gpt-4',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_123',
                    type: 'function',
                    function: {
                      name: 'test_function',
                      arguments: '{"param":"value"}',
                    },
                  },
                ],
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
          },
        }),
      );
    });
  });

  describe('advanced streaming scenarios', () => {
    it('should combine streaming responses correctly for logging', async () => {
      const loggingConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          enableOpenAILogging: true,
        }),
      } as unknown as Config;

      const loggingGenerator = new OpenAIContentGenerator(
        'test-key',
        'gpt-4',
        loggingConfig,
      );

      const mockStream = [
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: { content: 'Hello' },
              finish_reason: null,
            },
          ],
          created: 1677652288,
        },
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: { content: ' world' },
              finish_reason: null,
            },
          ],
          created: 1677652288,
        },
        {
          id: 'chatcmpl-123',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
            },
          ],
          created: 1677652288,
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        },
      ];

      mockOpenAIClient.chat.completions.create.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          for (const chunk of mockStream) {
            yield chunk;
          }
        },
      });

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const stream = await loggingGenerator.generateContentStream(
        request,
        'test-prompt-id',
      );
      const responses = [];
      for await (const response of stream) {
        responses.push(response);
      }

      // Verify logging was called with combined content
      const { openaiLogger } = await import('../utils/openaiLogger.js');
      expect(openaiLogger.logInteraction).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          choices: [
            expect.objectContaining({
              message: expect.objectContaining({
                content: 'Hello world', // Combined text
              }),
            }),
          ],
        }),
      );
    });

    it('should handle streaming without choices', async () => {
      const mockStream = [
        {
          id: 'chatcmpl-123',
          choices: [],
          created: 1677652288,
        },
      ];

      mockOpenAIClient.chat.completions.create.mockResolvedValue({
        async *[Symbol.asyncIterator]() {
          for (const chunk of mockStream) {
            yield chunk;
          }
        },
      });

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      const stream = await generator.generateContentStream(
        request,
        'test-prompt-id',
      );
      const responses = [];
      for await (const response of stream) {
        responses.push(response);
      }

      expect(responses).toHaveLength(1);
      expect(responses[0].candidates).toEqual([]);
    });
  });

  describe('embed content edge cases', () => {
    it('should handle mixed content types in embed request', async () => {
      const mockEmbedding = {
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        model: 'text-embedding-ada-002',
        usage: { prompt_tokens: 5, total_tokens: 5 },
      };

      mockOpenAIClient.embeddings.create.mockResolvedValue(mockEmbedding);

      const request: EmbedContentParameters = {
        contents: 'Hello world Direct string Another part',
        model: 'text-embedding-ada-002',
      };

      const result = await generator.embedContent(request);

      expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-ada-002',
        input: 'Hello world Direct string Another part',
      });

      expect(result.embeddings).toHaveLength(1);
      expect(result.embeddings?.[0]?.values).toEqual([0.1, 0.2, 0.3]);
    });

    it('should handle empty content in embed request', async () => {
      const mockEmbedding = {
        data: [{ embedding: [] }],
      };

      mockOpenAIClient.embeddings.create.mockResolvedValue(mockEmbedding);

      const request: EmbedContentParameters = {
        contents: [],
        model: 'text-embedding-ada-002',
      };

      await generator.embedContent(request);

      expect(mockOpenAIClient.embeddings.create).toHaveBeenCalledWith({
        model: 'text-embedding-ada-002',
        input: '',
      });
    });
  });

  describe('system instruction edge cases', () => {
    it('should handle array system instructions', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          systemInstruction: 'You are helpful\nBe concise',
        },
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'You are helpful\nBe concise' },
            { role: 'user', content: 'Hello' },
          ],
        }),
      );
    });

    it('should handle object system instruction', async () => {
      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          systemInstruction: {
            parts: [{ text: 'System message' }, { text: 'Additional text' }],
          } as Content,
        },
      };

      await generator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            { role: 'system', content: 'System message\nAdditional text' },
            { role: 'user', content: 'Hello' },
          ],
        }),
      );
    });
  });

  describe('sampling parameters edge cases', () => {
    it('should handle undefined sampling parameters gracefully', async () => {
      const configWithUndefined = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          samplingParams: {
            temperature: undefined,
            max_tokens: undefined,
            top_p: undefined,
          },
        }),
      } as unknown as Config;

      const testGenerator = new OpenAIContentGenerator(
        'test-key',
        'gpt-4',
        configWithUndefined,
      );

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
        config: {
          temperature: undefined,
          maxOutputTokens: undefined,
          topP: undefined,
        },
      };

      await testGenerator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.0, // Default value
          top_p: 1.0, // Default value
          // max_tokens should not be present when undefined
        }),
      );
    });

    it('should handle all config-level sampling parameters', async () => {
      const fullSamplingConfig = {
        getContentGeneratorConfig: vi.fn().mockReturnValue({
          samplingParams: {
            temperature: 0.8,
            max_tokens: 1500,
            top_p: 0.95,
            top_k: 40,
            repetition_penalty: 1.1,
            presence_penalty: 0.5,
            frequency_penalty: 0.3,
          },
        }),
      } as unknown as Config;

      const testGenerator = new OpenAIContentGenerator(
        'test-key',
        'gpt-4',
        fullSamplingConfig,
      );

      const mockResponse = {
        id: 'chatcmpl-123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Response' },
            finish_reason: 'stop',
          },
        ],
        created: 1677652288,
        model: 'gpt-4',
      };

      mockOpenAIClient.chat.completions.create.mockResolvedValue(mockResponse);

      const request: GenerateContentParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'gpt-4',
      };

      await testGenerator.generateContent(request, 'test-prompt-id');

      expect(mockOpenAIClient.chat.completions.create).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.8,
          max_tokens: 1500,
          top_p: 0.95,
          top_k: 40,
          repetition_penalty: 1.1,
          presence_penalty: 0.5,
          frequency_penalty: 0.3,
        }),
      );
    });
  });

  describe('token counting edge cases', () => {
    it('should handle tiktoken import failure with console warning', async () => {
      // Mock tiktoken to fail on import
      vi.doMock('tiktoken', () => {
        throw new Error('Failed to import tiktoken');
      });

      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Test content' }] }],
        model: 'gpt-4',
      };

      const result = await generator.countTokens(request);

      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringMatching(/Failed to load tiktoken.*falling back/),
        expect.any(Error),
      );

      // Should use character approximation
      expect(result.totalTokens).toBeGreaterThan(0);

      consoleSpy.mockRestore();
    });
  });
});

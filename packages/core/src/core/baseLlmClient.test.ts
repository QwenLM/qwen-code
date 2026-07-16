/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type Mocked,
} from 'vitest';

import type { GenerateContentResponse } from '@google/genai';
import { BaseLlmClient, type GenerateJsonOptions } from './baseLlmClient.js';
import type { ContentGenerator } from './contentGenerator.js';
import type { Config } from '../config/config.js';
import { AuthType } from './contentGenerator.js';
import { reportError } from '../utils/errorReporting.js';
import { retryWithBackoff } from '../utils/retry.js';
import { getErrorMessage } from '../utils/errors.js';
import { getFunctionCalls } from '../utils/generateContentResponseUtilities.js';

vi.mock('../utils/errorReporting.js');
vi.mock('../utils/errors.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/errors.js')>();
  return {
    ...actual,
    getErrorMessage: vi.fn((e) => (e instanceof Error ? e.message : String(e))),
  };
});

vi.mock('../utils/generateContentResponseUtilities.js', () => ({
  getFunctionCalls: vi.fn(),
}));

vi.mock('../utils/retry.js', () => ({
  retryWithBackoff: vi.fn(async (fn) => await fn()),
  isUnattendedMode: vi.fn(() => false),
}));

const mockCreateContentGenerator = vi.fn();
vi.mock('./contentGenerator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./contentGenerator.js')>();
  return {
    ...actual,
    createContentGenerator: (
      ...args: Parameters<typeof actual.createContentGenerator>
    ) => mockCreateContentGenerator(...args),
  };
});

const mockBuildAgentContentGeneratorConfig = vi.fn();
vi.mock('../models/content-generator-config.js', () => ({
  buildAgentContentGeneratorConfig: (...args: unknown[]): unknown =>
    mockBuildAgentContentGeneratorConfig(...args),
}));

const mockGenerateContent = vi.fn();
const mockGenerateContentStream = vi.fn();
const mockEmbedContent = vi.fn();

const mockContentGenerator = {
  generateContent: mockGenerateContent,
  generateContentStream: mockGenerateContentStream,
  embedContent: mockEmbedContent,
} as unknown as Mocked<ContentGenerator>;

const mockConfig = {
  getSessionId: vi.fn().mockReturnValue('test-session-id'),
  getContentGeneratorConfig: vi
    .fn()
    .mockReturnValue({ authType: AuthType.USE_GEMINI }),
  getEmbeddingModel: vi.fn().mockReturnValue('test-embedding-model'),
  // Default test model — matches `defaultOptions.model` so resolveForModel
  // returns the constructor-injected ContentGenerator without trying to
  // build a per-model one.
  getModel: vi.fn().mockReturnValue('test-model'),
  getModelsConfig: vi.fn().mockReturnValue(undefined),
} as unknown as Mocked<Config>;

// Helper to create a mock GenerateContentResponse with function call
const createMockResponseWithFunctionCall = (
  args: Record<string, unknown>,
): GenerateContentResponse =>
  ({
    candidates: [
      {
        content: {
          role: 'model',
          parts: [
            {
              functionCall: {
                name: 'respond_in_schema',
                args,
              },
            },
          ],
        },
        index: 0,
      },
    ],
  }) as GenerateContentResponse;

// Helper to create a mock response without function call (for error cases)
const createMockResponseWithoutFunctionCall = (): GenerateContentResponse =>
  ({
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'some text' }],
        },
        index: 0,
      },
    ],
  }) as GenerateContentResponse;

const createMockTextResponse = (text: string): GenerateContentResponse =>
  ({
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text }],
        },
        index: 0,
      },
    ],
  }) as GenerateContentResponse;

// Builds an async generator that yields one response per text delta, then an
// optional trailing usage-only chunk — mirroring how the streaming pipeline
// emits content deltas followed by a final chunk carrying usageMetadata.
async function* mockTextStream(
  chunks: string[],
  usage?: GenerateContentResponse['usageMetadata'],
): AsyncGenerator<GenerateContentResponse> {
  for (const text of chunks) {
    yield createMockTextResponse(text);
  }
  if (usage) {
    yield { usageMetadata: usage } as GenerateContentResponse;
  }
}

describe('BaseLlmClient', () => {
  let client: BaseLlmClient;
  let abortController: AbortController;
  let defaultOptions: GenerateJsonOptions;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      model: 'test-model',
      authType: AuthType.USE_GEMINI,
    });
    // Reset the mocked implementation for getErrorMessage for accurate error message assertions
    vi.mocked(getErrorMessage).mockImplementation((e) =>
      e instanceof Error ? e.message : String(e),
    );
    client = new BaseLlmClient(mockContentGenerator, mockConfig);
    abortController = new AbortController();
    defaultOptions = {
      contents: [{ role: 'user', parts: [{ text: 'Give me a color.' }] }],
      schema: { type: 'object', properties: { color: { type: 'string' } } },
      model: 'test-model',
      abortSignal: abortController.signal,
      promptId: 'test-prompt-id',
    };
  });

  afterEach(() => {
    abortController.abort();
  });

  describe('generateJson - Success Scenarios', () => {
    it('should call generateContent with correct parameters using function declarations', async () => {
      const mockResponse = createMockResponseWithFunctionCall({
        color: 'blue',
      });
      mockGenerateContent.mockResolvedValue(mockResponse);
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { color: 'blue' } },
      ]);

      const result = await client.generateJson(defaultOptions);

      expect(result).toEqual({ color: 'blue' });

      // Ensure the retry mechanism was engaged
      expect(retryWithBackoff).toHaveBeenCalledTimes(1);
      expect(retryWithBackoff).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          maxAttempts: 7,
        }),
      );

      // Validate the parameters passed to the underlying generator
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          contents: defaultOptions.contents,
          config: expect.objectContaining({
            abortSignal: defaultOptions.abortSignal,
            tools: [
              {
                functionDeclarations: [
                  {
                    name: 'respond_in_schema',
                    description: 'Provide the response in provided schema',
                    parameters: defaultOptions.schema,
                  },
                ],
              },
            ],
          }),
        }),
        'test-prompt-id',
      );
    });

    it('should respect configuration overrides', async () => {
      const mockResponse = createMockResponseWithFunctionCall({ color: 'red' });
      mockGenerateContent.mockResolvedValue(mockResponse);
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { color: 'red' } },
      ]);

      const options: GenerateJsonOptions = {
        ...defaultOptions,
        config: { temperature: 0.8, topK: 10 },
      };

      await client.generateJson(options);

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            temperature: 0.8,
            topK: 10,
            tools: expect.any(Array),
          }),
        }),
        expect.any(String),
      );
    });

    it('should include system instructions when provided', async () => {
      const mockResponse = createMockResponseWithFunctionCall({
        color: 'green',
      });
      mockGenerateContent.mockResolvedValue(mockResponse);
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { color: 'green' } },
      ]);
      const systemInstruction = 'You are a helpful assistant.';

      const options: GenerateJsonOptions = {
        ...defaultOptions,
        systemInstruction,
      };

      await client.generateJson(options);

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            systemInstruction,
          }),
        }),
        expect.any(String),
      );
    });

    it('should use the provided promptId', async () => {
      const mockResponse = createMockResponseWithFunctionCall({
        color: 'yellow',
      });
      mockGenerateContent.mockResolvedValue(mockResponse);
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { color: 'yellow' } },
      ]);
      const customPromptId = 'custom-id-123';

      const options: GenerateJsonOptions = {
        ...defaultOptions,
        promptId: customPromptId,
      };

      await client.generateJson(options);

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.any(Object),
        customPromptId,
      );
    });

    it('should pass maxAttempts to retryWithBackoff when provided', async () => {
      const mockResponse = createMockResponseWithFunctionCall({
        color: 'cyan',
      });
      mockGenerateContent.mockResolvedValue(mockResponse);
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { color: 'cyan' } },
      ]);
      const customMaxAttempts = 3;

      const options: GenerateJsonOptions = {
        ...defaultOptions,
        maxAttempts: customMaxAttempts,
      };

      await client.generateJson(options);

      expect(retryWithBackoff).toHaveBeenCalledTimes(1);
      expect(retryWithBackoff).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          maxAttempts: customMaxAttempts,
        }),
      );
    });

    it('should call retryWithBackoff with default maxAttempts when not provided', async () => {
      const mockResponse = createMockResponseWithFunctionCall({
        color: 'indigo',
      });
      mockGenerateContent.mockResolvedValue(mockResponse);
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { color: 'indigo' } },
      ]);

      // No maxAttempts in defaultOptions
      await client.generateJson(defaultOptions);

      expect(retryWithBackoff).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          maxAttempts: 7,
        }),
      );
    });

    it('should pass configured retry error codes to retryWithBackoff', async () => {
      const retryErrorCodes = [4999];
      mockConfig.getContentGeneratorConfig.mockReturnValue({
        model: 'test-model',
        authType: AuthType.USE_GEMINI,
        retryErrorCodes,
      });
      const mockResponse = createMockResponseWithFunctionCall({
        color: 'green',
      });
      mockGenerateContent.mockResolvedValue(mockResponse);
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { color: 'green' } },
      ]);

      await client.generateJson(defaultOptions);

      expect(retryWithBackoff).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          extraRetryErrorCodes: retryErrorCodes,
        }),
      );
    });

    it('should return empty object when no function calls are returned', async () => {
      const mockResponse = createMockResponseWithoutFunctionCall();
      mockGenerateContent.mockResolvedValue(mockResponse);
      vi.mocked(getFunctionCalls).mockReturnValue(undefined);

      const result = await client.generateJson(defaultOptions);

      expect(result).toEqual({});
    });

    it('should parse a loose JSON object from text when no function call is returned', async () => {
      mockGenerateContent.mockResolvedValue(
        createMockTextResponse('Result:\n{"color":"purple","count":2}\nDone.'),
      );
      vi.mocked(getFunctionCalls).mockReturnValue(undefined);

      const result = await client.generateJson(defaultOptions);

      expect(result).toEqual({ color: 'purple', count: 2 });
    });

    it('should parse fenced JSON text when no function call is returned', async () => {
      mockGenerateContent.mockResolvedValue(
        createMockTextResponse('```json\n{"color":"orange"}\n```'),
      );
      vi.mocked(getFunctionCalls).mockReturnValue(undefined);

      const result = await client.generateJson(defaultOptions);

      expect(result).toEqual({ color: 'orange' });
    });

    it('should ignore malformed loose JSON text', async () => {
      mockGenerateContent.mockResolvedValue(
        createMockTextResponse('```json\n{"color":\n```'),
      );
      vi.mocked(getFunctionCalls).mockReturnValue(undefined);

      const result = await client.generateJson(defaultOptions);

      expect(result).toEqual({});
    });

    it('should reject loose JSON arrays', async () => {
      mockGenerateContent.mockResolvedValue(
        createMockTextResponse('[{"color":"blue"}]'),
      );
      vi.mocked(getFunctionCalls).mockReturnValue(undefined);

      const result = await client.generateJson(defaultOptions);

      expect(result).toEqual({});
    });
  });

  describe('generateJson - Error Handling', () => {
    it('should throw and report generic API errors', async () => {
      const apiError = new Error('Service Unavailable (503)');
      // Simulate the generator failing
      mockGenerateContent.mockRejectedValue(apiError);

      await expect(client.generateJson(defaultOptions)).rejects.toThrow(
        'Failed to generate JSON content (test-prompt-id): Service Unavailable (503)',
      );

      // Verify generic error reporting
      expect(reportError).toHaveBeenCalledTimes(1);
      expect(reportError).toHaveBeenCalledWith(
        apiError,
        'Error generating JSON content via API.',
        defaultOptions.contents,
        'generateJson-api',
      );
    });

    it('should throw immediately without reporting if aborted', async () => {
      const abortError = new DOMException('Aborted', 'AbortError');

      // Simulate abortion happening during the API call
      mockGenerateContent.mockImplementation(() => {
        abortController.abort(); // Ensure the signal is aborted when the service checks
        throw abortError;
      });

      const options = {
        ...defaultOptions,
        abortSignal: abortController.signal,
      };

      await expect(client.generateJson(options)).rejects.toThrow(abortError);

      // Crucially, it should not report a cancellation as an application error
      expect(reportError).not.toHaveBeenCalled();
    });

    it('should not throw for empty response message check', async () => {
      const emptyResponseError = new Error(
        'API returned an empty response for generateJson.',
      );
      mockGenerateContent.mockRejectedValue(emptyResponseError);

      await expect(client.generateJson(defaultOptions)).rejects.toThrow(
        'API returned an empty response for generateJson.',
      );

      // Should not double-report this specific error
      expect(reportError).not.toHaveBeenCalled();
    });
  });

  describe('generateEmbedding', () => {
    const texts = ['hello world', 'goodbye world'];
    const testEmbeddingModel = 'test-embedding-model';

    it('should call embedContent with correct parameters and return embeddings', async () => {
      const mockEmbeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      mockEmbedContent.mockResolvedValue({
        embeddings: [
          { values: mockEmbeddings[0] },
          { values: mockEmbeddings[1] },
        ],
      });

      const result = await client.generateEmbedding(texts);

      expect(mockEmbedContent).toHaveBeenCalledTimes(1);
      expect(mockEmbedContent).toHaveBeenCalledWith({
        model: testEmbeddingModel,
        contents: texts,
      });
      expect(result).toEqual(mockEmbeddings);
    });

    it('should return an empty array if an empty array is passed', async () => {
      const result = await client.generateEmbedding([]);
      expect(result).toEqual([]);
      expect(mockEmbedContent).not.toHaveBeenCalled();
    });

    it('should throw an error if API response has no embeddings array', async () => {
      mockEmbedContent.mockResolvedValue({});

      await expect(client.generateEmbedding(texts)).rejects.toThrow(
        'No embeddings found in API response.',
      );
    });

    it('should throw an error if API response has an empty embeddings array', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [],
      });

      await expect(client.generateEmbedding(texts)).rejects.toThrow(
        'No embeddings found in API response.',
      );
    });

    it('should throw an error if API returns a mismatched number of embeddings', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [1, 2, 3] }], // Only one for two texts
      });

      await expect(client.generateEmbedding(texts)).rejects.toThrow(
        'API returned a mismatched number of embeddings. Expected 2, got 1.',
      );
    });

    it('should throw an error if any embedding has nullish values', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [1, 2, 3] }, { values: undefined }], // Second one is bad
      });

      await expect(client.generateEmbedding(texts)).rejects.toThrow(
        'API returned an empty embedding for input text at index 1: "goodbye world"',
      );
    });

    it('should throw an error if any embedding has an empty values array', async () => {
      mockEmbedContent.mockResolvedValue({
        embeddings: [{ values: [] }, { values: [1, 2, 3] }], // First one is bad
      });

      await expect(client.generateEmbedding(texts)).rejects.toThrow(
        'API returned an empty embedding for input text at index 0: "hello world"',
      );
    });

    it('should propagate errors from the API call', async () => {
      mockEmbedContent.mockRejectedValue(new Error('API Failure'));

      await expect(client.generateEmbedding(texts)).rejects.toThrow(
        'API Failure',
      );
    });
  });

  describe('generateText - streaming', () => {
    it('routes through generateContentStream, concatenates deltas, trims once, and captures final-chunk usage', async () => {
      const usage = {
        promptTokenCount: 11,
        candidatesTokenCount: 7,
        totalTokenCount: 18,
      };
      mockGenerateContentStream.mockImplementation(async () =>
        mockTextStream(['  Hello', ', ', 'world  '], usage),
      );

      const result = await client.generateText({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        model: 'test-model',
        abortSignal: abortController.signal,
        promptId: 'p',
        stream: true,
      });

      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
      // The streaming branch builds the same request object as the non-stream
      // path: resolved model, contents, and a config carrying the abortSignal.
      expect(mockGenerateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          config: expect.objectContaining({
            abortSignal: abortController.signal,
          }),
        }),
        'p',
      );
      expect(mockGenerateContent).not.toHaveBeenCalled();
      // Deltas are concatenated, then trimmed once at the end.
      expect(result.text).toBe('Hello, world');
      expect(result.usage).toEqual(usage);
    });

    it('drops thought parts and tolerates a stream that omits usage', async () => {
      async function* streamWithThought(): AsyncGenerator<GenerateContentResponse> {
        yield createMockTextResponse('answer');
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'reasoning', thought: true }],
              },
              index: 0,
            },
          ],
        } as unknown as GenerateContentResponse;
      }
      mockGenerateContentStream.mockImplementation(async () =>
        streamWithThought(),
      );

      const result = await client.generateText({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        model: 'test-model',
        abortSignal: abortController.signal,
        promptId: 'p',
        stream: true,
      });

      expect(result.text).toBe('answer');
      expect(result.usage).toBeUndefined();
    });

    it('does not stream when stream is omitted (non-streaming path, still trimmed)', async () => {
      mockGenerateContent.mockResolvedValue(
        createMockTextResponse('  plain  '),
      );

      const result = await client.generateText({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        model: 'test-model',
        abortSignal: abortController.signal,
        promptId: 'p',
      });

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContentStream).not.toHaveBeenCalled();
      expect(result.text).toBe('plain');
    });

    it('propagates a mid-stream error and never returns the partial text', async () => {
      async function* failingStream(): AsyncGenerator<GenerateContentResponse> {
        yield createMockTextResponse('partial');
        throw new Error('connection reset');
      }
      mockGenerateContentStream.mockImplementation(async () => failingStream());

      // A failure after some deltas have arrived rejects the whole call — the
      // accumulated 'partial' text is never surfaced as a success — and, since
      // the signal isn't aborted, the error is reported like the non-streaming
      // path. This is the gateway-timeout-mid-inference scenario the PR targets.
      await expect(
        client.generateText({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          model: 'test-model',
          abortSignal: abortController.signal,
          promptId: 'p',
          stream: true,
        }),
      ).rejects.toThrow('connection reset');
      expect(vi.mocked(reportError)).toHaveBeenCalled();
    });

    it('surfaces an abort that fires mid-stream and skips error reporting', async () => {
      async function* abortingStream(): AsyncGenerator<GenerateContentResponse> {
        yield createMockTextResponse('chunk');
        abortController.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      mockGenerateContentStream.mockImplementation(async () =>
        abortingStream(),
      );

      // The `abortSignal.aborted` guard in the catch block rethrows the original
      // error unwrapped and skips reportError, so a user-initiated cancellation
      // mid-stream surfaces verbatim and is not logged as an API failure.
      await expect(
        client.generateText({
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          model: 'test-model',
          abortSignal: abortController.signal,
          promptId: 'p',
          stream: true,
        }),
      ).rejects.toThrow('The operation was aborted.');
      expect(vi.mocked(reportError)).not.toHaveBeenCalled();
    });

    it('returns an empty result for a stream that yields no chunks', async () => {
      // A stream that closes immediately (no content, no usage) must resolve to
      // an empty string rather than throw — the boundary the streaming branch
      // introduces. mockTextStream([]) yields nothing.
      mockGenerateContentStream.mockImplementation(async () =>
        mockTextStream([]),
      );

      const result = await client.generateText({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        model: 'test-model',
        abortSignal: abortController.signal,
        promptId: 'p',
        stream: true,
      });

      expect(result.text).toBe('');
      expect(result.usage).toBeUndefined();
    });

    it('captures usage that rides the final content-bearing chunk', async () => {
      // Realistic Gemini/OpenAI shape: usageMetadata arrives on the last chunk
      // that *also* carries a text delta. Text and usage are read independently
      // per chunk, so the trailing text must not be dropped when usage is read.
      const usage = {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8,
      };
      async function* usageOnTextChunk(): AsyncGenerator<GenerateContentResponse> {
        yield createMockTextResponse('Hello, ');
        const finalChunk = createMockTextResponse('world');
        finalChunk.usageMetadata = usage;
        yield finalChunk;
      }
      mockGenerateContentStream.mockImplementation(async () =>
        usageOnTextChunk(),
      );

      const result = await client.generateText({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        model: 'test-model',
        abortSignal: abortController.signal,
        promptId: 'p',
        stream: true,
      });

      expect(result.text).toBe('Hello, world');
      expect(result.usage).toEqual(usage);
    });
  });

  describe('per-model resolution', () => {
    const fastModel = 'fast-model';
    const fastGenerateContent = vi.fn();
    const fastGenerateContentStream = vi.fn();
    const fastContentGenerator = {
      generateContent: fastGenerateContent,
      generateContentStream: fastGenerateContentStream,
      embedContent: vi.fn(),
    } as unknown as Mocked<ContentGenerator>;

    const getResolvedModel = vi.fn();
    let crossProviderConfig: Mocked<Config>;

    beforeEach(() => {
      vi.mocked(retryWithBackoff).mockImplementation(
        async (fn) => await (fn as () => Promise<unknown>)(),
      );
      fastGenerateContent.mockReset();
      fastGenerateContentStream.mockReset();
      mockCreateContentGenerator.mockReset();
      mockBuildAgentContentGeneratorConfig.mockReset();
      getResolvedModel.mockReset();

      mockCreateContentGenerator.mockResolvedValue(fastContentGenerator);
      mockBuildAgentContentGeneratorConfig.mockReturnValue({
        model: fastModel,
        authType: AuthType.USE_ANTHROPIC,
      });

      crossProviderConfig = {
        getSessionId: vi.fn().mockReturnValue('test-session-id'),
        getContentGeneratorConfig: vi
          .fn()
          .mockReturnValue({ authType: AuthType.QWEN_OAUTH }),
        getEmbeddingModel: vi.fn().mockReturnValue('test-embedding-model'),
        getModel: vi.fn().mockReturnValue('main-model'),
        getFastModel: vi.fn().mockReturnValue(undefined),
        getAllConfiguredModels: vi.fn((authTypes?: AuthType[]) =>
          authTypes?.includes(AuthType.QWEN_OAUTH)
            ? []
            : [
                {
                  id: fastModel,
                  authType: AuthType.USE_ANTHROPIC,
                },
              ],
        ),
        getModelsConfig: vi.fn().mockReturnValue({ getResolvedModel }),
      } as unknown as Mocked<Config>;
    });

    it('returns the constructor-injected generator when model matches main', async () => {
      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      const resolved = await c.resolveForModel('main-model');

      expect(resolved.contentGenerator).toBe(mockContentGenerator);
      expect(resolved.retryAuthType).toBe(AuthType.QWEN_OAUTH);
      expect(getResolvedModel).not.toHaveBeenCalled();
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('returns the active runtime generator when model matches the runtime view', async () => {
      const runtimeContentGenerator = {
        generateContent: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as Mocked<ContentGenerator>;
      crossProviderConfig.getContentGenerator = vi
        .fn()
        .mockReturnValue(runtimeContentGenerator);
      vi.mocked(crossProviderConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_OPENAI,
        model: 'runtime-model',
      });
      vi.mocked(crossProviderConfig.getModel).mockReturnValue('runtime-model');
      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      const resolved = await c.resolveForModel('runtime-model');

      expect(resolved.contentGenerator).toBe(runtimeContentGenerator);
      expect(resolved.retryAuthType).toBe(AuthType.USE_OPENAI);
      expect(getResolvedModel).not.toHaveBeenCalled();
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('builds a per-model generator when model differs and is registered under another authType', async () => {
      // Main authType is QWEN_OAUTH; fast model only resolves under USE_ANTHROPIC.
      getResolvedModel.mockImplementation((authType: string, model: string) => {
        if (authType === AuthType.QWEN_OAUTH) return undefined;
        if (authType === AuthType.USE_ANTHROPIC && model === fastModel) {
          return {
            authType: AuthType.USE_ANTHROPIC,
            envKey: 'ANTHROPIC_API_KEY',
            baseUrl: 'https://api.anthropic.com',
          };
        }
        return undefined;
      });

      const targetConfig = {
        model: fastModel,
        authType: AuthType.USE_ANTHROPIC,
      };
      mockBuildAgentContentGeneratorConfig.mockReturnValue(targetConfig);
      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      const resolved = await c.resolveForModel(fastModel);

      expect(resolved.contentGenerator).toBe(fastContentGenerator);
      expect(resolved.contentGeneratorConfig).toBe(targetConfig);
      expect(resolved.retryAuthType).toBe(AuthType.USE_ANTHROPIC);
      expect(mockBuildAgentContentGeneratorConfig).toHaveBeenCalledWith(
        crossProviderConfig,
        fastModel,
        expect.objectContaining({
          authType: AuthType.USE_ANTHROPIC,
          baseUrl: 'https://api.anthropic.com',
        }),
      );
      expect(mockCreateContentGenerator).toHaveBeenCalledTimes(1);
    });

    it('does not confuse a qualified cross-provider namesake with the primary', async () => {
      vi.mocked(crossProviderConfig.getModel).mockReturnValue('shared-model');
      getResolvedModel.mockImplementation((authType: string, model: string) =>
        authType === AuthType.USE_ANTHROPIC && model === 'shared-model'
          ? {
              id: 'shared-model',
              authType: AuthType.USE_ANTHROPIC,
              baseUrl: '',
            }
          : undefined,
      );

      const resolved = await new BaseLlmClient(
        mockContentGenerator,
        crossProviderConfig,
      ).resolveForModel('anthropic:shared-model', { failClosed: true });

      expect(resolved.contentGenerator).toBe(fastContentGenerator);
      expect(mockCreateContentGenerator).toHaveBeenCalledOnce();
    });

    it('keeps explicit vision capability on the resolved generator config', async () => {
      getResolvedModel.mockImplementation((authType: string, model: string) =>
        authType === AuthType.USE_ANTHROPIC && model === fastModel
          ? {
              id: fastModel,
              authType: AuthType.USE_ANTHROPIC,
              baseUrl: 'https://api.anthropic.com',
              capabilities: { vision: true },
            }
          : undefined,
      );
      mockBuildAgentContentGeneratorConfig.mockReturnValue({
        model: fastModel,
        authType: AuthType.USE_ANTHROPIC,
        modalities: {},
      });

      const resolved = await new BaseLlmClient(
        mockContentGenerator,
        crossProviderConfig,
      ).resolveForModel(fastModel, { failClosed: true });

      expect(resolved.contentGeneratorConfig.modalities?.image).toBe(true);
      expect(mockCreateContentGenerator).toHaveBeenCalledWith(
        expect.objectContaining({ modalities: { image: true } }),
        crossProviderConfig,
      );
    });

    it('resolves same-id model selectors by baseUrl when provided', async () => {
      const selectedBaseUrl = 'https://token-plan.example.com/v1';
      getResolvedModel.mockImplementation(
        (authType: string, model: string, baseUrl?: string) => {
          if (
            authType === AuthType.USE_OPENAI &&
            model === 'qwen3.7-plus' &&
            baseUrl === selectedBaseUrl
          ) {
            return {
              id: 'qwen3.7-plus',
              authType: AuthType.USE_OPENAI,
              envKey: 'TOKEN_PLAN_KEY',
              baseUrl: selectedBaseUrl,
            };
          }
          return undefined;
        },
      );

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);
      const resolved = await c.resolveForModel(
        `openai:qwen3.7-plus\0${selectedBaseUrl}`,
      );

      expect(resolved.contentGenerator).toBe(fastContentGenerator);
      expect(getResolvedModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3.7-plus',
        selectedBaseUrl,
      );
      expect(mockBuildAgentContentGeneratorConfig).toHaveBeenCalledWith(
        crossProviderConfig,
        'qwen3.7-plus',
        expect.objectContaining({
          authType: AuthType.USE_OPENAI,
          baseUrl: selectedBaseUrl,
        }),
      );
    });

    it('threads baseUrl through bare model registry lookups', async () => {
      const selectedBaseUrl = 'https://token-plan.example.com/v1';
      getResolvedModel.mockImplementation(
        (authType: string, model: string, baseUrl?: string) => {
          if (
            authType === AuthType.USE_ANTHROPIC &&
            model === 'qwen3.7-plus' &&
            baseUrl === selectedBaseUrl
          ) {
            return {
              id: 'qwen3.7-plus',
              authType: AuthType.USE_ANTHROPIC,
              envKey: 'TOKEN_PLAN_KEY',
              baseUrl: selectedBaseUrl,
            };
          }
          return undefined;
        },
      );

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);
      await c.resolveForModel(`qwen3.7-plus\0${selectedBaseUrl}`);

      expect(getResolvedModel).toHaveBeenCalledWith(
        AuthType.QWEN_OAUTH,
        'qwen3.7-plus',
        selectedBaseUrl,
      );
    });

    it('does not reuse the main generator when the requested baseUrl differs', async () => {
      const mainBaseUrl = 'https://main.example.com/v1';
      const selectedBaseUrl = 'https://token-plan.example.com/v1';
      vi.mocked(crossProviderConfig.getModel).mockReturnValue('qwen3.7-plus');
      vi.mocked(crossProviderConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-plus',
        baseUrl: mainBaseUrl,
      });
      getResolvedModel.mockImplementation(
        (authType: string, model: string, baseUrl?: string) => {
          if (
            authType === AuthType.USE_OPENAI &&
            model === 'qwen3.7-plus' &&
            baseUrl === selectedBaseUrl
          ) {
            return {
              id: 'qwen3.7-plus',
              authType: AuthType.USE_OPENAI,
              envKey: 'TOKEN_PLAN_KEY',
              baseUrl: selectedBaseUrl,
            };
          }
          return undefined;
        },
      );

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);
      const resolved = await c.resolveForModel(
        `openai:qwen3.7-plus\0${selectedBaseUrl}`,
      );

      expect(resolved.contentGenerator).toBe(fastContentGenerator);
      expect(mockCreateContentGenerator).toHaveBeenCalledTimes(1);
      expect(getResolvedModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3.7-plus',
        selectedBaseUrl,
      );
    });

    it('fails closed (throws) for an unregistered model when failClosed is set', async () => {
      getResolvedModel.mockReturnValue(undefined); // not registered anywhere
      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      await expect(
        c.resolveForModel('ghost-model', { failClosed: true }),
      ).rejects.toThrow(/not registered/i);
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('fails closed when the requested baseUrl does not match any registered model', async () => {
      getResolvedModel.mockReturnValue(undefined);
      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      await expect(
        c.resolveForModel('openai:real-model\0https://wrong-url.example.com', {
          failClosed: true,
        }),
      ).rejects.toThrow(
        'Model "openai:real-model" at baseUrl "https://wrong-url.example.com" is not registered',
      );
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('fails closed (throws) when generator creation fails and failClosed is set', async () => {
      getResolvedModel.mockImplementation((authType: string, model: string) =>
        authType === AuthType.USE_ANTHROPIC && model === fastModel
          ? {
              authType: AuthType.USE_ANTHROPIC,
              envKey: 'ANTHROPIC_API_KEY',
              baseUrl: 'https://api.anthropic.com',
            }
          : undefined,
      );
      mockCreateContentGenerator.mockRejectedValue(
        new Error('missing credential'),
      );
      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      await expect(
        c.resolveForModel(fastModel, { failClosed: true }),
      ).rejects.toThrow(/missing credential/i);
    });

    it('falls back to the main generator for an unregistered model when failClosed is not set', async () => {
      getResolvedModel.mockReturnValue(undefined);
      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      const resolved = await c.resolveForModel('ghost-model');

      expect(resolved.contentGenerator).toBe(mockContentGenerator);
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('streams through a per-model generator resolved by model (compression path)', async () => {
      // chatCompressionService passes both `model` and `stream: true`, so the
      // streaming branch must run on the resolveForModel-selected generator,
      // not the constructor-injected default.
      getResolvedModel.mockReturnValue({
        authType: AuthType.USE_ANTHROPIC,
        envKey: 'ANTHROPIC_API_KEY',
      });
      const usage = {
        promptTokenCount: 2,
        candidatesTokenCount: 2,
        totalTokenCount: 4,
      };
      fastGenerateContentStream.mockImplementation(async () =>
        mockTextStream(['fast ', 'stream'], usage),
      );

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);
      const result = await c.generateText({
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        model: fastModel,
        abortSignal: abortController.signal,
        promptId: 'p',
        stream: true,
      });

      expect(fastGenerateContentStream).toHaveBeenCalledTimes(1);
      // Streamed against the resolved per-model identity, not the main model.
      expect(fastGenerateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          model: fastModel,
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
          config: expect.objectContaining({
            abortSignal: abortController.signal,
          }),
        }),
        'p',
      );
      // The constructor-injected default generator must not be touched.
      expect(mockGenerateContentStream).not.toHaveBeenCalled();
      expect(result.text).toBe('fast stream');
      expect(result.usage).toEqual(usage);
    });

    it('caches the per-model generator across resolveForModel calls', async () => {
      getResolvedModel.mockReturnValue({
        authType: AuthType.USE_ANTHROPIC,
        envKey: 'ANTHROPIC_API_KEY',
      });

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      await c.resolveForModel(fastModel);
      await c.resolveForModel(fastModel);

      expect(mockCreateContentGenerator).toHaveBeenCalledTimes(1);
    });

    it('clearPerModelGeneratorCache forces a rebuild on the next call', async () => {
      getResolvedModel.mockReturnValue({
        authType: AuthType.USE_ANTHROPIC,
        envKey: 'ANTHROPIC_API_KEY',
      });

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);
      await c.resolveForModel(fastModel);
      c.clearPerModelGeneratorCache();
      await c.resolveForModel(fastModel);

      expect(mockCreateContentGenerator).toHaveBeenCalledTimes(2);
    });

    it('falls back to the main generator when the target model is not in the registry', async () => {
      getResolvedModel.mockReturnValue(undefined);

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);
      const resolved = await c.resolveForModel('unknown-model');

      expect(resolved.contentGenerator).toBe(mockContentGenerator);
      // Falls back to main authType for retry classification.
      expect(resolved.retryAuthType).toBe(AuthType.QWEN_OAUTH);
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('does not cache the unregistered-model fallback across runtime-view changes', async () => {
      // Unregistered selector: createContentGeneratorForModel falls back to
      // getCurrentContentGenerator(). The runtime view changes between calls
      // — caching would pin the first call's generator under the selector
      // key and return it on the second call after the view has unwound.
      getResolvedModel.mockReturnValue(undefined);

      const firstRuntimeGenerator = {
        generateContent: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as Mocked<ContentGenerator>;
      const secondRuntimeGenerator = {
        generateContent: vi.fn(),
        embedContent: vi.fn(),
      } as unknown as Mocked<ContentGenerator>;
      const getContentGenerator = vi
        .fn()
        .mockReturnValueOnce(firstRuntimeGenerator)
        .mockReturnValueOnce(secondRuntimeGenerator);
      crossProviderConfig.getContentGenerator = getContentGenerator;

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      const first = await c.resolveForModel('unknown-model');
      const second = await c.resolveForModel('unknown-model');

      expect(first.contentGenerator).toBe(firstRuntimeGenerator);
      expect(second.contentGenerator).toBe(secondRuntimeGenerator);
      expect(getContentGenerator).toHaveBeenCalledTimes(2);
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('falls back to the main generator when createContentGenerator throws', async () => {
      getResolvedModel.mockReturnValue({
        authType: AuthType.USE_ANTHROPIC,
        envKey: 'ANTHROPIC_API_KEY',
      });
      mockCreateContentGenerator.mockRejectedValue(
        new Error('SDK init failed'),
      );

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);
      const resolved = await c.resolveForModel(fastModel);

      expect(resolved.contentGenerator).toBe(mockContentGenerator);
      // retryAuthType still reflects the target provider — failure to build
      // the generator does not change which provider's retry policy applies.
      expect(resolved.retryAuthType).toBe(AuthType.USE_ANTHROPIC);
    });

    it('generateJson routes through the per-model generator and forwards retry authType', async () => {
      const retryErrorCodes = [4999];
      getResolvedModel.mockReturnValue({
        authType: AuthType.USE_ANTHROPIC,
        envKey: 'ANTHROPIC_API_KEY',
        generationConfig: {
          retryErrorCodes,
        },
      });
      fastGenerateContent.mockResolvedValue(
        createMockResponseWithFunctionCall({ ok: true }),
      );
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { ok: true } },
      ]);

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      await c.generateJson({
        contents: [{ role: 'user', parts: [{ text: 'go' }] }],
        schema: { type: 'object' },
        model: fastModel,
        abortSignal: new AbortController().signal,
        promptId: 'test',
      });

      expect(fastGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(retryWithBackoff).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({
          authType: AuthType.USE_ANTHROPIC,
          extraRetryErrorCodes: retryErrorCodes,
        }),
      );
    });

    it('generateJson accepts authType-qualified selectors and sends the bare model id', async () => {
      getResolvedModel.mockImplementation((authType: string, model: string) => {
        if (authType === AuthType.USE_OPENAI && model === 'shared-model') {
          return {
            id: 'shared-model',
            authType: AuthType.USE_OPENAI,
            envKey: 'OPENAI_API_KEY',
          };
        }
        return undefined;
      });
      fastGenerateContent.mockResolvedValue(
        createMockResponseWithFunctionCall({ ok: true }),
      );
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { ok: true } },
      ]);

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      await c.generateJson({
        contents: [{ role: 'user', parts: [{ text: 'go' }] }],
        schema: { type: 'object' },
        model: 'openai:shared-model',
        abortSignal: new AbortController().signal,
        promptId: 'test',
      });

      expect(getResolvedModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'shared-model',
      );
      expect(mockBuildAgentContentGeneratorConfig).toHaveBeenCalledWith(
        crossProviderConfig,
        'shared-model',
        expect.objectContaining({ authType: AuthType.USE_OPENAI }),
      );
      expect(fastGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'shared-model' }),
        'test',
      );
    });

    it('generateJson resolves fast selectors through the configured fast model', async () => {
      crossProviderConfig.getFastModel.mockReturnValue('openai:shared-model');
      getResolvedModel.mockImplementation((authType: string, model: string) => {
        if (authType === AuthType.USE_OPENAI && model === 'shared-model') {
          return {
            id: 'shared-model',
            authType: AuthType.USE_OPENAI,
            envKey: 'OPENAI_API_KEY',
          };
        }
        return undefined;
      });
      fastGenerateContent.mockResolvedValue(
        createMockResponseWithFunctionCall({ ok: true }),
      );
      vi.mocked(getFunctionCalls).mockReturnValue([
        { name: 'respond_in_schema', args: { ok: true } },
      ]);

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      await c.generateJson({
        contents: [{ role: 'user', parts: [{ text: 'go' }] }],
        schema: { type: 'object' },
        model: 'fast',
        abortSignal: new AbortController().signal,
        promptId: 'test',
      });

      expect(getResolvedModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'shared-model',
      );
      expect(mockBuildAgentContentGeneratorConfig).toHaveBeenCalledWith(
        crossProviderConfig,
        'shared-model',
        expect.objectContaining({ authType: AuthType.USE_OPENAI }),
      );
      expect(fastGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'shared-model' }),
        'test',
      );
    });

    it('generateText routes through the per-model generator and forwards retry authType', async () => {
      getResolvedModel.mockReturnValue({
        authType: AuthType.USE_ANTHROPIC,
        envKey: 'ANTHROPIC_API_KEY',
      });
      fastGenerateContent.mockResolvedValue({
        candidates: [
          { content: { role: 'model', parts: [{ text: 'hi' }] }, index: 0 },
        ],
      });

      const c = new BaseLlmClient(mockContentGenerator, crossProviderConfig);

      const result = await c.generateText({
        contents: [{ role: 'user', parts: [{ text: 'say hi' }] }],
        model: fastModel,
        abortSignal: new AbortController().signal,
        promptId: 'test',
      });

      expect(result.text).toBe('hi');
      expect(fastGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expect(retryWithBackoff).toHaveBeenCalledWith(
        expect.any(Function),
        expect.objectContaining({ authType: AuthType.USE_ANTHROPIC }),
      );
    });
  });
});

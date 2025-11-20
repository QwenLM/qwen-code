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
}));

const mockGenerateContent = vi.fn();
const mockEmbedContent = vi.fn();

const mockContentGenerator = {
  generateContent: mockGenerateContent,
  embedContent: mockEmbedContent,
} as unknown as Mocked<ContentGenerator>;

const mockConfig = {
  getSessionId: vi.fn().mockReturnValue('test-session-id'),
  getContentGeneratorConfig: vi
    .fn()
    .mockReturnValue({ authType: AuthType.USE_GEMINI }),
  getEmbeddingModel: vi.fn().mockReturnValue('test-embedding-model'),
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

describe('BaseLlmClient', () => {
  let client: BaseLlmClient;
  let abortController: AbortController;
  let defaultOptions: GenerateJsonOptions;

  beforeEach(() => {
    vi.clearAllMocks();
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
          maxAttempts: 5,
        }),
      );

      // Validate the parameters passed to the underlying generator
      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContent).toHaveBeenCalledWith(
        {
          model: 'test-model',
          contents: defaultOptions.contents,
          config: {
            abortSignal: defaultOptions.abortSignal,
            temperature: 0,
            topP: 1,
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
            // Crucial: systemInstruction should NOT be in the config object if not provided
          },
        },
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
            topP: 1, // Default should remain if not overridden
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
          maxAttempts: 5,
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
  });

  describe('generateJson - Error Handling', () => {
    it('should throw and report generic API errors', async () => {
      const apiError = new Error('Service Unavailable (503)');
      // Simulate the generator failing
      mockGenerateContent.mockRejectedValue(apiError);

      await expect(client.generateJson(defaultOptions)).rejects.toThrow(
        'Failed to generate JSON content: Service Unavailable (503)',
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
});

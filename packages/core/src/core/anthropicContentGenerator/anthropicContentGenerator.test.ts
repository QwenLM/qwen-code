/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CountTokensParameters,
  GenerateContentParameters,
} from '@google/genai';
import { FinishReason, GenerateContentResponse } from '@google/genai';

// Mock the request tokenizer module BEFORE importing the class that uses it.
const mockTokenizer = {
  calculateTokens: vi.fn(),
  dispose: vi.fn(),
};

vi.mock('../../utils/request-tokenizer/index.js', () => ({
  getDefaultTokenizer: vi.fn(() => mockTokenizer),
  DefaultRequestTokenizer: vi.fn(() => mockTokenizer),
  disposeDefaultTokenizer: vi.fn(),
}));

type AnthropicCreateArgs = [unknown, { signal?: AbortSignal }?];

const anthropicMockState: {
  constructorOptions?: Record<string, unknown>;
  lastCreateArgs?: AnthropicCreateArgs;
  createImpl: ReturnType<typeof vi.fn>;
} = {
  constructorOptions: undefined,
  lastCreateArgs: undefined,
  createImpl: vi.fn(),
};

vi.mock('@anthropic-ai/sdk', () => {
  class AnthropicMock {
    messages: { create: (...args: AnthropicCreateArgs) => unknown };

    constructor(options: Record<string, unknown>) {
      anthropicMockState.constructorOptions = options;
      this.messages = {
        create: (...args: AnthropicCreateArgs) => {
          anthropicMockState.lastCreateArgs = args;
          return anthropicMockState.createImpl(...args);
        },
      };
    }
  }

  return {
    default: AnthropicMock,
    __anthropicState: anthropicMockState,
  };
});

// Now import the modules that depend on the mocked modules.
import type { Config } from '../../config/config.js';

const importGenerator = async (): Promise<{
  AnthropicContentGenerator: typeof import('./anthropicContentGenerator.js').AnthropicContentGenerator;
}> => import('./anthropicContentGenerator.js');

const importConverter = async (): Promise<{
  AnthropicContentConverter: typeof import('./converter.js').AnthropicContentConverter;
}> => import('./converter.js');

describe('AnthropicContentGenerator', () => {
  let mockConfig: Config;
  let anthropicState: {
    constructorOptions?: Record<string, unknown>;
    lastCreateArgs?: AnthropicCreateArgs;
    createImpl: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    mockTokenizer.calculateTokens.mockResolvedValue({
      totalTokens: 50,
      breakdown: {
        textTokens: 50,
        imageTokens: 0,
        audioTokens: 0,
        otherTokens: 0,
      },
      processingTime: 1,
    });
    anthropicState = anthropicMockState;

    anthropicState.createImpl.mockReset();
    anthropicState.lastCreateArgs = undefined;
    anthropicState.constructorOptions = undefined;

    mockConfig = {
      getCliVersion: vi.fn().mockReturnValue('1.2.3'),
    } as unknown as Config;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('passes a QwenCode User-Agent header to the Anthropic SDK', async () => {
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-test',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
      },
      mockConfig,
    );

    const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
      {}) as Record<string, string>;
    expect(headers['User-Agent']).toContain('QwenCode/1.2.3');
    expect(headers['User-Agent']).toContain(
      `(${process.platform}; ${process.arch})`,
    );
  });

  it('adds the effort beta header when reasoning.effort is set', async () => {
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-test',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
        reasoning: { effort: 'medium' },
      },
      mockConfig,
    );

    const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
      {}) as Record<string, string>;
    expect(headers['anthropic-beta']).toContain('effort-2025-11-24');
  });

  it('does not add the effort beta header when reasoning.effort is not set', async () => {
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-test',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
      },
      mockConfig,
    );

    const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
      {}) as Record<string, string>;
    expect(headers['anthropic-beta']).not.toContain('effort-2025-11-24');
  });

  it('omits the anthropic beta header when reasoning is disabled', async () => {
    const { AnthropicContentGenerator } = await importGenerator();
    void new AnthropicContentGenerator(
      {
        model: 'claude-test',
        apiKey: 'test-key',
        baseUrl: 'https://example.invalid',
        timeout: 10_000,
        maxRetries: 2,
        samplingParams: {},
        schemaCompliance: 'auto',
        reasoning: false,
      },
      mockConfig,
    );

    const headers = (anthropicState.constructorOptions?.['defaultHeaders'] ||
      {}) as Record<string, string>;
    expect(headers['anthropic-beta']).toBeUndefined();
  });

  describe('generateContent', () => {
    it('builds request with config sampling params (config overrides request) and thinking budget', async () => {
      const { AnthropicContentConverter } = await importConverter();
      const { AnthropicContentGenerator } = await importGenerator();

      const convertResponseSpy = vi
        .spyOn(
          AnthropicContentConverter.prototype,
          'convertAnthropicResponseToGemini',
        )
        .mockReturnValue(
          (() => {
            const r = new GenerateContentResponse();
            r.responseId = 'gemini-1';
            return r;
          })(),
        );

      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          baseUrl: 'https://example.invalid',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: {
            temperature: 0.7,
            max_tokens: 1000,
            top_p: 0.9,
            top_k: 20,
          },
          schemaCompliance: 'auto',
          reasoning: { effort: 'high', budget_tokens: 1000 },
        },
        mockConfig,
      );

      const abortController = new AbortController();
      const request: GenerateContentParameters = {
        model: 'models/ignored',
        contents: 'Hello',
        config: {
          temperature: 0.1,
          maxOutputTokens: 200,
          topP: 0.5,
          topK: 5,
          abortSignal: abortController.signal,
        },
      };

      const result = await generator.generateContent(request);
      expect(result.responseId).toBe('gemini-1');

      expect(anthropicState.lastCreateArgs).toBeDefined();
      const [anthropicRequest, options] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;

      expect(options?.signal).toBe(abortController.signal);

      expect(anthropicRequest).toEqual(
        expect.objectContaining({
          model: 'claude-test',
          max_tokens: 1000,
          temperature: 0.7,
          top_p: 0.9,
          top_k: 20,
          thinking: { type: 'enabled', budget_tokens: 1000 },
          output_config: { effort: 'high' },
        }),
      );

      expect(convertResponseSpy).toHaveBeenCalledTimes(1);
    });

    it('omits thinking when request.config.thinkingConfig.includeThoughts is false', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue({
        id: 'anthropic-1',
        model: 'claude-test',
        content: [{ type: 'text', text: 'hi' }],
      });

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 500 },
          schemaCompliance: 'auto',
          reasoning: { effort: 'high' },
        },
        mockConfig,
      );

      await generator.generateContent({
        model: 'models/ignored',
        contents: 'Hello',
        config: { thinkingConfig: { includeThoughts: false } },
      } as unknown as GenerateContentParameters);

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      expect(anthropicRequest).toEqual(
        expect.not.objectContaining({ thinking: expect.anything() }),
      );
    });
  });

  describe('countTokens', () => {
    it('counts tokens using the request tokenizer', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: {},
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello world' }] }],
        model: 'claude-test',
      };

      const result = await generator.countTokens(request);
      expect(mockTokenizer.calculateTokens).toHaveBeenCalledWith(request, {
        textEncoding: 'cl100k_base',
      });
      expect(result.totalTokens).toBe(50);
    });

    it('falls back to character approximation when tokenizer throws', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      mockTokenizer.calculateTokens.mockRejectedValueOnce(new Error('boom'));
      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: {},
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      const request: CountTokensParameters = {
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        model: 'claude-test',
      };

      const content = JSON.stringify(request.contents);
      const expected = Math.ceil(content.length / 4);
      const result = await generator.countTokens(request);
      expect(result.totalTokens).toBe(expected);
    });
  });

  describe('generateContentStream', () => {
    it('requests stream=true and converts streamed events into Gemini chunks', async () => {
      const { AnthropicContentGenerator } = await importGenerator();
      anthropicState.createImpl.mockResolvedValue(
        (async function* () {
          yield {
            type: 'message_start',
            message: {
              id: 'msg-1',
              model: 'claude-test',
              usage: { cache_read_input_tokens: 2, input_tokens: 3 },
            },
          };

          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text' },
          };
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'Hello' },
          };
          yield { type: 'content_block_stop', index: 0 };

          yield {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'thinking', signature: '' },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'thinking_delta', thinking: 'Think' },
          };
          yield {
            type: 'content_block_delta',
            index: 1,
            delta: { type: 'signature_delta', signature: 'abc' },
          };
          yield { type: 'content_block_stop', index: 1 };

          yield {
            type: 'content_block_start',
            index: 2,
            content_block: {
              type: 'tool_use',
              id: 't1',
              name: 'tool',
              input: {},
            },
          };
          yield {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '{"x":' },
          };
          yield {
            type: 'content_block_delta',
            index: 2,
            delta: { type: 'input_json_delta', partial_json: '1}' },
          };
          yield { type: 'content_block_stop', index: 2 };

          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: {
              output_tokens: 5,
              input_tokens: 7,
              cache_read_input_tokens: 2,
            },
          };
          yield { type: 'message_stop' };
        })(),
      );

      const generator = new AnthropicContentGenerator(
        {
          model: 'claude-test',
          apiKey: 'test-key',
          timeout: 10_000,
          maxRetries: 2,
          samplingParams: { max_tokens: 123 },
          schemaCompliance: 'auto',
        },
        mockConfig,
      );

      const stream = await generator.generateContentStream({
        model: 'models/ignored',
        contents: 'Hello',
      } as unknown as GenerateContentParameters);

      const chunks: GenerateContentResponse[] = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const [anthropicRequest] =
        anthropicState.lastCreateArgs as AnthropicCreateArgs;
      expect(anthropicRequest).toEqual(
        expect.objectContaining({ stream: true }),
      );

      // Text chunk.
      expect(chunks[0]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
        text: 'Hello',
      });

      // Thinking chunk.
      expect(chunks[1]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
        text: 'Think',
        thought: true,
      });

      // Signature chunk.
      expect(chunks[2]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
        thought: true,
        thoughtSignature: 'abc',
      });

      // Tool call chunk.
      expect(chunks[3]?.candidates?.[0]?.content?.parts?.[0]).toEqual({
        functionCall: { id: 't1', name: 'tool', args: { x: 1 } },
      });

      // Usage/finish chunks exist; check the last one.
      const last = chunks[chunks.length - 1]!;
      expect(last.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(last.usageMetadata).toEqual({
        cachedContentTokenCount: 2,
        promptTokenCount: 9, // cached(2) + input(7)
        candidatesTokenCount: 5,
        totalTokenCount: 14,
      });
    });
  });
});

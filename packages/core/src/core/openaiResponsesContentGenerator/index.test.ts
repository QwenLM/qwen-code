/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const mockTokenizer = {
  calculateTokens: vi.fn(),
};
vi.mock('../../utils/request-tokenizer/index.js', () => ({
  RequestTokenEstimator: vi.fn(() => mockTokenizer),
}));

const mockExecute = vi.fn();
const mockExecuteStream = vi.fn();
vi.mock('./responses-pipeline.js', () => ({
  ResponsesPipeline: vi.fn().mockImplementation(() => ({
    execute: mockExecute,
    executeStream: mockExecuteStream,
  })),
}));

const mockEmbeddingsCreate = vi.fn();
vi.mock('openai', () => ({
  default: vi.fn().mockImplementation(() => ({
    embeddings: { create: mockEmbeddingsCreate },
  })),
}));

import {
  OpenAIResponsesContentGenerator,
  createOpenAIResponsesContentGenerator,
} from './index.js';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import { GenerateContentResponse } from '@google/genai';
import { preloadRuntimeFetchModule } from '../../utils/runtimeFetchOptions.js';

function makeCliConfig(): Config {
  return { getProxy: () => undefined } as unknown as Config;
}

function makeGeneratorConfig(): ContentGeneratorConfig {
  return {
    model: 'gpt-5',
    apiKey: 'test-key',
  } as ContentGeneratorConfig;
}

describe('OpenAIResponsesContentGenerator', () => {
  let generator: OpenAIResponsesContentGenerator;

  beforeAll(async () => {
    // embedContent's client builds runtime fetch options, which lazy-loads
    // undici; production always calls this via createContentGenerator before
    // constructing any generator.
    await preloadRuntimeFetchModule();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    generator = new OpenAIResponsesContentGenerator(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
  });

  it('delegates generateContent to the pipeline', async () => {
    const expected = new GenerateContentResponse();
    mockExecute.mockResolvedValue(expected);
    const result = await generator.generateContent(
      { model: 'gpt-5', contents: [] },
      'prompt-1',
    );
    expect(result).toBe(expected);
    expect(mockExecute).toHaveBeenCalledWith(
      { model: 'gpt-5', contents: [] },
      'prompt-1',
      undefined,
    );
  });

  it('delegates generateContentStream to the pipeline', async () => {
    async function* fakeStream() {
      yield new GenerateContentResponse();
    }
    mockExecuteStream.mockResolvedValue(fakeStream());
    await generator.generateContentStream(
      { model: 'gpt-5', contents: [] },
      'prompt-1',
    );
    expect(mockExecuteStream).toHaveBeenCalledWith(
      { model: 'gpt-5', contents: [] },
      'prompt-1',
      undefined,
    );
  });

  it('countTokens uses the request tokenizer', async () => {
    mockTokenizer.calculateTokens.mockResolvedValue({ totalTokens: 42 });
    const result = await generator.countTokens({
      model: 'gpt-5',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    expect(result).toEqual({ totalTokens: 42 });
  });

  it('countTokens falls back to a character-based estimate on tokenizer failure', async () => {
    mockTokenizer.calculateTokens.mockRejectedValue(new Error('boom'));
    const result = await generator.countTokens({
      model: 'gpt-5',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    });
    expect(result.totalTokens).toBeGreaterThan(0);
  });

  it('useSummarizedThinking returns true', () => {
    expect(generator.useSummarizedThinking()).toBe(true);
  });

  describe('embedContent', () => {
    it('extracts text from an array of Content and embeds it', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1, 0.2] }],
      });
      const result = await generator.embedContent({
        model: 'text-embedding-ada-002',
        contents: [{ role: 'user', parts: [{ text: 'hello world' }] }],
      });
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ input: 'hello world' }),
      );
      expect(result).toEqual({ embeddings: [{ values: [0.1, 0.2] }] });
    });

    it('extracts text from a single non-array Content', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.3] }],
      });
      await generator.embedContent({
        model: 'text-embedding-ada-002',
        contents: { role: 'user', parts: [{ text: 'solo' }] },
      });
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ input: 'solo' }),
      );
    });

    it('extracts a plain string content directly', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.4] }],
      });
      await generator.embedContent({
        model: 'text-embedding-ada-002',
        contents: 'plain string',
      });
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ input: 'plain string' }),
      );
    });

    it('throws when the embeddings API returns an empty data array', async () => {
      mockEmbeddingsCreate.mockResolvedValue({ data: [] });
      await expect(
        generator.embedContent({
          model: 'text-embedding-ada-002',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
      ).rejects.toThrow(/Embedding error/);
    });

    it('wraps and rethrows on API failure', async () => {
      mockEmbeddingsCreate.mockRejectedValue(new Error('network down'));
      await expect(
        generator.embedContent({
          model: 'text-embedding-ada-002',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
      ).rejects.toThrow(/Embedding error: network down/);
    });
  });

  it('createOpenAIResponsesContentGenerator returns an OpenAIResponsesContentGenerator', () => {
    const created = createOpenAIResponsesContentGenerator(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    expect(created).toBeInstanceOf(OpenAIResponsesContentGenerator);
  });
});

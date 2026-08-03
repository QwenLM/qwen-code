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
const mockOpenAIConstructor = vi.fn();
vi.mock('openai', () => ({
  default: mockOpenAIConstructor.mockImplementation(() => ({
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

  it('forwards a real abortSignal from request.config to the pipeline', async () => {
    const expected = new GenerateContentResponse();
    mockExecute.mockResolvedValue(expected);
    const { signal } = new AbortController();
    await generator.generateContent(
      { model: 'gpt-5', contents: [], config: { abortSignal: signal } },
      'prompt-1',
    );
    expect(mockExecute).toHaveBeenCalledWith(
      expect.anything(),
      'prompt-1',
      signal,
    );
  });

  it('forwards a real abortSignal from request.config to the pipeline stream', async () => {
    async function* fakeStream() {
      yield new GenerateContentResponse();
    }
    mockExecuteStream.mockResolvedValue(fakeStream());
    const { signal } = new AbortController();
    await generator.generateContentStream(
      { model: 'gpt-5', contents: [], config: { abortSignal: signal } },
      'prompt-1',
    );
    expect(mockExecuteStream).toHaveBeenCalledWith(
      expect.anything(),
      'prompt-1',
      signal,
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
      // `generator` (from the outer beforeEach) is built with
      // makeGeneratorConfig()'s model 'gpt-5', which does not contain
      // 'embed' -- asserts the fallback branch of the model selection
      // (`model.includes('embed') ? model : 'text-embedding-ada-002'`),
      // previously untested by any embedContent assertion.
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          input: 'hello world',
          model: 'text-embedding-ada-002',
        }),
      );
      expect(result).toEqual({ embeddings: [{ values: [0.1, 0.2] }] });
    });

    it('uses the configured model when it contains "embed"', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1] }],
      });
      const embedModelGenerator = new OpenAIResponsesContentGenerator(
        { ...makeGeneratorConfig(), model: 'text-embedding-3-small' },
        makeCliConfig(),
      );
      await embedModelGenerator.embedContent({
        model: 'text-embedding-3-small',
        contents: [{ role: 'user', parts: [{ text: 'hello world' }] }],
      });
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'text-embedding-3-small' }),
      );
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

    it('redacts proxy credentials from a thrown error message', async () => {
      // The sibling openaiContentGenerator already redacts here; this
      // generator's embedContent skipped it, leaking a configured proxy's
      // credentials into the error surfaced to the caller/logs on failure.
      mockEmbeddingsCreate.mockRejectedValue(
        new Error('connect ECONNREFUSED http://user:secret@proxy.local:8080'),
      );
      await expect(
        generator.embedContent({
          model: 'text-embedding-ada-002',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        }),
      ).rejects.toThrow(/<redacted>@proxy\.local:8080/);
    });

    it('appends /v1 to a bare-origin baseUrl before constructing the OpenAI SDK client', async () => {
      // This generator's own baseUrl convention (used by the streaming
      // pipeline) is /v1-less, but the OpenAI SDK does not append /v1 to a
      // custom baseURL on its own -- only to its own built-in default.
      // Passing the bare origin straight through 404s every embedding call.
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1] }],
      });
      const bareOriginGenerator = new OpenAIResponsesContentGenerator(
        { ...makeGeneratorConfig(), baseUrl: 'https://api.openai.com' },
        makeCliConfig(),
      );
      await bareOriginGenerator.embedContent({
        model: 'text-embedding-ada-002',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://api.openai.com/v1' }),
      );
    });

    it('applies customHeaders to the embeddings SDK client', async () => {
      // The streaming pipeline (responses-pipeline.ts) applies
      // config.customHeaders to every request; embedContent's own SDK
      // client construction skipped it, so a header configured for the
      // streaming path (e.g. a proxy auth header) silently never reached
      // embedding calls.
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1] }],
      });
      const generatorWithHeaders = new OpenAIResponsesContentGenerator(
        {
          ...makeGeneratorConfig(),
          customHeaders: { 'X-Proxy-Auth': 'token' },
        },
        makeCliConfig(),
      );
      await generatorWithHeaders.embedContent({
        model: 'text-embedding-ada-002',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { 'X-Proxy-Auth': 'token' },
        }),
      );
    });

    it('does not append a second /v1 when baseUrl already has one', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1] }],
      });
      const generatorWithV1 = new OpenAIResponsesContentGenerator(
        { ...makeGeneratorConfig(), baseUrl: 'https://api.openai.com/v1' },
        makeCliConfig(),
      );
      await generatorWithV1.embedContent({
        model: 'text-embedding-ada-002',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ baseURL: 'https://api.openai.com/v1' }),
      );
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

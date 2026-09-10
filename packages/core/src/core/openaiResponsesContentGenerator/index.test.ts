/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const mockExecute = vi.fn();
const mockExecuteStream = vi.fn();
const mockConnectStream = vi.fn();
vi.mock('./responses-pipeline.js', () => ({
  ResponsesPipeline: vi.fn().mockImplementation(() => ({
    execute: mockExecute,
    executeStream: mockExecuteStream,
    connectStream: mockConnectStream,
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
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT,
  DISABLED_REQUEST_TIMEOUT_MS,
} from '../openaiContentGenerator/constants.js';

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

  afterEach(() => {
    vi.unstubAllEnvs();
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
    const stream = fakeStream();
    mockConnectStream.mockResolvedValue(stream);
    const result = await generator.generateContentStream(
      { model: 'gpt-5', contents: [] },
      'prompt-1',
    );
    expect(result).toBe(stream);
    expect(mockConnectStream).toHaveBeenCalledWith(
      { model: 'gpt-5', contents: [] },
      'prompt-1',
      undefined,
    );
  });

  it('rejects generateContentStream when the initial connection fails', async () => {
    mockConnectStream.mockRejectedValue(
      Object.assign(new Error('Responses API error 500'), { status: 500 }),
    );

    await expect(
      generator.generateContentStream(
        { model: 'gpt-5', contents: [] },
        'prompt-1',
      ),
    ).rejects.toThrow('Responses API error 500');
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
    mockConnectStream.mockResolvedValue(fakeStream());
    const { signal } = new AbortController();
    await generator.generateContentStream(
      { model: 'gpt-5', contents: [], config: { abortSignal: signal } },
      'prompt-1',
    );
    expect(mockConnectStream).toHaveBeenCalledWith(
      expect.anything(),
      'prompt-1',
      signal,
    );
  });

  it('normalizes a null abortSignal to undefined for the pipeline', async () => {
    const expected = new GenerateContentResponse();
    mockExecute.mockResolvedValue(expected);
    await generator.generateContent(
      {
        model: 'gpt-5',
        contents: [],
        config: { abortSignal: null },
      } as unknown as Parameters<typeof generator.generateContent>[0],
      'prompt-1',
    );
    expect(mockExecute).toHaveBeenCalledWith(
      expect.anything(),
      'prompt-1',
      undefined,
    );
  });

  it('normalizes a null abortSignal to undefined for the pipeline stream', async () => {
    async function* fakeStream() {
      yield new GenerateContentResponse();
    }
    mockConnectStream.mockResolvedValue(fakeStream());
    await generator.generateContentStream(
      {
        model: 'gpt-5',
        contents: [],
        config: { abortSignal: null },
      } as unknown as Parameters<typeof generator.generateContentStream>[0],
      'prompt-1',
    );
    expect(mockConnectStream).toHaveBeenCalledWith(
      expect.anything(),
      'prompt-1',
      undefined,
    );
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
        model: 'request-model-that-does-not-embed',
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

    it('joins an array of string contents for embedding', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.3] }],
      });
      await generator.embedContent({
        model: 'text-embedding-ada-002',
        contents: ['first text', 'second text'],
      });
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ input: 'first text second text' }),
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

    it('applies SDK client defaults and configured credentials', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1] }],
      });
      const configuredGenerator = new OpenAIResponsesContentGenerator(
        {
          ...makeGeneratorConfig(),
          baseUrl: 'https://api.openai.com/',
          timeout: 0,
        },
        makeCliConfig(),
      );
      await configuredGenerator.embedContent({
        model: 'text-embedding-ada-002',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          apiKey: 'test-key',
          baseURL: 'https://api.openai.com/v1',
          timeout: DISABLED_REQUEST_TIMEOUT_MS,
          maxRetries: DEFAULT_MAX_RETRIES,
        }),
      );
    });

    it('applies the repository default timeout when none is configured', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1] }],
      });

      await generator.embedContent({
        model: 'text-embedding-ada-002',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: undefined,
          timeout: DEFAULT_TIMEOUT,
        }),
      );
    });

    it('uses apiKeyEnvKey when no direct API key is configured', async () => {
      vi.stubEnv('TEST_EMBED_KEY', 'env-key');
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1] }],
      });
      const generatorWithEnvKey = new OpenAIResponsesContentGenerator(
        {
          model: 'gpt-5',
          apiKeyEnvKey: 'TEST_EMBED_KEY',
        } as ContentGeneratorConfig,
        makeCliConfig(),
      );

      await generatorWithEnvKey.embedContent({
        model: 'text-embedding-ada-002',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'env-key' }),
      );
    });

    it('passes configured maxRetries to the embeddings SDK client', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1] }],
      });
      const generatorWithRetries = new OpenAIResponsesContentGenerator(
        { ...makeGeneratorConfig(), maxRetries: 0 },
        makeCliConfig(),
      );

      await generatorWithRetries.embedContent({
        model: 'text-embedding-ada-002',
        contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      });

      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ maxRetries: 0 }),
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

    it.each(['https://api.openai.com/v1', 'https://api.openai.com/v1/'])(
      'does not append a second /v1 to %s',
      async (baseUrl) => {
        mockEmbeddingsCreate.mockResolvedValue({
          data: [{ embedding: [0.1] }],
        });
        const generatorWithV1 = new OpenAIResponsesContentGenerator(
          { ...makeGeneratorConfig(), baseUrl },
          makeCliConfig(),
        );
        await generatorWithV1.embedContent({
          model: 'text-embedding-ada-002',
          contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
        });
        expect(mockOpenAIConstructor).toHaveBeenCalledWith(
          expect.objectContaining({ baseURL: 'https://api.openai.com/v1' }),
        );
      },
    );
  });

  it('createOpenAIResponsesContentGenerator returns an OpenAIResponsesContentGenerator', () => {
    const created = createOpenAIResponsesContentGenerator(
      makeGeneratorConfig(),
      makeCliConfig(),
    );
    expect(created).toBeInstanceOf(OpenAIResponsesContentGenerator);
  });
});

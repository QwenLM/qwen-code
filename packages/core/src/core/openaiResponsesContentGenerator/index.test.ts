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
vi.mock('./responses-pipeline.js', async (importOriginal) => {
  // Keep the module's real exports (normalizeOpenAiWireBaseUrl drives the
  // embeddings baseURL below); only the pipeline class is stubbed.
  const actual =
    await importOriginal<typeof import('./responses-pipeline.js')>();
  return {
    ...actual,
    ResponsesPipeline: vi.fn().mockImplementation(() => ({
      execute: mockExecute,
      executeStream: mockExecuteStream,
      connectStream: mockConnectStream,
    })),
  };
});

const mockEmbeddingsCreate = vi.fn();
const mockOpenAIConstructor = vi.fn();
vi.mock('openai', () => ({
  default: mockOpenAIConstructor.mockImplementation(() => ({
    embeddings: { create: mockEmbeddingsCreate },
  })),
}));

// embedContent's client is built with buildRuntimeFetchOptions' pinned
// fetch. Handing back a spy keeps the base fetch the session-aware wrapper
// delegates to observable without a live network call.
const { embedBaseFetchMock } = vi.hoisted(() => ({
  embedBaseFetchMock: vi.fn(),
}));
vi.mock('../../utils/runtimeFetchOptions.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../utils/runtimeFetchOptions.js')>();
  return {
    ...actual,
    buildRuntimeFetchOptions: () => ({ fetch: embedBaseFetchMock }),
  };
});

import {
  OpenAIResponsesContentGenerator,
  createOpenAIResponsesContentGenerator,
} from './index.js';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig } from '../contentGenerator.js';
import type { ContentListUnion } from '@google/genai';
import { GenerateContentResponse } from '@google/genai';
import { preloadRuntimeFetchModule } from '../../utils/runtimeFetchOptions.js';
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_TIMEOUT,
  DISABLED_REQUEST_TIMEOUT_MS,
} from '../openaiContentGenerator/constants.js';
import { streamOf, userText } from '../../test-utils/model-fixtures.js';

function makeCliConfig(
  sessionId = '',
  allowDynamicHeaderValues = false,
): Config {
  return {
    getProxy: () => undefined,
    // The session-aware fetch this generator installs resolves
    // customHeaders placeholders and the first-party session_id header from
    // live Config state; the consent gate defaults to off, as in production.
    getSessionId: () => sessionId,
    getOutboundAllowDynamicHeaderValues: () => allowDynamicHeaderValues,
  } as unknown as Config;
}

function makeGeneratorConfig(
  overrides: Partial<ContentGeneratorConfig> = {},
): ContentGeneratorConfig {
  return {
    model: 'gpt-5',
    apiKey: 'test-key',
    ...overrides,
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

  type Req = Parameters<typeof generator.generateContent>[0];
  // generateContent delegates to the pipeline's execute, generateContentStream
  // to its connectStream; both forward the prompt id and abort signal.
  const viaExecute = {
    pipe: mockExecute,
    call: (req: Req) => generator.generateContent(req, 'prompt-1'),
    make: () => new GenerateContentResponse(),
  };
  const viaStream = {
    pipe: mockConnectStream,
    call: (req: Req) => generator.generateContentStream(req, 'prompt-1'),
    make: () => streamOf(new GenerateContentResponse()),
  };

  it.each([
    ['generateContent', viaExecute],
    ['generateContentStream', viaStream],
  ])('delegates %s to the pipeline', async (_, path) => {
    const expected = path.make();
    path.pipe.mockResolvedValue(expected);
    const result = await path.call({ model: 'gpt-5', contents: [] });
    expect(result).toBe(expected);
    expect(path.pipe).toHaveBeenCalledWith(
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
      viaStream.call({ model: 'gpt-5', contents: [] }),
    ).rejects.toThrow('Responses API error 500');
  });

  it.each([
    ['', viaExecute],
    [' stream', viaStream],
  ])(
    'forwards a real abortSignal from request.config to the pipeline%s',
    async (_, path) => {
      path.pipe.mockResolvedValue(path.make());
      const { signal } = new AbortController();
      await path.call({
        model: 'gpt-5',
        contents: [],
        config: { abortSignal: signal },
      });
      expect(path.pipe).toHaveBeenCalledWith(
        expect.anything(),
        'prompt-1',
        signal,
      );
    },
  );

  it.each([
    ['', viaExecute],
    [' stream', viaStream],
  ])(
    'normalizes a null abortSignal to undefined for the pipeline%s',
    async (_, path) => {
      path.pipe.mockResolvedValue(path.make());
      await path.call({
        model: 'gpt-5',
        contents: [],
        config: { abortSignal: null },
      } as unknown as Req);
      expect(path.pipe).toHaveBeenCalledWith(
        expect.anything(),
        'prompt-1',
        undefined,
      );
    },
  );

  describe('embedContent', () => {
    const embedHi = (gen = generator) =>
      gen.embedContent({
        model: 'text-embedding-ada-002',
        contents: [userText('hi')],
      });

    /** Embeds 'hi' through a fresh generator built from `config`. */
    function embedWith(config: ContentGeneratorConfig, cli = makeCliConfig()) {
      mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.1] }] });
      return embedHi(new OpenAIResponsesContentGenerator(config, cli));
    }

    it('extracts text from an array of Content and embeds it', async () => {
      mockEmbeddingsCreate.mockResolvedValue({
        data: [{ embedding: [0.1, 0.2] }],
      });
      const result = await generator.embedContent({
        model: 'text-embedding-ada-002',
        contents: [userText('hello world')],
      });
      // `generator` uses model 'gpt-5', which lacks 'embed': covers the
      // fallback branch of `model.includes('embed') ? model :
      // 'text-embedding-ada-002'`, previously untested by any embedContent
      // assertion.
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
      await new OpenAIResponsesContentGenerator(
        makeGeneratorConfig({ model: 'text-embedding-3-small' }),
        makeCliConfig(),
      ).embedContent({
        model: 'request-model-that-does-not-embed',
        contents: [userText('hello world')],
      });
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'text-embedding-3-small' }),
      );
    });

    it.each<[string, ContentListUnion, string]>([
      [
        'extracts text from a single non-array Content',
        userText('solo'),
        'solo',
      ],
      [
        'joins an array of string contents for embedding',
        ['first text', 'second text'],
        'first text second text',
      ],
      [
        'extracts a plain string content directly',
        'plain string',
        'plain string',
      ],
    ])('%s', async (_, contents, input) => {
      mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: [0.3] }] });
      await generator.embedContent({
        model: 'text-embedding-ada-002',
        contents,
      });
      expect(mockEmbeddingsCreate).toHaveBeenCalledWith(
        expect.objectContaining({ input }),
      );
    });

    it('throws when the embeddings API returns an empty data array', async () => {
      mockEmbeddingsCreate.mockResolvedValue({ data: [] });
      await expect(embedHi()).rejects.toThrow(/Embedding error/);
    });

    it('wraps and rethrows on API failure', async () => {
      mockEmbeddingsCreate.mockRejectedValue(new Error('network down'));
      await expect(embedHi()).rejects.toThrow(/Embedding error: network down/);
    });

    it('redacts proxy credentials from a thrown error message', async () => {
      // The sibling openaiContentGenerator already redacted here; this one
      // leaked a configured proxy's credentials into the surfaced error.
      mockEmbeddingsCreate.mockRejectedValue(
        new Error('connect ECONNREFUSED http://user:secret@proxy.local:8080'),
      );
      await expect(embedHi()).rejects.toThrow(/<redacted>@proxy\.local:8080/);
    });

    it('applies SDK client defaults and configured credentials', async () => {
      await embedWith(
        makeGeneratorConfig({ baseUrl: 'https://api.openai.com/', timeout: 0 }),
      );
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
      await embedWith(makeGeneratorConfig());
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: undefined,
          timeout: DEFAULT_TIMEOUT,
        }),
      );
    });

    it('uses apiKeyEnvKey when no direct API key is configured', async () => {
      vi.stubEnv('TEST_EMBED_KEY', 'env-key');
      await embedWith({
        model: 'gpt-5',
        apiKeyEnvKey: 'TEST_EMBED_KEY',
      } as ContentGeneratorConfig);
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'env-key' }),
      );
    });

    it('passes configured maxRetries to the embeddings SDK client', async () => {
      await embedWith(makeGeneratorConfig({ maxRetries: 0 }));
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({ maxRetries: 0 }),
      );
    });

    it('applies customHeaders to the embeddings SDK client', async () => {
      // The streaming pipeline applies config.customHeaders to every request;
      // embedContent's own SDK client skipped them, so a header set for
      // streaming (e.g. proxy auth) never reached embedding calls.
      await embedWith(
        makeGeneratorConfig({ customHeaders: { 'X-Proxy-Auth': 'token' } }),
      );
      expect(mockOpenAIConstructor).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: { 'X-Proxy-Auth': 'token' },
        }),
      );
    });

    it('expands a ${session_id} customHeader per request instead of sending the baked-in literal', async () => {
      // Issue #11936: defaultHeaders is fixed at client construction, so a
      // placeholder in it can only be corrected by a per-request fetch
      // wrapper -- the same one the Chat wire installs on its client.
      await embedWith(
        makeGeneratorConfig({
          customHeaders: { 'x-opencode-session': '${session_id}' },
        }),
        makeCliConfig('session-embed', true),
      );

      const clientOptions = mockOpenAIConstructor.mock.calls.at(-1)![0] as {
        fetch?: (input: string, init?: RequestInit) => Promise<Response>;
      };
      expect(typeof clientOptions.fetch).toBe('function');

      // What the SDK does with defaultHeaders on every request: hand them to
      // fetch as request headers.
      embedBaseFetchMock.mockResolvedValue(new Response('{}'));
      await clientOptions.fetch!('https://api.openai.com/v1/embeddings', {
        headers: { 'x-opencode-session': '${session_id}' },
      });

      const sent = new Headers(embedBaseFetchMock.mock.calls[0]![1].headers);
      expect(sent.get('x-opencode-session')).toBe('session-embed');
    });

    it.each(['https://api.openai.com/v1', 'https://api.openai.com/v1/'])(
      'does not append a second /v1 to %s',
      async (baseUrl) => {
        await embedWith(makeGeneratorConfig({ baseUrl }));
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

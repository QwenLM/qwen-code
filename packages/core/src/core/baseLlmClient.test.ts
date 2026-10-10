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

import type { GenerateContentResponse, Part } from '@google/genai';
import {
  BaseLlmClient,
  type GenerateJsonOptions,
  type GenerateTextOptions,
} from './baseLlmClient.js';
import type { ContentGenerator } from './contentGenerator.js';
import type { Config } from '../config/config.js';
import { AuthType } from './contentGenerator.js';
import { reportError } from '../utils/errorReporting.js';
import { retryWithBackoff } from '../utils/retry.js';
import { getErrorMessage } from '../utils/errors.js';
import { getFunctionCalls } from '../utils/generateContentResponseUtilities.js';
import { CHARS_PER_TOKEN } from '../services/tokenEstimation.js';
import {
  content,
  fnCall,
  streamOf,
  userText,
} from '../test-utils/model-fixtures.js';

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
  // Matches `defaultOptions.model`, so resolveForModel returns the
  // constructor-injected ContentGenerator without building a per-model one.
  getModel: vi.fn().mockReturnValue('test-model'),
  getModelsConfig: vi.fn().mockReturnValue(undefined),
  getChatCompression: vi.fn().mockReturnValue(undefined),
} as unknown as Mocked<Config>;

// A single-candidate model response carrying `part`.
const createMockResponse = (part: Part): GenerateContentResponse =>
  ({
    candidates: [{ content: content('model', part), index: 0 }],
  }) as GenerateContentResponse;
const createMockResponseWithFunctionCall = (args: Record<string, unknown>) =>
  createMockResponse(fnCall('respond_in_schema', args));
const createMockTextResponse = (text: string) => createMockResponse({ text });

// Yields one response per text delta, then an optional usage-only chunk, as
// the streaming pipeline emits them.
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

// The model answers through a respond_in_schema function call carrying `args`.
function answerWithJson(
  args: Record<string, unknown>,
  generator = mockGenerateContent,
) {
  generator.mockResolvedValue(createMockResponseWithFunctionCall(args));
  vi.mocked(getFunctionCalls).mockReturnValue([
    { name: 'respond_in_schema', args },
  ]);
}

const streamYields = (
  stream: AsyncGenerator<GenerateContentResponse>,
  generator = mockGenerateContentStream,
) => generator.mockImplementation(async () => stream);

const expectRetriedWith = (options: Record<string, unknown>) =>
  expect(retryWithBackoff).toHaveBeenCalledWith(
    expect.any(Function),
    expect.objectContaining(options),
  );

describe('BaseLlmClient', () => {
  let client: BaseLlmClient;
  let abortController: AbortController;
  let defaultOptions: GenerateJsonOptions;

  // A plain 'hi' text request with promptId 'p'.
  const askHi = (extra: Partial<GenerateTextOptions> = {}, c = client) =>
    c.generateText({
      contents: [userText('hi')],
      model: 'test-model',
      abortSignal: abortController.signal,
      promptId: 'p',
      ...extra,
    });
  const streamHi = (stream: AsyncGenerator<GenerateContentResponse>) => {
    streamYields(stream);
    return askHi({ stream: true });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      model: 'test-model',
      authType: AuthType.USE_GEMINI,
    });
    // Reset getErrorMessage so error message assertions are accurate
    vi.mocked(getErrorMessage).mockImplementation((e) =>
      e instanceof Error ? e.message : String(e),
    );
    client = new BaseLlmClient(mockContentGenerator, mockConfig);
    abortController = new AbortController();
    defaultOptions = {
      contents: [userText('Give me a color.')],
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
    // Answers with `args`, then runs generateJson on defaultOptions + overrides.
    const generateJsonWith = (
      args: Record<string, unknown>,
      overrides: Partial<GenerateJsonOptions> = {},
    ) => {
      answerWithJson(args);
      return client.generateJson({ ...defaultOptions, ...overrides });
    };

    it('should call generateContent with correct parameters using function declarations', async () => {
      const result = await generateJsonWith({ color: 'blue' });

      expect(result).toEqual({ color: 'blue' });
      // Ensure the retry mechanism was engaged
      expect(retryWithBackoff).toHaveBeenCalledTimes(1);
      expectRetriedWith({ maxAttempts: 7 });
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
      await generateJsonWith(
        { color: 'red' },
        { config: { temperature: 0.8, topK: 10 } },
      );

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
      const systemInstruction = 'You are a helpful assistant.';
      await generateJsonWith({ color: 'green' }, { systemInstruction });

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ systemInstruction }),
        }),
        expect.any(String),
      );
    });

    it('should use the provided promptId', async () => {
      await generateJsonWith(
        { color: 'yellow' },
        { promptId: 'custom-id-123' },
      );

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.any(Object),
        'custom-id-123',
      );
    });

    it('should pass maxAttempts to retryWithBackoff when provided', async () => {
      await generateJsonWith({ color: 'cyan' }, { maxAttempts: 3 });

      expect(retryWithBackoff).toHaveBeenCalledTimes(1);
      expectRetriedWith({ maxAttempts: 3 });
    });

    it('should call retryWithBackoff with default maxAttempts when not provided', async () => {
      await generateJsonWith({ color: 'indigo' }); // no maxAttempts given

      expectRetriedWith({ maxAttempts: 7 });
    });

    it('should pass configured retry error codes to retryWithBackoff', async () => {
      const retryErrorCodes = [4999];
      mockConfig.getContentGeneratorConfig.mockReturnValue({
        model: 'test-model',
        authType: AuthType.USE_GEMINI,
        retryErrorCodes,
      });
      await generateJsonWith({ color: 'green' });

      expectRetriedWith({ extraRetryErrorCodes: retryErrorCodes });
    });

    it.each([
      [
        'should return empty object when no function calls are returned',
        'some text',
        {},
      ],
      [
        'should parse a loose JSON object from text when no function call is returned',
        'Result:\n{"color":"purple","count":2}\nDone.',
        { color: 'purple', count: 2 },
      ],
      [
        'should parse fenced JSON text when no function call is returned',
        '```json\n{"color":"orange"}\n```',
        { color: 'orange' },
      ],
      [
        'should ignore malformed loose JSON text',
        '```json\n{"color":\n```',
        {},
      ],
      ['should reject loose JSON arrays', '[{"color":"blue"}]', {}],
    ])('%s', async (_title, text, expected) => {
      mockGenerateContent.mockResolvedValue(createMockTextResponse(text));
      vi.mocked(getFunctionCalls).mockReturnValue(undefined);

      expect(await client.generateJson(defaultOptions)).toEqual(expected);
    });
  });

  describe('generateJson - Error Handling', () => {
    it('should throw and report generic API errors', async () => {
      const apiError = new Error('Service Unavailable (503)');
      mockGenerateContent.mockRejectedValue(apiError);

      await expect(client.generateJson(defaultOptions)).rejects.toThrow(
        'Failed to generate JSON content (test-prompt-id): Service Unavailable (503)',
      );
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
      // Abort during the API call, so the signal is aborted when checked
      mockGenerateContent.mockImplementation(() => {
        abortController.abort();
        throw abortError;
      });

      // defaultOptions carries abortController.signal
      await expect(client.generateJson(defaultOptions)).rejects.toThrow(
        abortError,
      );
      // A cancellation is not an application error to report
      expect(reportError).not.toHaveBeenCalled();
    });

    it('should not throw for empty response message check', async () => {
      mockGenerateContent.mockRejectedValue(
        new Error('API returned an empty response for generateJson.'),
      );

      await expect(client.generateJson(defaultOptions)).rejects.toThrow(
        'API returned an empty response for generateJson.',
      );
      // Should not double-report this specific error
      expect(reportError).not.toHaveBeenCalled();
    });
  });

  it('filters unsupported media from text and JSON side queries', async () => {
    mockConfig.getContentGeneratorConfig.mockReturnValue({
      model: 'test-model',
      authType: AuthType.USE_GEMINI,
      modalities: { pdf: true },
    });
    const contents = [
      content(
        'user',
        { inlineData: { mimeType: 'image/png', data: 'image-bytes' } },
        { inlineData: { mimeType: 'application/pdf', data: 'pdf-bytes' } },
      ),
    ];
    mockGenerateContent
      .mockResolvedValueOnce(createMockTextResponse('ok'))
      .mockResolvedValueOnce(createMockResponseWithFunctionCall({ ok: true }));
    vi.mocked(getFunctionCalls).mockReturnValue([
      { name: 'respond_in_schema', args: { ok: true } },
    ]);

    await client.generateText({
      contents,
      model: 'test-model',
      abortSignal: abortController.signal,
    });
    await client.generateJson({
      contents,
      schema: { type: 'object' },
      model: 'test-model',
      abortSignal: abortController.signal,
    });

    for (const [request] of mockGenerateContent.mock.calls) {
      const sent = JSON.stringify(request.contents);
      expect(sent).not.toContain('image-bytes');
      expect(sent).toContain('pdf-bytes');
    }
  });

  describe('generateEmbedding', () => {
    const texts = ['hello world', 'goodbye world'];

    it('should call embedContent with correct parameters and return embeddings', async () => {
      const mockEmbeddings = [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ];
      mockEmbedContent.mockResolvedValue({
        embeddings: mockEmbeddings.map((values) => ({ values })),
      });

      const result = await client.generateEmbedding(texts);

      expect(mockEmbedContent).toHaveBeenCalledTimes(1);
      expect(mockEmbedContent).toHaveBeenCalledWith({
        model: 'test-embedding-model',
        contents: texts,
      });
      expect(result).toEqual(mockEmbeddings);
    });

    it('should return an empty array if an empty array is passed', async () => {
      const result = await client.generateEmbedding([]);
      expect(result).toEqual([]);
      expect(mockEmbedContent).not.toHaveBeenCalled();
    });

    it.each([
      [
        'should throw an error if API response has no embeddings array',
        {},
        'No embeddings found in API response.',
      ],
      [
        'should throw an error if API response has an empty embeddings array',
        { embeddings: [] },
        'No embeddings found in API response.',
      ],
      [
        'should throw an error if API returns a mismatched number of embeddings',
        { embeddings: [{ values: [1, 2, 3] }] },
        'API returned a mismatched number of embeddings. Expected 2, got 1.',
      ],
      [
        'should throw an error if any embedding has nullish values',
        { embeddings: [{ values: [1, 2, 3] }, { values: undefined }] },
        'API returned an empty embedding for input text at index 1: "goodbye world"',
      ],
      [
        'should throw an error if any embedding has an empty values array',
        { embeddings: [{ values: [] }, { values: [1, 2, 3] }] },
        'API returned an empty embedding for input text at index 0: "hello world"',
      ],
    ])('%s', async (_title, response, message) => {
      mockEmbedContent.mockResolvedValue(response);

      await expect(client.generateEmbedding(texts)).rejects.toThrow(message);
    });

    it('should propagate errors from the API call', async () => {
      mockEmbedContent.mockRejectedValue(new Error('API Failure'));

      await expect(client.generateEmbedding(texts)).rejects.toThrow(
        'API Failure',
      );
    });
  });

  describe('generateText - streaming', () => {
    // A streamed 'summarize' request (no promptId) answered with 'summary'.
    const summarize = (extra: Partial<GenerateTextOptions>) => {
      streamYields(mockTextStream(['summary']));
      return client.generateText({
        contents: [userText('summarize')],
        model: 'test-model',
        abortSignal: abortController.signal,
        stream: true,
        ...extra,
      });
    };
    const useOpenAI = () =>
      mockConfig.getContentGeneratorConfig.mockReturnValue({
        model: 'test-model',
        authType: AuthType.USE_OPENAI,
      });

    it('routes through generateContentStream, concatenates deltas, trims once, and captures final-chunk usage', async () => {
      const usage = {
        promptTokenCount: 11,
        candidatesTokenCount: 7,
        totalTokenCount: 18,
      };
      vi.mocked(getFunctionCalls).mockReturnValue(undefined);

      const result = await streamHi(
        mockTextStream(['  Hello', ', ', 'world  '], usage),
      );

      expect(mockGenerateContentStream).toHaveBeenCalledTimes(1);
      // Same request object as the non-stream path: resolved model, contents,
      // and a config carrying the abortSignal.
      expect(mockGenerateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          contents: [userText('hi')],
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
      expect(result.hadToolCall).toBe(false);
    });

    it('forwards tool declarations and reports function calls without executing them', async () => {
      const tools = [
        {
          functionDeclarations: [
            { name: 'read_file', description: 'Read a file' },
          ],
        },
      ];
      vi.mocked(getFunctionCalls).mockReturnValueOnce([
        { name: 'read_file', args: { path: 'README.md' } },
      ]);

      const result = await summarize({ config: { tools } });

      expect(mockGenerateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ tools }),
        }),
        '',
      );
      expect(result.hadToolCall).toBe(true);
    });

    it('forwards the prompt-cache-sharing marker to the provider request', async () => {
      useOpenAI();
      await summarize({ promptCacheSharing: true });

      expect(mockGenerateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({ promptCacheSharing: true }),
        '',
      );
    });

    it.each([false, undefined])(
      'does not forward the prompt-cache-sharing marker when disabled (%s)',
      async (promptCacheSharing) => {
        useOpenAI();
        await summarize({ promptCacheSharing });

        expect(mockGenerateContentStream.mock.calls[0]?.[0]).not.toHaveProperty(
          'promptCacheSharing',
        );
      },
    );

    it('drops thought parts and tolerates a stream that omits usage', async () => {
      const result = await streamHi(
        streamOf(
          createMockTextResponse('answer'),
          createMockResponse({ text: 'reasoning', thought: true }),
        ),
      );

      expect(result.text).toBe('answer');
      expect(result.usage).toBeUndefined();
    });

    it('does not stream when stream is omitted (non-streaming path, still trimmed)', async () => {
      mockGenerateContent.mockResolvedValue(
        createMockTextResponse('  plain  '),
      );
      vi.mocked(getFunctionCalls).mockReturnValueOnce(undefined);

      const result = await askHi();

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContentStream).not.toHaveBeenCalled();
      expect(result.text).toBe('plain');
      expect(result.hadToolCall).toBe(false);
    });

    it('reports function calls from the non-streaming response', async () => {
      const response = createMockResponseWithFunctionCall({});
      mockGenerateContent.mockResolvedValue(response);
      vi.mocked(getFunctionCalls).mockReturnValueOnce([
        { name: 'respond_in_schema', args: {} },
      ]);

      const result = await askHi();

      expect(mockGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContentStream).not.toHaveBeenCalled();
      expect(getFunctionCalls).toHaveBeenCalledWith(response);
      expect(result.hadToolCall).toBe(true);
    });

    it('propagates a mid-stream error and never returns the partial text', async () => {
      async function* failingStream(): AsyncGenerator<GenerateContentResponse> {
        yield createMockTextResponse('partial');
        throw new Error('connection reset');
      }

      // A failure after some deltas rejects the whole call (the 'partial' text
      // never surfaces as a success) and, the signal not being aborted, is
      // reported like the non-streaming path. This is the
      // gateway-timeout-mid-inference scenario the PR targets.
      await expect(streamHi(failingStream())).rejects.toThrow(
        'connection reset',
      );
      expect(vi.mocked(reportError)).toHaveBeenCalled();
    });

    it('surfaces an abort that fires mid-stream and skips error reporting', async () => {
      async function* abortingStream(): AsyncGenerator<GenerateContentResponse> {
        yield createMockTextResponse('chunk');
        abortController.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      // The catch block's `abortSignal.aborted` guard rethrows the original
      // error unwrapped and skips reportError, so a user cancellation
      // mid-stream surfaces verbatim and is not logged as an API failure.
      await expect(streamHi(abortingStream())).rejects.toThrow(
        'The operation was aborted.',
      );
      expect(vi.mocked(reportError)).not.toHaveBeenCalled();
    });

    it('returns an empty result for a stream that yields no chunks', async () => {
      // A stream that closes immediately (no content, no usage) must resolve
      // to an empty string rather than throw: the boundary the streaming
      // branch introduces.
      const result = await streamHi(mockTextStream([]));

      expect(result.text).toBe('');
      expect(result.usage).toBeUndefined();
    });

    it('captures usage that rides the final content-bearing chunk', async () => {
      // Realistic Gemini/OpenAI shape: usageMetadata arrives on the last chunk
      // that *also* carries a text delta. Text and usage are read
      // independently per chunk, so reading usage must not drop that text.
      const usage = {
        promptTokenCount: 5,
        candidatesTokenCount: 3,
        totalTokenCount: 8,
      };

      const result = await streamHi(
        streamOf(
          createMockTextResponse('Hello, '),
          Object.assign(createMockTextResponse('world'), {
            usageMetadata: usage,
          }),
        ),
      );

      expect(result.text).toBe('Hello, world');
      expect(result.usage).toEqual(usage);
    });
  });

  describe('per-model resolution', () => {
    const fastModel = 'fast-model';
    const tokenPlanUrl = 'https://token-plan.example.com/v1';
    const fastGenerateContent = vi.fn();
    const fastGenerateContentStream = vi.fn();
    const fastContentGenerator = {
      generateContent: fastGenerateContent,
      generateContentStream: fastGenerateContentStream,
      embedContent: vi.fn(),
    } as unknown as Mocked<ContentGenerator>;

    const getResolvedModel = vi.fn();
    let crossProviderConfig: Mocked<Config>;

    const perModelClient = () =>
      new BaseLlmClient(mockContentGenerator, crossProviderConfig);
    const resolve = (model: string, opts?: { failClosed?: boolean }) =>
      perModelClient().resolveForModel(model, opts);
    const bareGenerator = () =>
      ({
        generateContent: vi.fn(),
        embedContent: vi.fn(),
      }) as unknown as Mocked<ContentGenerator>;
    // The registry knows only `entry`, under (authType, model) and, when
    // given, baseUrl.
    const registerOnly = (
      authType: AuthType,
      model: string,
      entry: Record<string, unknown>,
      baseUrl?: string,
    ) =>
      getResolvedModel.mockImplementation((a: string, m: string, b?: string) =>
        a === authType &&
        m === model &&
        (baseUrl === undefined || b === baseUrl)
          ? { ...entry }
          : undefined,
      );
    const anthropicKey = (extra: Record<string, unknown> = {}) => ({
      authType: AuthType.USE_ANTHROPIC,
      envKey: 'ANTHROPIC_API_KEY',
      ...extra,
    });
    // Registers 'qwen3.7-plus' under `authType` at the token-plan baseUrl only.
    const registerTokenPlan = (authType: AuthType) =>
      registerOnly(
        authType,
        'qwen3.7-plus',
        {
          id: 'qwen3.7-plus',
          authType,
          envKey: 'TOKEN_PLAN_KEY',
          baseUrl: tokenPlanUrl,
        },
        tokenPlanUrl,
      );
    // generateJson for a 'go' prompt on `model`, answered by the fast generator.
    const generateJsonOn = (model: string) => {
      answerWithJson({ ok: true }, fastGenerateContent);
      return perModelClient().generateJson({
        contents: [userText('go')],
        schema: { type: 'object' },
        model,
        abortSignal: new AbortController().signal,
        promptId: 'test',
      });
    };
    // `model` must be looked up, built and sent as the bare openai
    // 'shared-model' id.
    const expectRoutedToSharedModel = async (model: string) => {
      registerOnly(AuthType.USE_OPENAI, 'shared-model', {
        id: 'shared-model',
        authType: AuthType.USE_OPENAI,
        envKey: 'OPENAI_API_KEY',
      });

      await generateJsonOn(model);

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
    };

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
            : [{ id: fastModel, authType: AuthType.USE_ANTHROPIC }],
        ),
        getModelsConfig: vi.fn().mockReturnValue({ getResolvedModel }),
      } as unknown as Mocked<Config>;
    });

    it('returns the constructor-injected generator when model matches main', async () => {
      const resolved = await resolve('main-model');

      expect(resolved.contentGenerator).toBe(mockContentGenerator);
      expect(resolved.retryAuthType).toBe(AuthType.QWEN_OAUTH);
      expect(getResolvedModel).not.toHaveBeenCalled();
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('returns the active runtime generator when model matches the runtime view', async () => {
      const runtimeContentGenerator = bareGenerator();
      crossProviderConfig.getContentGenerator = vi
        .fn()
        .mockReturnValue(runtimeContentGenerator);
      vi.mocked(crossProviderConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_OPENAI,
        model: 'runtime-model',
      });
      vi.mocked(crossProviderConfig.getModel).mockReturnValue('runtime-model');

      const resolved = await resolve('runtime-model');

      expect(resolved.contentGenerator).toBe(runtimeContentGenerator);
      expect(resolved.retryAuthType).toBe(AuthType.USE_OPENAI);
      expect(getResolvedModel).not.toHaveBeenCalled();
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('builds a per-model generator when model differs and is registered under another authType', async () => {
      // Main authType is QWEN_OAUTH; fast model only resolves under USE_ANTHROPIC.
      registerOnly(
        AuthType.USE_ANTHROPIC,
        fastModel,
        anthropicKey({ baseUrl: 'https://api.anthropic.com' }),
      );
      const targetConfig = {
        model: fastModel,
        authType: AuthType.USE_ANTHROPIC,
      };
      mockBuildAgentContentGeneratorConfig.mockReturnValue(targetConfig);

      const resolved = await resolve(fastModel);

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
      registerOnly(AuthType.USE_ANTHROPIC, 'shared-model', {
        id: 'shared-model',
        authType: AuthType.USE_ANTHROPIC,
        baseUrl: '',
      });

      const resolved = await resolve('anthropic:shared-model', {
        failClosed: true,
      });

      expect(resolved.contentGenerator).toBe(fastContentGenerator);
      expect(mockCreateContentGenerator).toHaveBeenCalledOnce();
    });

    it('keeps explicit vision capability on the resolved generator config', async () => {
      registerOnly(AuthType.USE_ANTHROPIC, fastModel, {
        id: fastModel,
        authType: AuthType.USE_ANTHROPIC,
        baseUrl: 'https://api.anthropic.com',
        capabilities: { vision: true },
      });
      mockBuildAgentContentGeneratorConfig.mockReturnValue({
        model: fastModel,
        authType: AuthType.USE_ANTHROPIC,
        modalities: {},
      });

      const resolved = await resolve(fastModel, { failClosed: true });

      expect(resolved.contentGeneratorConfig.modalities?.image).toBe(true);
      expect(mockCreateContentGenerator).toHaveBeenCalledWith(
        expect.objectContaining({ modalities: { image: true } }),
        crossProviderConfig,
      );
    });

    it('resolves same-id model selectors by baseUrl when provided', async () => {
      registerTokenPlan(AuthType.USE_OPENAI);

      const resolved = await resolve(`openai:qwen3.7-plus\0${tokenPlanUrl}`);

      expect(resolved.contentGenerator).toBe(fastContentGenerator);
      expect(getResolvedModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3.7-plus',
        tokenPlanUrl,
      );
      expect(mockBuildAgentContentGeneratorConfig).toHaveBeenCalledWith(
        crossProviderConfig,
        'qwen3.7-plus',
        expect.objectContaining({
          authType: AuthType.USE_OPENAI,
          baseUrl: tokenPlanUrl,
        }),
      );
    });

    it('threads baseUrl through bare model registry lookups', async () => {
      registerTokenPlan(AuthType.USE_ANTHROPIC);

      await resolve(`qwen3.7-plus\0${tokenPlanUrl}`);

      expect(getResolvedModel).toHaveBeenCalledWith(
        AuthType.QWEN_OAUTH,
        'qwen3.7-plus',
        tokenPlanUrl,
      );
    });

    it('does not reuse the main generator when the requested baseUrl differs', async () => {
      vi.mocked(crossProviderConfig.getModel).mockReturnValue('qwen3.7-plus');
      vi.mocked(crossProviderConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-plus',
        baseUrl: 'https://main.example.com/v1',
      });
      registerTokenPlan(AuthType.USE_OPENAI);

      const resolved = await resolve(`openai:qwen3.7-plus\0${tokenPlanUrl}`);

      expect(resolved.contentGenerator).toBe(fastContentGenerator);
      expect(mockCreateContentGenerator).toHaveBeenCalledTimes(1);
      expect(getResolvedModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3.7-plus',
        tokenPlanUrl,
      );
    });

    it('fails closed (throws) for an unregistered model when failClosed is set', async () => {
      getResolvedModel.mockReturnValue(undefined); // not registered anywhere

      await expect(
        resolve('ghost-model', { failClosed: true }),
      ).rejects.toThrow(/not registered/i);
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('fails closed when the requested baseUrl does not match any registered model', async () => {
      getResolvedModel.mockReturnValue(undefined);

      await expect(
        resolve('openai:real-model\0https://wrong-url.example.com', {
          failClosed: true,
        }),
      ).rejects.toThrow(
        'Model "openai:real-model" at baseUrl "https://wrong-url.example.com" is not registered',
      );
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('fails closed (throws) when generator creation fails and failClosed is set', async () => {
      registerOnly(
        AuthType.USE_ANTHROPIC,
        fastModel,
        anthropicKey({ baseUrl: 'https://api.anthropic.com' }),
      );
      mockCreateContentGenerator.mockRejectedValue(
        new Error('missing credential'),
      );

      await expect(resolve(fastModel, { failClosed: true })).rejects.toThrow(
        /missing credential/i,
      );
    });

    it('falls back to the main generator for an unregistered model when failClosed is not set', async () => {
      getResolvedModel.mockReturnValue(undefined);

      const resolved = await resolve('ghost-model');

      expect(resolved.contentGenerator).toBe(mockContentGenerator);
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('streams through a per-model generator resolved by model (compression path)', async () => {
      // chatCompressionService passes both `model` and `stream: true`, so the
      // streaming branch must run on the resolveForModel-selected generator,
      // not the constructor-injected default.
      getResolvedModel.mockReturnValue(anthropicKey());
      const usage = {
        promptTokenCount: 2,
        candidatesTokenCount: 2,
        totalTokenCount: 4,
      };
      streamYields(
        mockTextStream(['fast ', 'stream'], usage),
        fastGenerateContentStream,
      );

      const result = await askHi(
        { model: fastModel, stream: true },
        perModelClient(),
      );

      expect(fastGenerateContentStream).toHaveBeenCalledTimes(1);
      // Streamed against the resolved per-model identity, not the main model.
      expect(fastGenerateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          model: fastModel,
          contents: [userText('hi')],
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
      getResolvedModel.mockReturnValue(anthropicKey());
      const c = perModelClient();

      await c.resolveForModel(fastModel);
      await c.resolveForModel(fastModel);

      expect(mockCreateContentGenerator).toHaveBeenCalledTimes(1);
    });

    it('shares a successful per-model generator across failClosed modes', async () => {
      getResolvedModel.mockReturnValue(anthropicKey());
      const c = perModelClient();

      await c.resolveForModel(fastModel, { failClosed: true });
      await c.resolveForModel(fastModel);

      expect(mockCreateContentGenerator).toHaveBeenCalledTimes(1);
    });

    it('clearPerModelGeneratorCache forces a rebuild on the next call', async () => {
      getResolvedModel.mockReturnValue(anthropicKey());
      const c = perModelClient();

      await c.resolveForModel(fastModel);
      c.clearPerModelGeneratorCache();
      await c.resolveForModel(fastModel);

      expect(mockCreateContentGenerator).toHaveBeenCalledTimes(2);
    });

    it('falls back to the main generator when the target model is not in the registry', async () => {
      getResolvedModel.mockReturnValue(undefined);

      const resolved = await resolve('unknown-model');

      expect(resolved.contentGenerator).toBe(mockContentGenerator);
      // Falls back to main authType for retry classification.
      expect(resolved.retryAuthType).toBe(AuthType.QWEN_OAUTH);
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('does not cache the unregistered-model fallback across runtime-view changes', async () => {
      // An unregistered selector falls back to getCurrentContentGenerator(),
      // and the runtime view changes between calls: caching would pin the
      // first call's generator under the selector key and return it after the
      // view has unwound.
      getResolvedModel.mockReturnValue(undefined);
      const firstRuntimeGenerator = bareGenerator();
      const secondRuntimeGenerator = bareGenerator();
      const getContentGenerator = vi
        .fn()
        .mockReturnValueOnce(firstRuntimeGenerator)
        .mockReturnValueOnce(secondRuntimeGenerator);
      crossProviderConfig.getContentGenerator = getContentGenerator;
      const c = perModelClient();

      const first = await c.resolveForModel('unknown-model');
      const second = await c.resolveForModel('unknown-model');

      expect(first.contentGenerator).toBe(firstRuntimeGenerator);
      expect(second.contentGenerator).toBe(secondRuntimeGenerator);
      expect(getContentGenerator).toHaveBeenCalledTimes(2);
      expect(mockCreateContentGenerator).not.toHaveBeenCalled();
    });

    it('falls back to the main generator when createContentGenerator throws', async () => {
      getResolvedModel.mockReturnValue(anthropicKey());
      mockCreateContentGenerator.mockRejectedValue(
        new Error('SDK init failed'),
      );

      const resolved = await resolve(fastModel);

      expect(resolved.contentGenerator).toBe(mockContentGenerator);
      // retryAuthType still reflects the target provider: failing to build the
      // generator does not change which provider's retry policy applies.
      expect(resolved.retryAuthType).toBe(AuthType.USE_ANTHROPIC);
    });

    it('generateJson routes through the per-model generator and forwards retry authType', async () => {
      const retryErrorCodes = [4999];
      getResolvedModel.mockReturnValue(
        anthropicKey({ generationConfig: { retryErrorCodes } }),
      );

      await generateJsonOn(fastModel);

      expect(fastGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expectRetriedWith({
        authType: AuthType.USE_ANTHROPIC,
        extraRetryErrorCodes: retryErrorCodes,
      });
    });

    it('generateJson accepts authType-qualified selectors and sends the bare model id', () =>
      expectRoutedToSharedModel('openai:shared-model'));

    it('generateJson resolves fast selectors through the configured fast model', async () => {
      crossProviderConfig.getFastModel.mockReturnValue('openai:shared-model');
      await expectRoutedToSharedModel('fast');
    });

    it('generateText routes through the per-model generator and forwards retry authType', async () => {
      getResolvedModel.mockReturnValue(anthropicKey());
      fastGenerateContent.mockResolvedValue(createMockTextResponse('hi'));

      const result = await perModelClient().generateText({
        contents: [userText('say hi')],
        model: fastModel,
        abortSignal: new AbortController().signal,
        promptId: 'test',
      });

      expect(result.text).toBe('hi');
      expect(fastGenerateContent).toHaveBeenCalledTimes(1);
      expect(mockGenerateContent).not.toHaveBeenCalled();
      expectRetriedWith({ authType: AuthType.USE_ANTHROPIC });
    });
  });

  describe('output budget is window-aware (issue #13208)', () => {
    // `estimateContentTokens` counts chars/4 for ASCII text, so a prompt of
    // `tokens` tokens is `tokens * 4` characters.
    const promptOfTokens = (tokens: number) => [
      userText('x'.repeat(tokens * 4)),
    ];

    // Pins the session model to `model` so `resolveForModel` takes the
    // same-model path and hands this window back. Omitting
    // `contextWindowSize` leaves it unconfigured, which is how the budget
    // falls back to `tokenLimit(model, 'input')`.
    function useWindow(model: string, contextWindowSize?: number) {
      mockConfig.getModel.mockReturnValue(model);
      mockConfig.getContentGeneratorConfig.mockReturnValue({
        model,
        authType: AuthType.USE_GEMINI,
        ...(contextWindowSize === undefined ? {} : { contextWindowSize }),
      });
    }

    // `maxOutputTokens` on the config actually handed to the generator.
    const sentBudget = (generator = mockGenerateContent) =>
      (
        generator.mock.calls.at(-1)?.[0] as
          | { config?: { maxOutputTokens?: number } }
          | undefined
      )?.config?.maxOutputTokens;

    // `thinkingConfig` on that same config: its `thinkingBudget` is the
    // request-local cap `anthropicContentGenerator` clamps `budget_tokens`
    // against, so an emitted budget is only usable if this comes down with it.
    const sentThinking = () =>
      (
        mockGenerateContent.mock.calls.at(-1)?.[0] as
          | {
              config?: {
                thinkingConfig?: {
                  includeThoughts?: boolean;
                  thinkingBudget?: number;
                };
              };
            }
          | undefined
      )?.config?.thinkingConfig;

    // Estimate of the `tools` payload on the wire the last request actually
    // carried, priced the way the budget prices it: the declaration is read
    // back off the mock rather than rebuilt so the assertion measures the
    // production shape, not a copy that could drift from it.
    const sentToolsTokens = (generator = mockGenerateContent) => {
      const tools = (
        generator.mock.calls.at(-1)?.[0] as
          | { config?: { tools?: unknown } }
          | undefined
      )?.config?.tools;
      return Math.ceil(JSON.stringify(tools).length / CHARS_PER_TOKEN);
    };

    const askText = (
      model: string,
      tokens: number,
      extra: Partial<GenerateTextOptions> = {},
    ) => {
      mockGenerateContent.mockResolvedValue(createMockTextResponse('ok'));
      return client.generateText({
        contents: promptOfTokens(tokens),
        model,
        abortSignal: abortController.signal,
        promptId: 'p',
        ...extra,
      });
    };

    // Both keys are read by the code under test — `QWEN_CODE_MAX_OUTPUT_TOKENS`
    // as the explicit ceiling, `QWEN_IMAGE_TOKEN_ESTIMATE` through
    // `resolveSlimmingConfig`, where env outranks the mocked settings — so an
    // ambient value in a dev shell or a CI job decides these cases instead of
    // the mocks. Clear them per case and put back whatever was there.
    beforeEach(() => {
      vi.stubEnv('QWEN_CODE_MAX_OUTPUT_TOKENS', undefined);
      vi.stubEnv('QWEN_IMAGE_TOKEN_ESTIMATE', undefined);
    });

    // `useWindow` replaces these implementations for good (`clearAllMocks`
    // keeps implementations), so the rest of the file needs them back.
    afterEach(() => {
      vi.unstubAllEnvs();
      mockConfig.getModel.mockReturnValue('test-model');
      mockConfig.getModelsConfig.mockReturnValue(
        undefined as unknown as ReturnType<Config['getModelsConfig']>,
      );
      mockConfig.getChatCompression.mockReturnValue(undefined);
      mockBuildAgentContentGeneratorConfig.mockReset();
      mockCreateContentGenerator.mockReset();
    });

    it('shrinks the request so a large prompt still fits the window', async () => {
      useWindow('qwen3-coder-plus', 131_072);

      await askText('qwen3-coder-plus', 100_000);

      // 131_072 − 100_000 = 31_072 of room, under the model's 64_000 output
      // ceiling: the budget is the room actually left, so
      // prompt + max_tokens == window.
      expect(sentBudget()).toBe(31_072);
      expect(100_000 + 31_072).toBeLessThanOrEqual(131_072);
    });

    it('keeps a smaller caller-supplied maxOutputTokens', async () => {
      useWindow('qwen3-coder-plus', 131_072);

      await askText('qwen3-coder-plus', 100_000, {
        config: { maxOutputTokens: 300 },
      });

      expect(sentBudget()).toBe(300);
    });

    it('sends a larger caller-supplied maxOutputTokens as given', async () => {
      // A caller that budgeted its own value against the *receiving* window
      // (compaction, via `computeCompactionOutputBudget`, #7960) must not be
      // re-clamped here: that would shrink a request against a window it is
      // not going to, so the value passes through even when it exceeds the
      // configured one. The fixed-constant callers are not window-budgeted —
      // see the caveat on `budgetOutputTokensForWindow`.
      useWindow('qwen3-coder-plus', 131_072);

      await askText('qwen3-coder-plus', 100_000, {
        config: { maxOutputTokens: 60_000 },
      });

      expect(sentBudget()).toBe(60_000);
    });

    it('applies the same budget in JSON mode', async () => {
      useWindow('qwen3-coder-plus', 131_072);
      answerWithJson({ ok: true });

      await client.generateJson({
        contents: promptOfTokens(100_000),
        schema: { type: 'object', properties: { ok: { type: 'boolean' } } },
        model: 'qwen3-coder-plus',
        abortSignal: abortController.signal,
        promptId: 'p',
      });

      // The room is priced against the `respond_in_schema` declaration too,
      // so the emitted cap sits below the plain `window − prompt` by the
      // schema's wire size; prompt + cap + schema still fit the window.
      const budget = sentBudget();
      const schemaTokens = sentToolsTokens();
      expect(schemaTokens).toBeGreaterThan(0);
      expect(budget).toBe(31_072 - schemaTokens);
      expect(100_000 + (budget ?? 0) + schemaTokens).toBeLessThanOrEqual(
        131_072,
      );
    });

    it('leaves room for a large respond_in_schema schema against the window', async () => {
      // The failure this case pins: a room term pricing only the prompt
      // emits `window − prompt` (31_072) and the wire then adds the
      // declaration on top, so a ~10_000-token schema on top of a
      // 100_000-token prompt sends ~141_072 against a 131_072 window and
      // comes back an unretried 400 — exactly the regression the budget
      // exists to prevent.
      const schema = {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 1_000 }, (_, i) => [
            `field_${i}`,
            { type: 'string', description: `column ${i} of the record` },
          ]),
        ),
      } as const;
      useWindow('qwen3-coder-plus', 131_072);
      answerWithJson({});

      await client.generateJson({
        contents: promptOfTokens(100_000),
        schema,
        model: 'qwen3-coder-plus',
        abortSignal: abortController.signal,
        promptId: 'p',
      });

      const budget = sentBudget();
      const schemaTokens = sentToolsTokens();
      expect(schemaTokens).toBeGreaterThan(10_000);
      expect(budget).toBe(31_072 - schemaTokens);
      expect(100_000 + (budget ?? 0) + schemaTokens).toBeLessThanOrEqual(
        131_072,
      );
    });

    it('prices a caller-supplied responseJsonSchema on the text route too', async () => {
      // The failure this case pins, on a live caller: `goals/goal-verifier.ts`
      // sends `responseMimeType` plus `responseJsonSchema` through
      // `runSideQuery` in text mode with no `maxOutputTokens` of its own, and
      // `openaiContentGenerator/pipeline.ts` puts the schema on the wire as
      // `response_format.json_schema`. A room term pricing only the prompt
      // emits `window − prompt`, so the wire adds the schema on top and
      // overshoots by exactly its size — the unretried 400 the budget exists
      // to prevent, on a caller that sets `maxAttempts: 1`.
      const schema = {
        type: 'object',
        properties: Object.fromEntries(
          Array.from({ length: 1_000 }, (_, i) => [
            `field_${i}`,
            { type: 'string', description: `column ${i} of the record` },
          ]),
        ),
      };
      useWindow('qwen3-coder-plus', 131_072);

      await askText('qwen3-coder-plus', 100_000, {
        config: {
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
        },
      });

      const schemaTokens = Math.ceil(
        JSON.stringify(schema).length / CHARS_PER_TOKEN,
      );
      const budget = sentBudget();
      expect(schemaTokens).toBeGreaterThan(10_000);
      expect(budget).toBe(31_072 - schemaTokens);
      expect(100_000 + (budget ?? 0) + schemaTokens).toBeLessThanOrEqual(
        131_072,
      );
    });

    it('budgets the streaming request too', async () => {
      useWindow('qwen3-coder-plus', 131_072);
      streamYields(mockTextStream(['ok']));

      await askText('qwen3-coder-plus', 100_000, { stream: true });

      expect(sentBudget(mockGenerateContentStream)).toBe(31_072);
    });

    it('falls back to the model input limit when no window is configured', async () => {
      // `deepseek-r1` is not in the catalog, so the curated tables apply:
      // input 131_072, output 65_536 → `defaultOutputCeiling` 64_000.
      useWindow('deepseek-r1');

      await askText('deepseek-r1', 100_000);

      expect(sentBudget()).toBe(31_072);
    });

    it('leaves the request untouched when the window has room', async () => {
      useWindow('deepseek-r1', 200_000);

      await askText('deepseek-r1', 100_000);

      // 200_000 − 100_000 = 100_000 of room, above the 64_000 ceiling: the
      // window is not what binds, so the budget emits nothing and the wire
      // keeps applying its own output limit as it did before this change.
      expect(sentBudget()).toBeUndefined();
    });

    it('does not cap a Gemini side query at the stale 8k output row', async () => {
      // The Gemini/Vertex wire (`llm-content-generator.ts`) and the OpenAI
      // Responses wire (`responses-pipeline.ts`) never consulted
      // `defaultOutputCeiling`, so they sent no output limit at all. Emitting
      // one unconditionally would cap every `gemini-2.5-*` side query at 8_192
      // (`OUTPUT_PATTERNS`'s `[/^gemini-/, LIMITS['8k']]` row) against a
      // 65_536 backend default — `/summary`, web-fetch extraction and the
      // vision bridge truncated with no `finishReason` to reveal it.
      useWindow('gemini-2.5-pro', 1_000_000);

      await askText('gemini-2.5-pro', 100);

      expect(sentBudget()).not.toBe(8_192);
      expect(sentBudget()).toBeUndefined();
    });

    it('never requests a ceiling >= the window, even for a small prompt', async () => {
      // The `deepseek-r1-distill-llama-8b` shape from the issue: a 32_768
      // window against a 64_000 output ceiling. Without a window term the
      // whole ceiling went on the wire, so any non-empty prompt overflowed.
      useWindow('deepseek-r1', 32_768);

      await askText('deepseek-r1', 100);

      expect(sentBudget()).toBe(32_668);
    });

    it('keeps prompt + max_tokens inside a window smaller than the output floor', async () => {
      // The issue's second scenario: on an 8_192 window with a 5_000-token
      // prompt, `clampOutputTokensToWindow` floors the room at
      // MIN_CLAMPED_OUTPUT_TOKENS (4_000) and still requests 9_000 total. The
      // side-query budget emits the room itself instead, so the invariant
      // holds.
      useWindow('deepseek-r1', 8_192);

      await askText('deepseek-r1', 5_000);

      expect(sentBudget()).toBe(3_192);
      expect(5_000 + 3_192).toBeLessThanOrEqual(8_192);
    });

    it('leaves the request uncapped when the prompt already fills the window', async () => {
      // Reachable without the prompt really being too big: the estimator
      // over-prices as well as under-prices. A 2-byte PNG charged the
      // operator's flat `imageTokenEstimate` next to 5_300 tokens of text
      // estimates 8_300 against an 8_192 window, so `room` is negative while
      // the real payload would have fit. Emitting the budget that arithmetic
      // leaves sends a request that can only answer with a stub and reports it
      // as a normal success — `generateText` returns no `finishReason`, so
      // `tools/web-fetch.ts` stores that body as the page extract. Base sent
      // no output limit and a validating backend rejected the overflow loudly.
      useWindow('deepseek-r1', 8_192);

      await askText('deepseek-r1', 9_000);

      expect(sentBudget()).toBeUndefined();
    });

    it('leaves the request uncapped when the room cannot carry an answer', async () => {
      // The same stub one integer away from the case above: 12 tokens of room
      // is a positive number, and `max_tokens: 12` still answers with a stub
      // that reads as complete — `tools/web-fetch.ts` only falls back to the
      // raw page on a throw, and its sole empty-body guard cannot see a
      // non-empty one. Base put the 64 000 ceiling on the wire, so
      // `8_180 + 64_000 > 8_192` was rejected loudly and that fallback fired.
      useWindow('deepseek-r1', 8_192);

      await askText('deepseek-r1', 8_180);

      expect(sentBudget()).toBeUndefined();
    });

    it('counts the system instruction against the window', async () => {
      // `systemInstruction` travels with the request but is not part of
      // `contents`, so a room term measuring only `contents` over-budgets by
      // exactly the instruction's size: a 2_000-token instruction on an 8_192
      // window leaves 6_092, not 8_092. The sibling side-query budget counts
      // this term (services/chatCompressionService.ts `getColdInputEstimate`).
      useWindow('qwen3-coder-plus', 8_192);

      await askText('qwen3-coder-plus', 100, {
        systemInstruction: 'y'.repeat(2_000 * 4),
      });

      expect(sentBudget()).toBe(8_192 - 100 - 2_000);
      expect(100 + 2_000 + (8_192 - 100 - 2_000)).toBeLessThanOrEqual(8_192);
    });

    // The declared contract is `string | Part | Part[] | Content`, and
    // `appendSystemInstruction` in utils/sideQuery.ts produces every one of
    // those. Pin the three non-string branches: collapsing the shape-narrowing
    // to `parts = [value]` must redden the Content and Part[] cases.
    it.each<[string, NonNullable<GenerateTextOptions['systemInstruction']>]>([
      ['Content', { role: 'user', parts: [{ text: 'y'.repeat(2_000 * 4) }] }],
      ['Part[]', [{ text: 'y'.repeat(2_000 * 4) }]],
      ['bare Part', { text: 'y'.repeat(2_000 * 4) }],
    ])('counts a %s system instruction against the window', async (_l, si) => {
      useWindow('qwen3-coder-plus', 8_192);

      await askText('qwen3-coder-plus', 100, { systemInstruction: si });

      expect(sentBudget()).toBe(8_192 - 100 - 2_000);
    });

    it('prices a kept image with the operator-resolved estimate', async () => {
      // Every other estimator on the send path uses
      // `resolveSlimmingConfig(...).imageTokenEstimate`; the 1_600 default here
      // would under-price each image, over-state the room by the difference
      // and grant a `max_tokens` the window cannot hold.
      mockConfig.getModel.mockReturnValue('deepseek-r1');
      mockConfig.getContentGeneratorConfig.mockReturnValue({
        model: 'deepseek-r1',
        authType: AuthType.USE_GEMINI,
        contextWindowSize: 32_768,
        // `slimCompactionInput` keeps an `inlineData` part only for a target
        // that declares the modality.
        modalities: { image: true },
      });
      mockConfig.getChatCompression.mockReturnValue({
        imageTokenEstimate: 3_000,
      });
      mockGenerateContent.mockResolvedValue(createMockTextResponse('ok'));

      await client.generateText({
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: 'image/png', data: 'aGk=' } }],
          },
        ],
        model: 'deepseek-r1',
        abortSignal: abortController.signal,
        promptId: 'p',
      });

      expect(sentBudget()).toBe(32_768 - 3_000);
    });

    it('measures the room on the slimmed payload, not the caller-supplied one', async () => {
      // The budget runs after `slimCompactionInput`, and this target declares
      // no `image` modality, so the request actually carries the 18-char
      // `[image: image/png]` placeholder — 5 estimated tokens, not the 1_600
      // the raw `inlineData` part is charged. Feeding the pre-slimming
      // `contents` to the budget instead would emit 8_192 - 1_600 = 6_592.
      useWindow('deepseek-r1', 8_192);
      mockGenerateContent.mockResolvedValue(createMockTextResponse('ok'));

      await client.generateText({
        contents: [
          {
            role: 'user',
            parts: [{ inlineData: { mimeType: 'image/png', data: 'aGk=' } }],
          },
        ],
        model: 'deepseek-r1',
        abortSignal: abortController.signal,
        promptId: 'p',
      });

      expect(sentBudget()).toBe(8_187);
    });

    it('pairs the emitted budget with a thinking budget', async () => {
      // `/insight` sends a whole-session transcript with
      // `thinkingConfig: { includeThoughts: true }` and no `maxOutputTokens`
      // (services/insight/generators/DataProcessor.ts). The manual Anthropic
      // route clamps `budget_tokens` to `max_tokens - 1`, so an unpaired
      // 25 536 goes out beside `budget_tokens: 25 535` — one visible token,
      // no `respond_in_schema` call, `generateJson` returns `{}`, and the
      // session silently disappears from the report.
      useWindow('qwen3-coder-plus', 65_536);

      await askText('qwen3-coder-plus', 40_000, {
        config: { thinkingConfig: { includeThoughts: true } },
      });

      const budget = sentBudget() ?? 0;
      // `?? budget` is the unpaired arm: without the pairing the whole emitted
      // budget is what reasoning would take, which is the starvation itself.
      const thinkingBudget = sentThinking()?.thinkingBudget ?? budget;

      expect(budget).toBe(25_536);
      expect(thinkingBudget).toBe(12_768);
      expect(budget - thinkingBudget).toBeGreaterThanOrEqual(1_024);
    });

    it('leaves a thinking request uncapped when the room cannot host both', async () => {
      // 8 192 − 7 000 = 1 192 of room. The manual route drops thinking below a
      // 1 024 `budget_tokens`, so no legal split leaves visible output here:
      // capping anyway would answer with a stub, and forcing the 1 024 floor
      // would silently discard the reasoning the caller asked for. Uncapped
      // keeps `includeThoughts` and fails loudly, as base did.
      useWindow('deepseek-r1', 8_192);

      await askText('deepseek-r1', 7_000, {
        config: { thinkingConfig: { includeThoughts: true } },
      });

      expect(sentBudget()).toBeUndefined();
      expect(sentThinking()).toEqual({ includeThoughts: true });
    });

    it('budgets the no-thoughts shape every side query actually carries', async () => {
      // `applyThinkingDefault` (utils/sideQuery.ts) stamps
      // `thinkingConfig: { includeThoughts: false }` on every side query that
      // does not set its own, and `runSideQuery` adds no `maxOutputTokens`, so
      // this is the default production branch - all twelve callers arrive with
      // it (`tools/web-fetch.ts:609` passes no config at all). Same
      // 8 192 - 7 000 = 1 192 of room as the case above, which the thinking
      // split has to leave uncapped: with no reasoning to pay for, the whole
      // room is visible output and has to be emitted. Collapsing the guard to
      // `if (!thinking)` routes this into the split instead, where
      // `Math.floor(1_192 / 2)` = 596 falls below the 1 024 floor and the
      // request goes out with no budget at all - the #13208 overflow itself.
      useWindow('deepseek-r1', 8_192);

      await askText('deepseek-r1', 7_000, {
        config: { thinkingConfig: { includeThoughts: false } },
      });

      expect(sentBudget()).toBe(1_192);
      expect(7_000 + 1_192).toBeLessThanOrEqual(8_192);
      // Apart from the budget the request is returned as built: no
      // `thinkingBudget` is invented for a caller that asked for no reasoning.
      expect(sentThinking()).toEqual({ includeThoughts: false });
    });

    it('leaves a no-thoughts request unpaired where the split would apply', async () => {
      // Same window and prompt as `pairs the emitted budget with a thinking
      // budget`, so the room (25 536) is one where the split is legal and does
      // run for `includeThoughts: true`. With thoughts off the guard returns
      // before the split, so the emitted budget is the same but no
      // `thinkingBudget` key may appear: `if (!thinking)` alone would pair
      // 12 768 here, and `sentBudget()` cannot tell the two apart.
      useWindow('qwen3-coder-plus', 65_536);

      await askText('qwen3-coder-plus', 40_000, {
        config: { thinkingConfig: { includeThoughts: false } },
      });

      expect(sentBudget()).toBe(25_536);
      expect(sentThinking()).toEqual({ includeThoughts: false });
    });

    it('budgets against the target window, not the session window', async () => {
      // Side queries default to the fast model, and a same-provider target
      // whose registry entry declares no window inherits the *session* model's
      // number through `{ ...parentConfig }` — a number, so the
      // `?? tokenLimit(targetModel, 'input')` arm is the only thing standing
      // between that route and the session window. Session `test-model` on
      // 8_192, target `deepseek-r1` declaring nothing and tabled at 131_072:
      // budgeting against the inherited number leaves no room at all, so the
      // assertion below only holds when the window comes from the target, and
      // only when the target's own window still binds (a roomy one would emit
      // nothing either way). Deleting `contextWindowSize` from
      // `ResolvedGeneratorForModel`, or the `?? tokenLimit(...)` arm that
      // supplies it here, must redden it.
      useWindow('test-model', 8_192);
      mockConfig.getModelsConfig.mockReturnValue({
        getResolvedModel: vi.fn().mockReturnValue({
          id: 'deepseek-r1',
          authType: AuthType.USE_GEMINI,
          generationConfig: {},
        }),
      } as unknown as ReturnType<Config['getModelsConfig']>);
      mockBuildAgentContentGeneratorConfig.mockReturnValue({
        model: 'deepseek-r1',
        authType: AuthType.USE_GEMINI,
        // what the real builder hands back for a same-provider target that
        // declares no window of its own: the session's, inherited
        contextWindowSize: 8_192,
      });
      const targetGenerateContent = vi
        .fn()
        .mockResolvedValue(createMockTextResponse('ok'));
      mockCreateContentGenerator.mockResolvedValue({
        generateContent: targetGenerateContent,
        generateContentStream: vi.fn(),
        embedContent: vi.fn(),
      });

      await askText('deepseek-r1', 100_000);

      expect(targetGenerateContent).toHaveBeenCalledTimes(1);
      expect(sentBudget(targetGenerateContent)).toBe(31_072);
      expect(100_000 + 31_072).toBeLessThanOrEqual(131_072);
    });

    it('budgets against the session window when the target model is not registered', async () => {
      // Caveat, by design: `createRuntimeViewForModel` falls back to the main
      // generator when the target model is not registered, returning the
      // *session* config while `model` stays the resolved target. The window
      // therefore describes the session model (8_192) and the ceiling the
      // target (`qwen3-coder-plus`, 64_000) — the budget still fits the
      // window it was handed. The generator-error fallback returns the same
      // config object, so it budgets identically.
      useWindow('test-model', 8_192);

      await askText('qwen3-coder-plus', 100);

      expect(mockGenerateContent).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'qwen3-coder-plus' }),
        'p',
      );
      expect(sentBudget()).toBe(8_092);
    });

    it('ignores a non-positive configured window', async () => {
      // `config.ts` reads `contextWindowSize <= 0` as "not configured", so a
      // cleared settings value falls through to `tokenLimit(model, 'input')`
      // (131_072, as the unconfigured-window case above) instead of becoming
      // the window term and flooring the request to `max_tokens: 1`.
      useWindow('deepseek-r1', 0);

      await askText('deepseek-r1', 100_000);

      expect(sentBudget()).toBe(31_072);
    });

    describe('QWEN_CODE_MAX_OUTPUT_TOKENS still applies to side queries', () => {
      // Both providers read the override only when the request carries no
      // output limit of its own (`provider/default.ts` applyOutputTokenLimit,
      // `anthropicContentGenerator.ts` buildSamplingParameters), so a budget
      // that ignores the env var silently displaces the documented override —
      // and can even raise the wire value. The override therefore has to be
      // the term the room is compared against, not a value this layer emits.
      const ENV_KEY = 'QWEN_CODE_MAX_OUTPUT_TOKENS';

      it('caps the budget at the override instead of raising it', async () => {
        process.env[ENV_KEY] = '2000';
        useWindow('qwen3-coder-plus', 5_100);

        // 5_100 − 100 = 5_000 of room, above the operator's 2_000: the
        // override is what binds, so the budget leaves the request alone and
        // the provider applies 2_000 itself. An env-blind budget would compare
        // against the model's own 32_768 ceiling instead, find the window
        // binding, and put 5_000 on the wire — 2.5x what was asked for.
        await askText('qwen3-coder-plus', 100);

        expect(sentBudget()).toBeUndefined();
      });

      it('treats the override as a ceiling, not a floor', async () => {
        process.env[ENV_KEY] = '100000';
        useWindow('deepseek-r1', 32_768);

        await askText('deepseek-r1', 100);

        // The room left in the window still binds: the override must not lift
        // the budget back over it.
        expect(sentBudget()).toBe(32_668);
      });

      it('ignores a malformed override', async () => {
        process.env[ENV_KEY] = 'not-a-number';
        useWindow('qwen3-coder-plus', 131_072);

        await askText('qwen3-coder-plus', 100_000);

        expect(sentBudget()).toBe(31_072);
      });

      it('still lets a caller-supplied maxOutputTokens win over the override', async () => {
        // Documented precedence: an explicit request value outranks the env
        // override, exactly as it did before side queries were budgeted. The
        // caller value has to sit *above* the override to pin that direction —
        // with a value below it, an implementation doing the opposite
        // (`Math.min(callerValue, envOverride)`, override winning) returns the
        // same number and this case cannot tell the two apart.
        process.env[ENV_KEY] = '2000';
        useWindow('qwen3-coder-plus', 131_072);

        await askText('qwen3-coder-plus', 100_000, {
          config: { maxOutputTokens: 4_096 },
        });

        expect(sentBudget()).toBe(4_096);
      });

      it('sends an override above the auto ceiling instead of clipping it', async () => {
        // The override *replaces* the model-limit default, so an operator limit
        // above `defaultOutputCeiling` still reaches the wire on a side query,
        // as it does on the main turn. The window has to bind between the two
        // for that to be observable: at 60_100 the room is 60_000, above the
        // model's own 32_000 auto ceiling and below the override, so a budget
        // that intersected the two would emit 32_000 here.
        //
        // The model has to be one no provider clips: `test-model` is in neither
        // the catalog nor `OUTPUT_PATTERNS`, so what this layer emits is what
        // reaches the wire. A `qwen3-coder-plus` case cannot show the design —
        // `hasExplicitOutputLimit` is true for it, so `applyOutputTokenLimit`
        // and Anthropic's `buildSamplingParameters` both clamp 60_000 and
        // 100_000 to the same 32_768.
        process.env[ENV_KEY] = '100000';
        useWindow('test-model', 60_100);

        await askText('test-model', 100);

        expect(sentBudget()).toBe(60_000);
      });

      it('lets samplingParams.max_tokens outrank the override', async () => {
        // Documented precedence: the override "is overridden by
        // `samplingParams.max_tokens` in settings". The sampling value has to
        // sit above the override to pin that direction, and the window has to
        // bind between them: at 40_100 the room is 40_000, so a budget that
        // compared against the 2_000 override would emit nothing at all.
        process.env[ENV_KEY] = '2000';
        mockConfig.getModel.mockReturnValue('qwen3-coder-plus');
        mockConfig.getContentGeneratorConfig.mockReturnValue({
          model: 'qwen3-coder-plus',
          authType: AuthType.USE_GEMINI,
          contextWindowSize: 40_100,
          samplingParams: { max_tokens: 128_000 },
        });

        await askText('qwen3-coder-plus', 100);

        expect(sentBudget()).toBe(40_000);
      });

      it('does not let the override authorize a budget above the model output limit', async () => {
        // The override is an operator ceiling, not a licence to emit above the
        // model's own output maximum. Two wires apply no output clamp of their
        // own — Gemini/Vertex and OpenAI Responses, which assigns
        // `max_output_tokens` straight off the request
        // (`responses-pipeline.ts` reconcileMaxTokens) — while the sibling chat
        // wire does clamp (`provider/default.ts` applyOutputTokenLimit, "cap at
        // model limit to avoid API errors"). On those two an emitted 172_000 for
        // a model whose output maximum is 131_072 goes out as-is and the server
        // answers a plain 400, which `utils/retry.ts` does not retry — where
        // before side queries were budgeted the same request carried no
        // `max_tokens` and succeeded.
        //
        // The clamp has to key on `hasExplicitOutputLimit`, never on
        // `tokenLimit(model, 'output')` unconditionally: an id in neither table
        // resolves to `DEFAULT_OUTPUT_TOKEN_LIMIT`, and `tokenLimits.ts` states
        // that catalog-only limits "must not clamp a user's endpoint-specific
        // override" — the `test-model` case above is what pins that.
        process.env[ENV_KEY] = '200000';
        useWindow('gpt-5', 272_000);

        // 272_000 − 100_000 = 172_000 of room: below the operator's 200_000, so
        // an output-blind comparison emits it, but above `gpt-5`'s 131_072 output
        // maximum, so the override cannot authorize it and the wire keeps its
        // pre-budget behaviour of sending nothing.
        await askText('gpt-5', 100_000);

        expect(sentBudget()).toBeUndefined();
      });
    });
  });
});

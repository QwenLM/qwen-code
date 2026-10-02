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
});

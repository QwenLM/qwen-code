/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type OpenAI from 'openai';
import type { Candidate, GenerateContentParameters, Part } from '@google/genai';
import {
  FinishReason,
  FunctionCallingConfigMode,
  GenerateContentResponse,
  Type,
} from '@google/genai';
import type { ErrorHandler, PipelineConfig } from './types.js';
import {
  ContentGenerationPipeline,
  NonSSEResponseError,
  StreamContentError,
  StreamInactivityTimeoutError,
  StreamLifetimeExceededError,
} from './pipeline.js';
import { OpenAIContentConverter } from './converter.js';
import { toolCallArgumentsWereIncomplete } from '../incomplete-tool-call-args.js';
import { openaiRequestCaptureContext } from './requestCaptureContext.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';
import type { Config } from '../../config/config.js';
import {
  AuthType,
  type ContentGeneratorConfig,
  type PromptCacheSharingParameters,
} from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import { determineProvider } from './index.js';
import { DefaultOpenAICompatibleProvider } from './provider/default.js';
import { DashScopeOpenAICompatibleProvider } from './provider/dashscope.js';
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  DEFAULT_STREAM_MAX_LIFETIME_MS,
  MAX_STREAM_GUARD_TIMEOUT_MS,
  QWEN_STREAM_IDLE_TIMEOUT_MS_ENV,
  QWEN_STREAM_MAX_LIFETIME_MS_ENV,
} from './constants.js';
import { logProtocolTagSanitized } from '../../telemetry/loggers.js';
import {
  getGenAiUsageProvenance,
  setGenAiUsageProvenance,
} from '../../telemetry/gen-ai-usage.js';
import { setToolCallPreparations } from '../tool-call-preparation.js';
import { runWithAgentContext } from '../../agents/runtime/agent-context.js';
import { runInForkContext } from '../../tools/agent/fork-subagent.js';
import { findProviderById } from '../../providers/all-providers.js';
import {
  buildInstallPlan,
  resolveBaseUrl,
} from '../../providers/provider-config.js';
import { DeepSeekOpenAICompatibleProvider } from './provider/deepseek.js';
import { fnCall } from '../../test-utils/model-fixtures.js';

const mockReportOpenAiRequest = vi.hoisted(() => vi.fn());
const mockReportOpenAiResponse = vi.hoisted(() => vi.fn());
const mockReportOpenAiChunk = vi.hoisted(() => vi.fn());

vi.mock('./converter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./converter.js')>();
  return {
    // The pipeline settles a parked truncation override with this pure numeric
    // verdict, so it must stay real here — only the converter class is stubbed.
    corroborateTruncationFromCompletionTokens:
      actual.corroborateTruncationFromCompletionTokens,
    OpenAIContentConverter: {
      convertLlmRequestToOpenAI: vi.fn(),
      convertOpenAIResponseToLlm: vi.fn(),
      convertOpenAIChunkToLlm: vi.fn(),
      convertLlmToolsToOpenAI: vi.fn(),
    },
  };
});
vi.mock('openai');
vi.mock('../../telemetry/loggers.js', () => ({
  logProtocolTagSanitized: vi.fn(),
}));
vi.mock('../../telemetry/gen-ai-request.js', () => ({
  reportOpenAiRequest: mockReportOpenAiRequest,
  reportOpenAiResponse: mockReportOpenAiResponse,
  reportOpenAiChunk: mockReportOpenAiChunk,
}));

const DASHSCOPE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const TOKEN_PLAN_URL =
  'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1';
/** A connection error naming proxy credentials, and its redacted form. */
const PROXY_ERROR = 'connect ECONNREFUSED token@proxy.local:8080';
const PROXY_ERROR_REDACTED = 'connect ECONNREFUSED <redacted>@proxy.local:8080';

/** `it.each` rows from cases keyed by full title (`$title` would truncate). */
const titled = <T>(cases: Record<string, T>) => Object.entries(cases);

/** `it.each` rows from cases keyed by `name`, for `$name` titles. */
const named = <T>(cases: Record<string, T>) =>
  Object.entries(cases).map(([name, row]) => ({ name, ...row }));

/** A single-turn user request. */
function userRequest(
  model = 'test-model',
  config?: GenerateContentParameters['config'],
): GenerateContentParameters {
  return {
    model,
    contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
    ...(config ? { config } : {}),
  };
}

/** A request with thinking turned off, the shape side queries send. */
const sideQuery = (model = 'test-model') =>
  userRequest(model, { thinkingConfig: { includeThoughts: false } });

/** Request config forcing the respond_in_schema tool (classifier shape). */
function forcedToolConfig(
  includeThoughts: boolean | undefined,
): GenerateContentParameters['config'] {
  return {
    thinkingConfig: { includeThoughts },
    tools: [
      {
        functionDeclarations: [
          {
            name: 'respond_in_schema',
            parameters: { type: Type.OBJECT, properties: {} },
          },
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: { mode: FunctionCallingConfigMode.ANY },
    },
  };
}

/** A 400 whose message says the model only accepts thinking turned on. */
const requiredThinkingError = (
  message = 'The value of the enable_thinking parameter is restricted to True.',
) => Object.assign(new Error(message), { status: 400 });

/** An OpenAI stream chunk with a single choice. */
function chunkOf(
  delta: Record<string, unknown> = {},
  finish_reason: string | null = null,
  fields: Record<string, unknown> = {},
): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'chunk',
    choices: [{ delta, finish_reason }],
    ...fields,
  } as unknown as OpenAI.Chat.ChatCompletionChunk;
}

/** A stream chunk with no choices (keep-alive, trailing, or usage-only). */
const noChoiceChunk = (fields: Record<string, unknown> = {}) =>
  chunkOf({}, null, { choices: [], ...fields });

/** An SDK stream yielding `items` in order; an Error item is thrown instead. */
function streamOf(...items: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) {
        if (item instanceof Error) throw item;
        yield item as OpenAI.Chat.ChatCompletionChunk;
      }
    },
  };
}

/** A converted response built from `fields`. */
const responseWith = (fields: Partial<GenerateContentResponse>) =>
  Object.assign(new GenerateContentResponse(), fields);

/** A converted response whose single model candidate carries `parts`. */
const responseOf = (
  parts: Part[] = [],
  candidate: Partial<Candidate> = {},
  fields: Partial<GenerateContentResponse> = {},
) =>
  responseWith({
    ...fields,
    candidates: [{ content: { parts, role: 'model' }, index: 0, ...candidate }],
  });

/** `responseOf` with a STOP finish reason. */
const finishOf = (
  parts: Part[] = [],
  fields: Partial<GenerateContentResponse> = {},
) => responseOf(parts, { finishReason: FinishReason.STOP }, fields);

const usage = (prompt = 10, candidates = 20, total = 30) => ({
  promptTokenCount: prompt,
  candidatesTokenCount: candidates,
  totalTokenCount: total,
});

/** Drains `gen` into `into` (returned). */
async function collect<T>(gen: AsyncIterable<T>, into: T[] = []) {
  for await (const item of gen) into.push(item);
  return into;
}

/** Drains `gen`; resolves with what it yielded and the error that ended it. */
async function settle<T>(gen: AsyncIterable<T>) {
  const items: T[] = [];
  let error: unknown;
  try {
    await collect(gen, items);
  } catch (e) {
    error = e;
  }
  return { items, error };
}

/** The next value `iterator` yields; throws if it is already done. */
async function nextValue<T>(iterator: AsyncIterator<T>) {
  const result = await iterator.next();
  if (result.done) throw new Error('Expected another response.');
  return result.value;
}

/** Wire usage fields for a stream chunk. */
const wireUsage = (prompt = 10, completion = 20, total = 30) => ({
  usage: {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
  },
});

/** A test-model request carrying `signal`. */
const abortable = (signal = new AbortController().signal) =>
  userRequest('test-model', { abortSignal: signal });

/** Asserts each `expected` field of `body`; an undefined value means absent. */
function expectFields(
  body: Record<string, unknown>,
  expected: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(expected)) {
    expect(body[key]).toEqual(value);
  }
}

/** `response` finished with STOP and carries the default `usage()`. */
function expectStopWithUsage(response: GenerateContentResponse) {
  expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
  expect(response.usageMetadata).toEqual(usage());
}

describe('ContentGenerationPipeline', () => {
  let pipeline: ContentGenerationPipeline;
  let mockConfig: PipelineConfig;
  let mockProvider: OpenAICompatibleProvider;
  let mockClient: OpenAI;
  let mockConverter: typeof OpenAIContentConverter;
  let mockErrorHandler: ErrorHandler;
  let mockContentGeneratorConfig: ContentGeneratorConfig;
  let mockCliConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();

    mockClient = {
      chat: {
        completions: {
          create: vi.fn(),
        },
      },
    } as unknown as OpenAI;

    // The pipeline snapshots request-scoped state into context and calls the
    // stateless (mocked) converter namespace directly.
    mockConverter = OpenAIContentConverter;

    mockProvider = {
      buildClient: vi.fn().mockReturnValue(mockClient),
      buildRequest: vi.fn().mockImplementation((req) => req),
      buildHeaders: vi.fn().mockReturnValue({}),
      getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
    };

    mockErrorHandler = {
      handle: vi.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
      shouldSuppressErrorLogging: vi.fn().mockReturnValue(false),
    } as unknown as ErrorHandler;

    mockCliConfig = {} as Config;
    mockContentGeneratorConfig = {
      model: 'test-model',
      authType: 'openai' as AuthType,
      // Official endpoint so response_format assertions exercise the
      // buildResponseFormat gate (custom endpoints suppress it).
      baseUrl: 'https://api.openai.com/v1',
      samplingParams: {
        temperature: 0.7,
        top_p: 0.9,
        max_tokens: 1000,
      },
    } as ContentGeneratorConfig;

    mockConfig = {
      cliConfig: mockCliConfig,
      provider: mockProvider,
      contentGeneratorConfig: mockContentGeneratorConfig,
      errorHandler: mockErrorHandler,
    };

    pipeline = new ContentGenerationPipeline(mockConfig);
  });

  const createMock = () => mockClient.chat.completions.create as Mock;

  /** The body the SDK received on its `index`-th create() call. */
  const sentBody = (index = 0) => createMock().mock.calls.at(index)![0];

  /** Rebuilds `pipeline` over the current config with `overrides` applied. */
  function pipelineWith(overrides: Partial<ContentGeneratorConfig>) {
    mockContentGeneratorConfig = {
      ...mockContentGeneratorConfig,
      ...overrides,
    } as ContentGeneratorConfig;
    mockConfig = {
      ...mockConfig,
      contentGeneratorConfig: mockContentGeneratorConfig,
    };
    pipeline = new ContentGenerationPipeline(mockConfig);
  }

  /** Mocks the converter plus a successful non-streaming completion. */
  function mockCompletion(
    messages: unknown[] = [{ role: 'user', content: 'Hello' }],
    completion: unknown = {
      id: 'r',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
    },
  ) {
    const llmResponse = new GenerateContentResponse();
    (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue(messages);
    (mockConverter.convertOpenAIResponseToLlm as Mock).mockReturnValue(
      llmResponse,
    );
    createMock().mockResolvedValue(completion);
    return { messages, completion, llmResponse };
  }

  /** `mockCompletion(messages)`, then executes `request`. */
  async function executeOk(
    request: PromptCacheSharingParameters = userRequest(),
    promptId = 'test-prompt-id',
    messages?: unknown[],
  ) {
    const mocked = mockCompletion(messages);
    return { ...mocked, result: await pipeline.execute(request, promptId) };
  }

  /**
   * Rebuilds the pipeline with `overrides`, executes, and returns the SDK
   * body. A `Provider` given builds the requests for real, on the new config.
   */
  async function executeWith(
    overrides: Partial<ContentGeneratorConfig>,
    request: GenerateContentParameters,
    promptId = 'forked_query',
    Provider?:
      | typeof DefaultOpenAICompatibleProvider
      | typeof DashScopeOpenAICompatibleProvider,
  ) {
    pipelineWith(overrides);
    if (Provider) {
      const realProvider = new Provider(mockContentGeneratorConfig, {
        getContentGeneratorConfig: () => ({ enableCacheControl: false }),
      } as unknown as Config);
      (mockProvider.buildRequest as Mock).mockImplementation((req) =>
        realProvider.buildRequest(req, promptId),
      );
    }
    await executeOk(request, promptId);
    return sentBody();
  }

  /** Makes the provider hook add `fields` to every request it builds. */
  const providerAdds = (fields: Record<string, unknown>) =>
    (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
      ...req,
      ...fields,
    }));

  /** Mocks the converted tool list for a `forcedToolConfig` request. */
  const mockForcedTool = () =>
    (mockConverter.convertLlmToolsToOpenAI as Mock).mockResolvedValue([
      { type: 'function', function: { name: 'respond_in_schema' } },
    ]);

  /** Rebuilds `pipeline` on a real provider class with a mocked client. */
  function pipelineOnProvider(
    Provider: new (
      config: ContentGeneratorConfig,
      cliConfig: Config,
    ) => OpenAICompatibleProvider,
  ) {
    const provider = new Provider(mockContentGeneratorConfig, mockCliConfig);
    vi.spyOn(provider, 'buildClient').mockReturnValue(mockClient);
    pipeline = new ContentGenerationPipeline({
      ...mockConfig,
      provider,
      cliConfig: mockCliConfig,
      contentGeneratorConfig: mockContentGeneratorConfig,
    });
  }

  /** Serves `stream` from create() and starts a streaming request. */
  function streamFrom(
    stream: unknown,
    request: PromptCacheSharingParameters = userRequest(),
    promptId = 'test-prompt-id',
  ) {
    (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([]);
    createMock().mockResolvedValue(stream);
    return pipeline.executeStream(request, promptId);
  }

  /** Makes the chunk converter return `responses`, one per call. */
  function convertChunksTo(...responses: GenerateContentResponse[]) {
    const convert = mockConverter.convertOpenAIChunkToLlm as Mock;
    for (const response of responses) convert.mockReturnValueOnce(response);
  }

  /**
   * Makes every chunk conversion assign `contextFields()` onto the request
   * context (as the real converter does for held tags) and return `response`.
   */
  function convertChunksSetting(
    contextFields: () => Record<string, unknown>,
    response: GenerateContentResponse,
  ) {
    (mockConverter.convertOpenAIChunkToLlm as Mock).mockImplementation(
      (_chunk, context) => {
        Object.assign(context, contextFields());
        return response;
      },
    );
  }

  /** Makes every chunk conversion return `response`. */
  const convertEveryChunkTo = (response: GenerateContentResponse) =>
    (mockConverter.convertOpenAIChunkToLlm as Mock).mockReturnValue(response);

  /** Streams `chunks` (an Error item throws) and collects what is yielded. */
  const streamed = async (...chunks: unknown[]) =>
    collect(await streamFrom(streamOf(...chunks)));

  /** Makes create() reject with `error`. */
  function failCreate(error: Error) {
    (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([]);
    createMock().mockRejectedValue(error);
  }

  /** The AbortSignal the SDK received on its first create() call. */
  const sentSignal = () => createMock().mock.calls[0][1]?.signal as AbortSignal;

  /**
   * `promise` rejects with the `redacted` message, the error handler saw that
   * message for `request`, and `original`'s own message no longer has `secret`.
   */
  async function expectRedacted(
    promise: Promise<unknown>,
    request: GenerateContentParameters,
    original: Error,
    redacted: string,
    secret: string,
  ) {
    await expect(promise).rejects.toThrow(redacted);
    expect(mockErrorHandler.handle).toHaveBeenCalledWith(
      expect.objectContaining({ message: redacted }),
      expect.any(Object),
      request,
    );
    expect(original.message).not.toContain(secret);
  }
  describe('constructor', () => {
    it('should initialize with correct configuration', () => {
      expect(mockProvider.buildClient).toHaveBeenCalled();
    });
  });

  describe('execute', () => {
    it('should successfully execute non-streaming request', async () => {
      const request = userRequest();
      const telemetryAttempt = {};
      mockReportOpenAiRequest.mockReturnValueOnce(telemetryAttempt);

      const { messages, completion, llmResponse, result } =
        await executeOk(request);

      const context = expect.objectContaining({
        model: 'test-model',
        modalities: {},
      });
      expect(result).toBe(llmResponse);
      expect(mockConverter.convertLlmRequestToOpenAI).toHaveBeenCalledWith(
        request,
        context,
      );
      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          messages,
          stream: false,
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 1000,
        }),
        expect.objectContaining({ signal: undefined }),
      );
      expect(mockReportOpenAiRequest).toHaveBeenCalledWith(sentBody());
      expect(mockReportOpenAiResponse).toHaveBeenCalledWith(
        telemetryAttempt,
        completion,
      );
      expect(mockConverter.convertOpenAIResponseToLlm).toHaveBeenCalledWith(
        completion,
        context,
      );
    });

    /** Executes a request for `model`; `expected` reaches converter and SDK. */
    async function expectModelUsed(model: string, expected: string) {
      const request = userRequest(model);
      const { llmResponse, result } = await executeOk(request);

      expect(result).toBe(llmResponse);
      expect(mockConverter.convertLlmRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({ model: expected }),
      );
      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({ model: expected }),
        expect.any(Object),
      );
    }

    it('should use request.model when provided', async () => {
      // request.model takes precedence over contentGeneratorConfig.model
      await expectModelUsed('override-model', 'override-model');
    });

    it.each(
      titled<{
        overrides: object;
        config: Partial<ContentGeneratorConfig>;
        expected: object;
      }>({
        'should apply provider request context overrides': {
          overrides: { splitToolMedia: true },
          config: {},
          expected: { splitToolMedia: true },
        },
        'should let provider request context overrides take precedence over content generator config':
          {
            overrides: { splitToolMedia: false },
            config: { splitToolMedia: true },
            expected: { splitToolMedia: false },
          },
        // With neither source setting splitToolMedia it defaults to true, so
        // tool-returned images leave the spec-violating `role: "tool"`
        // message (#4876).
        'should default splitToolMedia to true when neither provider override nor content generator config sets it (issue #4876)':
          {
            overrides: {},
            config: { splitToolMedia: undefined },
            expected: { splitToolMedia: true },
          },
        'should pass configured tool result content format to the converter': {
          overrides: {},
          config: { toolResultContentFormat: 'string' },
          expected: { toolResultContentFormat: 'string' },
        },
        'should let provider tool result content format overrides take precedence':
          {
            overrides: { toolResultContentFormat: 'string' },
            config: { toolResultContentFormat: 'parts' },
            expected: { toolResultContentFormat: 'string' },
          },
      }),
    )('%s', async (_title, { overrides, config, expected }) => {
      Object.assign(mockContentGeneratorConfig, config);
      mockProvider.getRequestContextOverrides = vi
        .fn()
        .mockReturnValue(overrides);
      const request = userRequest();

      await executeOk(request);

      expect(mockConverter.convertLlmRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining(expected),
      );
    });

    it('should fall back to configured model when request.model is empty', async () => {
      // An empty (falsy) model string falls back to contentGeneratorConfig.model
      await expectModelUsed('', 'test-model');
    });

    it('should handle tools in request', async () => {
      const request = userRequest('test-model', {
        tools: [
          {
            functionDeclarations: [
              {
                name: 'test-function',
                description: 'Test function',
                parameters: { type: Type.OBJECT, properties: {} },
              },
            ],
          },
        ],
      });
      const mockTools = [
        { type: 'function', function: { name: 'test-function' } },
      ] as OpenAI.Chat.ChatCompletionTool[];
      (mockConverter.convertLlmToolsToOpenAI as Mock).mockResolvedValue(
        mockTools,
      );
      const { llmResponse, result } = await executeOk(request);

      expect(result).toBe(llmResponse);
      expect(mockConverter.convertLlmRequestToOpenAI).toHaveBeenCalledWith(
        request,
        expect.objectContaining({ model: 'test-model' }),
      );
      expect(mockConverter.convertLlmToolsToOpenAI).toHaveBeenCalledWith(
        request.config!.tools,
        'auto',
      );
      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({ tools: mockTools }),
        expect.objectContaining({ signal: undefined }),
      );
    });

    it('should skip empty tools array in request', async () => {
      // tools: [] must NOT reach the API request
      await executeOk(userRequest('test-model', { tools: [] }));

      expect(mockConverter.convertLlmToolsToOpenAI).not.toHaveBeenCalled();
      expect(sentBody().tools).toBeUndefined();
    });

    // Rows default to the DashScope endpoint and includeThoughts: true.
    it.each(
      named<{
        baseUrl?: string;
        model: string;
        requestModel?: string;
        extraBody?: Record<string, unknown>;
        thinkingMandatory?: boolean;
        reasoning?: ContentGeneratorConfig['reasoning'];
        includeThoughts?: boolean;
        expectedThinking?: boolean;
        expectedToolChoice?: string;
        expectedReasoningEffort?: string;
      }>({
        'keep thinking for a thinkingMandatory model on Token Plan side queries':
          {
            baseUrl: TOKEN_PLAN_URL,
            model: 'qwen3.8-max-preview',
            extraBody: { enable_thinking: true },
            thinkingMandatory: true,
            includeThoughts: false,
            expectedThinking: true,
          },
        'apply thinkingMandatory to any qwen model on any DashScope endpoint': {
          model: 'qwen3.9-turbo',
          extraBody: { enable_thinking: true },
          thinkingMandatory: true,
          includeThoughts: false,
          expectedThinking: true,
        },
        'remove required tool selection when thinking is enabled on the wire': {
          model: 'qwen3.7-max',
          extraBody: { enable_thinking: true },
          expectedThinking: true,
        },
        'remove required tool selection when reasoning effort enables thinking':
          {
            model: 'qwen3.8-max',
            extraBody: { reasoning_effort: 'high' },
          },
        'remove required tool selection when thinking budget enables thinking':
          {
            model: 'qwen3.8-max',
            extraBody: { thinking_budget: 4096 },
          },
        'remove required tool selection when a string thinking budget enables thinking':
          {
            model: 'qwen3.8-max',
            extraBody: { thinking_budget: '4096' },
            reasoning: { effort: 'high' },
          },
        'preserve required tool selection when thinking is explicitly disabled alongside a budget':
          {
            model: 'qwen3-max',
            extraBody: { thinking_budget: 4096 },
            includeThoughts: false,
            expectedThinking: false,
            expectedToolChoice: 'required',
          },
        'preserve required tool selection when reasoning effort is none': {
          model: 'qwen3.8-max',
          extraBody: { reasoning_effort: 'none' },
          expectedToolChoice: 'required',
        },
        'preserve required tool selection for a non-qwen model with a user reasoning_effort':
          {
            baseUrl: TOKEN_PLAN_URL,
            model: 'glm-5.2',
            extraBody: { reasoning_effort: 'high' },
            expectedToolChoice: 'required',
          },
        ...Object.fromEntries(
          ['gpt-5-pro', 'gpt-6-astra'].map((model) => [
            `preserve required tool selection for name-derived mandatory ${model}`,
            {
              baseUrl: 'https://idealab.alibaba-inc.com/api/openai/v1',
              model,
              includeThoughts: false,
              expectedToolChoice: 'required',
            },
          ]),
        ),
        'preserve required tool selection when thinking is not enabled': {
          model: 'qwen3.7-max',
          expectedToolChoice: 'required',
        },
        'emit the tier-native disable shape under the config-level reasoning opt-out':
          {
            model: 'qwen3.8-max',
            extraBody: { reasoning_effort: 'high' },
            reasoning: false,
            expectedReasoningEffort: 'none',
            expectedToolChoice: 'required',
          },
        'emit the tier-native disable shape under the per-request thinking opt-out':
          {
            model: 'qwen3.8-max',
            extraBody: { reasoning_effort: 'high' },
            includeThoughts: false,
            expectedReasoningEffort: 'none',
            expectedToolChoice: 'required',
          },
        'never emit the disable even under the reasoning opt-out': {
          baseUrl: TOKEN_PLAN_URL,
          model: 'qwen3.8-max-preview',
          extraBody: { enable_thinking: true },
          thinkingMandatory: true,
          reasoning: false,
          includeThoughts: false,
          expectedThinking: true,
        },
        'still force-disable hybrid models that only declare extra_body.enable_thinking':
          {
            baseUrl: TOKEN_PLAN_URL,
            model: 'qwen3.7-max',
            extraBody: { enable_thinking: true },
            includeThoughts: false,
            expectedThinking: false,
            expectedToolChoice: 'required',
          },
        'allow automatic tool selection when mandatory thinking stays on': {
          baseUrl: TOKEN_PLAN_URL,
          model: 'qwen3.8-max-preview',
          extraBody: { enable_thinking: true },
          thinkingMandatory: true,
          expectedThinking: true,
        },
        'not inherit mandatory thinking through request.model overrides': {
          baseUrl: TOKEN_PLAN_URL,
          model: 'qwen3.8-max-preview',
          requestModel: 'qwen3.7-max',
          extraBody: { enable_thinking: true },
          thinkingMandatory: true,
          includeThoughts: false,
          expectedThinking: false,
          expectedToolChoice: 'required',
        },
        'drop a contradictory thinking disable for aliased mandatory models': {
          baseUrl: TOKEN_PLAN_URL,
          model: 'token-plan-model-alias',
          extraBody: { enable_thinking: false },
          thinkingMandatory: true,
          includeThoughts: false,
        },
        'preserve required tool selection when a null thinking budget means unset':
          {
            model: 'qwen3-max',
            extraBody: { thinking_budget: null },
            expectedToolChoice: 'required',
          },
        'strip the tier-native disable shape for thinkingMandatory models': {
          baseUrl: TOKEN_PLAN_URL,
          model: 'qwen3.8-max-preview',
          extraBody: { reasoning_effort: 'none' },
          thinkingMandatory: true,
          expectedReasoningEffort: undefined,
        },
      }),
    )('should $name', async (testCase) => {
      // Simulate the provider merging user extra_body last (see dashscope.ts).
      providerAdds(testCase.extraBody ?? {});
      mockForcedTool();

      const apiCall = await executeWith(
        {
          baseUrl: testCase.baseUrl ?? DASHSCOPE_URL,
          model: testCase.model,
          extra_body: testCase.extraBody,
          thinkingMandatory: testCase.thinkingMandatory,
          reasoning: testCase.reasoning,
        } as Partial<ContentGeneratorConfig>,
        userRequest(
          testCase.requestModel ?? testCase.model,
          forcedToolConfig(testCase.includeThoughts ?? true),
        ),
        'side-query:permissions-classifier',
      );

      expect(apiCall.enable_thinking).toBe(testCase.expectedThinking);
      expect(apiCall.tool_choice).toBe(testCase.expectedToolChoice);
      if ('expectedReasoningEffort' in testCase) {
        expect(apiCall.reasoning_effort).toBe(testCase.expectedReasoningEffort);
      }
    });

    it('keeps forced tool selection for a non-qwen preset shape end to end', async () => {
      // The table above mocks buildRequest as a plain extra_body merge, so run
      // the real DashScope provider here: its family-gated drop keeps the glm
      // preset's enable_thinking, and the pipeline's clause is family-gated
      // too — on glm the field is an opaque no-op (GLM reads
      // thinking.enabled), so tool_choice=required must survive for its
      // forced-tool side queries.
      mockForcedTool();
      const apiCall = await executeWith(
        {
          baseUrl: TOKEN_PLAN_URL,
          model: 'glm-5.2',
          authType: AuthType.QWEN_OAUTH,
          extra_body: { enable_thinking: true, reasoning_effort: 'high' },
        },
        userRequest('glm-5.2', forcedToolConfig(true)),
        'side-query:combined-shape',
        DashScopeOpenAICompatibleProvider,
      );

      expectFields(apiCall, {
        enable_thinking: true,
        reasoning_effort: 'high',
        tool_choice: 'required',
      });
    });

    it('never ships the max tier to the tiered DashScope family end to end', async () => {
      // `/effort max` persists the tier in config, so a raw pass-through 400s
      // on this and every later request of the session: through the real
      // provider, the wire body must carry the tier capped at xhigh.
      const apiCall = await executeWith(
        {
          baseUrl: DASHSCOPE_URL,
          model: 'qwen3.8-max',
          authType: AuthType.QWEN_OAUTH,
          reasoning: { effort: 'max' },
        },
        userRequest('qwen3.8-max', {
          thinkingConfig: { includeThoughts: true },
        }),
        'prompt-id',
        DashScopeOpenAICompatibleProvider,
      );

      // The tier ships alone — no competing nested knob.
      expectFields(apiCall, {
        reasoning_effort: 'xhigh',
        reasoning: undefined,
      });
    });

    it('never ships the max tier to a generic OpenAI-compatible endpoint end to end', async () => {
      // The same persisted-tier failure through the real default provider.
      const apiCall = await executeWith(
        {
          baseUrl: 'https://llm.example.com/v1',
          model: 'gpt-5.4',
          // Exercise the configured-tier path without sampling overrides.
          samplingParams: undefined,
          reasoning: { effort: 'max' },
        },
        userRequest('gpt-5.4', { thinkingConfig: { includeThoughts: true } }),
        'prompt-id',
        DefaultOpenAICompatibleProvider,
      );

      expectFields(apiCall, {
        reasoning_effort: 'xhigh',
        reasoning: undefined,
      });
    });

    const gpt55Capability = {
      model: 'gpt-5.5',
      capability: {
        thinking: true,
        efforts: ['low', 'high'],
        defaultEffort: 'high',
        disableField: 'reasoning_effort',
      },
    };
    // Rows default to model gpt-5.4, reasoning { effort: 'high' } and empty
    // samplingParams.
    it.each(
      named<{
        model?: string;
        configuredModel?: string;
        baseUrl?: string;
        reasoning?: ContentGeneratorConfig['reasoning'];
        samplingParams?: Record<string, unknown>;
        extraBody?: Record<string, unknown>;
        includeThoughts?: boolean;
        capability?: Record<string, unknown>;
        expected: Record<string, unknown>;
      }>({
        'capability with sampling null': {
          ...gpt55Capability,
          samplingParams: { reasoning_effort: null },
          expected: { reasoning_effort: 'high' },
        },
        'capability with sampling empty string': {
          ...gpt55Capability,
          samplingParams: { reasoning_effort: '' },
          expected: { reasoning_effort: 'high' },
        },
        'capability with extra-body null': {
          ...gpt55Capability,
          extraBody: { reasoning_effort: null },
          expected: { reasoning_effort: 'high' },
        },
        'capability with raw nested extra body': {
          ...gpt55Capability,
          extraBody: { reasoning: { effort: 'low' } },
          expected: { reasoning: { effort: 'low' } },
        },
        'configured GPT tiers ahead of the built-in fallback': {
          reasoning: { effort: 'max' },
          expected: { reasoning_effort: 'max' },
          capability: {
            thinking: true,
            efforts: ['medium', 'max'],
            defaultEffort: 'max',
            disableField: 'reasoning_effort',
          },
        },
        'configured effort with a token budget': {
          samplingParams: { max_completion_tokens: 1024 },
          expected: { reasoning_effort: 'high', max_completion_tokens: 1024 },
        },
        'over-ceiling effort with a token budget': {
          model: 'gpt-5.1',
          reasoning: { effort: 'max' },
          samplingParams: { max_completion_tokens: 1024 },
          expected: { reasoning_effort: 'high', max_completion_tokens: 1024 },
        },
        'configured effort with a null flat placeholder': {
          samplingParams: { reasoning_effort: null },
          expected: { reasoning_effort: 'high' },
        },
        'an empty-string flat placeholder': {
          samplingParams: { reasoning_effort: '' },
          expected: { reasoning_effort: 'high' },
        },
        'an extra-body empty string clearing a flat override': {
          samplingParams: { reasoning_effort: 'none' },
          extraBody: { reasoning_effort: '' },
          expected: { reasoning_effort: 'high' },
        },
        'an explicit nested null in sampling parameters': {
          samplingParams: { reasoning: null },
          expected: { reasoning: null },
        },
        'an explicit nested null in extra body': {
          samplingParams: { max_completion_tokens: 1024 },
          extraBody: { reasoning: null },
          expected: { reasoning: null, max_completion_tokens: 1024 },
        },
        'configured effort after an extra-body null replaces a flat override': {
          samplingParams: { reasoning_effort: 'none' },
          extraBody: { reasoning_effort: null },
          expected: { reasoning_effort: 'high' },
        },
        'a configured reasoning budget with an extra-body flat override': {
          reasoning: { effort: 'high', budget_tokens: 8192 },
          samplingParams: { max_completion_tokens: 1024 },
          extraBody: { reasoning_effort: 'low' },
          expected: {
            reasoning_effort: 'low',
            reasoning: { budget_tokens: 8192 },
            max_completion_tokens: 1024,
          },
        },
        'a non-mandatory GPT model on OpenRouter': {
          model: 'openai/gpt-5.4',
          baseUrl: OPENROUTER_URL,
          reasoning: false,
          expected: { reasoning: { enabled: false } },
        },
        'configured model fallback with a token budget': {
          model: '',
          configuredModel: 'gpt-5.4',
          samplingParams: { max_completion_tokens: 1024 },
          expected: { reasoning_effort: 'high', max_completion_tokens: 1024 },
        },
        'GPT-6 effort with a token budget': {
          model: 'gpt-6-astra',
          samplingParams: { max_completion_tokens: 1024 },
          expected: { reasoning_effort: 'high', max_completion_tokens: 1024 },
        },
        'GPT-6 mandatory thinking with a raw disable value': {
          model: 'gpt-6-astra',
          samplingParams: { reasoning_effort: 'none' },
          expected: {},
        },
        'GPT-6 mandatory thinking on OpenRouter': {
          model: 'openai/gpt-6-astra',
          baseUrl: OPENROUTER_URL,
          reasoning: false,
          expected: {},
        },
        'the wire model thinking rules over the configured GPT-6 model': {
          model: 'gpt-5.5',
          configuredModel: 'gpt-6-astra',
          includeThoughts: false,
          expected: { reasoning_effort: 'none' },
        },
        'an explicit flat override': {
          samplingParams: { reasoning_effort: 'low' },
          expected: { reasoning_effort: 'low' },
        },
        'an explicit nested override': {
          samplingParams: { reasoning: { effort: 'low' } },
          expected: { reasoning: { effort: 'low' } },
        },
        'no configured effort': { reasoning: undefined, expected: {} },
        'disabled thinking': {
          reasoning: false,
          samplingParams: { reasoning_effort: 'high' },
          expected: { reasoning_effort: 'none' },
        },
        'per-request disabled thinking': {
          model: 'gpt-5.5',
          includeThoughts: false,
          expected: { reasoning_effort: 'none' },
        },
        'mandatory GPT thinking': {
          model: 'gpt-5.3-codex',
          reasoning: false,
          expected: {},
        },
        'a non-GPT sampling request': {
          model: 'custom-model',
          expected: {},
        },
      }),
    )('sends $name through the real provider', async (testCase) => {
      const model = testCase.model ?? 'gpt-5.4';
      mockContentGeneratorConfig = {
        ...mockContentGeneratorConfig,
        baseUrl: testCase.baseUrl ?? mockContentGeneratorConfig.baseUrl,
        model: testCase.configuredModel ?? model,
        reasoning:
          'reasoning' in testCase ? testCase.reasoning : { effort: 'high' },
        samplingParams: testCase.samplingParams ?? {},
        extra_body: testCase.extraBody,
      } as ContentGeneratorConfig;
      if (testCase.capability) {
        mockCliConfig = {
          ...mockCliConfig,
          getResolvedModelConfig: vi.fn(() => ({
            capabilities: { reasoning: testCase.capability },
          })),
        } as unknown as Config;
      }
      pipelineOnProvider(DefaultOpenAICompatibleProvider);

      await executeOk(
        userRequest(model, {
          thinkingConfig: { includeThoughts: testCase.includeThoughts },
        }),
        'prompt-id',
      );

      const { expected } = testCase;
      const body = sentBody();
      expect(body).toMatchObject(expected);
      expect(body.reasoning).toEqual(
        'reasoning' in expected ? expected['reasoning'] : undefined,
      );
      expect(body.reasoning_effort).toEqual(
        'reasoning_effort' in expected
          ? expected['reasoning_effort']
          : undefined,
      );
    });

    it('never ships the escape-hatch disable shape to a thinkingMandatory model end to end', async () => {
      // The provider canonicalizes the documented extra_body
      // `enable_thinking: false` escape hatch into the tiered family's disable
      // shape (`reasoning_effort: 'none'`) even when no effort tier ships. The
      // thinkingMandatory strip must catch that shape too: on a
      // mandatory-thinking model it fails the request, like the boolean it
      // replaced.
      mockForcedTool();
      const apiCall = await executeWith(
        {
          baseUrl: TOKEN_PLAN_URL,
          model: 'qwen3.8-max-preview',
          authType: AuthType.QWEN_OAUTH,
          thinkingMandatory: true,
          extra_body: { enable_thinking: false },
        },
        userRequest('qwen3.8-max-preview', forcedToolConfig(true)),
        'side-query:escape-hatch',
        DashScopeOpenAICompatibleProvider,
      );

      expectFields(apiCall, {
        enable_thinking: undefined,
        reasoning_effort: undefined,
        tool_choice: undefined,
      });
    });

    it('learns required thinking from a provider error and retries once', async () => {
      pipelineWith({
        baseUrl: TOKEN_PLAN_URL,
        model: 'qwen3.8-max-preview',
        extra_body: { enable_thinking: true },
      });
      providerAdds({ enable_thinking: true });
      mockForcedTool();
      mockCompletion();
      createMock().mockRejectedValueOnce(requiredThinkingError());
      const request = userRequest(
        'qwen3.8-max-preview',
        forcedToolConfig(false),
      );

      await pipeline.execute(request, 'forked_query');
      await pipeline.execute(request, 'forked_query');

      const calls = createMock().mock.calls;
      expect(calls).toHaveLength(3);
      // The tier-native disable shape is reasoning_effort: 'none' (this family
      // reads no boolean knob), and the retry trigger must recognise it.
      expect(calls[0][0]).toMatchObject({
        reasoning_effort: 'none',
        tool_choice: 'required',
      });
      expect(calls[0][0].enable_thinking).toBeUndefined();
      for (const call of calls.slice(1)) {
        expectFields(call[0], {
          enable_thinking: true,
          tool_choice: undefined,
        });
      }
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it.each([
      {
        name: 'preserving unrelated chat_template_kwargs',
        extraBody: {
          enable_thinking: false,
          chat_template_kwargs: {
            apply_chat_template: true,
            enable_thinking: false,
          },
        },
        initialChatTemplateKwargs: {
          apply_chat_template: true,
          enable_thinking: false,
        },
        retryChatTemplateKwargs: { apply_chat_template: true },
      },
      {
        name: 'removing empty chat_template_kwargs',
        extraBody: { chat_template_kwargs: { enable_thinking: false } },
        initialChatTemplateKwargs: { enable_thinking: false },
        retryChatTemplateKwargs: undefined,
      },
    ])(
      'retries without provider-configured thinking opt-outs on non-DashScope endpoints: $name',
      async ({
        extraBody,
        initialChatTemplateKwargs,
        retryChatTemplateKwargs,
      }) => {
        mockContentGeneratorConfig = {
          ...mockContentGeneratorConfig,
          baseUrl: 'https://llm.example.com/v1',
          model: 'Qwen3.6-27B',
          extra_body: extraBody,
        } as ContentGeneratorConfig;
        pipelineOnProvider(DefaultOpenAICompatibleProvider);
        mockCompletion();
        createMock().mockRejectedValueOnce(
          requiredThinkingError('enable_thinking must be true for this model'),
        );

        await pipeline.execute(sideQuery('Qwen3.6-27B'), 'forked_query');

        const calls = createMock().mock.calls;
        expect(calls).toHaveLength(2);
        expectFields(calls[0][0], {
          chat_template_kwargs: initialChatTemplateKwargs,
          enable_thinking: undefined,
        });
        expectFields(calls[1][0], {
          chat_template_kwargs: retryChatTemplateKwargs,
          enable_thinking: undefined,
        });
        expect(mockErrorHandler.handle).not.toHaveBeenCalled();
      },
    );

    /** Rejects create() with `errors` in turn: `request` fails on the last. */
    async function expectRejectsAfter(
      request: GenerateContentParameters,
      calls: number,
      ...errors: Error[]
    ) {
      providerAdds({ enable_thinking: true });
      (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([
        { role: 'user', content: 'What is 2+2?' },
      ]);
      for (const error of errors) createMock().mockRejectedValueOnce(error);
      const last = errors.at(-1)!;

      await expect(pipeline.execute(request, 'forked_query')).rejects.toBe(
        last,
      );
      expect(createMock()).toHaveBeenCalledTimes(calls);
      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        last,
        expect.any(Object),
        request,
      );
    }

    it('handles the retry error when required-thinking retry fails', async () => {
      pipelineWith({
        baseUrl: TOKEN_PLAN_URL,
        model: 'qwen3.8-max-preview',
        extra_body: { enable_thinking: true },
      });
      await expectRejectsAfter(
        sideQuery('qwen3.8-max-preview'),
        2,
        requiredThinkingError(),
        new Error('retry failed'),
      );
    });

    it('does not retry required-thinking errors after abort', async () => {
      await expectRejectsAfter(
        userRequest('qwen3.8-max-preview', {
          abortSignal: AbortSignal.abort(),
          thinkingConfig: { includeThoughts: false },
        }),
        1,
        requiredThinkingError(),
      );
    });

    it.each([
      'Invalid request parameter.',
      'enable_thinking is not supported for this model',
    ])(
      'does not retry a non-required-thinking 400 error: %s',
      async (message) => {
        pipelineWith({ baseUrl: TOKEN_PLAN_URL, model: 'qwen3.8-max-preview' });
        (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([
          { role: 'user', content: 'Hello' },
        ]);
        const error = Object.assign(new Error(message), { status: 400 });
        createMock().mockRejectedValue(error);

        await expect(
          pipeline.execute(sideQuery('qwen3.8-max-preview'), 'forked_query'),
        ).rejects.toBe(error);
        expect(createMock()).toHaveBeenCalledTimes(1);
      },
    );

    it.each([
      ['gpt-5.4', 'none'],
      ['gpt-5', undefined],
      ['gpt-6-astra', undefined],
    ] as const)(
      'respects %s support for disabling thinking',
      async (model, expected) => {
        const apiCall = await executeWith(
          {
            samplingParams: { reasoning_effort: 'none' },
          } as Partial<ContentGeneratorConfig>,
          sideQuery(model),
          'side-query:permission-classifier',
        );
        expect(apiCall.reasoning_effort).toBe(expected);
      },
    );

    // Shared wiring for the capability cases below: an identity provider hook
    // so the assertions read the pipeline's own output, and a resolved model
    // config carrying whatever capability the case declares.
    async function executeWithCapability(
      capability: unknown,
      configOverrides: Partial<ContentGeneratorConfig>,
      model = 'deepseek-v4-pro',
    ): Promise<Record<string, unknown>> {
      mockCliConfig = {
        getResolvedModelConfig: vi
          .fn()
          .mockReturnValue({ capabilities: { reasoning: capability } }),
      } as unknown as Config;
      mockConfig = { ...mockConfig, cliConfig: mockCliConfig };
      pipelineWith({
        model,
        baseUrl: 'https://example.com/v1',
        ...configOverrides,
      });

      await executeOk(userRequest(model), 'main');
      return sentBody(-1);
    }

    /** A thinking capability with high/max tiers, disabled via `disableField`. */
    const highMax = (disableField: string) => ({
      thinking: true,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
      disableField,
    });

    /** Routes buildRequest through a `Provider` built on the current configs. */
    const routeThrough = (
      Provider:
        | typeof DefaultOpenAICompatibleProvider
        | typeof DeepSeekOpenAICompatibleProvider,
    ) =>
      (mockProvider.buildRequest as Mock).mockImplementation((request) =>
        new Provider(mockContentGeneratorConfig, mockCliConfig).buildRequest(
          request,
          'test',
        ),
      );

    it.each([
      [{ effort: 'max' as const }, 'max', undefined],
      [{ effort: 'low' as const }, undefined, undefined],
      [false as const, undefined, { type: 'disabled' }],
    ])(
      'applies a resolved model reasoning capability for %j',
      async (reasoning, expectedEffort, expectedThinking) => {
        const apiCall = await executeWithCapability(highMax('thinking'), {
          reasoning,
        });
        expectFields(apiCall, {
          reasoning_effort: expectedEffort,
          thinking: expectedThinking,
          reasoning: undefined,
        });
      },
    );

    const std = 'alibabaStandard';
    it.each([
      ['moonshot', 'kimi-k3', 'max', undefined, true],
      ['moonshot', 'kimi-k2.7-code', undefined, undefined, true],
      ['moonshot', 'kimi-k2.7-code-highspeed', undefined, undefined, true],
      ['moonshot', 'kimi-k2.6', undefined, 'thinking', false],
      ['deepseek', 'deepseek-v4-pro', 'low', 'thinking', false],
      ['deepseek', 'deepseek-v4-flash', 'low', 'thinking', false],
      [std, 'qwen3.8-max', 'low', 'reasoning_effort', false],
      [std, 'qwen3.8-max-0902', 'medium', 'reasoning_effort', false],
      [std, 'qwen3.8-flash', 'xhigh', 'reasoning_effort', false],
      [std, 'qwen3.7-plus', undefined, 'enable_thinking', false],
      [std, 'deepseek-v4-pro', 'high', 'enable_thinking', false],
      [std, 'deepseek-v4-pro', 'max', 'enable_thinking', false],
      [std, 'deepseek-v4-flash', 'high', 'enable_thinking', false],
      [std, 'deepseek-v4-pro-0813', 'low', 'enable_thinking', false],
      [std, 'deepseek-v4-flash-0731', 'low', 'enable_thinking', false],
      [std, 'kimi-k3', 'low', undefined, true],
      [std, 'kimi-k2.7-code', undefined, undefined, true],
      [std, 'kimi-k2.6', undefined, 'enable_thinking', false],
      ['token-plan', 'qwen3.8-max', 'low', undefined, true],
      ['token-plan', 'qwen3.8-max-preview', 'medium', undefined, true],
      ['token-plan', 'qwen3.8-flash', 'low', 'reasoning_effort', false],
      ['token-plan', 'deepseek-v4-pro-0813', 'low', 'enable_thinking', false],
      ['coding-plan', 'qwen3.5-plus', undefined, 'enable_thinking', false],
      ['coding-plan', 'kimi-k2.5', undefined, 'enable_thinking', false],
    ] as const)(
      'sends installed %s / %s reasoning through the real provider hook',
      async (providerId, model, effort, disableField, mandatory) => {
        const preset = findProviderById(providerId)!;
        const baseUrl = resolveBaseUrl(preset);
        const installed = buildInstallPlan(preset, {
          baseUrl,
          apiKey: 'test-key',
          modelIds: [model],
        }).modelProviders![0].models[0];
        expect(installed.capabilities?.reasoning).toBeDefined();

        for (const [mode, partial] of (
          ['enabled', 'disabled', 'side-query'] as const
        ).flatMap((mode) => [
          [mode, false] as const,
          ...(effort ? [[mode, true] as const] : []),
        ])) {
          mockContentGeneratorConfig = {
            ...mockContentGeneratorConfig,
            ...installed.generationConfig,
            authType: AuthType.USE_OPENAI,
            model,
            baseUrl,
            enableCacheControl: false,
            reasoning:
              mode === 'disabled' ? false : effort ? { effort } : undefined,
          };
          mockCliConfig = {
            ...mockCliConfig,
            getResolvedModelConfig: vi.fn().mockReturnValue(
              partial
                ? {
                    ...installed,
                    capabilities: { reasoning: { defaultEffort: effort } },
                  }
                : installed,
            ),
            getContentGeneratorConfig: () => mockContentGeneratorConfig,
            getCliVersion: () => 'test',
          } as unknown as Config;
          pipelineOnProvider(
            providerId === 'moonshot'
              ? DefaultOpenAICompatibleProvider
              : providerId === 'deepseek'
                ? DeepSeekOpenAICompatibleProvider
                : DashScopeOpenAICompatibleProvider,
          );
          await executeOk(
            userRequest(
              model,
              mode === 'side-query'
                ? { thinkingConfig: { includeThoughts: false } }
                : undefined,
            ),
            'preset-test',
          );
          const wire = sentBody(-1);
          expect(wire.reasoning).toBeUndefined();
          if (partial && mandatory && mode === 'side-query')
            expect(wire.reasoning_effort).toBeUndefined();
          if (mode === 'enabled') {
            expect(wire.reasoning_effort).toBe(effort);
            if (providerId === std && model === 'deepseek-v4-pro') {
              expect(wire.enable_thinking).toBeUndefined();
              expect(wire.thinking).toBeUndefined();
            }
          } else if (!mandatory) {
            expectFields(wire, {
              reasoning_effort:
                disableField === 'reasoning_effort' ? 'none' : undefined,
              enable_thinking:
                disableField === 'enable_thinking' ? false : undefined,
              thinking:
                disableField === 'thinking' ? { type: 'disabled' } : undefined,
            });
          } else {
            expect(wire.reasoning_effort).not.toBe('none');
            expect(wire.enable_thinking).not.toBe(false);
            expect(wire.thinking?.type).not.toBe('disabled');
          }
          if (
            providerId === 'moonshot' ||
            disableField === 'reasoning_effort'
          ) {
            expect(wire.enable_thinking).toBeUndefined();
          }
        }
      },
    );

    it.each([
      [
        'openai-effort',
        { reasoning_effort: 'medium' },
        { reasoning_effort: 'none' },
      ],
      [
        'openai-reasoning',
        { reasoning: { effort: 'medium' } },
        { reasoning: { enabled: false } },
      ],
      [
        'deepseek-openai',
        { thinking: { type: 'enabled' }, reasoning_effort: 'medium' },
        { thinking: { type: 'disabled' } },
      ],
      [
        'dashscope-effort',
        { reasoning_effort: 'medium' },
        { reasoning_effort: 'none' },
      ],
      [
        'dashscope-thinking',
        { enable_thinking: true },
        { enable_thinking: false },
      ],
      [
        'qwen-chat-template',
        { chat_template_kwargs: { enable_thinking: true } },
        { chat_template_kwargs: { enable_thinking: false } },
      ],
    ])(
      'uses declared %s defaults and disable wire for an unknown alias',
      async (profile, enabled, disabled) => {
        routeThrough(DefaultOpenAICompatibleProvider);
        const capability = {
          profile,
          ...(profile === 'dashscope-thinking' ||
          profile === 'qwen-chat-template'
            ? {}
            : { efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' }),
        };
        for (const [reasoning, expected] of [
          [undefined, enabled],
          [false, disabled],
        ] as const) {
          const wire = await executeWithCapability(
            capability,
            { reasoning },
            'company-alias',
          );
          const actual = Object.fromEntries(
            Object.entries(wire).filter(([key]) =>
              [
                'reasoning',
                'reasoning_effort',
                'thinking',
                'enable_thinking',
                'chat_template_kwargs',
              ].includes(key),
            ),
          );
          expect(actual).toEqual(expected);
        }
      },
    );

    it('preserves template siblings and clears incompatible budget on declared off requests', async () => {
      routeThrough(DefaultOpenAICompatibleProvider);
      const template = await executeWithCapability(
        { profile: 'qwen-chat-template' },
        {
          reasoning: false,
          extra_body: {
            enable_thinking: true,
            chat_template_kwargs: { foo: 1 },
          },
        },
        'company-alias',
      );
      expectFields(template, {
        chat_template_kwargs: { foo: 1, enable_thinking: false },
        enable_thinking: undefined,
      });
      const effort = await executeWithCapability(
        { defaultEffort: 'medium' },
        {
          baseUrl: DASHSCOPE_URL,
          reasoning: false,
          extra_body: { thinking_budget: 4096, enable_thinking: true },
        },
        'qwen3.8-max',
      );
      expectFields(effort, {
        reasoning_effort: 'none',
        thinking_budget: undefined,
        enable_thinking: undefined,
      });
    });

    it.each(['samplingParams', 'extra_body'] as const)(
      'keeps native DeepSeek %s reasoning projection with a profile',
      async (source) => {
        routeThrough(DeepSeekOpenAICompatibleProvider);
        const wire = await executeWithCapability(
          {
            profile: 'deepseek-openai',
            efforts: ['high', 'max'],
            defaultEffort: 'high',
          },
          {
            baseUrl: 'https://api.deepseek.com/v1',
            [source]: { reasoning: { effort: 'max' } },
          },
        );
        expectFields(wire, { reasoning_effort: 'max', reasoning: undefined });
      },
    );

    it.each([
      ['https://api.deepseek.com/v1', 'openai-effort', 'reasoning_content', ''],
      [
        'https://api.cerebras.ai/v1',
        'deepseek-openai',
        'reasoning_content',
        undefined,
      ],
      [
        'https://api.mistral.ai/v1',
        'deepseek-openai',
        'reasoning_content',
        undefined,
      ],
      [
        'https://api.fireworks.ai/inference/v1',
        'qwen-chat-template',
        'reasoning',
        undefined,
      ],
      [
        'https://api.xiaomimimo.com/v1',
        'openai-effort',
        'reasoning_content',
        '',
      ],
    ] as const)(
      'preserves native history constraints on %s with %s',
      (baseUrl, profile, field, expected) => {
        const config = {
          ...mockContentGeneratorConfig,
          authType: AuthType.USE_OPENAI,
          model: 'alias',
          baseUrl,
        };
        const cli = {
          ...mockCliConfig,
          getResolvedModelConfig: vi.fn().mockReturnValue({
            capabilities: {
              reasoning: {
                profile,
                ...(profile === 'qwen-chat-template'
                  ? {}
                  : {
                      efforts: ['low', 'medium', 'high'],
                      defaultEffort: 'medium',
                    }),
              },
            },
          }),
        };
        const provider = determineProvider(config, cli as unknown as Config);
        const result = provider.buildRequest(
          {
            model: 'alias',
            messages: [
              {
                role: 'assistant',
                content: 'answer',
                ...(expected === undefined
                  ? { reasoning_content: 'trace' }
                  : {}),
              },
            ],
          } as OpenAI.Chat.ChatCompletionCreateParams,
          'test',
        );
        if (expected === undefined)
          expect(result.messages[0]).not.toHaveProperty(field);
        else expect(result.messages[0]).toHaveProperty(field, expected);
      },
    );

    it('keeps explicit sampling reasoning above a configured default', async () => {
      const capability = {
        profile: 'openai-effort',
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'medium',
      };
      const wire = await executeWithCapability(
        capability,
        { samplingParams: { reasoning: { effort: 'minimal' } } },
        'company-alias',
      );
      expect(wire['reasoning']).toEqual({ effort: 'minimal' });
      const budget = await executeWithCapability(
        capability,
        {
          samplingParams: undefined,
          reasoning: { effort: 'high', budget_tokens: 8192 },
        },
        'company-alias',
      );
      expect(budget).toMatchObject({
        reasoning_effort: 'high',
        reasoning: { budget_tokens: 8192 },
      });
    });

    it.each([
      ['qwen3.8-max', DASHSCOPE_URL],
      ['openai/gpt-5.4', OPENROUTER_URL],
    ])(
      'resolves %s default before shaping its request',
      async (model, baseUrl) => {
        const openRouter = model.startsWith('openai/');
        const wire = await executeWithCapability(
          { defaultEffort: 'medium' },
          {
            baseUrl,
            extra_body: openRouter ? undefined : { reasoning_effort: null },
          },
          model,
        );
        if (openRouter) expect(wire['reasoning']).toEqual({ effort: 'medium' });
        else {
          expectFields(wire, {
            reasoning_effort: 'medium',
            reasoning: undefined,
          });
        }
      },
    );

    it.each([
      ['enable_thinking', false, undefined, undefined],
      ['reasoning_effort', undefined, 'none', undefined],
    ] as const)(
      'emits the declared %s disable field when reasoning is off',
      async (disableField, enableThinking, reasoningEffort, thinking) => {
        const apiCall = await executeWithCapability(highMax(disableField), {
          reasoning: false,
        });
        expectFields(apiCall, {
          enable_thinking: enableThinking,
          reasoning_effort: reasoningEffort,
          thinking,
        });
      },
    );

    it.each([
      ['enable_thinking', { enable_thinking: false }],
      ['thinking', { thinking: { type: 'disabled' } }],
    ] as const)(
      'preserves the configured GPT %s disable ownership',
      async (disableField, expected) => {
        const apiCall = await executeWithCapability(
          { thinking: true, efforts: ['medium'], disableField },
          { reasoning: false },
          'gpt-5.5',
        );
        expect(apiCall).toMatchObject(expected);
        expect(apiCall['reasoning_effort']).toBeUndefined();
      },
    );

    it('emits no disable shape for a capability that forbids disabling', async () => {
      const apiCall = await executeWithCapability(
        { ...highMax('thinking'), canDisable: false },
        { reasoning: false },
      );
      expectFields(apiCall, {
        thinking: undefined,
        reasoning_effort: undefined,
        enable_thinking: undefined,
      });
    });

    it('ignores a capability that omits the disable field', async () => {
      // `disableField` is the one capability member with no fallback, so an
      // entry without it is refused wholesale: the configured tier reaches the
      // provider hook as it would with no capability at all.
      const apiCall = await executeWithCapability(
        { thinking: true, efforts: ['high', 'max'] },
        { reasoning: { effort: 'low' }, samplingParams: undefined },
        'qwen3.9-plus',
      );
      expectFields(apiCall, {
        reasoning: { effort: 'low' },
        reasoning_effort: undefined,
      });
    });

    it('does not let an unparsable canDisable suppress the disable shape', async () => {
      const apiCall = await executeWithCapability(
        { thinking: true, toggleOnly: true, canDisable: false },
        { reasoning: false, samplingParams: undefined },
        'qwen3.9-plus',
      );
      expect(apiCall['chat_template_kwargs']).toEqual({
        enable_thinking: false,
      });
    });

    it('leaves nested reasoning for provider-owned wire paths', async () => {
      // `samplingParams` is the user's own wire shape and ships verbatim (the
      // contract `clampConfiguredReasoningEffort` keeps), so a tier the
      // capability does not list must still reach the provider hook that
      // translates it instead of being deleted here.
      const capability = highMax('thinking');
      const apiCall = await executeWithCapability(capability, {
        samplingParams: {
          reasoning: { effort: 'xhigh' },
        } as ContentGeneratorConfig['samplingParams'],
      });
      expectFields(apiCall, {
        reasoning: { effort: 'xhigh' },
        reasoning_effort: undefined,
      });

      const openRouterCall = await executeWithCapability(capability, {
        baseUrl: OPENROUTER_URL,
        reasoning: { effort: 'high' },
        samplingParams: undefined,
      });
      expectFields(openRouterCall, {
        reasoning: { effort: 'high' },
        reasoning_effort: undefined,
      });
    });

    const DEEPSEEK_URL = 'https://api.deepseek.com/v1';
    const OPENAI_URL = 'https://api.openai.com/v1';
    const SELF_HOSTED_URL = 'https://llm.example.com/v1';
    const qwen27b = 'qwen/qwen3.8-27b';
    // [title, config overrides, request, expected wire fields (undefined:
    // absent), prompt id, fields the provider hook adds (simulating
    // extra_body injection)]
    it.each<
      [
        string,
        Partial<ContentGeneratorConfig>,
        GenerateContentParameters,
        Record<string, unknown>,
        string?,
        Record<string, unknown>?,
      ]
    >([
      // The provider injects enable_thinking: true via extra_body (e.g. the
      // setup wizard's `enableThinking: true`, see provider-config.ts) but the
      // request disables thinking. The gate needs the DashScope hostname AND
      // a qwen model, so the field never leaks to other routings (off-DashScope,
      // or GLM/DeepSeek on the same hostname).
      [
        'should override enable_thinking when thinkingConfig disables it',
        { baseUrl: DASHSCOPE_URL, model: 'qwen3.5-flash' },
        sideQuery('qwen3.5-flash'),
        { enable_thinking: false },
        undefined,
        { enable_thinking: true },
      ],
      [
        'should strip reasoning key from extra_body when thinking is disabled',
        {},
        sideQuery(),
        { reasoning: undefined },
        undefined,
        { reasoning: { effort: 'high' } },
      ],
      // A normal request (no thinkingConfig) keeps the injected enable_thinking.
      [
        'should preserve enable_thinking when thinking is not explicitly disabled',
        {},
        userRequest(),
        { enable_thinking: true },
        'main',
        { enable_thinking: true },
      ],
      // DeepSeek V4+ defaults thinking.type to 'enabled': dropping only the
      // effort knob keeps thinking on, leaking latency/cost into side queries.
      [
        'emits thinking:disabled on DeepSeek hostname when includeThoughts is false',
        { baseUrl: DEEPSEEK_URL, model: 'deepseek-v4-pro' },
        sideQuery(),
        { thinking: { type: 'disabled' }, reasoning_effort: undefined },
      ],
      // The config-level opt-out must disable DeepSeek thinking too.
      [
        'emits thinking:disabled on DeepSeek hostname when reasoning is configured to false',
        { baseUrl: DEEPSEEK_URL, model: 'deepseek-v4-pro', reasoning: false },
        userRequest(),
        { thinking: { type: 'disabled' }, reasoning_effort: undefined },
        'main',
      ],
      // DeepSeek-specific shape: strict OpenAI-compat backends could 400 on
      // the unknown key.
      [
        'does NOT emit thinking:disabled on a non-DeepSeek hostname',
        { baseUrl: OPENAI_URL, model: 'gpt-5' },
        sideQuery(),
        { thinking: undefined },
      ],
      // As with reasoning_effort (round 7): model-name detection covers
      // self-hosted DeepSeek for content flattening, but sglang/vllm may not
      // accept the V4 thinking param, so this gate is hostname-only.
      [
        'does NOT emit thinking:disabled on self-hosted DeepSeek (model-name fallback only)',
        {
          baseUrl: 'https://my-sglang.example.com:8000/v1',
          model: 'deepseek-v4-pro',
        },
        sideQuery(),
        { thinking: undefined },
      ],
      // #9757: OpenRouter's native thinking switch is the provider-level
      // `reasoning` parameter. The disable path emitted only shapes OpenRouter
      // ignores (chat_template_kwargs) and stripped `reasoning`, so the
      // AUTO-mode classifier's stage-1 side query (256-token budget, forced
      // respond_in_schema, includeThoughts: false) spent its budget
      // reasoning, never called the tool, and fail-closed with "Classifier
      // stage 1 unavailable".
      [
        'emits reasoning.enabled=false on OpenRouter hostname when includeThoughts is false',
        { baseUrl: OPENROUTER_URL, model: qwen27b },
        sideQuery(qwen27b),
        { reasoning: { enabled: false } },
        'side-query:permission-classifier',
      ],
      [
        'does NOT emit reasoning.enabled=false on OpenRouter when thinking is enabled',
        { baseUrl: OPENROUTER_URL, model: qwen27b },
        userRequest(qwen27b),
        { reasoning: undefined },
        'main',
      ],
      // The config-level opt-out lands the native shape too, as on DeepSeek.
      [
        'emits reasoning.enabled=false on OpenRouter hostname when reasoning is configured to false',
        { baseUrl: OPENROUTER_URL, model: qwen27b, reasoning: false },
        userRequest(qwen27b),
        { reasoning: { enabled: false } },
        'main',
      ],
      // `reasoning` is a gateway parameter routed to any model supporting it,
      // not a qwen wire field: a family gate would leave other thinking
      // models on OpenRouter broken the same way.
      [
        'emits reasoning.enabled=false on OpenRouter for non-qwen models too',
        { baseUrl: OPENROUTER_URL, model: 'deepseek/deepseek-r1' },
        sideQuery('deepseek/deepseek-r1'),
        { reasoning: { enabled: false } },
        'side-query:permission-classifier',
      ],
      // thinkingMandatory models 400 on a disable shape; the exemption must
      // hold on OpenRouter too.
      [
        'does NOT emit reasoning.enabled=false for thinking-mandatory models on OpenRouter',
        { baseUrl: OPENROUTER_URL, model: qwen27b, thinkingMandatory: true },
        sideQuery(qwen27b),
        { reasoning: undefined },
      ],
      // OpenRouter-specific: vLLM/SGLang/strict-compat gateways must not get
      // the extra `reasoning` field.
      [
        'does NOT emit reasoning on a non-OpenRouter OpenAI-compatible endpoint',
        {
          baseUrl: 'https://my-vllm.example.com:8000/v1',
          model: 'qwen/qwen3-32b',
        },
        sideQuery('qwen/qwen3-32b'),
        { reasoning: undefined },
      ],
      // Exact hostname match (openrouter.ai or *.openrouter.ai): a substring
      // check would false-positive on hostile hosts.
      [
        'does NOT treat lookalike hostnames as OpenRouter',
        { baseUrl: 'https://openrouter.ai.evil.com/v1', model: qwen27b },
        sideQuery(qwen27b),
        { reasoning: undefined },
      ],
      // api.openai.com has its own reasoning shapes and rejects unknown fields.
      [
        'does NOT emit reasoning on the official OpenAI endpoint when includeThoughts is false',
        { baseUrl: OPENAI_URL, model: 'gpt-5' },
        sideQuery('gpt-5'),
        { reasoning: undefined },
      ],
      // #4501: qwen3 hybrids (e.g. qwen3.5-flash) default to thinking on and
      // providers never auto-inject `enable_thinking`, so the old guarded
      // `'enable_thinking' in typed` check never fired and side queries burned
      // reasoning tokens (24-95x output bloat). The provider here passes the
      // request through, as when no `extra_body.enable_thinking` is set.
      [
        'emits enable_thinking:false on DashScope hostname when includeThoughts is false',
        { baseUrl: DASHSCOPE_URL, model: 'qwen3.5-flash' },
        sideQuery('qwen3.5-flash'),
        { enable_thinking: false },
      ],
      // The config-level opt-out, mirroring the DeepSeek pair.
      [
        'emits enable_thinking:false on DashScope hostname when reasoning is configured to false',
        { baseUrl: DASHSCOPE_URL, model: 'qwen3.5-flash', reasoning: false },
        userRequest('qwen3.5-flash'),
        { enable_thinking: false },
        'main',
      ],
      // QWEN_OAUTH, the first-run default, ships `model: 'coder-model'`
      // (DEFAULT_QWEN_MODEL, aliased to Qwen 3.6 Plus hybrid). It does not
      // start with `qwen`, so the gate must special-case it or #4501 stays
      // live on the default flow.
      [
        'emits enable_thinking:false on QWEN_OAUTH with the default coder-model',
        {
          authType: AuthType.QWEN_OAUTH,
          baseUrl: 'https://some-oauth-issued-endpoint.example/v1',
          model: 'coder-model',
        },
        sideQuery('coder-model'),
        { enable_thinking: false },
      ],
      // Internal Alibaba domains proxy DashScope-compatible APIs and count as
      // DashScope by design (provider/dashscope.ts:75-78); pinned so tighter
      // hostname rules cannot silently drop internal users.
      [
        'emits enable_thinking:false on internal alibaba-inc.com hostname',
        {
          baseUrl: 'https://gateway.alibaba-inc.com/v1',
          model: 'qwen3.5-flash',
        },
        sideQuery('qwen3.5-flash'),
        { enable_thinking: false },
      ],
      // A qwen-specific extension: on a strict OpenAI-compatible backend it
      // could 400 and pollutes logs (the DeepSeek negative's mirror).
      [
        'does NOT emit enable_thinking on a non-DashScope hostname',
        { baseUrl: OPENAI_URL, model: 'gpt-5' },
        sideQuery(),
        { enable_thinking: undefined },
      ],
      // Self-hosted servers render the chat template server-side and read the
      // switch from `chat_template_kwargs`, ignoring a top-level
      // `enable_thinking`; a preset-injected top-level `enable_thinking: true`
      // must be stripped so it cannot contradict the opt-out.
      [
        'disables qwen thinking via chat_template_kwargs on a non-DashScope endpoint (vLLM/SGLang)',
        { baseUrl: SELF_HOSTED_URL, model: 'Qwen3.6-27B' },
        sideQuery('Qwen3.6-27B'),
        {
          chat_template_kwargs: { enable_thinking: false },
          enable_thinking: undefined,
        },
        undefined,
        { enable_thinking: true },
      ],
      // A user can point the QWEN_OAUTH default at a self-hosted endpoint:
      // the `model === 'coder-model'` arm must reach this path too.
      [
        'disables coder-model thinking via chat_template_kwargs on a non-DashScope endpoint',
        { baseUrl: SELF_HOSTED_URL, model: 'coder-model' },
        sideQuery('coder-model'),
        {
          chat_template_kwargs: { enable_thinking: false },
          enable_thinking: undefined,
        },
      ],
      // Existing kwargs are spread before `enable_thinking: false` is added;
      // a refactor must not drop user-configured kwargs.
      [
        'merges enable_thinking into pre-existing chat_template_kwargs on a non-DashScope endpoint',
        { baseUrl: SELF_HOSTED_URL, model: 'Qwen3.6-27B' },
        sideQuery('Qwen3.6-27B'),
        {
          chat_template_kwargs: {
            apply_chat_template: true,
            enable_thinking: false,
          },
        },
        undefined,
        { chat_template_kwargs: { apply_chat_template: true } },
      ],
      // The hostname routes several families: GLM reads
      // `extra_body.thinking.enabled`, DeepSeek-on-DashScope
      // `thinking: { type: 'disabled' }`, so `enable_thinking` is a no-op at
      // best and an upstream rejection at worst.
      [
        'does NOT emit enable_thinking on a non-qwen model routed through DashScope',
        { baseUrl: DASHSCOPE_URL, model: 'glm-5' },
        sideQuery('glm-5'),
        { enable_thinking: undefined },
      ],
      // buildRequest ships `context.model` (request.model || config.model),
      // so a qwen config with a non-qwen request model gates on the request
      // model — else the field leaks to the routing actually on the wire.
      [
        'gates on the wire model, not config: qwen config + non-qwen request.model does NOT emit',
        { baseUrl: DASHSCOPE_URL, model: 'qwen3.5-flash' },
        sideQuery('glm-5'),
        { enable_thinking: undefined },
      ],
      // The mirror: a qwen wire model must still get the disable (#4501).
      [
        'gates on the wire model, not config: non-qwen config + qwen request.model emits false',
        { baseUrl: DASHSCOPE_URL, model: 'glm-5' },
        sideQuery('qwen3.5-flash'),
        { enable_thinking: false },
      ],
    ])('%s', async (_title, config, request, expected, promptId, adds) => {
      if (adds) providerAdds(adds);
      expectFields(
        await executeWith(config, request, promptId ?? 'forked_query'),
        expected,
      );
    });

    it('emits enable_thinking:false when baseUrl is unset (DashScope default)', async () => {
      // `isDashScopeProvider` returns true for `!baseUrl` (dashscope.ts:49), the
      // path a fresh install without the setup wizard hits. Every other
      // positive case sets baseUrl, so this pins the implicit default.
      pipelineWith({ model: 'qwen3.5-flash' });
      delete (mockContentGeneratorConfig as { baseUrl?: string }).baseUrl;

      await executeOk(sideQuery('qwen3.5-flash'), 'forked_query');

      expect(sentBody().enable_thinking).toBe(false);
    });

    it('should handle errors and log them', async () => {
      const request = userRequest();
      const testError = new Error('API Error');
      failCreate(testError);

      await expect(pipeline.execute(request, 'test-prompt-id')).rejects.toThrow(
        'API Error',
      );
      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        testError,
        expect.any(Object),
        request,
      );
    });

    it('should redact proxy credentials before request errors reach the error handler', async () => {
      const request = userRequest();
      const testError = new Error(PROXY_ERROR);
      failCreate(testError);

      await expectRedacted(
        pipeline.execute(request, 'test-prompt-id'),
        request,
        testError,
        PROXY_ERROR_REDACTED,
        'token@',
      );
    });

    it('should pass abort signal to OpenAI client when provided', async () => {
      const abortController = new AbortController();

      await executeOk(abortable(abortController.signal), 'test-id', []);

      // The pipeline wraps the caller's signal in a per-request child to
      // isolate OpenAI SDK listener leaks: the SDK gets the child.
      expect(sentSignal()).toBeInstanceOf(AbortSignal);
      expect(sentSignal()).not.toBe(abortController.signal);
    });

    it('should propagate parent abort to SDK child signal', async () => {
      const abortController = new AbortController();
      (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([]);
      createMock().mockImplementation(() => {
        abortController.abort();
        return { choices: [{ message: { content: 'ok' } }] };
      });
      (mockConverter.convertOpenAIResponseToLlm as Mock).mockReturnValue(
        new GenerateContentResponse(),
      );

      await pipeline.execute(abortable(abortController.signal), 'test-id');
      expect(sentSignal().aborted).toBe(true);
    });
  });

  describe('executeStream', () => {
    /** An APIPromise for `stream` whose withResponse() returns `withResponse()`. */
    const apiPromise = (
      stream: unknown,
      withResponse: () => Promise<unknown>,
    ) => Object.assign(Promise.resolve(stream), { withResponse });

    /** Serves `stream` via an APIPromise whose withResponse() reports `response`. */
    function serveWithResponse(
      response: Response,
      request_id: string | null,
      stream = streamOf(),
    ) {
      (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([]);
      createMock().mockReturnValue(
        apiPromise(stream, () =>
          Promise.resolve({ data: stream, response, request_id }),
        ),
      );
    }

    const httpResponse = (
      headers: Record<string, string>,
      body: ReadableStream | null = null,
    ) => ({ headers: new Headers(headers), status: 200, body }) as Response;

    const bodyOf = (text: string) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });

    /** Serves a `headers` response and resolves with executeStream's rejection. */
    async function nonSSEError(
      headers: Record<string, string>,
      body: ReadableStream | null = null,
      requestId: string | null = null,
    ) {
      serveWithResponse(httpResponse(headers, body), requestId);
      return (await pipeline
        .executeStream(userRequest(), 'test-id')
        .catch((e: unknown) => e)) as NonSSEResponseError;
    }

    /** Streams `chunks`; resolves with what was yielded and the ending error. */
    const settled = async (...chunks: unknown[]) =>
      settle(await streamFrom(streamOf(...chunks)));

    /** Context fields for a `</think>` closing-tag candidate still pending. */
    const pendingCloseTag = () => ({
      pendingThinkingTagCandidate: {
        text: '</think>',
        closingTagName: 'think',
      },
    });

    /** Context fields for a whitespace-only candidate holding `parts`. */
    const heldParts =
      (...parts: Part[]) =>
      () => ({
        pendingThinkingTagCandidate: { text: ' ' },
        pendingUntrustedResponseParts: parts,
      });

    /**
     * Converts each chunk by id to `responses[id]` (else `rest`), first
     * recording `sanitized[id]` on the context as the converter does when it
     * strips a protocol tag.
     */
    function convertById(
      responses: Record<string, GenerateContentResponse>,
      rest: GenerateContentResponse,
      sanitized: Record<string, { tagName: string; toolCallCount: number }>,
    ) {
      (mockConverter.convertOpenAIChunkToLlm as Mock).mockImplementation(
        (chunk, context) => {
          if (sanitized[chunk.id]) {
            context.protocolTagSanitized = sanitized[chunk.id];
          }
          return responses[chunk.id] ?? rest;
        },
      );
    }

    /**
     * Streams `first` as content, then a read_file tool-call finish, then a
     * transport failure the consumer must see.
     */
    async function failAfterToolCall(
      first: Part,
      request?: PromptCacheSharingParameters,
    ) {
      const firstResponse = responseOf([first]);
      const finish = finishOf([fnCall('read_file')]);
      convertChunksTo(firstResponse, finish);
      const streamError = new Error('stream failed after finish');
      const { items, error } = await settle(
        await streamFrom(
          streamOf(
            chunkOf({ content: first.text }),
            chunkOf({}, 'tool_calls'),
            streamError,
          ),
          request,
        ),
      );
      expect(error).toBe(streamError);
      return { items, first: firstResponse, finish };
    }

    /**
     * Streams an answer and its `stop` finish, then `error`; checks both
     * responses arrive (the parked finish flushed ahead of the error).
     */
    async function parkedFinishBefore(error: Error) {
      const content = responseOf([{ text: 'a complete answer' }]);
      convertChunksTo(content, finishOf());
      const iterator = (
        await streamFrom(
          streamOf(
            chunkOf({ content: 'a complete answer' }),
            chunkOf({ content: '' }, 'stop'),
            error,
          ),
        )
      )[Symbol.asyncIterator]();
      expect(await nextValue(iterator)).toBe(content);
      expect((await nextValue(iterator)).candidates?.[0]?.finishReason).toBe(
        FinishReason.STOP,
      );
      return iterator;
    }

    const CONSUMER_THREW = 'consumer threw into the generator';
    const throwInto = (gen: AsyncGenerator<GenerateContentResponse>) =>
      gen.throw!(new Error(CONSUMER_THREW));

    it('retries stream creation when the provider requires thinking', async () => {
      pipelineWith({
        baseUrl: TOKEN_PLAN_URL,
        model: 'qwen3.8-max-preview',
        extra_body: { enable_thinking: true },
      });
      providerAdds({ enable_thinking: true });
      (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([]);
      const stream = streamOf(); // empty: this covers stream creation only
      createMock()
        .mockReturnValueOnce(
          apiPromise(stream, () => Promise.reject(requiredThinkingError())),
        )
        .mockReturnValueOnce(
          apiPromise(stream, () =>
            Promise.resolve({
              data: stream,
              response: new Response(null, {
                headers: { 'content-type': 'text/event-stream' },
              }),
              request_id: 'retry-success',
            }),
          ),
        );

      await collect(
        await pipeline.executeStream(
          sideQuery('qwen3.8-max-preview'),
          'forked_query',
        ),
      );

      const calls = createMock().mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][0].reasoning_effort).toBe('none');
      expect(calls[0][0].enable_thinking).toBeUndefined();
      expect(calls[1][0].enable_thinking).toBe(true);
      expect(mockReportOpenAiRequest).toHaveBeenNthCalledWith(1, calls[0][0]);
      expect(mockReportOpenAiRequest).toHaveBeenNthCalledWith(2, calls[1][0]);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('should successfully execute streaming request', async () => {
      const chunks = [
        chunkOf({ content: 'Hello' }),
        chunkOf({ content: ' response' }, 'stop'),
      ];
      const responses = [
        responseOf([{ text: 'Hello' }]),
        responseOf([{ text: ' response' }]),
      ];
      convertChunksTo(...responses);
      mockProvider.getResponseParsingOptions = vi.fn().mockReturnValue({
        contentOnlyThinkingTagLeaks: true,
      });
      const telemetryAttempt = {};
      mockReportOpenAiRequest.mockReturnValueOnce(telemetryAttempt);

      const results = await streamed(...chunks);

      expect(results).toHaveLength(2);
      expect(results[0]).toBe(responses[0]);
      expect(results[1]).toBe(responses[1]);
      expect(mockProvider.getResponseParsingOptions).toHaveBeenCalledWith(
        'test-model',
      );
      const [[, firstChunkContext], [, secondChunkContext]] = (
        mockConverter.convertOpenAIChunkToLlm as Mock
      ).mock.calls;
      expect(firstChunkContext).toEqual(
        expect.objectContaining({
          model: 'test-model',
          modalities: {},
          toolCallParser: expect.any(StreamingToolCallParser),
          responseParsingOptions: { contentOnlyThinkingTagLeaks: true },
        }),
      );
      expect(secondChunkContext.toolCallParser).toBe(
        firstChunkContext.toolCallParser,
      );
      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          stream: true,
          stream_options: { include_usage: true },
        }),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(mockReportOpenAiRequest).toHaveBeenCalledWith(sentBody());
      for (const [i, chunk] of chunks.entries()) {
        expect(mockReportOpenAiChunk).toHaveBeenNthCalledWith(
          i + 1,
          telemetryAttempt,
          chunk,
        );
      }
    });

    it('should filter empty responses', async () => {
      const valid = responseOf([{ text: 'Hello response' }]);
      convertChunksTo(
        responseOf([]),
        responseWith({ candidates: [] }),
        new GenerateContentResponse(),
        valid,
      );

      const results = await streamed(
        chunkOf({ content: '' }),
        noChoiceChunk(),
        noChoiceChunk(),
        chunkOf({ content: 'Hello response' }, 'stop'),
      );

      expect(results).toHaveLength(1); // the empty responses are filtered out
      expect(results[0]).toBe(valid);
    });

    it('rejects an unresolved thinking-tag candidate at clean stream EOF', async () => {
      convertChunksSetting(pendingCloseTag, responseOf([]));

      await expect(
        streamed(chunkOf({ content: '</think>' })),
      ).rejects.toMatchObject({ type: 'PROTOCOL_TAG_LEAK' });
      expect(logProtocolTagSanitized).not.toHaveBeenCalled();
    });

    it('allows a whitespace-only tag candidate at clean stream EOF', async () => {
      convertChunksSetting(
        () => ({ pendingThinkingTagCandidate: { text: ' ' } }),
        responseOf([]),
      );

      expect(await streamed(chunkOf({ content: ' ' }))).toEqual([]);
    });

    it('flushes held response parts for a whitespace-only candidate at clean EOF', async () => {
      convertChunksSetting(
        heldParts({ thought: true, text: 'reasoning' }),
        responseOf([]),
      );

      const results = await streamed(chunkOf({ content: ' ' }));

      expect(results).toHaveLength(1);
      expect(results[0]?.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'reasoning' },
      ]);
    });

    it('logs protocol-tag sanitization when a held finish is flushed on the error path', async () => {
      const streamError = new Error('stream failed after finish');
      // A text finish, not a functionCall one: the error-path flush never
      // releases those (see the withhold case below), and the log pin needs
      // a finish the flush actually delivers.
      const finish = finishOf([{ text: 'sanitized answer' }], {
        responseId: 'finish-response',
      });
      convertChunksSetting(
        () => ({
          protocolTagSanitized: { tagName: 'think', toolCallCount: 0 },
        }),
        finish,
      );

      const { items, error } = await settled(chunkOf({}, 'stop'), streamError);

      expect(error).toBe(streamError);
      // The flush delivers the held finish ahead of the rejection, so its
      // sanitization is telemetry for a response the caller really received.
      expect(items).toEqual([finish]);
      expect(logProtocolTagSanitized).toHaveBeenCalledTimes(1);
    });

    it('logs only the accepted finish after duplicate and empty trailing chunks', async () => {
      const finishFor = (responseId: string, callId: string) =>
        finishOf([fnCall('read_file', undefined, callId)], { responseId });
      const firstFinish = finishFor('finish-1', 'call-1');
      convertById(
        {
          'finish-1': firstFinish,
          'finish-2': finishFor('finish-2', 'call-2'),
        },
        responseOf([]),
        {
          'finish-1': { tagName: 'think', toolCallCount: 1 },
          'finish-2': { tagName: 'thinking', toolCallCount: 2 },
        },
      );

      const results = await streamed(
        ...['finish-1', 'finish-2', 'trailing-empty'].map((id) =>
          chunkOf({}, null, { id }),
        ),
      );

      expect(results).toEqual([firstFinish]);
      expect(logProtocolTagSanitized).toHaveBeenCalledTimes(1);
      expect(logProtocolTagSanitized).toHaveBeenCalledWith(
        mockCliConfig,
        expect.objectContaining({
          response_id: 'finish-1',
          tag_name: 'think',
          tool_call_count: 1,
        }),
      );
    });

    it('does not attribute sanitization from a discarded duplicate finish', async () => {
      const finishFor = (responseId: string) =>
        finishOf([fnCall('read_file')], { responseId });
      convertById(
        {
          'finish-1': finishFor('finish-1'),
          'finish-2': finishFor('finish-2'),
        },
        responseWith({ usageMetadata: { totalTokenCount: 1 } }),
        { 'finish-2': { tagName: 'think', toolCallCount: 1 } },
      );

      await streamed(
        ...['finish-1', 'finish-2', 'usage'].map((id) =>
          chunkOf({}, null, { id }),
        ),
      );

      expect(logProtocolTagSanitized).not.toHaveBeenCalled();
    });

    it('rejects visible content after a sanitized finish', async () => {
      convertById(
        { finish: finishOf([fnCall('read_file')], { responseId: 'finish' }) },
        responseOf([{ text: 'unexpected' }]),
        { finish: { tagName: 'think', toolCallCount: 1 } },
      );

      await expect(
        streamed(
          chunkOf({}, null, { id: 'finish' }),
          chunkOf({}, null, { id: 'trailing-content' }),
        ),
      ).rejects.toMatchObject({ type: 'PROTOCOL_TAG_LEAK' });
      expect(logProtocolTagSanitized).not.toHaveBeenCalled();
    });

    it.each(['transport error', 'explicit abort'] as const)(
      'handles a pending closing tag on %s',
      async (termination) => {
        const abortController = new AbortController();
        const streamError = new Error(
          termination === 'explicit abort' ? 'Aborted' : 'socket reset',
        ) as Error & { code?: string };
        if (termination === 'explicit abort') {
          streamError.name = 'AbortError';
        } else {
          streamError.code = 'ECONNRESET';
        }
        const mockStream = {
          async *[Symbol.asyncIterator]() {
            yield chunkOf({}, null, { id: 'pending-tag' });
            if (termination === 'explicit abort') abortController.abort();
            throw streamError;
          },
        };
        const reasoning = responseOf([{ thought: true, text: 'reasoning' }]);
        convertChunksSetting(pendingCloseTag, reasoning);

        const { items, error } = await settle(
          await streamFrom(mockStream, abortable(abortController.signal)),
        );

        expect(items).toEqual([reasoning]);
        if (termination === 'explicit abort') {
          expect(error).toBe(streamError);
        } else {
          expect(error).toMatchObject({ type: 'PROTOCOL_TAG_LEAK' });
        }
      },
    );

    it('preserves a StreamContentError while a closing tag is pending', async () => {
      convertChunksSetting(pendingCloseTag, responseOf([]));

      await expect(
        streamed(
          chunkOf({}, null, { id: 'pending-tag' }),
          chunkOf({ content: 'Throttling: TPM(1/1)' }, 'error_finish'),
        ),
      ).rejects.toThrow(StreamContentError);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('should preserve an otherwise empty response with tool preparation metadata', async () => {
      const preparation = responseOf([]);
      setToolCallPreparations(preparation, [
        { callId: 'call-1', toolName: 'read_file' },
      ]);
      convertEveryChunkTo(preparation);

      expect(await streamed(chunkOf({ tool_calls: [] }))).toEqual([
        preparation,
      ]);
    });

    it('should handle streaming errors and reset tool calls', async () => {
      const request = userRequest();
      const testError = new Error('Stream Error');

      // The error reaches the consumer through the generator; the pipeline
      // also calls errorHandler.handle() internally.
      const { items, error } = await settle(
        await streamFrom(streamOf(testError), request),
      );
      expect(error).toBe(testError);
      expect(items).toHaveLength(0);
      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        testError,
        expect.any(Object),
        request,
      );
    });

    it('should redact proxy credentials from stream creation errors', async () => {
      const request = userRequest();
      const testError = new Error('407 via http://user:pass@proxy.local');
      failCreate(testError);

      await expectRedacted(
        pipeline.executeStream(request, 'test-prompt-id'),
        request,
        testError,
        '407 via http://<redacted>@proxy.local',
        'user:pass',
      );
    });

    it('should redact proxy credentials before stream errors reach the error handler', async () => {
      const request = userRequest();
      const testError = new Error(PROXY_ERROR);
      const mockStream = {
        [Symbol.asyncIterator]: () => ({
          next: vi.fn().mockRejectedValue(testError),
        }),
      };

      await expectRedacted(
        collect(await streamFrom(mockStream, request)),
        request,
        testError,
        PROXY_ERROR_REDACTED,
        'token@',
      );
    });

    it('should throw StreamContentError when stream chunk contains error_finish', async () => {
      await expect(
        streamed(chunkOf({ content: 'Throttling: TPM(1/1)' }, 'error_finish')),
      ).rejects.toThrow(StreamContentError);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
      expect(mockConverter.convertOpenAIChunkToLlm).not.toHaveBeenCalled();
    });

    it('should redact proxy credentials from StreamContentError messages', async () => {
      await expect(
        streamed(chunkOf({ content: PROXY_ERROR }, 'error_finish')),
      ).rejects.toThrow(PROXY_ERROR_REDACTED);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('should throw NonSSEResponseError when response has non-SSE content-type', async () => {
      // The stream yields nothing — simulates an HTML body parsed as SSE.
      const thrownError = await nonSSEError(
        {
          'content-type': 'text/html;charset=UTF-8',
          'x-request-id': 'req-123',
        },
        null,
        'req-123',
      );

      expect(thrownError).toBeInstanceOf(NonSSEResponseError);
      expect(thrownError.httpStatus).toBe(200);
      expect(thrownError.status).toBe(200);
      expect(thrownError.requestId).toBe('req-123');
      expect(thrownError.request_id).toBe('req-123');
    });

    it('should throw NonSSEResponseError for application/json streaming responses', async () => {
      const thrownError = await nonSSEError(
        { 'content-type': 'application/json' },
        bodyOf('{"error":"gateway blocked streaming request"}'),
        'req-json',
      );

      expect(thrownError).toBeInstanceOf(NonSSEResponseError);
      expect(thrownError.contentType).toBe('application/json');
      expect(thrownError.bodyPrefix).toContain('gateway blocked');
      expect(thrownError.requestId).toBe('req-json');
    });

    it('should include body prefix in NonSSEResponseError when body is readable', async () => {
      const htmlBody = '<html>' + 'x'.repeat(700) + '</html>';
      const thrownError = await nonSSEError(
        { 'content-type': 'text/html' },
        bodyOf(htmlBody),
      );

      expect(thrownError).toBeInstanceOf(NonSSEResponseError);
      expect(thrownError.contentType).toBe('text/html');
      expect(thrownError.httpStatus).toBe(200);
      expect(thrownError.bodyPrefix).toBe(htmlBody.slice(0, 512));
      expect(thrownError.bodyPrefix).toHaveLength(512);
      expect(thrownError.requestId).toBeNull();
    });

    it('should still throw NonSSEResponseError when body prefix read fails', async () => {
      const thrownError = await nonSSEError(
        { 'content-type': 'text/html' },
        new ReadableStream({
          start(controller) {
            controller.error(new Error('body already consumed'));
          },
        }),
      );

      expect(thrownError).toBeInstanceOf(NonSSEResponseError);
      expect(thrownError.bodyPrefix).toBe('');
    });

    it('should not throw NonSSEResponseError for text/event-stream content-type', async () => {
      serveWithResponse(
        httpResponse({ 'content-type': 'text/event-stream' }),
        null,
        streamOf(chunkOf({ content: 'Hello' }, 'stop')),
      );
      convertEveryChunkTo(finishOf([{ text: 'Hello' }]));

      const results = await collect(
        await pipeline.executeStream(userRequest(), 'test-id'),
      );
      expect(results.length).toBeGreaterThan(0);
    });

    it('should fall back to regular await when withResponse is not available', async () => {
      convertEveryChunkTo(finishOf([{ text: 'Hello' }]));

      // streamFrom resolves create() plainly — no withResponse method.
      const results = await streamed(chunkOf({ content: 'Hello' }, 'stop'));
      expect(results.length).toBeGreaterThan(0);
    });

    it('should pass abort signal to OpenAI client for streaming requests', async () => {
      const abortController = new AbortController();
      convertEveryChunkTo(new GenerateContentResponse());

      await collect(
        await streamFrom(
          streamOf(chunkOf({ content: 'Hello' }, 'stop')),
          abortable(abortController.signal),
          'test-id',
        ),
      );

      // A per-request child signal isolates SDK listener leaks.
      expect(sentSignal()).toBeInstanceOf(AbortSignal);
      expect(sentSignal()).not.toBe(abortController.signal);
    });

    it('should abort child signal after stream is fully consumed', async () => {
      convertEveryChunkTo(new GenerateContentResponse());

      const resultGenerator = await streamFrom(
        streamOf(chunkOf({ content: 'Hello' }, 'stop')),
        abortable(),
        'test-id',
      );
      expect(sentSignal().aborted).toBe(false);

      await collect(resultGenerator);

      expect(sentSignal().aborted).toBe(true);
    });

    it('should abort child signal when consumer breaks early', async () => {
      convertEveryChunkTo(new GenerateContentResponse());

      const resultGenerator = await streamFrom(
        streamOf(chunkOf({ content: 'a' }), chunkOf({ content: 'b' }, 'stop')),
        abortable(),
        'test-id',
      );

      for await (const _result of resultGenerator) {
        break;
      }

      expect(sentSignal().aborted).toBe(true);
    });

    it('should abort child signal when SDK create() throws', async () => {
      (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([]);
      createMock().mockImplementation(() => {
        throw new Error('network failure');
      });

      await expect(
        pipeline.executeStream(abortable(), 'test-id'),
      ).rejects.toThrow();

      expect(sentSignal().aborted).toBe(true);
    });

    it('should ignore empty choices while merging finishReason and usageMetadata', async () => {
      const usageMetadata = usage();
      setGenAiUsageProvenance(usageMetadata, {
        cachedInputTokensReported: false,
      });
      const content = responseOf([{ text: 'Hello response' }]);
      convertChunksTo(
        content,
        finishOf([], { modelVersion: 'actual-provider-model' }),
        responseWith({ candidates: [] }),
        responseWith({ candidates: [], usageMetadata }),
      );

      const iterator = (
        await streamFrom(
          streamOf(
            chunkOf({ content: 'Hello response' }),
            chunkOf({ content: '' }, 'stop'), // finish: empty content
            noChoiceChunk(), // empty choices between finish and usage
            noChoiceChunk(wireUsage()), // usage: empty candidates
          ),
        )
      )[Symbol.asyncIterator]();

      try {
        expect(await nextValue(iterator)).toBe(content);
        const finish = await nextValue(iterator);
        // Check before resuming: a later chunk can mutate the yielded object.
        expect(finish.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
        expect(finish.usageMetadata).toEqual(usage());
        expect(finish.modelVersion).toBe('actual-provider-model');
        expect(getGenAiUsageProvenance(finish.usageMetadata)).toEqual({
          cachedInputTokensReported: false,
        });

        await expect(iterator.next()).resolves.toEqual({
          value: undefined,
          done: true,
        });
      } finally {
        while (!(await iterator.next()).done) {
          // drain what is left
        }
      }
    });

    it('should handle ideal case where last chunk has both finishReason and usageMetadata', async () => {
      const content = responseOf([{ text: 'Hello response' }]);
      const final = finishOf([], { usageMetadata: usage() });
      convertChunksTo(content, final);

      const results = await streamed(
        chunkOf({ content: 'Hello response' }),
        // The ideal case: the final chunk has both finish_reason and usage.
        chunkOf({ content: '' }, 'stop', wireUsage()),
      );

      expect(results).toHaveLength(2);
      expect(results[0]).toBe(content);
      expect(results[1]).toBe(final);
      expectStopWithUsage(results[1]);
    });

    it('should handle providers that send zero usage in finish chunk (like modelscope)', async () => {
      // Zero usage on the content chunk should be filtered or ignored.
      const content = responseOf(
        [{ text: 'Hello response' }],
        {},
        {
          usageMetadata: usage(0, 0, 0),
        },
      );
      convertChunksTo(
        content,
        // All-zero usage on the finish chunk is treated as no usage.
        finishOf([], { usageMetadata: usage(0, 0, 0) }),
        responseWith({ candidates: [], usageMetadata: usage() }),
      );

      const results = await streamed(
        // Modelscope sends zero usage on the content and finish chunks.
        chunkOf({ content: 'Hello response' }, null, wireUsage(0, 0, 0)),
        chunkOf({ content: '' }, 'stop', wireUsage(0, 0, 0)),
        noChoiceChunk(wireUsage()), // the real usage arrives last
      );

      expect(results).toHaveLength(2); // content + merged finish/usage
      expect(results[0]).toBe(content);
      expectStopWithUsage(results[1]);
    });

    it('should handle providers that send finishReason and valid usage in same chunk', async () => {
      const content = responseOf(
        [{ text: 'Hello response' }],
        {},
        {
          usageMetadata: usage(0, 0, 0),
        },
      );
      const final = finishOf([], { usageMetadata: usage() });
      convertChunksTo(content, final);

      const results = await streamed(
        chunkOf({ content: 'Hello response' }, null, wireUsage(0, 0, 0)),
        chunkOf({ content: '' }, 'stop', wireUsage()), // finish + valid usage
      );

      expect(results).toHaveLength(2);
      expect(results[0]).toBe(content);
      expect(results[1]).toBe(final);
      expectStopWithUsage(results[1]);
    });

    it('should not duplicate function calls when trailing chunks arrive after finish+usage merge', async () => {
      // Real-world bug: some providers (e.g. bailian/glm-5) send trailing
      // empty chunks AFTER the finish+usage pair; each re-triggered the merge
      // and yielded the finish (and its function call) again, duplicating
      // tool-call execution in the UI.
      const content = responseOf([{ text: 'I will create a todo' }]);
      convertChunksTo(
        content,
        finishOf([fnCall('todoWrite', { text: 'buy milk' })]),
        responseWith({ candidates: [], usageMetadata: usage() }),
        responseWith({ candidates: [] }),
      );

      const results = await streamed(
        chunkOf({ content: 'I will create a todo' }),
        chunkOf({}, 'tool_calls'), // finish with tool calls
        noChoiceChunk(wireUsage()), // usage only
        noChoiceChunk(), // the trailing empty chunk that duplicated
      );

      // Content plus ONE merged finish; before the fix this was 3.
      expect(results).toHaveLength(2);
      expect(results[0]).toBe(content);
      const merged = results[1]!;
      expect(merged.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(
        merged.candidates?.[0]?.content?.parts?.[0]?.functionCall?.name,
      ).toBe('todoWrite');
      expect(merged.usageMetadata).toEqual(usage());
      // Exactly one function-call part across ALL yielded results.
      expect(
        results.flatMap((r) =>
          (r.candidates?.[0]?.content?.parts ?? []).filter(
            (p) => p.functionCall,
          ),
        ),
      ).toHaveLength(1);
    });

    it('flushes a parked finish response when the stream fails before the trailing tail', async () => {
      // A gateway error frame can land where the trailing usage chunk would
      // have been, after the finish chunk was parked for the usage merge. The
      // caller must still get the finish ahead of the rejection, or
      // downstream completeness gates cannot tell the answer finished.
      const iterator = await parkedFinishBefore(
        Object.assign(new Error("'id'"), {
          code: 'KeyError',
          requestID: 'req-1',
        }),
      );

      await expect(iterator.next()).rejects.toThrow("'id'");
      expect(mockErrorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it('flushes a parked finish response ahead of a stream-guard timeout', async () => {
      // A provider that sends content and `finish_reason: 'stop'` then goes
      // silent (hung or drip-fed gateway) trips the inactivity watchdog with
      // the finish still parked. Completeness gates key on the finish reason,
      // so it must reach the caller ahead of the guard's rethrow; a flush
      // placed below the guard branch never runs for this error class.
      const guardError = new StreamInactivityTimeoutError(240_000, 2, 240_500);
      const iterator = await parkedFinishBefore(guardError);

      // The caller still gets the dedicated timeout instance, type and
      // idle/chunk metadata intact: the guard branch bypasses handleError.
      await expect(iterator.next()).rejects.toBe(guardError);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('withholds a parked functionCall finish when the stream fails before the trailing tail', async () => {
      // The converter emits functionCall parts only on the finish chunk, which
      // streaming always parks for the trailing usage. Releasing it ahead of
      // the error would flip LlmChat's delivered flags
      // (streamYieldedContentChunk, streamYieldedFunctionCall) and shut the
      // transport replay gate that recovers exactly this cut, while the
      // post-completion acceptance arm the flush feeds excludes tool calls
      // anyway — so a tool-call finish stays parked on the error path.
      const streamError = new Error('stream failed after finish');
      convertEveryChunkTo(finishOf([fnCall('read_file')]));

      const { items, error } = await settled(
        chunkOf({}, 'tool_calls'),
        streamError,
      );

      expect(error).toBe(streamError);
      expect(items).toEqual([]); // no chunk, only the rejection
      expect(mockErrorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it('releases a parked functionCall finish once content was delivered when the stream fails', async () => {
      // The withhold above protects LlmChat's transport replay gate, open only
      // while nothing user-visible was delivered. Once prose reached the
      // caller that gate is shut, so withholding just strands the decided
      // tool call: releasing it flips LlmChat's delivered flags and lets the
      // error-path persistence and the scheduler's repair flow take over.
      const { items, first, finish } = await failAfterToolCall({
        text: 'Let me read that file. ',
      });

      expect(items).toEqual([first, finish]); // both ahead of the rejection
      expect(mockErrorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it('withholds a parked functionCall finish when only thought content was delivered', async () => {
      // The delivered-content flag mirrors LlmChat's, which excludes thought
      // parts: a thought-only prefix persists nothing on the error path and
      // leaves the replay gate open, so the tool-call finish stays withheld.
      const { items, first } = await failAfterToolCall({
        text: 'Let me plan this out.',
        thought: true,
      });

      expect(items).toEqual([first]);
      expect(mockErrorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it('releases a parked functionCall finish on a continuation attempt even when only thought content was delivered', async () => {
      // As above, but on a transport-continuation attempt. The replay gate is
      // turn-scoped (LlmChat's transportContinuationText) and already shut by
      // the accumulated prefix, which a fresh stream's own yields cannot
      // show; the delivered-content flag is seeded from the continuation
      // marker, so the decided tool call is released rather than parked into
      // another prose continuation.
      const { items, first, finish } = await failAfterToolCall(
        { text: 'Let me plan this out.', thought: true },
        { ...userRequest(), continuationInFlight: true },
      );

      expect(items).toEqual([first, finish]);
      expect(mockErrorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it('does not re-deliver a Stage 2d finish when the consumer throws into the generator', async () => {
      // Stage 2d yields the parked finish and suspends there. A consumer
      // throwing into the generator then lands in the error-path flush, which
      // re-tests `finishYielded`: had Stage 2d not set it, the same response
      // would be delivered (and persisted) twice. Latent, not live — the two
      // `.throw()` sites in this chain only forward one
      // (`llm-content-generator.ts`, `loggingContentGenerator.ts`) and a
      // `for await` consumer abandons through `.return()` — so this pins the
      // invariant for the first caller that does throw.
      const finish = finishOf([{ text: 'a complete answer' }]);
      convertChunksTo(finish);

      const gen = await streamFrom(streamOf(chunkOf({}, 'stop')));

      expect((await gen.next()).value).toBe(finish);
      // The throw propagates instead of resolving with the same response.
      await expect(throwInto(gen)).rejects.toThrow(CONSUMER_THREW);
      expect(mockErrorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it('does not re-deliver an in-loop merged finish when the consumer throws into the generator', async () => {
      // The other yield of a parked finish: a chunk arriving after it is
      // merged in and yielded in-loop, so the flag must be raised before
      // suspending there too.
      const finish = finishOf([{ text: 'a complete answer' }]);
      convertChunksTo(finish, responseWith({ usageMetadata: usage(3, 5, 8) }));

      const gen = await streamFrom(streamOf(chunkOf({}, 'stop'), chunkOf()));

      const first = await gen.next();
      // The merge keeps the parked candidates and carries the late usage.
      expect(first.value?.candidates).toBe(finish.candidates);
      expect(first.value?.usageMetadata?.totalTokenCount).toBe(8);
      await expect(throwInto(gen)).rejects.toThrow(CONSUMER_THREW);
      expect(mockErrorHandler.handle).toHaveBeenCalledTimes(1);
    });

    it('releases a parked tool call when the held-parts flush delivered the content', async () => {
      // The unclosed-thinking-tag flush yields the held parts. Non-thought
      // content there makes LlmChat count the chunk as delivered and shut its
      // replay gate, so `contentYielded` must agree at this yield site too —
      // else the error-path flush withholds a tool call no recovery arm can
      // pick up. Thought-only held parts keep it false (the sibling below).
      const finish = finishOf([fnCall('read_file')]);
      // A whitespace-only candidate with no closing tag takes the flush
      // branch; the parts it holds are plain content, not reasoning.
      convertChunksSetting(
        heldParts({ text: 'Let me read that file. ' }),
        finish,
      );

      const gen = await streamFrom(streamOf(chunkOf({ content: ' ' })));

      expect((await gen.next()).value?.candidates?.[0]?.content?.parts).toEqual(
        [{ text: 'Let me read that file. ' }],
      );
      expect((await throwInto(gen)).value).toBe(finish);
    });

    it('keeps a parked tool call withheld when the held-parts flush delivered only thought', async () => {
      // The other end: thought-marked held parts do not count as delivered,
      // so the replay gate is open and withholding still buys its recovery;
      // setting the flag unconditionally would strand the call.
      convertChunksSetting(
        heldParts({ thought: true, text: 'reasoning' }),
        finishOf([fnCall('read_file')]),
      );

      const gen = await streamFrom(streamOf(chunkOf({ content: ' ' })));

      expect((await gen.next()).value?.candidates?.[0]?.content?.parts).toEqual(
        [{ thought: true, text: 'reasoning' }],
      );
      // Nothing user-visible was delivered: the finish stays parked and the
      // throw propagates.
      await expect(throwInto(gen)).rejects.toThrow(CONSUMER_THREW);
    });

    it('does not flush a parked tool-call finish into a cancelled turn', async () => {
      // R17-2. The flush synthesises a delivery on the error path, so it needs
      // the abort guard every other synthesis branch in this catch has (the
      // PROTOCOL_TAG_LEAK throw spells it
      // `request.config?.abortSignal?.aborted !== true`). Without it a user
      // cancellation hands LlmChat a parked functionCall it never showed, and
      // cancellation persistence writes a model[functionCall] turn (history
      // and JSONL) for a call never dispatched in a cancelled turn. Guarded on
      // the signal, not the error's identity: `isAbortError` is not imported
      // there and two branches of one catch must agree on "aborted".
      const abortController = new AbortController();
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      const mockStream = {
        async *[Symbol.asyncIterator]() {
          yield chunkOf({ content: 'Let me read that file. ' });
          yield chunkOf({}, 'tool_calls');
          // The usage tail never arrives: the user pressed Esc first.
          abortController.abort();
          throw abortError;
        },
      };
      const prose = responseOf([{ text: 'Let me read that file. ' }]);
      convertChunksTo(prose, finishOf([fnCall('read_file')]));

      const { items, error } = await settle(
        await streamFrom(mockStream, abortable(abortController.signal)),
      );

      // The prose the caller was shown survives; the parked call does not.
      expect(items).toEqual([prose]);
      expect(
        items.some((response) =>
          response.candidates?.some((candidate) =>
            candidate.content?.parts?.some((part) => part.functionCall),
          ),
        ),
      ).toBe(false);
      expect(error).toBe(abortError);
    });
  });

  describe('buildResponseFormat endpoint gate', () => {
    /** response_format for a JSON-mode request with `responseJsonSchema`. */
    const formatFor = (responseJsonSchema?: Record<string, unknown>) =>
      pipeline['buildResponseFormat']({
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
        config: {
          responseMimeType: 'application/json',
          ...(responseJsonSchema ? { responseJsonSchema } : {}),
        },
      }).response_format;

    it('omits response_format on custom OpenAI-compatible endpoints', () => {
      mockContentGeneratorConfig.baseUrl = 'https://api.custom-provider.com/v1';
      expect(formatFor()).toBeUndefined();
    });

    it('keeps json_object response_format on the official endpoint', () => {
      expect(formatFor()).toEqual({ type: 'json_object' });
    });

    it('falls back to json_object when required is partial', () => {
      const format = formatFor({
        type: 'object',
        properties: { ok: { type: 'boolean' }, note: { type: 'string' } },
        required: ['ok'],
      });
      expect(format).toEqual({ type: 'json_object' });
    });

    it('falls back to json_object when a property lacks a type', () => {
      const format = formatFor({
        type: 'object',
        properties: { ok: {} },
        required: ['ok'],
      });
      expect(format).toEqual({ type: 'json_object' });
    });
  });

  describe('buildRequest', () => {
    it('should build request with sampling parameters', async () => {
      const { messages } = await executeOk(
        userRequest('test-model', {
          temperature: 0.8,
          topP: 0.7,
          maxOutputTokens: 500,
        }),
      );

      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          messages,
          // Config values: request overrides are not applied for these two.
          temperature: 0.7,
          top_p: 0.9,
          // min(config 1000, request 500): the smaller wins so the window
          // clamp survives samplingParams passthrough.
          max_tokens: 500,
        }),
        expect.objectContaining({ signal: undefined }),
      );
    });

    it('should use config sampling parameters when request parameters are not provided', async () => {
      await executeOk();

      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.7,
          top_p: 0.9,
          max_tokens: 1000,
        }),
        expect.objectContaining({ signal: undefined }),
      );
    });

    it('should map JSON mode before provider enhancement', async () => {
      (mockProvider.buildRequest as Mock).mockImplementation(
        (req: OpenAI.Chat.ChatCompletionCreateParams, promptId: string) => ({
          ...req,
          metadata: { promptId },
        }),
      );
      const { messages } = await executeOk(
        userRequest('test-model', { responseMimeType: 'application/json' }),
      );

      expect(mockProvider.buildRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
          messages,
          response_format: { type: 'json_object' },
        }),
        'test-prompt-id',
        0,
      );
      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({ metadata: { promptId: 'test-prompt-id' } }),
        expect.objectContaining({ signal: undefined }),
      );
    });

    const verdictSchema = () => ({
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    });
    it.each(
      titled({
        'uses json_schema when a response schema is present': {
          config: { responseJsonSchema: verdictSchema() },
          schema: verdictSchema(),
        },
        'normalizes responseJsonSchema before strict OpenAI output': {
          config: {
            responseJsonSchema: {
              type: 'object',
              properties: { verdict: { type: 'string', minLength: 1 } },
              required: ['verdict'],
            },
          },
          schema: verdictSchema(),
        },
        'uses json_schema for compatible Gemini responseSchema configs': {
          config: {
            responseSchema: {
              type: 'OBJECT',
              properties: { ok: { type: 'BOOLEAN' } },
              required: ['ok'],
              additionalProperties: false,
            },
          },
          schema: {
            type: 'object',
            properties: { ok: { type: 'boolean' } },
            required: ['ok'],
            additionalProperties: false,
          },
        },
      }),
    )('%s', async (_title, { config, schema }) => {
      await executeOk(
        userRequest('test-model', {
          responseMimeType: 'application/json',
          ...config,
        } as GenerateContentParameters['config']),
      );

      expect(mockProvider.buildRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: {
            type: 'json_schema',
            json_schema: { name: 'response', schema, strict: true },
          },
        }),
        'test-prompt-id',
        0,
      );
    });

    const OPENAI_URL = 'https://api.openai.com/v1';

    /** Rebuilds the pipeline for `model` at `baseUrl` in session-123. */
    function sessionPipeline(baseUrl: string | undefined, model: string) {
      mockContentGeneratorConfig.baseUrl = baseUrl;
      mockContentGeneratorConfig.model = model;
      mockCliConfig = {
        getSessionId: vi.fn().mockReturnValue('session-123'),
      } as unknown as Config;
      mockConfig.cliConfig = mockCliConfig;
      pipeline = new ContentGenerationPipeline(mockConfig);
    }

    /**
     * Executes a GPT-5.6 request that opts into prompt-cache sharing on a
     * session pipeline at `baseUrl`, with a compression-shaped history
     * (stable prefix plus a directive); returns the SDK body.
     */
    async function executeSharing(baseUrl: string | undefined) {
      sessionPipeline(baseUrl, 'gpt-5.6');
      const { messages } = await executeOk(
        { ...userRequest('gpt-5.6'), promptCacheSharing: true },
        'prompt-id',
        [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'main request' },
          { role: 'assistant', content: 'main response' },
          { role: 'user', content: 'compression directive' },
        ],
      );
      return { sent: sentBody(), messages };
    }

    it('adds an official OpenAI session cache key to regular requests', async () => {
      sessionPipeline(OPENAI_URL, 'gpt-5.5');

      const { messages } = await executeOk(userRequest('gpt-5.5'), 'prompt-id');

      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt_cache_key: 'qwen-code:session-123',
          messages,
        }),
        expect.anything(),
      );
    });

    it('partitions official OpenAI cache keys for concurrent subagents', async () => {
      sessionPipeline(OPENAI_URL, 'gpt-5.6');

      await runWithAgentContext('Explore-a1b2c3d4', () =>
        executeOk(userRequest('gpt-5.6'), 'prompt-id'),
      );

      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt_cache_key: 'qwen-code:session-123:Explore-a1b2c3d4',
        }),
        expect.anything(),
      );
    });

    it('preserves the session cache key for forked agents', async () => {
      sessionPipeline(OPENAI_URL, 'gpt-5.6');

      await runInForkContext(() =>
        runWithAgentContext('fork-a1b2c3d4', () =>
          executeOk(userRequest('gpt-5.6'), 'prompt-id'),
        ),
      );

      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({ prompt_cache_key: 'qwen-code:session-123' }),
        expect.anything(),
      );
    });

    it('does not add explicit cache fields to regular GPT-5.6 requests', async () => {
      sessionPipeline(OPENAI_URL, 'gpt-5.6');
      const { messages } = await executeOk(
        userRequest('gpt-5.6'),
        'prompt-id',
        [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
          { role: 'user', content: 'Follow-up question' },
        ],
      );

      const sent = sentBody();
      expect(sent.prompt_cache_key).toBe('qwen-code:session-123');
      expect(sent.prompt_cache_options).toBeUndefined();
      expect(sent.messages).toEqual(messages);
    });

    it('does not add official OpenAI cache fields when cache control is disabled', async () => {
      mockContentGeneratorConfig.enableCacheControl = false;
      const { sent } = await executeSharing(OPENAI_URL);

      expect(sent['prompt_cache_key']).toBeUndefined();
      expect(sent['prompt_cache_options']).toBeUndefined();
    });

    it('does not add official OpenAI cache fields to third-party compatible endpoints', async () => {
      const { sent, messages } = await executeSharing(
        'https://api.deepseek.com/v1',
      );

      expect(sent.prompt_cache_key).toBeUndefined();
      expect(sent.prompt_cache_options).toBeUndefined();
      expect(sent.messages).toEqual(messages);
    });

    it('marks the stable official OpenAI prefix for GPT-5.6 compression', async () => {
      const { sent } = await executeSharing(OPENAI_URL);

      expect(sent.prompt_cache_key).toBe('qwen-code:session-123');
      expect(sent.prompt_cache_options).toEqual({ mode: 'explicit' });
      expect(sent.messages[1]?.content).toEqual([
        {
          type: 'text',
          text: 'main request',
          prompt_cache_breakpoint: { mode: 'explicit' },
        },
      ]);
      expect(sent.messages.at(-1)?.content).toBe('compression directive');
    });

    it('does not add official OpenAI cache fields when baseUrl is unset', async () => {
      const { sent } = await executeSharing(undefined);

      expect(sent.prompt_cache_key).toBeUndefined();
      expect(sent.prompt_cache_options).toBeUndefined();
      expect(sent.messages[1]?.content).toBe('main request');
    });

    /** Executes with `samplingParams` configured; returns the SDK body. */
    async function executeWithSampling(
      samplingParams: Record<string, unknown> | undefined,
      config: GenerateContentParameters['config'],
    ) {
      mockContentGeneratorConfig.samplingParams =
        samplingParams as ContentGeneratorConfig['samplingParams'];
      pipeline = new ContentGenerationPipeline(mockConfig);
      await executeOk(userRequest('test-model', config), 'prompt-id', []);
      return sentBody();
    }

    it('should pass arbitrary samplingParams keys through verbatim when the window has room (e.g. max_completion_tokens for GPT-5)', async () => {
      // samplingParams is the source of truth, so its untyped GPT-5 /
      // o-series keys all reach the wire; maxOutputTokens (32000) leaves room
      // above max_completion_tokens (4096), so nothing is clamped.
      const call = await executeWithSampling(
        {
          max_completion_tokens: 4096,
          reasoning_effort: 'medium',
          verbosity: 'low',
        },
        { maxOutputTokens: 32000 },
      );

      expect(call).toMatchObject({
        max_completion_tokens: 4096,
        reasoning_effort: 'medium',
        verbosity: 'low',
      });
      // No synthesized max_tokens: it would double-specify the budget, and
      // o-series rejects the pair.
      expect(call).not.toHaveProperty('max_tokens');
    });

    describe('wire output budget recorded for truncation corroboration', () => {
      // The converter may only attribute incomplete tool-call JSON to
      // max_tokens after checking it against the budget that actually went out
      // on the wire, and getWireOutputBudget has exactly one caller — nothing
      // downstream can recover the value if this capture regresses.
      // converter.test.ts pins the reading half; these pin the writing half.
      async function captureContext(request: GenerateContentParameters) {
        const seen: Array<{ maxOutputTokens?: number }> = [];
        (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([]);
        (mockConverter.convertOpenAIChunkToLlm as Mock).mockImplementation(
          (_chunk: unknown, ctx: { maxOutputTokens?: number }) => {
            seen.push(ctx);
            const response = new GenerateContentResponse();
            response.candidates = [
              {
                content: { parts: [{ text: 'hi' }], role: 'model' },
                finishReason: FinishReason.STOP,
              },
            ];
            return response;
          },
        );
        (mockClient.chat.completions.create as Mock).mockResolvedValue({
          async *[Symbol.asyncIterator]() {
            yield {
              id: 'chunk-1',
              choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }],
            } as OpenAI.Chat.ChatCompletionChunk;
          },
        });

        const generator = await pipeline.executeStream(request, 'prompt-id');
        const iterator = generator[Symbol.asyncIterator]();
        let step = await iterator.next();
        while (!step.done) {
          step = await iterator.next();
        }

        const sent = (mockClient.chat.completions.create as Mock).mock
          .calls[0][0] as Record<string, unknown>;
        expect(seen.length).toBeGreaterThan(0);
        return { ctx: seen[0], sent };
      }

      it('records a budget sent as max_tokens', async () => {
        mockContentGeneratorConfig.samplingParams = undefined;
        pipeline = new ContentGenerationPipeline(mockConfig);

        const { ctx, sent } = await captureContext({
          model: 'test-model',
          contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
          config: { maxOutputTokens: 8192 },
        });

        expect(sent['max_tokens']).toBe(8192);
        expect(ctx.maxOutputTokens).toBe(8192);
      });

      it.each(['max_completion_tokens', 'max_new_tokens'])(
        'records a budget that travels only under the provider key %s',
        async (key) => {
          // The shape this file already builds for GPT-5 / o-series: no
          // max_tokens is synthesized, so the whole corroboration depends on
          // the PROVIDER_OUTPUT_BUDGET_KEYS fallback in getWireOutputBudget.
          // maxOutputTokens (32000) leaves room above 4096, so nothing clamps.
          mockContentGeneratorConfig.samplingParams = {
            [key]: 4096,
          } as ContentGeneratorConfig['samplingParams'];
          pipeline = new ContentGenerationPipeline(mockConfig);

          const { ctx, sent } = await captureContext({
            model: 'test-model',
            contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
            config: { maxOutputTokens: 32000 },
          });

          expect(sent).not.toHaveProperty('max_tokens');
          expect(sent[key]).toBe(4096);
          expect(ctx.maxOutputTokens).toBe(4096);
        },
      );

      it('leaves the budget undefined when the request caps output by neither', async () => {
        // Undefined is the honest answer: the corroboration then stays
        // inconclusive and keeps the legacy inference rather than inventing a
        // ceiling to compare against.
        mockContentGeneratorConfig.samplingParams = {};
        pipeline = new ContentGenerationPipeline(mockConfig);

        const { ctx, sent } = await captureContext({
          model: 'test-model',
          contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        });

        expect(sent).not.toHaveProperty('max_tokens');
        expect(ctx.maxOutputTokens).toBeUndefined();
      });
    });

    describe('parked truncation override settlement', () => {
      // QwenLM/qwen-code#12970. The pipeline requests
      // stream_options.include_usage, and under that convention the chunk
      // carrying finish_reason reports no usage — the totals arrive on a later
      // `choices: []` chunk. handleChunkMerging parks the finish response
      // until then, which makes the merge the first point the rewrite can be
      // corroborated, and it happens before the yield, so a consumer never
      // observes the unsettled reason.
      function arrangeReferenceStream(opts: {
        trailingCompletionTokens?: number;
        /** Emit the repaired call in the parked finish response, as the real
         * converter does, so the settle path has parts to mark. */
        withRepairedToolCall?: boolean;
      }) {
        const argsChunk = {
          id: 'chunk-args',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_1',
                    type: 'function',
                    function: {
                      name: 'read_file',
                      arguments:
                        '{"file_path": "/tmp/ad01.yml", "limit": {"file_path": "/tmp/node01.yml", "limit": null}',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletionChunk;
        const finishChunk = {
          id: 'chunk-finish',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        } as unknown as OpenAI.Chat.ChatCompletionChunk;
        const completionTokens = opts.trailingCompletionTokens;
        const usageChunk = {
          id: 'chunk-usage',
          choices: [],
          usage: {
            prompt_tokens: 252811,
            completion_tokens: completionTokens,
            total_tokens: 252811 + (completionTokens ?? 0),
          },
        } as unknown as OpenAI.Chat.ChatCompletionChunk;

        const finishResponse = new GenerateContentResponse();
        finishResponse.candidates = [
          {
            content: {
              parts: opts.withRepairedToolCall
                ? [
                    {
                      functionCall: {
                        id: 'call_1',
                        name: 'read_file',
                        args: {
                          file_path: '/tmp/ad01.yml',
                          limit: { file_path: '/tmp/node01.yml', limit: null },
                        },
                      },
                    },
                  ]
                : [],
              role: 'model',
            },
            finishReason: FinishReason.MAX_TOKENS,
          },
        ];
        const trailingResponse = new GenerateContentResponse();
        trailingResponse.candidates = [];
        trailingResponse.usageMetadata = {
          promptTokenCount: 252811,
          candidatesTokenCount: completionTokens ?? 0,
          totalTokenCount: 252811 + (completionTokens ?? 0),
        };
        setGenAiUsageProvenance(trailingResponse.usageMetadata, {
          cachedInputTokensReported: false,
        });

        // The real converter emits nothing yieldable for a partial argument
        // bag, rewrites stop -> length on the incomplete JSON, and parks the
        // provider's own reason when that chunk carried no usable usage.
        // converter.test.ts pins the real implementation's side of this
        // contract; these cases pin the pipeline's.
        (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([]);
        (mockConverter.convertOpenAIChunkToLlm as Mock).mockImplementation(
          (
            chunk: unknown,
            ctx: {
              pendingTruncationOverride?: { finishReason: FinishReason };
            },
          ) => {
            if (chunk === finishChunk) {
              ctx.pendingTruncationOverride = {
                finishReason: FinishReason.STOP,
              };
              return finishResponse;
            }
            if (chunk === usageChunk) {
              return trailingResponse;
            }
            const empty = new GenerateContentResponse();
            empty.candidates = [];
            return empty;
          },
        );
        (mockClient.chat.completions.create as Mock).mockResolvedValue({
          async *[Symbol.asyncIterator]() {
            yield argsChunk;
            yield finishChunk;
            if (completionTokens !== undefined) {
              yield usageChunk;
            }
          },
        });
      }

      async function yieldedFinishReason() {
        mockContentGeneratorConfig.samplingParams = undefined;
        pipeline = new ContentGenerationPipeline(mockConfig);
        const generator = await pipeline.executeStream(
          {
            model: 'test-model',
            contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
            config: { maxOutputTokens: 8192 },
          },
          'prompt-id',
        );
        const first = await generator[Symbol.asyncIterator]().next();
        if (first.done) {
          throw new Error('Expected the merged finish response.');
        }
        return first.value;
      }

      it('downgrades the override once trailing usage disproves truncation', async () => {
        arrangeReferenceStream({ trailingCompletionTokens: 185 });

        const response = await yieldedFinishReason();

        // 185 against an 8192 budget is not a token-limit cut, so the fused
        // read_file bag from #12970 must reach the scheduler as a plain schema
        // validation failure instead of carrying the max_tokens note.
        expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
        expect(response.usageMetadata?.candidatesTokenCount).toBe(185);
      });

      // The settle path withdraws the diagnosis after the parts already exist,
      // so it has to carry the guard's key over itself — otherwise the delayed
      // disproof silently lets a repaired partial write_file execute.
      it('keeps the incomplete-arguments mark when the settle downgrades the override', async () => {
        arrangeReferenceStream({
          trailingCompletionTokens: 185,
          withRepairedToolCall: true,
        });

        const response = await yieldedFinishReason();

        expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
        const fnCall = response.candidates?.[0]?.content?.parts?.find(
          (part) => part.functionCall,
        )?.functionCall;
        expect(fnCall?.name).toBe('read_file');
        expect(toolCallArgumentsWereIncomplete(fnCall!)).toBe(true);
      });

      it('keeps the override when trailing usage corroborates truncation', async () => {
        arrangeReferenceStream({ trailingCompletionTokens: 8192 });

        const response = await yieldedFinishReason();

        // #4964 must not regress: the delayed totals can just as well confirm
        // the cut, and then the rewrite stands.
        expect(response.candidates?.[0]?.finishReason).toBe(
          FinishReason.MAX_TOKENS,
        );
        expect(response.usageMetadata?.candidatesTokenCount).toBe(8192);
      });

      it('keeps the override when no trailing usage chunk ever arrives', async () => {
        arrangeReferenceStream({});

        const response = await yieldedFinishReason();

        // Stage 2d releases the parked finish at end of stream. With no totals
        // the verdict stays inconclusive, so the conservative inference and
        // the #4964 recovery are preserved rather than cleared on a guess.
        expect(response.candidates?.[0]?.finishReason).toBe(
          FinishReason.MAX_TOKENS,
        );
        expect(response.usageMetadata).toBeUndefined();
      });
    });

    it('should clamp a provider output-budget key to the window without injecting max_tokens', async () => {
      // max_completion_tokens (200000) exceeds the window's room
      // (maxOutputTokens 50000): it is clamped in place so
      // `prompt + output ≤ window` holds, with NO max_tokens injected
      // (o-series rejects both keys together).
      const call = await executeWithSampling(
        { max_completion_tokens: 200000, reasoning_effort: 'high' },
        { maxOutputTokens: 50000 },
      );

      expect(call).toMatchObject({
        max_completion_tokens: 50000,
        reasoning_effort: 'high',
      });
      expect(call).not.toHaveProperty('max_tokens');
    });

    it('should clamp a provider output-budget key even when max_tokens is also set', async () => {
      // max_tokens resolves via reconcile (min with the request), but the
      // provider key must not escape unclamped through the spread: backends
      // honoring the larger key would exceed the window.
      const call = await executeWithSampling(
        { max_tokens: 50000, max_completion_tokens: 100000 },
        { maxOutputTokens: 40000 },
      );

      expect(call).toMatchObject({
        max_tokens: 40000,
        max_completion_tokens: 40000,
      });
    });

    it('should inject the window-clamped max_tokens when samplingParams omits it and carries no provider output-budget key', async () => {
      // With no output budget in samplingParams, the window clamp
      // (request.config.maxOutputTokens) still reaches the wire as max_tokens:
      // the same `prompt + max_tokens ≤ window` protection as everyone else,
      // matching the Anthropic path.
      const call = await executeWithSampling(
        { temperature: 0.7 },
        { maxOutputTokens: 777 },
      );

      expect(call).toMatchObject({ temperature: 0.7, max_tokens: 777 });
    });

    it('should preserve historical default behavior when samplingParams is absent', async () => {
      // Without samplingParams, request.config.maxOutputTokens still falls
      // through to max_tokens, as it always has.
      await executeWithSampling(undefined, {
        temperature: 0.5,
        topP: 0.6,
        maxOutputTokens: 2048,
      });

      expect(createMock()).toHaveBeenCalledWith(
        expect.objectContaining({
          temperature: 0.5,
          top_p: 0.6,
          max_tokens: 2048,
        }),
        expect.objectContaining({ signal: undefined }),
      );
    });
  });

  describe('createRequestContext', () => {
    it('should create context with correct properties for non-streaming request', async () => {
      await executeOk(userRequest(), 'test-prompt-id', []);
    });

    it('should create context with correct properties for streaming request', async () => {
      convertEveryChunkTo(responseOf([{ text: 'Hello' }]));

      await streamed(chunkOf({ content: 'Hello' }, 'stop'));
    });

    it('should collect all OpenAI chunks for logging even when Gemini responses are filtered', async () => {
      const finalResponse = responseOf(
        [fnCall('test_function', { param: 'value' }, 'call_123')],
        { finishReason: FinishReason.STOP, safetyRatings: [] },
      );
      convertChunksTo(
        // The partial tool-call chunks convert to empty responses.
        responseOf([], { safetyRatings: [] }),
        responseOf([], { safetyRatings: [] }),
        finalResponse,
      );

      const responses = await streamed(
        chunkOf({
          tool_calls: [
            {
              index: 0,
              id: 'call_123',
              type: 'function',
              function: { name: 'test_function', arguments: '{"par' },
            },
          ],
        }),
        chunkOf({
          tool_calls: [{ index: 0, function: { arguments: 'am": "value"}' } }],
        }),
        chunkOf({}, 'tool_calls'),
      );

      // Only the final response is yielded; the empty ones are filtered.
      expect(responses).toHaveLength(1);
      expect(responses[0]).toBe(finalResponse);
    });
  });

  describe('openaiRequestCaptureContext integration', () => {
    /** Runs `fn` under a request capture; resolves with what was captured. */
    async function captureDuring(fn: () => Promise<unknown>) {
      let captured: OpenAI.Chat.ChatCompletionCreateParams | undefined;
      await openaiRequestCaptureContext.run((built) => {
        captured = built;
      }, fn);
      return captured;
    }

    it('forwards the provider-enhanced request to the active capture', async () => {
      const { messages } = mockCompletion();
      // Mimics DashScope injecting extra_body and metadata.
      providerAdds({
        extra_body: { thinking: { type: 'enabled' } },
        metadata: { user_id: 'abc' },
      });

      const captured = await captureDuring(() =>
        pipeline.execute(userRequest(), 'p'),
      );

      expect(captured).toBeDefined();
      // The capture is the very object handed to the SDK.
      expect(createMock()).toHaveBeenCalledWith(captured, expect.anything());
      expect(captured).toEqual(
        expect.objectContaining({
          model: 'test-model',
          messages,
          extra_body: { thinking: { type: 'enabled' } },
          metadata: { user_id: 'abc' },
        }),
      );
    });

    it('captures the streaming request including stream/stream_options', async () => {
      convertEveryChunkTo(new GenerateContentResponse());
      providerAdds({ extra_body: { enable_thinking: true } });

      const captured = await captureDuring(async () => {
        await collect(await streamFrom(streamOf(), userRequest(), 'p'));
      });

      expect(captured).toBeDefined();
      expect(captured).toEqual(
        expect.objectContaining({
          stream: true,
          stream_options: { include_usage: true },
          extra_body: { enable_thinking: true },
        }),
      );
    });

    it('isolates concurrent captures', async () => {
      mockCompletion([]);
      let n = 0;
      (mockProvider.buildRequest as Mock).mockImplementation((req) => ({
        ...req,
        extra_body: { call_index: ++n },
      }));

      const runOne = () =>
        captureDuring(() => pipeline.execute(userRequest(), 'p'));
      const [a, b] = await Promise.all([runOne(), runOne()]);

      expect(a).toBeDefined();
      expect(b).toBeDefined();
      // Each capture got its own object: the outer AsyncLocalStorage stores
      // must not bleed across awaits.
      const extraOf = (captured: typeof a) =>
        (captured as unknown as { extra_body: { call_index: number } })
          .extra_body;
      expect(extraOf(a)).not.toEqual(extraOf(b));
    });
  });

  describe('stream inactivity timeout', () => {
    type ChunkResult = IteratorResult<OpenAI.Chat.ChatCompletionChunk>;
    const done = (): ChunkResult => ({ done: true, value: undefined as never });

    // A stream whose `next()` stays pending until the test calls `push()`,
    // `end()` or `error()`: a silent (stalled) stream under fake timers.
    function gatedStream() {
      let pending: {
        resolve: (r: ChunkResult) => void;
        reject: (err: unknown) => void;
      } | null = null;
      const buffered: OpenAI.Chat.ChatCompletionChunk[] = [];
      let ended = false;
      let failure: { error: unknown } | null = null;
      let returned = false;
      const release = () => {
        const waiter = pending;
        pending = null;
        return waiter;
      };
      return {
        push(chunk: OpenAI.Chat.ChatCompletionChunk) {
          if (pending) release()!.resolve({ done: false, value: chunk });
          else buffered.push(chunk);
        },
        error(error: unknown) {
          failure = { error };
          release()?.reject(error);
        },
        end() {
          ended = true;
          release()?.resolve(done());
        },
        wasReturned: () => returned,
        stream: {
          [Symbol.asyncIterator]: () => ({
            next(): Promise<ChunkResult> {
              if (buffered.length)
                return Promise.resolve({
                  done: false,
                  value: buffered.shift()!,
                });
              if (failure) return Promise.reject(failure.error);
              if (ended) return Promise.resolve(done());
              return new Promise((resolve, reject) => {
                pending = { resolve, reject };
              });
            },
            return(): Promise<ChunkResult> {
              returned = ended = true;
              release()?.resolve(done());
              return Promise.resolve(done());
            },
          }),
        },
      };
    }

    const chunk = (text: string) =>
      ({
        id: 'c',
        choices: [{ delta: { content: text } }],
      }) as OpenAI.Chat.ChatCompletionChunk;

    function streamingRequest(signal?: AbortSignal): GenerateContentParameters {
      return {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hi' }], role: 'user' }],
        ...(signal ? { config: { abortSignal: signal } } : {}),
      } as GenerateContentParameters;
    }

    function buildPipeline(
      streamIdleTimeoutMs?: number,
      streamMaxLifetimeMs?: number,
    ) {
      pipelineWith({
        ...(streamIdleTimeoutMs !== undefined ? { streamIdleTimeoutMs } : {}),
        ...(streamMaxLifetimeMs !== undefined ? { streamMaxLifetimeMs } : {}),
      });
      return pipeline;
    }

    beforeEach(() => {
      (mockConverter.convertLlmRequestToOpenAI as Mock).mockReturnValue([]);
      (mockConverter.convertOpenAIChunkToLlm as Mock).mockImplementation(() => {
        const r = new GenerateContentResponse();
        r.candidates = [{ content: { parts: [{ text: 'x' }], role: 'model' } }];
        return r;
      });
      // Ignore any ambient QWEN_STREAM_IDLE_TIMEOUT_MS /
      // QWEN_STREAM_MAX_LIFETIME_MS from the dev/CI shell so the default
      // cases are not silently overridden; env cases re-stub them.
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, undefined);
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, undefined);
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllEnvs();
    });

    /**
     * Serves a fresh gated stream and starts a request carrying `signal`
     * (none when null) on `buildPipeline`.
     */
    async function startGated(
      streamIdleTimeoutMs?: number,
      streamMaxLifetimeMs?: number,
      signal: AbortSignal | null = new AbortController().signal,
    ) {
      const gated = gatedStream();
      createMock().mockResolvedValue(gated.stream);
      const p = buildPipeline(streamIdleTimeoutMs, streamMaxLifetimeMs);
      const request = streamingRequest(signal ?? undefined);
      return { gated, gen: await p.executeStream(request, 'id') };
    }

    /**
     * Drains `gen` in the background. The flags record how it ended so far;
     * `done` resolves with the error it rejected with (undefined otherwise).
     */
    function drain(
      gen: AsyncIterable<GenerateContentResponse>,
      into: GenerateContentResponse[] = [],
    ) {
      const run = {
        settled: false,
        completed: false,
        rejected: false,
        error: undefined as unknown,
        done: Promise.resolve(undefined as unknown),
      };
      run.done = collect(gen, into).then(
        () => {
          run.settled = run.completed = true;
          return undefined;
        },
        (e: unknown) => {
          run.settled = run.rejected = true;
          run.error = e;
          return e;
        },
      );
      return run;
    }

    /** `startGated`, then drains the stream in the background. */
    async function drainGated(
      idleMs?: number,
      lifetimeMs?: number,
      signal?: AbortSignal | null,
    ) {
      const started = await startGated(idleMs, lifetimeMs, signal);
      return { ...started, run: drain(started.gen) };
    }

    /** Pushes `count` chunks, advancing fake time by `everyMs` after each. */
    async function drip(
      gated: ReturnType<typeof gatedStream>,
      count: number,
      everyMs = 500,
    ) {
      for (let i = 0; i < count; i++) {
        gated.push(chunk('x'));
        await vi.advanceTimersByTimeAsync(everyMs);
      }
    }

    /** `run` has not tripped `quietMs` from now, and has `thenMs` later. */
    async function expectTripsAfter(
      run: ReturnType<typeof drain>,
      quietMs: number,
      thenMs: number,
    ) {
      await vi.advanceTimersByTimeAsync(quietMs);
      expect(run.rejected).toBe(false);
      await vi.advanceTimersByTimeAsync(thenMs);
      await run.done;
      expect(run.rejected).toBe(true);
    }

    /** Awaits `run` and checks it ended on a `maxLifetimeMs` lifetime cap. */
    async function expectLifetimeCap(
      run: ReturnType<typeof drain>,
      maxLifetimeMs: number,
    ) {
      const error = await run.done;
      expect(error).toBeInstanceOf(StreamLifetimeExceededError);
      expect((error as StreamLifetimeExceededError).maxLifetimeMs).toBe(
        maxLifetimeMs,
      );
      return error as StreamLifetimeExceededError;
    }

    it('aborts and throws ETIMEDOUT when the stream is silent past the idle timeout', async () => {
      const { gated, run } = await drainGated(1000); // never push/end → silent
      await vi.advanceTimersByTimeAsync(1000);
      const err = await run.done;
      expect(err).toBeInstanceOf(StreamInactivityTimeoutError);
      expect((err as Error).message).toBe(
        'No stream activity for 1000ms after 0 chunks ' +
          '(stream lifetime: 1000ms). For provider-backed models, ' +
          'increase modelProviders[providerId][].generationConfig.streamIdleTimeoutMs; ' +
          'provider configuration takes precedence, so model.generationConfig is ' +
          'ignored for those models. For runtime models, increase ' +
          'model.generationConfig.streamIdleTimeoutMs. Built-in Qwen OAuth models ' +
          'cannot be overridden via settings. Use QWEN_STREAM_IDLE_TIMEOUT_MS ' +
          'for them or whenever no explicit value is active. ' +
          'Set the active value to 0 to disable it.',
      );
      expect(err).toMatchObject({ code: 'ETIMEDOUT' });
      expect((err as StreamInactivityTimeoutError).chunksReceived).toBe(0);
      expect((err as StreamInactivityTimeoutError).streamLifetimeMs).toBe(1000);
      expect(gated.wasReturned()).toBe(true);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('includes settings and environment override hints in timeout errors', async () => {
      const { run } = await drainGated(1000); // never push/end → silent
      await vi.advanceTimersByTimeAsync(1000);
      const err = await run.done;
      expect(err).toBeInstanceOf(StreamInactivityTimeoutError);
      const message = (err as Error).message;
      expect(message).toContain('No stream activity for 1000ms after 0 chunks');
      expect(message).toContain('model.generationConfig.streamIdleTimeoutMs');
      expect(message).toContain(
        'modelProviders[providerId][].generationConfig.streamIdleTimeoutMs',
      );
      expect(message).toContain('QWEN_STREAM_IDLE_TIMEOUT_MS');
    });

    it('uses the default stream idle timeout when no override is configured', async () => {
      const { gated, run } = await drainGated(undefined, undefined, null); // never push/end → silent
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      const err = await run.done;
      expect(err).toBeInstanceOf(StreamInactivityTimeoutError);
      expect(err).toMatchObject({
        code: 'ETIMEDOUT',
        idleMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        chunksReceived: 0,
        streamLifetimeMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
      });
      expect(gated.wasReturned()).toBe(true);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('swallows the orphaned SDK next() rejection after an idle timeout', async () => {
      const pendingSdkNext: { reject?: (err: unknown) => void } = {};
      createMock().mockResolvedValue({
        [Symbol.asyncIterator]: () => ({
          next: (): Promise<ChunkResult> =>
            new Promise((_res, rej) => {
              pendingSdkNext.reject = rej;
            }),
          return: (): Promise<ChunkResult> => Promise.resolve(done()),
        }),
      });
      const unhandled: unknown[] = [];
      const handler = (err: unknown) => unhandled.push(err);
      process.on('unhandledRejection', handler);

      try {
        const gen = await buildPipeline(1000).executeStream(
          streamingRequest(),
          'id',
        );
        const run = drain(gen);

        await vi.advanceTimersByTimeAsync(1000);
        expect(await run.done).toMatchObject({
          code: 'ETIMEDOUT',
          chunksReceived: 0,
        });

        const sdkAbort = new Error('aborted by SDK');
        sdkAbort.name = 'AbortError';
        expect(pendingSdkNext.reject).toBeDefined();
        pendingSdkNext.reject!(sdkAbort);
        pendingSdkNext.reject = undefined;
        await vi.advanceTimersByTimeAsync(0);
        await Promise.resolve();
        expect(unhandled).toHaveLength(0);
      } finally {
        process.off('unhandledRejection', handler);
      }
    });

    it('aborts the SDK signal on idle timeout without a parent abort signal', async () => {
      const { gated, gen } = await startGated(1000, undefined, null); // never push/end → silent
      const sdkSignal = createMock().mock.calls[0][1]?.signal as
        | AbortSignal
        | undefined;
      const run = drain(gen);
      expect(sdkSignal).toBeInstanceOf(AbortSignal);
      expect(sdkSignal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await run.done).toMatchObject({ code: 'ETIMEDOUT' });
      expect(sdkSignal?.aborted).toBe(true);
      expect(gated.wasReturned()).toBe(true);
    });

    it('delivers chunks then throws ETIMEDOUT when the stream stalls after some output', async () => {
      const { gated, gen } = await startGated(1000);
      gated.push(chunk('hello')); // one chunk, then silence
      const results: GenerateContentResponse[] = [];
      const run = drain(gen, results);
      await vi.advanceTimersByTimeAsync(1000);
      expect(await run.done).toMatchObject({
        code: 'ETIMEDOUT',
        chunksReceived: 1,
      });
      expect(results).toHaveLength(1);
      expect(gated.wasReturned()).toBe(true);
    });

    it('resets the timer on each chunk and completes a slow-but-active stream', async () => {
      const { gated, gen } = await startGated(1000);
      const results: GenerateContentResponse[] = [];
      const consume = collect(gen, results);
      // Chunks 800ms apart: 2400ms in total but never idle for a full second,
      // so the watchdog must not trip.
      await vi.advanceTimersByTimeAsync(800);
      gated.push(chunk('a'));
      await vi.advanceTimersByTimeAsync(800);
      gated.push(chunk('b'));
      await vi.advanceTimersByTimeAsync(800);
      gated.end();
      await consume;
      expect(results).toHaveLength(2);
      // Late advance after completion must not produce a delayed throw.
      await vi.advanceTimersByTimeAsync(5000);
    });

    it('closes the guarded SDK iterator when the consumer breaks early', async () => {
      const { gated, gen } = await startGated(1000, undefined, null);
      gated.push(chunk('hello'));
      const sdkSignal = createMock().mock.calls[0][1]?.signal;

      for await (const _ of gen) {
        break;
      }

      expect(gated.wasReturned()).toBe(true);
      expect(sdkSignal?.aborted).toBe(true);
    });

    it('propagates mid-stream errors without converting them to ETIMEDOUT', async () => {
      const { gated, gen } = await startGated(1000, undefined, null);
      const results: GenerateContentResponse[] = [];
      gated.push(chunk('hello'));
      const run = drain(gen, results);
      const networkError = new Error('network down');
      gated.error(networkError);
      expect(await run.done).toBe(networkError);
      expect(results).toHaveLength(1);
      expect(mockErrorHandler.handle).toHaveBeenCalledWith(
        networkError,
        expect.anything(),
        expect.anything(),
      );

      await vi.advanceTimersByTimeAsync(5000);
    });

    it('propagates a user AbortError (not ETIMEDOUT) when the parent signal is aborted', async () => {
      const ac = new AbortController();
      const { gated, gen } = await startGated(1000, undefined, ac.signal); // silent
      const run = drain(gen);
      ac.abort();
      await vi.advanceTimersByTimeAsync(1000);
      const err = (await run.done) as { name?: string; code?: string };
      expect(err.name).toBe('AbortError');
      expect(err.code).not.toBe('ETIMEDOUT');
      expect(gated.wasReturned()).toBe(true);
    });

    // Each case leaves the stream silent: no timeout may fire, however far
    // the fake clock runs; the stream is then ended so it does not leak.
    it.each(
      titled<{
        env?: Record<string, string>;
        idle?: number;
        lifetime?: number;
        advanceMs: number;
      }>({
        'is disabled when streamIdleTimeoutMs <= 0 (no timeout fires)': {
          idle: 0,
          advanceMs: 600000,
        },
        'disables the watchdog when QWEN_STREAM_IDLE_TIMEOUT_MS=0': {
          env: { [QWEN_STREAM_IDLE_TIMEOUT_MS_ENV]: '0' },
          advanceMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS + 60000, // well past the default
        },
        'disables the watchdog with a negative config value': {
          idle: -1, // negative → disabled (idleMs > 0 guard)
          advanceMs: DEFAULT_STREAM_IDLE_TIMEOUT_MS + 60000,
        },
        // Pins the both-guards-off OUTCOME (stream passes through untouched,
        // never aborted), not the mechanism: both the caller's
        // `idleMs > 0 || maxLifetimeMs > 0` skip and the in-function early
        // return provide it, so an always-wrap refactor of the CALLER is still
        // caught — and the stream does not die to `setTimeout(Infinity)`
        // clamping to ~1ms.
        'disables both guards when both are 0 — no wrap, no cap, no idle abort':
          {
            idle: 0,
            lifetime: 0,
            // Past the default idle window AND the default lifetime cap.
            advanceMs: DEFAULT_STREAM_MAX_LIFETIME_MS + 60000,
          },
        // The env twin: a `0` on either deployment knob must reach the guard,
        // not fall through to the default.
        'disables both guards when both env knobs are 0': {
          env: {
            [QWEN_STREAM_IDLE_TIMEOUT_MS_ENV]: '0',
            [QWEN_STREAM_MAX_LIFETIME_MS_ENV]: '0',
          },
          advanceMs: DEFAULT_STREAM_MAX_LIFETIME_MS + 60000,
        },
      }),
    )('%s', async (_title, { env = {}, idle, lifetime, advanceMs }) => {
      for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
      const { gated, run } = await drainGated(idle, lifetime);
      await vi.advanceTimersByTimeAsync(advanceMs);
      expect(run.settled).toBe(false);
      gated.end(); // unblock so the test doesn't leak a pending stream
      await run.done;
    });

    it('honors a custom streamIdleTimeoutMs value', async () => {
      const { gated, run } = await drainGated(5000); // silent
      await expectTripsAfter(run, 4000, 1000); // quiet before 5000ms, trips at it
      expect(gated.wasReturned()).toBe(true);
    });

    // Each case leaves the stream silent and checks the effective idle timeout:
    // not tripped one millisecond before it, tripped exactly at it.
    it.each(
      titled<{
        env?: string;
        config?: number;
        tripsAt: number;
      }>({
        'honors QWEN_STREAM_IDLE_TIMEOUT_MS when no explicit config is set': {
          env: '3000',
          tripsAt: 3000,
        },
        // Not tripping early proves a malformed value did not become 0/NaN;
        // tripping at the default proves no other value was used.
        'ignores a malformed QWEN_STREAM_IDLE_TIMEOUT_MS and falls back to the default':
          {
            env: 'not-a-number',
            tripsAt: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          },
        // A value above the JS timer ceiling must be rejected, not used: used
        // verbatim it would schedule the watchdog ~24.8 days out (and real
        // Node would compress it to 1ms), so tripping AT the default proves it
        // was rejected.
        'ignores an oversized QWEN_STREAM_IDLE_TIMEOUT_MS (beyond the timer ceiling)':
          {
            env: '9999999999',
            tripsAt: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          },
        // Number('0x10') === 16: a strict decimal check keeps a typo from
        // becoming a 16ms timeout.
        'rejects a non-decimal QWEN_STREAM_IDLE_TIMEOUT_MS (hex/scientific) and uses the default':
          {
            env: '0x10',
            tripsAt: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
          },
        // A config value above the timer ceiling would overflow setTimeout.
        'rejects an out-of-range config streamIdleTimeoutMs and falls back': {
          config: MAX_STREAM_GUARD_TIMEOUT_MS + 1,
          tripsAt: DEFAULT_STREAM_IDLE_TIMEOUT_MS,
        },
        // Oversized config is rejected; the env value (not the default) wins.
        'falls back from an invalid config to the env value (config→env cascade)':
          {
            env: '4000',
            config: MAX_STREAM_GUARD_TIMEOUT_MS + 1,
            tripsAt: 4000,
          },
      }),
    )('%s', async (_title, { env, config, tripsAt }) => {
      if (env !== undefined) vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, env);
      const { run } = await drainGated(config); // silent
      await expectTripsAfter(run, tripsAt - 1, 1);
    });

    it('lets an explicit streamIdleTimeoutMs config take precedence over the env', async () => {
      vi.stubEnv(QWEN_STREAM_IDLE_TIMEOUT_MS_ENV, '1000');
      const { run } = await drainGated(5000); // config 5000 wins over env 1000
      await expectTripsAfter(run, 1000, 4000);
    });

    it('accepts the exact MAX_STREAM_GUARD_TIMEOUT_MS boundary value', async () => {
      // The ceiling itself is valid: guards an off-by-one turning `<=` into `<`.
      const { gated, run } = await drainGated(MAX_STREAM_GUARD_TIMEOUT_MS);
      // Tripping at the default would mean the ceiling was rejected.
      await vi.advanceTimersByTimeAsync(DEFAULT_STREAM_IDLE_TIMEOUT_MS);
      expect(run.rejected).toBe(false);
      gated.end();
      await run.done;
    });

    it('caps the total stream lifetime even when chunks keep resetting the idle watchdog (issue #8597)', async () => {
      const { gated, run } = await drainGated(1000, 3000);
      // A chunk every 500ms keeps resetting the 1s idle watchdog — the CI hang
      // shape. The 3s lifetime cap does not reset.
      await drip(gated, 5);
      await vi.advanceTimersByTimeAsync(1000); // t=3500 — past the cap
      const error = await expectLifetimeCap(run, 3000);
      expect(error).toMatchObject({ code: 'ETIMEDOUT' });
      expect(error.chunksReceived).toBe(5);
      expect(error.message).toContain('QWEN_STREAM_MAX_LIFETIME_MS');
      expect(gated.wasReturned()).toBe(true);
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });

    it('does not interrupt a drip-fed stream that completes within the lifetime cap', async () => {
      const { gated, run } = await drainGated(1000, 3000, null);
      gated.push(chunk('a'));
      await vi.advanceTimersByTimeAsync(500);
      gated.push(chunk('b'));
      await vi.advanceTimersByTimeAsync(500);
      gated.end(); // completes at t=1000, well under the 3s cap
      await vi.advanceTimersByTimeAsync(0);
      await run.done;
      expect(run.error).toBeUndefined();
      expect(run.completed).toBe(true);
    });

    it('does not charge the cap for a wall-clock jump — the accounting is monotonic', async () => {
      // The guard accounts on `performance.now()`, not `Date.now()`: an NTP
      // step or laptop wake must not kill a healthy stream, nor a backward
      // step disable the cap. The jump lands while `it.next()` is pending, so
      // a wall-clock deadline charged it as upstream wait and threw.
      const { gated, run } = await drainGated(1000, 3000, null);
      await vi.advanceTimersByTimeAsync(500); // next() pending, t=500
      // The wall clock leaps 20 minutes while monotonic time does not.
      const dateNow = vi
        .spyOn(Date, 'now')
        .mockReturnValue(Date.now() + 1_200_000);
      gated.push(chunk('a')); // ends the wait 500ms in by the monotonic clock
      await vi.advanceTimersByTimeAsync(0);
      gated.push(chunk('b'));
      await vi.advanceTimersByTimeAsync(500);
      gated.end(); // completes at monotonic t=1000, well under the 3s cap
      await vi.advanceTimersByTimeAsync(0);
      await run.done;
      dateNow.mockRestore();
      expect(run.error).toBeUndefined();
      expect(run.completed).toBe(true);
    });

    it('honours QWEN_STREAM_MAX_LIFETIME_MS when no explicit config is set', async () => {
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, '4000');
      const { gated, run } = await drainGated(1000);
      await drip(gated, 7);
      await vi.advanceTimersByTimeAsync(1000); // t=4500 — past the 4s env cap
      await expectLifetimeCap(run, 4000);
    });

    it('lets an explicit streamMaxLifetimeMs config take precedence over the env', async () => {
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, '1000');
      const { gated, run } = await drainGated(500, 3000); // config 3s beats env 1s
      await drip(gated, 4, 400);
      expect(run.error).toBeUndefined(); // t=1600: past the env value, no trip
      await drip(gated, 4, 400); // t=3200: past the 3s config cap
      await expectLifetimeCap(run, 3000);
    });

    it('ignores a malformed QWEN_STREAM_MAX_LIFETIME_MS and falls back to the default', async () => {
      vi.stubEnv(QWEN_STREAM_MAX_LIFETIME_MS_ENV, 'not-a-number');
      const { gated, run } = await drainGated(1000); // idle never reached
      // Not tripping early proves the value did not become 0/disabled or fire
      // at once; tripping at the default proves no other value was used.
      const drips = Math.ceil(DEFAULT_STREAM_MAX_LIFETIME_MS / 500);
      await drip(gated, drips - 1);
      expect(run.error).toBeUndefined();
      await drip(gated, 1);
      await expectLifetimeCap(run, DEFAULT_STREAM_MAX_LIFETIME_MS);
    });

    it('uses the default lifetime cap when nothing overrides it', async () => {
      const { gated, run } = await drainGated(1000);
      // Drip every 500ms up to the default cap: the idle watchdog never
      // fires, the 15-minute lifetime cap does.
      await drip(gated, Math.ceil(DEFAULT_STREAM_MAX_LIFETIME_MS / 500));
      await expectLifetimeCap(run, DEFAULT_STREAM_MAX_LIFETIME_MS);
    });

    it('keeps the idle guard answering when the lifetime cap is disabled', async () => {
      // The guards are independent. (The disable itself is pinned by the
      // both-guards-0 cases: a silent stream would trip the 1s idle timer for
      // ANY lifetime value, so it cannot tell a working disable apart.)
      const { run } = await drainGated(1000, 0); // silent
      await vi.advanceTimersByTimeAsync(1000);
      expect(await run.done).toBeInstanceOf(StreamInactivityTimeoutError);
    });

    it('caps the lifetime even when the idle watchdog is disabled', async () => {
      // Deployments with QWEN_STREAM_IDLE_TIMEOUT_MS=0 rely on the cap as
      // their only guard, so it must still wrap the stream.
      const { gated, run } = await drainGated(0, 3000);
      await drip(gated, 5);
      await vi.advanceTimersByTimeAsync(1000); // t=3500 — past the 3s cap
      await expectLifetimeCap(run, 3000);
      expect(gated.wasReturned()).toBe(true);
    });

    it('does not cap a buffered, already-complete stream for a slow consumer — consumer time is not upstream wait', async () => {
      // The cap charges only time BLOCKED on `it.next()`, never consumer time
      // after a yield: all ten pre-buffered chunks arrive even with the clock
      // racing 2s per chunk past the 3s cap. (Charging the deadline at the
      // top of the loop cut this healthy stream at 2 chunks.)
      const { gated, gen } = await startGated(1000, 3000);
      for (let i = 0; i < 10; i++) gated.push(chunk('x')); // all pre-buffered
      gated.end();
      const received: GenerateContentResponse[] = [];
      let error: unknown;
      await (async () => {
        for await (const r of gen) {
          received.push(r);
          await vi.advanceTimersByTimeAsync(2000); // every next() a microtask
        }
      })().catch((e: unknown) => {
        error = e;
      });
      expect(error).toBeUndefined();
      expect(received).toHaveLength(10); // all delivered, none discarded
      expect(mockErrorHandler.handle).not.toHaveBeenCalled();
    });
  });
});

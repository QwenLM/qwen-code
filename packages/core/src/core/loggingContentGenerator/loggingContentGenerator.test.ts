/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Mock } from 'vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  GenerateContentParameters,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { GenerateContentResponse } from '@google/genai';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Config } from '../../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import { AuthType } from '../contentGenerator.js';
import { LoggingContentGenerator } from './index.js';
import { OpenAIContentConverter } from '../openaiContentGenerator/converter.js';
import { openaiRequestCaptureContext } from '../openaiContentGenerator/requestCaptureContext.js';
import {
  convertResponsesEventToGemini,
  ResponsesStreamState,
} from '../openaiResponsesContentGenerator/responses-converter.js';
import {
  logApiRequest,
  logApiResponse,
  logApiError,
} from '../../telemetry/loggers.js';
import { isTelemetrySdkInitialized } from '../../telemetry/index.js';
import { startLLMRequestSpanWithContext } from '../../telemetry/session-tracing.js';
import { OpenAILogger } from '../../utils/openaiLogger.js';
import type OpenAI from 'openai';
import { APIUserAbortError } from 'openai';
import { setGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';
import {
  collect,
  content,
  drain,
  fnCall,
  fnResponse,
  streamOf,
  userText,
} from '../../test-utils/model-fixtures.js';

const activeOtelContext = vi.hoisted(() => ({ current: 'root' }));
const loggingSpanRecords = vi.hoisted(
  (): Array<{
    name: string;
    attributes: Record<string, string | number | boolean>;
    statuses: Array<{ code: number; message?: string }>;
    ended: boolean;
    /** endLLMRequestSpan metadata, captured to assert what is forwarded. */
    endMetadata?: {
      success?: boolean;
      cancelled?: boolean;
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      cachedInputTokensReported?: boolean;
      cacheCreationInputTokens?: number;
      responseModel?: string;
      finishReasons?: string[];
      ttftMs?: number;
      requestSetupMs?: number;
      attempt?: number;
      retryTotalDelayMs?: number;
      durationMs?: number;
      error?: string;
    };
  }> => [],
);
const loggingSpanNamesWithSetStatusFailure = vi.hoisted(
  () => new Set<string>(),
);
const loggingSpanAttributeFailures = vi.hoisted(() => new Set<string>());
const loggingSpanAttributeSetAttempts = vi.hoisted((): string[] => []);
const startLLMRequestSpanWithContextMock = vi.hoisted(() => vi.fn());
const genAiExchangeState = vi.hoisted(
  (): {
    controllers: Array<{ finalize: ReturnType<typeof vi.fn> }>;
    finalizeResult: string[] | undefined;
  } => ({
    controllers: [],
    finalizeResult: undefined,
  }),
);

vi.mock('@opentelemetry/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opentelemetry/api')>();

  function runWithActive<T>(label: string, fn: () => T): T {
    const previous = activeOtelContext.current;
    activeOtelContext.current = label;
    try {
      const result = fn();
      if (result instanceof Promise) {
        return result.finally(() => {
          activeOtelContext.current = previous;
        }) as T;
      }
      activeOtelContext.current = previous;
      return result;
    } catch (error) {
      activeOtelContext.current = previous;
      throw error;
    }
  }

  return {
    ...actual,
    context: {
      ...actual.context,
      active: () => ({ label: activeOtelContext.current }),
      with<T>(ctx: unknown, fn: () => T): T {
        const label =
          typeof ctx === 'object' &&
          ctx !== null &&
          'label' in ctx &&
          typeof ctx.label === 'string'
            ? ctx.label
            : activeOtelContext.current;
        return runWithActive(label, fn);
      },
    },
    trace: {
      ...actual.trace,
      setSpan: (_ctx: unknown, span: unknown) => ({
        label:
          typeof span === 'object' &&
          span !== null &&
          '__spanName' in span &&
          typeof span.__spanName === 'string'
            ? span.__spanName
            : 'span',
        span,
      }),
      getSpan: (ctx: unknown) =>
        typeof ctx === 'object' && ctx !== null && 'span' in ctx
          ? ctx.span
          : undefined,
    },
  };
});

vi.mock('../../telemetry/tracer.js', () => ({
  API_CALL_FAILED_SPAN_STATUS_MESSAGE: 'API call failed',
  API_CALL_ABORTED_SPAN_STATUS_MESSAGE: 'API call aborted',
}));

vi.mock('../../telemetry/gen-ai-request.js', () => ({
  createGenAiExchange: vi.fn((parent: unknown) => {
    const controller = {
      finalize: vi.fn(() => genAiExchangeState.finalizeResult),
    };
    genAiExchangeState.controllers.push(controller);
    return { context: parent, controller };
  }),
}));

vi.mock('../../telemetry/session-tracing.js', () => ({
  startLLMRequestSpanWithContext: startLLMRequestSpanWithContextMock,
}));

vi.mock('../../telemetry/index.js', () => {
  const isTelemetrySdkInitialized = vi.fn(() => true);

  return {
    endLLMRequestSpan: vi.fn(
      (
        span: {
          __spanName: string;
          setStatus: (status: { code: number; message?: string }) => void;
          end: () => void;
        },
        metadata?: {
          success: boolean;
          cancelled?: boolean;
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
          cachedInputTokensReported?: boolean;
          cacheCreationInputTokens?: number;
          responseModel?: string;
          finishReasons?: string[];
          ttftMs?: number;
          requestSetupMs?: number;
          attempt?: number;
          retryTotalDelayMs?: number;
          durationMs?: number;
          error?: string;
        },
      ) => {
        // Capture metadata on the matching span record so tests can assert
        // token counts, durationMs, success, error are forwarded correctly.
        const record = loggingSpanRecords.find(
          (r) => r.name === span.__spanName && r.endMetadata === undefined,
        );
        if (record) {
          record.endMetadata = metadata;
        }
        try {
          if (metadata && !metadata.success && !metadata.cancelled) {
            span.setStatus({
              code: 2,
              message: metadata.error ?? 'unknown error',
            }); // ERROR
          }
          span.end();
        } catch {
          // Match production best-effort behavior.
          span.end();
        }
      },
    ),
    addSystemPromptAttributes: vi.fn(),
    addToolSchemaAttributes: vi.fn(),
    addModelOutputAttributes: vi.fn(),
    isTelemetrySdkInitialized,
    areSensitiveSpanAttributesEnabled: vi.fn(
      (config: Pick<Config, 'getTelemetryIncludeSensitiveSpanAttributes'>) =>
        isTelemetrySdkInitialized() &&
        config.getTelemetryIncludeSensitiveSpanAttributes(),
    ),
  };
});

vi.mock('../../telemetry/loggers.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../telemetry/loggers.js')>();
  return {
    ...actual,
    logApiRequest: vi.fn(),
    logApiResponse: vi.fn(),
    logApiError: vi.fn(),
  };
});

vi.mock('../../utils/openaiLogger.js', () => ({
  OpenAILogger: vi.fn().mockImplementation(() => ({
    logInteraction: vi.fn().mockResolvedValue(undefined),
  })),
}));

function createOwnedLlmSpan(
  model: string,
  promptId: string,
  options?: {
    operationName?: string;
    providerName?: string;
    outputType?: string;
    sessionId?: string;
    userId?: string;
  },
) {
  const name = 'qwen-code.llm_request';
  const record = {
    name,
    attributes: {
      model,
      prompt_id: promptId,
      ...(options?.operationName
        ? { 'gen_ai.operation.name': options.operationName }
        : {}),
      ...(options?.providerName
        ? { 'gen_ai.provider.name': options.providerName }
        : {}),
      ...(options?.outputType
        ? { 'gen_ai.output.type': options.outputType }
        : {}),
      ...(options?.sessionId ? { 'session.id': options.sessionId } : {}),
      ...(options?.userId ? { 'gen_ai.user.id': options.userId } : {}),
    } as Record<string, string | number | boolean>,
    statuses: [] as Array<{ code: number; message?: string }>,
    ended: false,
  };
  loggingSpanRecords.push(record);
  return {
    __spanName: name,
    setStatus(status: { code: number; message?: string }) {
      if (loggingSpanNamesWithSetStatusFailure.has(name)) {
        throw new Error('set-status-fail');
      }
      record.statuses.push(status);
    },
    setAttribute(key: string, value: string | number | boolean) {
      loggingSpanAttributeSetAttempts.push(key);
      if (loggingSpanAttributeFailures.has(key)) {
        throw new Error('set-attribute-fail');
      }
      record.attributes[key] = value;
    },
    setAttributes(attrs: Record<string, string | number | boolean>) {
      Object.assign(record.attributes, attrs);
    },
    end() {
      record.ended = true;
    },
    spanContext: () => ({
      traceId: 'a'.repeat(32),
      spanId: 'b'.repeat(16),
      traceFlags: 1,
    }),
  };
}

const realConvertLlmRequestToOpenAI =
  OpenAIContentConverter.convertLlmRequestToOpenAI;
const convertLlmRequestToOpenAISpy = vi
  .spyOn(OpenAIContentConverter, 'convertLlmRequestToOpenAI')
  .mockReturnValue([{ role: 'user', content: 'converted' }]);
const convertLlmToolsToOpenAISpy = vi
  .spyOn(OpenAIContentConverter, 'convertLlmToolsToOpenAI')
  .mockResolvedValue([{ type: 'function', function: { name: 'tool' } }]);
const convertLlmResponseToOpenAISpy = vi
  .spyOn(OpenAIContentConverter, 'convertLlmResponseToOpenAI')
  .mockReturnValue({
    id: 'openai-response',
    object: 'chat.completion',
    created: 123456789,
    model: 'test-model',
    choices: [],
  } as OpenAI.Chat.ChatCompletion);

const createConfig = (overrides: Record<string, unknown> = {}): Config => {
  const configContent: Record<string, unknown> = {
    authType: 'openai',
    enableOpenAILogging: false,
    ...overrides,
  };
  return {
    getContentGeneratorConfig: () => configContent,
    getAuthType: () => configContent['authType'] as AuthType | undefined,
    getWorkingDir: () => process.cwd(),
    getTelemetryIncludeSensitiveSpanAttributes: () =>
      Boolean(configContent['includeSensitiveSpanAttributes']),
    getTelemetryLogPromptsEnabled: () =>
      Boolean(configContent['logPrompts'] ?? true),
    getTelemetrySensitiveSpanAttributeMaxLength: () =>
      (configContent['sensitiveSpanAttributeMaxLength'] as number) ??
      1024 * 1024,
    getSessionId: () =>
      (configContent['sessionId'] as string | undefined) ?? 'test-session',
    getTelemetryUserId: () => configContent['userId'] as string | undefined,
    getUserMemory: () => (configContent['userMemory'] as string) ?? '',
    getAutoMemoryPrompt: () =>
      (configContent['autoMemoryPrompt'] as string) ?? '',
    getAutoCompactThreshold: () =>
      configContent['autoCompactThreshold'] as number | undefined,
    getToolRegistry: () =>
      configContent['toolRegistry'] ?? { getTool: () => undefined },
    getSkillManager: () => configContent['skillManager'] ?? null,
  } as Config;
};

const createWrappedGenerator = (
  generateContent: ContentGenerator['generateContent'],
  generateContentStream: ContentGenerator['generateContentStream'],
): ContentGenerator =>
  ({
    generateContent,
    generateContentStream,
    embedContent: vi.fn(),
  }) as ContentGenerator;

const createResponse = (
  responseId: string,
  modelVersion: string,
  parts: Array<Record<string, unknown>>,
  usageMetadata?: GenerateContentResponseUsageMetadata,
  finishReason?: string,
): GenerateContentResponse => {
  const response = new GenerateContentResponse();
  response.responseId = responseId;
  response.modelVersion = modelVersion;
  response.usageMetadata = usageMetadata;
  response.candidates = [
    {
      content: {
        role: 'model',
        parts: parts as never[],
      },
      finishReason: finishReason as never,
      index: 0,
      safetyRatings: [],
    },
  ];
  return response;
};

const llmSpan = () => {
  const spanRecord = loggingSpanRecords.find(
    (record) => record.name === 'qwen-code.llm_request',
  );
  if (!spanRecord) {
    throw new Error('qwen-code.llm_request span was not created');
  }
  return spanRecord;
};

const MAX_RESPONSE_TEXT_LENGTH = 4096;
const RESPONSE_TEXT_TRUNCATION_SUFFIX = '...[truncated]';
const TTFC = 'gen_ai.response.time_to_first_chunk';
const FAILED_STATUS = [
  { code: SpanStatusCode.ERROR, message: 'API call failed' },
];
const CANCELLED = {
  success: false,
  cancelled: true,
  error: 'API call aborted',
};
const OPENAI_LOGS = { enableOpenAILogging: true, openAILoggingDir: 'logs' };

/** A response carrying one text part. */
const resp = (id: string, text = 'ok', model = 'test-model') =>
  createResponse(id, model, [{ text }]);

/** Usage metadata; the total defaults to prompt + candidates. */
const usage = (
  promptTokenCount: number,
  candidatesTokenCount: number,
  totalTokenCount = promptTokenCount + candidatesTokenCount,
  cachedContentTokenCount?: number,
): GenerateContentResponseUsageMetadata => ({
  promptTokenCount,
  candidatesTokenCount,
  ...(cachedContentTokenCount !== undefined ? { cachedContentTokenCount } : {}),
  totalTokenCount,
});

const resolving = (value: unknown) => vi.fn().mockResolvedValue(value);
const rejecting = (error: unknown) => vi.fn().mockRejectedValue(error);
const streams = (...chunks: GenerateContentResponse[]) =>
  resolving(streamOf(...chunks));
/** A wrapped stream call that yields `chunks`, then throws `error`. */
const failingStream = (error: unknown, ...chunks: GenerateContentResponse[]) =>
  resolving(
    (async function* () {
      yield* chunks;
      throw error;
    })(),
  );
const userAbort = () =>
  new APIUserAbortError({ message: 'Request was aborted.' });

/** `{ model, contents: 'Hello' }`, plus `config` when given. */
const helloRequest = (config?: Record<string, unknown>, model = 'test-model') =>
  ({
    model,
    contents: 'Hello',
    ...(config ? { config } : {}),
  }) as unknown as GenerateContentParameters;

/** A request whose contents are one user text turn. */
const textRequest = (
  text: string,
  model = 'test-model',
  config?: Record<string, unknown>,
) =>
  ({
    model,
    contents: [userText(text)],
    ...(config ? { config } : {}),
  }) as unknown as GenerateContentParameters;

/** A generator for test-model on OpenAI auth unless `overrides` say otherwise. */
const makeGenerator = (
  {
    generate = vi.fn(),
    stream = vi.fn(),
  }: {
    generate?: ContentGenerator['generateContent'];
    stream?: ContentGenerator['generateContentStream'];
  },
  overrides: Partial<ContentGeneratorConfig> = {},
  config = createConfig(),
) =>
  new LoggingContentGenerator(
    createWrappedGenerator(generate, stream),
    config,
    {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      ...overrides,
    },
  );

type RunOptions = {
  request?: GenerateContentParameters;
  overrides?: Partial<ContentGeneratorConfig>;
  config?: Config;
};

/** One non-stream call through a fresh generator wrapping `generate`. */
const runContent = (
  generate: ContentGenerator['generateContent'],
  promptId: string,
  { request = helloRequest(), overrides, config }: RunOptions = {},
) =>
  makeGenerator({ generate }, overrides, config).generateContent(
    request,
    promptId,
  );

/** Opens a stream through a fresh generator wrapping `stream`. */
const openStream = (
  stream: ContentGenerator['generateContentStream'],
  promptId: string,
  { request = helloRequest(), overrides, config }: RunOptions = {},
) =>
  makeGenerator({ stream }, overrides, config).generateContentStream(
    request,
    promptId,
  );

/** Opens a stream on `generator` and consumes it, returning what it yielded. */
const streamFrom = async (
  generator: LoggingContentGenerator,
  promptId: string,
  request = helloRequest(),
) => collect(await generator.generateContentStream(request, promptId));

/** `openStream`, then consumes the stream and returns what it yielded. */
const runStream = async (...args: Parameters<typeof openStream>) =>
  collect(await openStream(...args));

const spanOptions = (call = 0) =>
  vi.mocked(startLLMRequestSpanWithContext).mock.calls[call]?.[2];
const loggedRequest = () => vi.mocked(logApiRequest).mock.calls[0][1];
const loggedResponse = () => vi.mocked(logApiResponse).mock.calls[0][1];
const loggedError = () => vi.mocked(logApiError).mock.calls[0][1];
/** The OpenAILogger of the latest generator built with OpenAI logging on. */
const openaiLogger = () =>
  vi.mocked(OpenAILogger).mock.results.at(-1)?.value as {
    logInteraction: Mock;
  };
const loggedOpenAIRequest = () =>
  openaiLogger().logInteraction.mock
    .calls[0][0] as OpenAI.Chat.ChatCompletionCreateParams;
const lastFinalize = () => genAiExchangeState.controllers.at(-1)?.finalize;
const failOnce = (logger: unknown, message: string) =>
  (logger as Mock).mockImplementationOnce(() => {
    throw new Error(message);
  });

/** A promise plus the function that resolves it. */
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

/**
 * Captures the 5-min stream idle-timeout callback through a setTimeout spy so
 * a test can fire it by hand: fake timers interact poorly with
 * async-generator iteration.
 */
const captureIdleTimeout = () => {
  const realSetTimeout = global.setTimeout;
  const idle: { callback?: () => void } = {};
  const spy = vi.spyOn(global, 'setTimeout').mockImplementation(((
    ...args: Parameters<typeof setTimeout>
  ) => {
    const [cb, ms] = args;
    if (ms === 5 * 60_000) {
      idle.callback = cb as () => void;
      return { unref: () => {} } as unknown as ReturnType<typeof setTimeout>;
    }
    return realSetTimeout(...args);
  }) as typeof setTimeout);
  return Object.assign(idle, { restore: () => spy.mockRestore() });
};

describe('LoggingContentGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(isTelemetrySdkInitialized).mockReturnValue(true);
    vi.mocked(startLLMRequestSpanWithContext).mockImplementation(
      (model, promptId, options) => {
        const span = createOwnedLlmSpan(model, promptId, options);
        return {
          span: span as never,
          context: {
            label: span.__spanName,
            span,
            getValue: () => options?.sessionId,
          } as never,
        };
      },
    );
    activeOtelContext.current = 'root';
    loggingSpanRecords.length = 0;
    loggingSpanNamesWithSetStatusFailure.clear();
    loggingSpanAttributeFailures.clear();
    loggingSpanAttributeSetAttempts.length = 0;
    genAiExchangeState.controllers.length = 0;
    genAiExchangeState.finalizeResult = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    convertLlmRequestToOpenAISpy.mockClear();
    convertLlmToolsToOpenAISpy.mockClear();
    convertLlmResponseToOpenAISpy.mockClear();
  });

  it('passes the owning config identity to a standalone LLM span', async () => {
    await runContent(resolving(resp('resp-owner')), 'owner-prompt', {
      request: textRequest('hello'),
      config: createConfig({
        sessionId: 'owner-session',
        userId: 'owner-user',
      }),
    });

    expect(startLLMRequestSpanWithContext).toHaveBeenCalledWith(
      'test-model',
      'owner-prompt',
      expect.objectContaining({
        sessionId: 'owner-session',
        userId: 'owner-user',
      }),
    );
  });

  it('snapshots context usage before a non-stream request starts', async () => {
    await runContent(resolving(resp('resp-context')), 'context-prompt', {
      request: textRequest('hello', 'test-model', {
        systemInstruction: 'system',
      }),
      overrides: { contextWindowSize: 100_000 },
    });

    expect(spanOptions()?.contextUsage).toMatchObject({
      version: 1,
      window_size_tokens: 100_000,
      breakdown: { system_prompt_tokens: 2, messages_tokens: 2 },
      estimated: true,
    });
  });

  it('reads the live context window after a hot model switch', async () => {
    const generatorConfig = {
      model: 'test-model',
      authType: AuthType.QWEN_OAUTH,
      contextWindowSize: 1_000_000,
    };
    const generator = new LoggingContentGenerator(
      createWrappedGenerator(resolving(resp('resp-context')), vi.fn()),
      createConfig(),
      generatorConfig,
    );
    const request = textRequest('hello');

    await generator.generateContent(request, 'before-model-switch');
    generatorConfig.contextWindowSize = 262_144;
    await generator.generateContent(request, 'after-model-switch');

    expect(spanOptions(0)?.contextUsage?.window_size_tokens).toBe(1_000_000);
    expect(spanOptions(1)?.contextUsage?.window_size_tokens).toBe(262_144);
  });

  it('snapshots context usage before a stream is iterated', async () => {
    const stream = await openStream(
      streams(resp('resp-context')),
      'context-stream-prompt',
      {
        request: textRequest('hello'),
        overrides: { contextWindowSize: 100_000 },
      },
    );

    expect(spanOptions()?.contextUsage?.window_size_tokens).toBe(100_000);
    await drain(stream); // so span finalization runs
  });

  it('skips context snapshot work when telemetry is disabled', async () => {
    vi.mocked(isTelemetrySdkInitialized).mockReturnValue(false);
    await runContent(
      resolving(resp('resp-context')),
      'context-disabled-prompt',
      {
        request: textRequest('hello'),
      },
    );

    expect(spanOptions()?.contextUsage).toBeUndefined();
  });

  it('uses the final logical-parent session for API logs', async () => {
    vi.mocked(startLLMRequestSpanWithContext).mockImplementationOnce(
      (model, promptId, options) => {
        const span = createOwnedLlmSpan(model, promptId, {
          ...options,
          sessionId: 'parent-session',
        });
        return {
          span: span as never,
          context: {
            label: span.__spanName,
            span,
            getValue: () => 'parent-session',
          } as never,
        };
      },
    );
    await runContent(resolving(resp('resp-parent')), 'parent-prompt', {
      request: textRequest('hello'),
      config: createConfig({ sessionId: 'different-owner' }),
    });

    expect(logApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'parent-session',
    );
    expect(logApiResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'parent-session',
      undefined,
    );
  });

  it('snapshots the owning identity before stream iteration', async () => {
    const iterationContexts: string[] = [];
    const responseLogContexts: string[] = [];
    vi.mocked(logApiResponse).mockImplementationOnce(() => {
      responseLogContexts.push(activeOtelContext.current);
    });
    let activeSessionId = 'stream-session-B';
    const config = createConfig({ userId: 'stream-user' });
    vi.spyOn(config, 'getSessionId').mockImplementation(() => activeSessionId);

    const stream = await openStream(
      vi.fn().mockImplementation(async () =>
        (async function* () {
          iterationContexts.push(activeOtelContext.current);
          yield resp('resp-stream');
        })(),
      ),
      'stream-owner-prompt',
      { request: textRequest('hello'), config },
    );
    activeSessionId = 'stream-session-C';
    await drain(stream); // runs every logging and span finalization path

    expect(startLLMRequestSpanWithContext).toHaveBeenCalledWith(
      'test-model',
      'stream-owner-prompt',
      expect.objectContaining({
        sessionId: 'stream-session-B',
        userId: 'stream-user',
      }),
    );
    expect(iterationContexts).toEqual(['qwen-code.llm_request']);
    expect(responseLogContexts).toEqual(['qwen-code.llm_request']);
    expect(logApiRequest).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'stream-session-B',
    );
    expect(logApiResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'stream-session-B',
      undefined,
    );
    expect(activeOtelContext.current).toBe('root');
  });

  it('logs request/response, normalizes thought parts, and logs OpenAI interaction', async () => {
    const generator = makeGenerator(
      {
        generate: resolving(
          createResponse(
            'resp-1',
            'model-v2',
            [{ text: 'ok' }, { text: 'hidden thought', thought: true }],
            usage(3, 5),
            'STOP',
          ),
        ),
      },
      {
        enableOpenAILogging: true,
        openAILoggingDir: 'logs',
        schemaCompliance: 'openapi_30',
      },
      createConfig({ authType: AuthType.USE_ANTHROPIC }),
    );

    const request = {
      model: 'test-model',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Hello', thought: 'internal' },
            {
              functionCall: { id: 'call-1', name: 'tool', args: '{}' },
              thought: 'strip-me',
            },
            null,
          ],
        },
      ],
      config: {
        temperature: 0.3,
        topP: 0.9,
        maxOutputTokens: 256,
        presencePenalty: 0.2,
        frequencyPenalty: 0.1,
        tools: [
          {
            functionDeclarations: [
              { name: 'tool', description: 'desc', parameters: {} },
            ],
          },
        ],
      },
    } as unknown as GenerateContentParameters;

    const response = await generator.generateContent(request, 'prompt-1');

    expect(response.responseId).toBe('resp-1');
    expect(logApiRequest).toHaveBeenCalledTimes(1);
    const loggedContents = JSON.parse(loggedRequest().request_text || '[]');
    expect(loggedContents[0].parts[0]).toEqual({
      text: 'Hello\n[Thought: internal]',
    });
    expect(loggedContents[0].parts[1]).toEqual({
      functionCall: { id: 'call-1', name: 'tool', args: '{}' },
    });

    expect(logApiResponse).toHaveBeenCalledTimes(1);
    const responseEvent = loggedResponse();
    expect(responseEvent.response_id).toBe('resp-1');
    expect(responseEvent.model).toBe('model-v2');
    expect(llmSpan().attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
    });
    expect(llmSpan().endMetadata).toMatchObject({
      responseModel: 'model-v2',
      finishReasons: ['STOP'],
    });
    expect(responseEvent.prompt_id).toBe('prompt-1');
    expect(responseEvent.auth_type).toBe(AuthType.USE_OPENAI);
    expect(responseEvent.input_token_count).toBe(3);
    expect(responseEvent.response_text).toBe('ok');

    expect(convertLlmRequestToOpenAISpy).toHaveBeenCalledTimes(1);
    expect(convertLlmToolsToOpenAISpy).toHaveBeenCalledTimes(1);
    expect(convertLlmResponseToOpenAISpy).toHaveBeenCalledTimes(1);

    expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);
    const [openaiRequest, openaiResponse, openaiError] =
      openaiLogger().logInteraction.mock.calls[0];
    expect(openaiRequest).toEqual(
      expect.objectContaining({
        model: 'test-model',
        messages: [{ role: 'user', content: 'converted' }],
        tools: [{ type: 'function', function: { name: 'tool' } }],
        temperature: 0.3,
        top_p: 0.9,
        max_tokens: 256,
        presence_penalty: 0.2,
        frequency_penalty: 0.1,
      }),
    );
    expect(openaiResponse).toEqual({
      id: 'openai-response',
      object: 'chat.completion',
      created: 123456789,
      model: 'test-model',
      choices: [],
    });
    expect(openaiError).toBeUndefined();
  });

  /** Runs one call with `logPrompts` set; a stream is drained so response logging finalizes. */
  const runWithLogPrompts = async (stream: boolean, logPrompts: boolean) => {
    const marker = logPrompts ? 'KEEP' : 'SENSITIVE';
    const tag = `${stream ? 'stream-' : ''}${logPrompts ? '' : 'no'}prompts`;
    const response = resp(`resp-${tag}`, `${marker}_RESPONSE_MARKER`);
    const options = {
      request: textRequest(`${marker}_REQUEST_MARKER`),
      config: createConfig({ logPrompts }),
    };
    if (stream) await runStream(streams(response), `prompt-${tag}`, options);
    else await runContent(resolving(response), `prompt-${tag}`, options);
  };

  it.each([
    [
      'omits request_text and response_text from API telemetry when logPrompts is false',
      false,
    ],
    [
      'omits request_text and response_text from API telemetry for streaming when logPrompts is false',
      true,
    ],
  ] as const)('%s', async (_title, stream) => {
    await runWithLogPrompts(stream, false);

    expect(logApiRequest).toHaveBeenCalledTimes(1);
    expect(loggedRequest().request_text).toBeUndefined();
    expect(logApiResponse).toHaveBeenCalledTimes(1);
    expect(loggedResponse().response_text).toBeUndefined();
  });

  it.each([
    [
      'keeps request_text and response_text in API telemetry when logPrompts is true',
      false,
      'toBe',
    ],
    [
      'keeps request_text and response_text in API telemetry for streaming when logPrompts is true',
      true,
      'toContain',
    ],
  ] as const)('%s', async (_title, stream, responseMatcher) => {
    await runWithLogPrompts(stream, true);

    expect(loggedRequest().request_text).toContain('KEEP_REQUEST_MARKER');
    expect(loggedResponse().response_text)[responseMatcher](
      'KEEP_RESPONSE_MARKER',
    );
  });

  it('creates and closes the non-stream API span on success', async () => {
    await runContent(resolving(resp('resp-span')), 'prompt-span');

    const spanRecord = llmSpan();
    expect(spanRecord.attributes).toMatchObject({
      model: 'test-model',
      prompt_id: 'prompt-span',
    });
    expect(spanRecord.statuses).toEqual([]);
    expect(spanRecord.ended).toBe(true);
    expect(lastFinalize()).toHaveBeenCalledWith(true);
  });

  it('records cancellation when a non-stream provider resolves after swallowing an abort', async () => {
    const abortController = new AbortController();
    const response = resp('resp-cancelled', 'partial');
    await runContent(
      vi.fn().mockImplementation(async () => {
        abortController.abort();
        return response;
      }),
      'prompt-swallowed-abort',
      { request: helloRequest({ abortSignal: abortController.signal }) },
    );

    expect(llmSpan().endMetadata).toMatchObject(CANCELLED);
    expect(logApiResponse).not.toHaveBeenCalled();
    expect(lastFinalize()).toHaveBeenCalledWith(false);
  });

  it('does not let a non-stream abort after provider completion rewrite success', async () => {
    const abortController = new AbortController();
    vi.mocked(logApiResponse).mockImplementationOnce(() =>
      abortController.abort(),
    );
    await runContent(
      resolving(resp('resp-complete', 'done')),
      'prompt-complete-before-abort',
      { request: helloRequest({ abortSignal: abortController.signal }) },
    );

    expect(llmSpan().endMetadata).toMatchObject({
      success: true,
      cancelled: false,
    });
    expect(lastFinalize()).toHaveBeenCalledWith(true);
  });

  it('emits output type only for Gemini and Vertex wire configurations', async () => {
    const request = helloRequest(
      { responseMimeType: 'application/json' },
      'request-model',
    );
    const run = (authType: AuthType, promptId: string) =>
      runContent(resolving(resp('response', 'ok', 'actual-model')), promptId, {
        request,
        overrides: { model: 'request-model', authType },
      });

    await run(AuthType.USE_GEMINI, 'g');
    await run(AuthType.USE_VERTEX_AI, 'v');
    await run(AuthType.USE_OPENAI, 'o');

    expect(loggingSpanRecords[0]!.attributes).toMatchObject({
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'gcp.gemini',
      'gen_ai.output.type': 'json',
    });
    expect(loggingSpanRecords[1]!.attributes).toMatchObject({
      'gen_ai.operation.name': 'generate_content',
      'gen_ai.provider.name': 'gcp.vertex_ai',
      'gen_ai.output.type': 'json',
    });
    expect(
      loggingSpanRecords[2]!.attributes['gen_ai.output.type'],
    ).toBeUndefined();
  });

  it('orders non-stream finish reasons by candidate index', async () => {
    const response = createResponse(
      'response',
      'actual-model',
      [{ text: 'first' }],
      undefined,
      'MAX_TOKENS',
    );
    response.candidates = [
      { ...response.candidates![0]!, index: 1 },
      { ...response.candidates![0]!, index: 0, finishReason: 'STOP' as never },
    ];
    await runContent(resolving(response), 'prompt', {
      request: helloRequest(undefined, 'request-model'),
      overrides: { model: 'request-model' },
    });

    expect(llmSpan().endMetadata).toMatchObject({
      responseModel: 'actual-model',
      finishReasons: ['STOP', 'MAX_TOKENS'],
    });
  });

  it('omits standard stream attributes from non-stream LLM spans', async () => {
    await runContent(resolving(resp('resp')), 'prompt-stream-attr');

    const { attributes } = llmSpan();
    expect(attributes['gen_ai.request.stream']).toBeUndefined();
    expect(attributes['llm_request.stream']).toBeUndefined();
    expect(attributes[TTFC]).toBeUndefined();
  });

  it('marks streaming LLM spans with the standard stream attributes', async () => {
    await runStream(streams(resp('resp-1')), 'prompt-stream-attr');

    const { attributes } = llmSpan();
    expect(attributes['gen_ai.request.stream']).toBe(true);
    expect(attributes['llm_request.stream']).toBeUndefined();
    expect(attributes[TTFC]).toBeGreaterThanOrEqual(0);
  });

  it('forwards token counts and duration to endLLMRequestSpan on non-stream success', async () => {
    const usageMetadata = usage(42, 17, 59, 0);
    setGenAiUsageProvenance(usageMetadata, {
      cachedInputTokensReported: false,
    });
    await runContent(
      resolving(
        createResponse('resp', 'test-model', [{ text: 'ok' }], usageMetadata),
      ),
      'prompt-meta',
    );

    const { endMetadata } = llmSpan();
    expect(endMetadata).toMatchObject({
      success: true,
      inputTokens: 42,
      outputTokens: 17,
      cachedInputTokensReported: false,
    });
    expect(endMetadata!.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('forwards error metadata to endLLMRequestSpan on non-stream failure', async () => {
    genAiExchangeState.finalizeResult = ['raw-error'];
    await expect(
      runContent(rejecting(new Error('upstream-down')), 'prompt-err'),
    ).rejects.toThrow('upstream-down');

    expect(llmSpan().endMetadata).toMatchObject({
      success: false,
      error: 'API call failed',
      finishReasons: ['raw-error'],
    });
    expect(lastFinalize()).toHaveBeenCalledWith(false);
  });

  it('does not emit an api_error event when the user cancelled the request', async () => {
    // A user cancel surfaces as the SDK's APIUserAbortError with the caller's
    // signal aborted; the span already records it, so it must not also be a
    // qwen-code.api_error. Regression for #8356 at the layer the bug is about:
    // the util-level isAbortError fix alone does not gate this telemetry path.
    await expect(
      runContent(rejecting(userAbort()), 'prompt-cancel', {
        request: helloRequest({ abortSignal: AbortSignal.abort() }),
      }),
    ).rejects.toBeInstanceOf(APIUserAbortError);

    expect(logApiError).not.toHaveBeenCalled();
    const spanRecord = llmSpan();
    expect(spanRecord.endMetadata).toMatchObject(CANCELLED);
    expect(spanRecord.statuses).toHaveLength(0);
  });

  // The gate is scoped to genuine user cancels, so each remaining cell of its
  // truth table must still report the failure.
  it.each([
    // A non-abort failure with no aborted signal at all.
    [
      'still emits an api_error event for a real failure that is not a cancel',
      new Error('upstream-down'),
      undefined,
      'toThrow',
      'upstream-down',
    ],
    // An abort-shaped error can come from the network rather than the user;
    // with the caller's signal never fired it is a genuine failure, so the
    // gate cannot key on the error shape alone.
    [
      'still emits an api_error event for an abort-shaped error the user did not cause',
      userAbort(),
      new AbortController().signal,
      'toBeInstanceOf',
      APIUserAbortError,
    ],
    // A genuine upstream failure landing just as the user cancels is still a
    // real error, so the gate cannot key on the aborted signal alone.
    [
      'still emits an api_error event for a real failure that races a cancel',
      new Error('rate limited'),
      AbortSignal.abort(),
      'toThrow',
      'rate limited',
    ],
    // No `config.abortSignal` at all: nobody could have cancelled, so an
    // abort-shaped rejection is a real failure. Pins against relaxing the
    // signal check to `?? true`.
    [
      'still emits an api_error event for an abort-shaped error when the request has no signal',
      userAbort(),
      undefined,
      'toBeInstanceOf',
      APIUserAbortError,
    ],
  ] as const)('%s', async (_title, error, abortSignal, matcher, expected) => {
    await expect(
      runContent(rejecting(error), 'prompt-api-error', {
        request: helloRequest(abortSignal && { abortSignal }),
      }),
    ).rejects[matcher](expected as never);

    expect(logApiError).toHaveBeenCalledTimes(1);
  });

  it('does not emit an api_error event when the user cancels during stream setup', async () => {
    // Cancelling before any chunk exists (Esc while the SDK request is still
    // being established) rejects stream *setup*, not the iterator: a call site
    // separate from the non-stream and mid-stream ones. The openai SDK only
    // swallows aborts in the stream iterator, not in the create call, so
    // APIUserAbortError genuinely arrives here. Dropping the signal argument
    // at this site would re-emit the #8356 noise.
    await expect(
      openStream(rejecting(userAbort()), 'prompt-stream-setup-cancel', {
        request: helloRequest({ abortSignal: AbortSignal.abort() }),
      }),
    ).rejects.toBeInstanceOf(APIUserAbortError);

    expect(logApiError).not.toHaveBeenCalled();
    const spanRecord = llmSpan();
    expect(spanRecord.endMetadata).toMatchObject(CANCELLED);
    expect(spanRecord.statuses).toHaveLength(0);
  });

  /** A stream that yields one chunk, then aborts the request and throws. */
  const openCancelledStream = (error: unknown, promptId: string) => {
    const controller = new AbortController();
    return openStream(
      resolving(
        (async function* () {
          yield resp('resp-1', 'partial');
          controller.abort();
          throw error;
        })(),
      ),
      promptId,
      { request: helloRequest({ abortSignal: controller.signal }) },
    );
  };

  it('does not emit an api_error event when the user cancels mid-stream', async () => {
    // The stream wrapper's catch is a third call site and needs its own
    // coverage. The pinned openai SDK swallows a mid-stream abort
    // (`core/streaming.mjs`: `if (isAbortError(e)) return;`), so an openai
    // stream cancel ends the iterator normally and never reaches this catch;
    // this case keeps the wrapper honest for a provider that does propagate
    // the SDK error. The shape that genuinely lands here is pinned below.
    const stream = await openCancelledStream(
      userAbort(),
      'prompt-stream-cancel',
    );

    await expect(drain(stream)).rejects.toBeInstanceOf(APIUserAbortError);
    expect(logApiError).not.toHaveBeenCalled();
  });

  it('does not emit an api_error event for a DOMException-shaped mid-stream cancel', async () => {
    // The real mid-stream cancel shape on the @google/genai path: its SSE
    // reader (`processStreamResponse`) has no abort special-case, so an abort
    // during a read rejects with the fetch DOMException named 'AbortError'.
    // Pins that the gate's `isAbortError` covers the AbortError-name branch
    // at the stream call site, not only the openai `APIUserAbortError`.
    const stream = await openCancelledStream(
      new DOMException('The operation was aborted.', 'AbortError'),
      'prompt-stream-cancel-dom',
    );

    await expect(drain(stream)).rejects.toMatchObject({ name: 'AbortError' });
    expect(logApiError).not.toHaveBeenCalled();
    expect(llmSpan().endMetadata).toMatchObject(CANCELLED);
    expect(logApiResponse).not.toHaveBeenCalled();
  });

  it('forwards usage attached to the final response after it was yielded', async () => {
    const response = resp('r1', 'a');
    await runStream(
      resolving(
        (async function* () {
          yield response;
          response.usageMetadata = usage(100, 50);
        })(),
      ),
      'prompt-tok',
    );

    expect(llmSpan().endMetadata).toMatchObject({
      success: true,
      inputTokens: 100,
      outputTokens: 50,
    });
    expect(lastFinalize()).toHaveBeenCalledWith(true);
  });

  it('retains late-attached usage when the stream subsequently fails', async () => {
    const response = resp('r1', 'a');
    const stream = await openStream(
      resolving(
        (async function* () {
          yield response;
          response.usageMetadata = usage(10, 5);
          throw new Error('late failure');
        })(),
      ),
      'prompt-late-usage-error',
    );

    await expect(drain(stream)).rejects.toThrow('late failure');
    expect(llmSpan().endMetadata).toMatchObject({
      success: false,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('separates standard first-chunk timing from user-visible TTFT', async () => {
    let wallClockMs = 0;
    let monotonicClockMs = 0;
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => wallClockMs);
    const performanceNowSpy = vi
      .spyOn(performance, 'now')
      .mockImplementation(() => monotonicClockMs);
    const streamFn = vi.fn().mockImplementation(async () => {
      wallClockMs = 40;
      monotonicClockMs = 40;
      return (async function* () {
        // The wall clock is deliberately driven apart from the monotonic
        // clock: time_to_first_chunk must come from performance.now()
        // (100ms -> 0.1s), so a mutant reading Date.now() (900ms -> 0.9s)
        // fails the toBeCloseTo(0.1) assertion below instead of passing.
        wallClockMs = 900;
        monotonicClockMs = 100;
        yield createResponse('r1', 'test-model', [], usage(10, 0));
        wallClockMs = 300;
        monotonicClockMs = 300;
        yield createResponse(
          'r2',
          'test-model',
          [{ text: 'hi' }],
          usage(10, 2),
        );
      })();
    });

    try {
      await runStream(streamFn, 'prompt-ttft');

      const spanRecord = llmSpan();
      expect(spanRecord.attributes[TTFC]).toBeCloseTo(0.1);
      expect(spanRecord.endMetadata?.ttftMs).toBe(300);
      expect(loggedResponse().ttft_ms).toBe(300);
    } finally {
      dateNowSpy.mockRestore();
      performanceNowSpy.mockRestore();
    }
  });

  it('forwards cachedInputTokens from usageMetadata to endLLMRequestSpan (Phase 4a)', async () => {
    await runStream(
      streams(
        createResponse(
          'r1',
          'test-model',
          [{ text: 'ok' }],
          usage(100, 20, 160, 40),
        ),
      ),
      'prompt-cache',
    );

    expect(llmSpan().endMetadata).toMatchObject({
      success: true,
      inputTokens: 100,
      cachedInputTokens: 40,
    });
  });

  it('leaves ttftMs undefined when stream yields no user-visible chunks (Phase 4a)', async () => {
    // Only usage-metadata chunks (no text/functionCall/etc): TTFT is only
    // meaningful when content arrives.
    await runStream(
      streams(createResponse('r1', 'test-model', [], usage(5, 0))),
      'prompt-no-content',
    );

    const spanRecord = llmSpan();
    expect(spanRecord.endMetadata!.ttftMs).toBeUndefined();
    expect(spanRecord.attributes[TTFC]).toBeGreaterThanOrEqual(0);
    expect(loggedResponse().ttft_ms).toBeUndefined();
  });

  it('omits first-chunk timing when a stream yields no chunks', async () => {
    await runStream(streams(), 'prompt-empty-stream');

    expect(llmSpan().attributes[TTFC]).toBeUndefined();
  });

  it('does not retry first-chunk telemetry after setAttribute fails', async () => {
    loggingSpanAttributeFailures.add(TTFC);
    const responses = [
      createResponse('r1', 'test-model', [], usage(5, 0)),
      resp('r2'),
    ];

    const seen = await runStream(
      streams(...responses),
      'prompt-first-chunk-attribute-failure',
    );

    expect(seen).toEqual(responses);
    expect(
      loggingSpanAttributeSetAttempts.filter((key) => key === TTFC),
    ).toHaveLength(1);
    expect(llmSpan().attributes[TTFC]).toBeUndefined();
  });

  it('forwards cachedInputTokens to endLLMRequestSpan on non-stream success (Phase 4a)', async () => {
    await runContent(
      resolving(
        createResponse(
          'resp-cache',
          'test-model',
          [{ text: 'ok' }],
          usage(100, 30, 190, 60),
        ),
      ),
      'prompt-cache-non-stream',
      { request: { model: 'test-model', contents: 'Hi' } },
    );

    expect(llmSpan().endMetadata).toMatchObject({
      success: true,
      inputTokens: 100,
      outputTokens: 30,
      cachedInputTokens: 60,
    });
  });

  it('preserves non-stream success when response and OpenAI logging fail', async () => {
    failOnce(logApiResponse, 'response-log-fail');
    const generator = makeGenerator(
      { generate: resolving(resp('resp-safe')) },
      { enableOpenAILogging: true },
    );
    openaiLogger().logInteraction.mockRejectedValueOnce(
      new Error('openai-log-fail'),
    );

    const response = await generator.generateContent(
      helloRequest(),
      'prompt-safe',
    );

    expect(response.responseId).toBe('resp-safe');
    expect(logApiResponse).toHaveBeenCalledTimes(1);
    expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);
    expect(llmSpan().statuses).toEqual([]);
  });

  it('truncates long response text in API response telemetry', async () => {
    const longText = 'x'.repeat(MAX_RESPONSE_TEXT_LENGTH + 100);
    await runContent(resolving(resp('resp-long', longText)), 'prompt-long');

    const responseText = loggedResponse().response_text;
    expect(responseText).toHaveLength(MAX_RESPONSE_TEXT_LENGTH);
    expect(responseText).toBe(
      `${longText.slice(
        0,
        MAX_RESPONSE_TEXT_LENGTH - RESPONSE_TEXT_TRUNCATION_SUFFIX.length,
      )}${RESPONSE_TEXT_TRUNCATION_SUFFIX}`,
    );
  });

  it.each([
    ['thought-only', [{ text: 'hidden thought', thought: true }]],
    [
      'functionCall-only',
      [{ functionCall: { id: 'call-1', name: 'tool', args: '{}' } }],
    ],
  ])('omits response_text for %s API responses', async (_name, parts) => {
    await runContent(
      resolving(createResponse('resp-empty', 'test-model', parts)),
      'prompt-empty',
    );

    expect(loggedResponse().response_text).toBeUndefined();
  });

  it('logs errors with status code and request id, then rethrows', async () => {
    const error = Object.assign(new Error('boom'), {
      status: 429,
      request_id: 'req-99',
      type: 'rate_limit',
    });
    await expect(
      runContent(rejecting(error), 'prompt-2', {
        overrides: { enableOpenAILogging: true },
      }),
    ).rejects.toThrow('boom');

    expect(logApiError).toHaveBeenCalledTimes(1);
    const errorEvent = loggedError();
    expect(errorEvent.response_id).toBe('req-99');
    expect(errorEvent.status_code).toBe(429);
    expect(errorEvent.error_type).toBe('rate_limit');
    expect(errorEvent.prompt_id).toBe('prompt-2');

    const [, , openaiError] = openaiLogger().logInteraction.mock.calls[0];
    expect(openaiError).toBeInstanceOf(Error);
    expect((openaiError as Error).message).toBe('boom');

    const spanRecord = llmSpan();
    expect(spanRecord.statuses).toEqual(FAILED_STATUS);
    expect(JSON.stringify(spanRecord.statuses)).not.toContain('boom');
    expect(spanRecord.ended).toBe(true);
  });

  it('sanitizes non-stream request logging errors in span status', async () => {
    const generateContent = vi.fn();
    failOnce(logApiRequest, 'request-log-secret');

    await expect(
      runContent(generateContent, 'prompt-log-prep', {
        overrides: { enableOpenAILogging: true },
      }),
    ).rejects.toThrow('request-log-secret');

    expect(generateContent).not.toHaveBeenCalled();
    expect(logApiError).toHaveBeenCalledTimes(1);
    const spanRecord = llmSpan();
    expect(spanRecord.statuses).toEqual(FAILED_STATUS);
    expect(JSON.stringify(spanRecord.statuses)).not.toContain(
      'request-log-secret',
    );
    expect(spanRecord.ended).toBe(true);
  });

  it('logs streaming responses and consolidates tool calls', async () => {
    const usage1 = {
      promptTokenCount: 1,
    } as GenerateContentResponseUsageMetadata;
    const usage2 = usage(2, 4);
    const response1 = createResponse(
      'resp-1',
      'model-stream',
      [
        { text: 'Hello' },
        { functionCall: { id: 'call-1', name: 'tool', args: '{}' } },
      ],
      usage1,
    );
    const response2 = createResponse(
      'resp-2',
      'model-stream',
      [
        { text: ' world' },
        { functionCall: { id: 'call-1', name: 'tool', args: '{"x":1}' } },
        { functionResponse: { name: 'tool', response: { output: 'ok' } } },
      ],
      undefined,
      'STOP',
    );
    const usageResponse = createResponse(
      'resp-usage',
      'model-stream',
      [],
      usage2,
    );

    const seen = await runStream(
      streams(response1, usageResponse, response2),
      'prompt-3',
      { overrides: { enableOpenAILogging: true } },
    );
    expect(seen).toHaveLength(3);

    expect(logApiResponse).toHaveBeenCalledTimes(1);
    const responseEvent = loggedResponse();
    expect(responseEvent.response_id).toBe('resp-1');
    expect(responseEvent.input_token_count).toBe(2);
    expect(responseEvent.response_text).toBe('Hello world');

    expect(convertLlmResponseToOpenAISpy).toHaveBeenCalledTimes(1);
    const [consolidatedResponse] = convertLlmResponseToOpenAISpy.mock.calls[0];
    const consolidatedParts =
      consolidatedResponse.candidates?.[0]?.content?.parts || [];
    expect(consolidatedParts).toEqual([
      { text: 'Hello' },
      { functionCall: { id: 'call-1', name: 'tool', args: '{"x":1}' } },
      { text: ' world' },
      { functionResponse: { name: 'tool', response: { output: 'ok' } } },
    ]);
    expect(consolidatedResponse.usageMetadata).toBe(usage2);
    expect(consolidatedResponse.responseId).toBe('resp-2');
    expect(consolidatedResponse.candidates?.[0]?.finishReason).toBe('STOP');

    const spanRecord = llmSpan();
    expect(spanRecord.statuses).toEqual([]);
    expect(spanRecord.ended).toBe(true);
    expect(lastFinalize()).toHaveBeenCalledWith(true);
  });

  it('does not retain every metadata-only streaming response for logging', async () => {
    const contentResponse = resp('resp-content', 'Hello', 'model-stream');
    const usageResponses = Array.from({ length: 1_000 }, (_, index) => {
      const response = new GenerateContentResponse();
      response.responseId = `resp-usage-${index}`;
      response.modelVersion = 'model-stream';
      response.candidates = [];
      response.usageMetadata = { totalTokenCount: index };
      return response;
    });
    const generator = makeGenerator({
      stream: streams(contentResponse, ...usageResponses),
    });
    const consolidateSpy = vi.spyOn(
      generator as unknown as {
        consolidateLlmResponsesForLogging: (
          responses: GenerateContentResponse[],
        ) => GenerateContentResponse | undefined;
      },
      'consolidateLlmResponsesForLogging',
    );

    await streamFrom(generator, 'prompt-metadata-only');

    expect(consolidateSpy).toHaveBeenCalledOnce();
    expect(consolidateSpy.mock.calls[0]?.[0]).toEqual([
      contentResponse,
      usageResponses.at(-1),
    ]);
  });

  it('preserves stream success when response and OpenAI logging fail', async () => {
    failOnce(logApiResponse, 'response-log-fail');
    const response = resp('resp-safe-stream', 'ok', 'model-stream');
    const generator = makeGenerator(
      { stream: streams(response) },
      { enableOpenAILogging: true },
    );
    openaiLogger().logInteraction.mockRejectedValueOnce(
      new Error('openai-log-fail'),
    );

    const seen = await streamFrom(generator, 'prompt-safe-stream');

    expect(seen).toEqual([response]);
    expect(logApiResponse).toHaveBeenCalledTimes(1);
    expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);
    expect(llmSpan().ended).toBe(true);
  });

  it('leaves stream success status unset', async () => {
    const response = resp('resp-status', 'ok', 'model-stream');

    const seen = await runStream(streams(response), 'prompt-status');

    expect(seen).toEqual([response]);
    const spanRecord = llmSpan();
    expect(spanRecord.statuses).toEqual([]);
    expect(spanRecord.ended).toBe(true);
  });

  it('activates the stream span while the wrapped generator creates the stream', async () => {
    const response = resp('resp-1', 'Hello', 'model-stream');
    let activeContextDuringWrappedCall = '';

    await runStream(
      vi.fn().mockImplementation(async () => {
        activeContextDuringWrappedCall = activeOtelContext.current;
        return streamOf(response);
      }),
      'prompt-3',
    );

    expect(activeContextDuringWrappedCall).toBe('qwen-code.llm_request');
  });

  it('logs stream setup errors before leaving the stream span context', async () => {
    let activeContextDuringApiError = '';
    let spanEndedDuringApiError = true;
    vi.mocked(logApiError).mockImplementationOnce(() => {
      activeContextDuringApiError = activeOtelContext.current;
      spanEndedDuringApiError = llmSpan().ended;
    });

    await expect(
      openStream(rejecting(new Error('setup-fail')), 'prompt-setup-error'),
    ).rejects.toThrow('setup-fail');

    expect(logApiError).toHaveBeenCalledTimes(1);
    expect(activeContextDuringApiError).toBe('qwen-code.llm_request');
    expect(spanEndedDuringApiError).toBe(false);

    const spanRecord = llmSpan();
    expect(spanRecord.attributes['gen_ai.request.stream']).toBe(true);
    expect(spanRecord.attributes['llm_request.stream']).toBeUndefined();
    expect(spanRecord.attributes[TTFC]).toBeUndefined();
    expect(spanRecord.statuses).toEqual(FAILED_STATUS);
    expect(JSON.stringify(spanRecord.statuses)).not.toContain('setup-fail');
    expect(spanRecord.ended).toBe(true);
  });

  it('logs stream errors and skips response logging', async () => {
    const response1 = createResponse(
      'resp-1',
      'model-stream',
      [{ text: 'partial' }],
      usage(12, 3),
    );
    const stream = await openStream(
      failingStream(new Error('stream-fail'), response1),
      'prompt-4',
      { overrides: { enableOpenAILogging: true } },
    );

    await expect(drain(stream)).rejects.toThrow('stream-fail');

    expect(logApiResponse).not.toHaveBeenCalled();
    expect(logApiError).toHaveBeenCalledTimes(1);
    expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);

    const spanRecord = llmSpan();
    expect(spanRecord.attributes[TTFC]).toBeGreaterThanOrEqual(0);
    expect(spanRecord.statuses).toEqual(FAILED_STATUS);
    expect(JSON.stringify(spanRecord.statuses)).not.toContain('stream-fail');
    expect(spanRecord.endMetadata).toMatchObject({
      responseModel: 'model-stream',
      inputTokens: 12,
      outputTokens: 3,
    });
    expect(spanRecord.ended).toBe(true);
  });

  it('reports nested Responses stream errors with provider details', async () => {
    const message =
      'Your requests to gpt-6-astra in eastus have exceeded rate limit.';
    const expectedMessage = `Responses API error: rate_limit_exceeded: ${message}`;
    const stream = await openStream(
      resolving(
        (async function* () {
          const chunk = convertResponsesEventToGemini(
            {
              event: 'error',
              data: {
                type: 'error',
                error: {
                  message,
                  type: 'too_many_requests',
                  code: 'rate_limit_exceeded',
                },
              },
            },
            'gpt-6-astra',
            new ResponsesStreamState(),
          );
          if (chunk) yield chunk;
        })(),
      ),
      'prompt-responses-error',
      {
        request: helloRequest(undefined, 'gpt-6-astra'),
        overrides: {
          model: 'gpt-6-astra',
          authType: AuthType.USE_OPENAI_RESPONSES,
          enableOpenAILogging: true,
        },
      },
    );

    await expect(drain(stream)).rejects.toThrow(expectedMessage);

    expect(logApiResponse).not.toHaveBeenCalled();
    expect(logApiError).toHaveBeenCalledTimes(1);
    expect(loggedError()).toMatchObject({
      error_message: expectedMessage,
      error_type: 'too_many_requests',
      status_code: 429,
      auth_type: AuthType.USE_OPENAI_RESPONSES,
    });
    const [, , openaiError] = openaiLogger().logInteraction.mock.calls[0];
    expect(openaiError).toMatchObject({
      message: expectedMessage,
      code: 'rate_limit_exceeded',
      type: 'too_many_requests',
      status: 429,
    });
    expect(llmSpan().endMetadata).toMatchObject({
      success: false,
      errorType: 'too_many_requests',
      errorStatusCode: 429,
    });
  });

  /** Options for a 'request-model' call whose request carries `signal`. */
  const requestModelWith = (abortSignal?: AbortSignal) => ({
    request: helloRequest(abortSignal && { abortSignal }, 'request-model'),
    overrides: { model: 'request-model' },
  });

  it('keeps a real partial-stream failure as an error when it races an abort', async () => {
    const abortController = new AbortController();
    const response = createResponse(
      'resp-abort',
      'model-stream',
      [{ text: 'partial' }],
      usage(9, 2),
      'STOP',
    );
    const stream = await openStream(
      resolving(
        (async function* () {
          yield response;
          abortController.abort();
          throw new Error('aborted upstream');
        })(),
      ),
      'prompt-abort',
      requestModelWith(abortController.signal),
    );

    await expect(drain(stream)).rejects.toThrow('aborted upstream');
    const spanRecord = llmSpan();
    expect(spanRecord.attributes[TTFC]).toBeGreaterThanOrEqual(0);
    expect(spanRecord.endMetadata).toMatchObject({
      success: false,
      cancelled: false,
      error: 'API call failed',
      responseModel: 'model-stream',
      inputTokens: 9,
      outputTokens: 2,
      finishReasons: ['STOP'],
    });
  });

  it('records cancellation when a provider ends normally after swallowing an abort', async () => {
    const abortController = new AbortController();
    const response = resp('resp-cancelled', 'partial', 'model-stream');

    await runStream(
      resolving(
        (async function* () {
          yield response;
          abortController.abort();
        })(),
      ),
      'prompt-swallowed-abort',
      requestModelWith(abortController.signal),
    );

    expect(llmSpan().endMetadata).toMatchObject(CANCELLED);
    expect(logApiResponse).not.toHaveBeenCalled();
  });

  it('does not let an abort after stream completion rewrite success', async () => {
    const abortController = new AbortController();
    const response = resp('resp-complete', 'done', 'model-stream');
    vi.mocked(logApiResponse).mockImplementationOnce(() =>
      abortController.abort(),
    );

    await runStream(
      streams(response),
      'prompt-late-abort',
      requestModelWith(abortController.signal),
    );

    expect(abortController.signal.aborted).toBe(true);
    expect(llmSpan().endMetadata).toMatchObject({
      success: true,
      cancelled: false,
    });
  });

  it('orders stream finish reasons by candidate index across chunks', async () => {
    const firstResponse = createResponse(
      'resp-multi',
      'model-stream',
      [{ text: 'partial' }],
      undefined,
      'SAFETY',
    );
    firstResponse.candidates = [
      { ...firstResponse.candidates![0]!, index: 2 },
      {
        ...firstResponse.candidates![0]!,
        index: 0,
        finishReason: 'STOP' as never,
      },
    ];
    const secondResponse = createResponse(
      'resp-multi',
      'model-stream',
      [{ text: 'done' }],
      undefined,
      'MAX_TOKENS',
    );
    secondResponse.candidates![0]!.index = 1;

    await runStream(
      streams(firstResponse, secondResponse),
      'prompt-multi-candidate',
      requestModelWith(),
    );

    expect(llmSpan().endMetadata).toMatchObject({
      responseModel: 'model-stream',
      finishReasons: ['STOP', 'MAX_TOKENS', 'SAFETY'],
    });
  });

  it('skips success api_response log when stream span is ended by idle timeout (#4212)', async () => {
    // The 5-min idle timeout would otherwise leave a contradictory pair of
    // signals during incident response: the span says "timed out / error"
    // while the api_response log says "success".
    const idle = captureIdleTimeout();
    const abortController = new AbortController();
    const removeAbortListener = vi.spyOn(
      abortController.signal,
      'removeEventListener',
    );

    try {
      // Created before the first yield so the test can release the stream
      // as soon as it reads the first chunk.
      const gate = deferred();
      const response1 = createResponse(
        'resp-idle',
        'model-stream',
        [{ text: 'partial' }],
        usage(15, 4),
        'MAX_TOKENS',
      );
      // OpenAI logging is on to verify the post-loop OpenAI interaction log
      // is also gated by spanEndedByTimeout: without it,
      // safelyLogOpenAIInteraction short-circuits unconditionally and the
      // skip behavior would go untested.
      const stream = await openStream(
        resolving(
          (async function* () {
            yield response1;
            // Meanwhile the idle timer fires and ends the span as failed.
            await gate.promise;
          })(),
        ),
        'prompt-idle-timeout',
        {
          request: helloRequest({ abortSignal: abortController.signal }),
          overrides: { enableOpenAILogging: true },
        },
      );
      const iterator = stream[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(idle.callback).toBeDefined();

      idle.callback?.(); // the span should end as timed-out
      expect(removeAbortListener).toHaveBeenCalledWith(
        'abort',
        expect.any(Function),
      );

      const spanRecord = llmSpan();
      expect(spanRecord.attributes['stream.timed_out']).toBe(true);
      expect(spanRecord.attributes[TTFC]).toBeGreaterThanOrEqual(0);
      expect(spanRecord.endMetadata?.success).toBe(false);
      expect(spanRecord.endMetadata?.error).toBe(
        'Stream span timed out (idle)',
      );
      expect(spanRecord.endMetadata).toMatchObject({
        responseModel: 'model-stream',
        inputTokens: 15,
        outputTokens: 4,
        finishReasons: ['MAX_TOKENS'],
      });
      expect(spanRecord.ended).toBe(true);
      expect(lastFinalize()).toHaveBeenCalledWith(false);

      gate.resolve();
      const done = await iterator.next();
      expect(done.done).toBe(true);

      // Though the stream then completes cleanly, no success-flavored
      // api_response or OpenAI-interaction log may be emitted: the span's
      // timeout state is the canonical signal.
      expect(logApiResponse).not.toHaveBeenCalled();
      expect(openaiLogger().logInteraction).not.toHaveBeenCalled();
    } finally {
      idle.restore();
    }
  });

  it('skips api_error log when stream throws after idle timeout already closed the span (#4302)', async () => {
    // Same gating as the success path: once the idle timeout closed the span
    // as failed, a downstream throw must not emit an api_error log either,
    // or telemetry shows "span timed-out + log api_error", the contradictory
    // pair the timeout fix targets.
    const idle = captureIdleTimeout();

    try {
      const gate = deferred();
      const response1 = resp('resp-throw', 'partial', 'model-stream');
      const downstreamError = new Error('upstream-fail');
      const stream = await openStream(
        resolving(
          (async function* () {
            yield response1;
            await gate.promise;
            throw downstreamError;
          })(),
        ),
        'prompt-throw-after-timeout',
        { overrides: { enableOpenAILogging: true } },
      );
      const iterator = stream[Symbol.asyncIterator]();

      const first = await iterator.next();
      expect(first.done).toBe(false);
      expect(idle.callback).toBeDefined();

      idle.callback?.(); // the span is now closed as timed-out
      gate.resolve(); // let the stream throw
      await expect(iterator.next()).rejects.toThrow('upstream-fail');

      expect(llmSpan().endMetadata?.error).toBe('Stream span timed out (idle)');
      // Neither error-flavored telemetry path may fire: the span's timeout
      // state is the canonical signal.
      expect(logApiError).not.toHaveBeenCalled();
      expect(openaiLogger().logInteraction).not.toHaveBeenCalled();
    } finally {
      idle.restore();
    }
  });

  it('keeps an aborted hanging stream classified as cancelled when the idle timeout closes it', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const gate = deferred();
    const stream = await openStream(
      resolving(
        (async function* () {
          await gate.promise;
          yield resp('late', 'late');
        })(),
      ),
      'prompt-aborted-idle-timeout',
      { request: helloRequest({ abortSignal: abortController.signal }) },
    );
    const iterator = stream[Symbol.asyncIterator]();
    const pendingNext = iterator.next();

    abortController.abort();
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    gate.resolve();
    await pendingNext;
    await iterator.return(undefined);
    vi.useRealTimers();

    const record = llmSpan();
    expect(record.attributes['stream.timed_out']).toBe(true);
    expect(record.endMetadata).toMatchObject(CANCELLED);
    expect(record.statuses).toHaveLength(0);
  });

  it('keeps an observed provider error when abort races blocked error logging', async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();
    const errorLogGate = deferred();
    const generator = makeGenerator(
      { stream: failingStream(new Error('provider failed')) },
      { enableOpenAILogging: true },
    );
    openaiLogger().logInteraction.mockReturnValueOnce(errorLogGate.promise);

    const stream = await generator.generateContentStream(
      helloRequest({ abortSignal: abortController.signal }),
      'prompt-error-abort-timeout',
    );
    const pendingNext = stream.next();
    await vi.waitFor(() => expect(logApiError).toHaveBeenCalledTimes(1));

    abortController.abort();
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    const record = llmSpan();
    expect(record.attributes['stream.timed_out']).toBe(true);
    expect(record.endMetadata).toMatchObject({
      success: false,
      cancelled: false,
      error: 'API call failed',
    });
    expect(record.statuses).toEqual(FAILED_STATUS);

    errorLogGate.resolve();
    await expect(pendingNext).rejects.toThrow('provider failed');
    vi.useRealTimers();
  });

  it('preserves stream errors when error logging fails', async () => {
    failOnce(logApiError, 'api-log-fail');
    const generator = makeGenerator(
      {
        stream: failingStream(
          new Error('stream-fail'),
          resp('resp-1', 'partial', 'model-stream'),
        ),
      },
      { enableOpenAILogging: true },
    );
    openaiLogger().logInteraction.mockRejectedValueOnce(
      new Error('openai-log-fail'),
    );

    const stream = await generator.generateContentStream(
      helloRequest(),
      'prompt-4',
    );
    await expect(drain(stream)).rejects.toThrow('stream-fail');

    expect(logApiError).toHaveBeenCalledTimes(1);
    expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);
    const spanRecord = llmSpan();
    expect(spanRecord.statuses).toEqual(FAILED_STATUS);
    expect(spanRecord.ended).toBe(true);
  });

  it('preserves stream errors when the error status update fails', async () => {
    loggingSpanNamesWithSetStatusFailure.add('qwen-code.llm_request');
    const stream = await openStream(
      failingStream(
        new Error('stream-fail'),
        resp('resp-1', 'partial', 'model-stream'),
      ),
      'prompt-error-status',
    );

    await expect(drain(stream)).rejects.toThrow('stream-fail');

    expect(logApiError).toHaveBeenCalledTimes(1);
    const spanRecord = llmSpan();
    expect(spanRecord.statuses).toEqual([]);
    expect(spanRecord.ended).toBe(true);
  });

  it('ends the stream span when the consumer stops early', async () => {
    const stream = await openStream(
      streams(
        resp('resp-1', 'first', 'model-stream'),
        resp('resp-2', 'second', 'model-stream'),
      ),
      'prompt-4',
    );
    for await (const _item of stream) {
      break;
    }

    const spanRecord = llmSpan();
    expect(spanRecord.attributes[TTFC]).toBeGreaterThanOrEqual(0);
    expect(spanRecord.statuses).toEqual([]);
    expect(spanRecord.ended).toBe(true);
    expect(lastFinalize()).toHaveBeenCalledWith(false);
  });

  it('uses generator modalities when converting logged OpenAI requests', async () => {
    convertLlmRequestToOpenAISpy.mockImplementationOnce(
      (request, requestContext, options) =>
        realConvertLlmRequestToOpenAI(request, requestContext, options),
    );
    const request = {
      model: 'test-model',
      contents: [
        content(
          'user',
          { text: 'Inspect this' },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'img-data',
              displayName: 'diagram.png',
            },
          },
        ),
      ],
    } as unknown as GenerateContentParameters;

    await runContent(resolving(resp('resp-5')), 'prompt-5', {
      request,
      overrides: {
        enableOpenAILogging: true,
        modalities: { image: true },
        toolResultContentFormat: 'string',
      },
    });

    expect(convertLlmRequestToOpenAISpy).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        model: 'test-model',
        modalities: { image: true },
        toolResultContentFormat: 'string',
      }),
      { cleanOrphanToolCalls: false },
    );
    expect(loggedOpenAIRequest().messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this' },
          {
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,img-data' },
          },
        ],
      },
    ]);
  });

  it('uses string tool result content in reconstructed OpenAI logs when configured', async () => {
    convertLlmRequestToOpenAISpy.mockImplementationOnce(
      (request, requestContext, options) =>
        realConvertLlmRequestToOpenAI(request, requestContext, options),
    );

    await runContent(resolving(resp('resp-tool-log')), 'prompt-tool-log', {
      request: {
        model: 'test-model',
        contents: [
          content('model', fnCall('shell', {}, 'call_1')),
          content(
            'user',
            fnResponse('shell', { output: 'hello world' }, 'call_1'),
          ),
        ],
      },
      overrides: {
        enableOpenAILogging: true,
        toolResultContentFormat: 'string',
      },
    });

    const toolMessage = loggedOpenAIRequest().messages.find(
      (message) => message.role === 'tool',
    );
    expect(toolMessage?.content).toBe('hello world');
  });

  it('logs the captured wire request including provider-injected fields (generateContent)', async () => {
    const wireRequest = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      max_tokens: 1024,
      // Provider-injected fields the synthetic reconstruction would drop:
      reasoning_effort: 'max',
      extra_body: { thinking: { type: 'enabled' }, enable_thinking: true },
      metadata: { dashscope_user_id: 'abc' },
    } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

    await runContent(
      vi.fn().mockImplementation(async () => {
        openaiRequestCaptureContext.getStore()?.(wireRequest);
        return resp('resp-cap', 'ok', 'deepseek-v4-pro');
      }),
      'prompt-cap',
      {
        request: textRequest('hi', 'deepseek-v4-pro'),
        overrides: { model: 'deepseek-v4-pro', ...OPENAI_LOGS },
      },
    );

    expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);
    // The logger must observe the actual wire request, not a stripped reconstruction.
    expect(loggedOpenAIRequest()).toBe(wireRequest);
    expect(loggedOpenAIRequest()).toMatchObject({
      reasoning_effort: 'max',
      extra_body: { thinking: { type: 'enabled' }, enable_thinking: true },
      metadata: { dashscope_user_id: 'abc' },
    });
  });

  it('logs the captured wire request for streaming requests (generateContentStream)', async () => {
    const wireRequest = {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      extra_body: { thinking: { type: 'enabled' } },
    } as unknown as OpenAI.Chat.ChatCompletionCreateParams;
    const chunk = resp('resp-stream-cap', 'ok', 'glm-5.1');

    await runStream(
      vi.fn().mockImplementation(async () => {
        openaiRequestCaptureContext.getStore()?.(wireRequest);
        return streamOf(chunk);
      }),
      'prompt-stream-cap',
      {
        request: textRequest('hi', 'glm-5.1'),
        overrides: { model: 'glm-5.1', ...OPENAI_LOGS },
      },
    );

    expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);
    expect(loggedOpenAIRequest()).toBe(wireRequest);
    expect(loggedOpenAIRequest()).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      extra_body: { thinking: { type: 'enabled' } },
    });
  });

  it('falls back to synthetic request when the wrapped generator does not capture', async () => {
    await runContent(resolving(resp('resp-fallback')), 'prompt-fallback', {
      request: textRequest('hi', 'test-model', { temperature: 0.4 }),
      overrides: OPENAI_LOGS,
    });

    expect(loggedOpenAIRequest()).toEqual(
      expect.objectContaining({ model: 'test-model', temperature: 0.4 }),
    );
  });

  it('does not propagate logging-side throws (success and error paths)', async () => {
    const successResponse = resp('resp-safe');
    const successGen = makeGenerator(
      { generate: resolving(successResponse) },
      OPENAI_LOGS,
    );
    // No capture fires, so resolve() falls through to the synthetic builder.
    // Force the synthetic build to throw; the API result must still surface.
    convertLlmRequestToOpenAISpy.mockImplementationOnce(() => {
      throw new Error('synth-fail-success');
    });
    const request = textRequest('hi');

    await expect(
      successGen.generateContent(request, 'prompt-safe-success'),
    ).resolves.toBe(successResponse);

    const errorGen = makeGenerator(
      { generate: rejecting(new Error('api-boom')) },
      OPENAI_LOGS,
    );
    convertLlmRequestToOpenAISpy.mockImplementationOnce(() => {
      throw new Error('synth-fail-error');
    });

    await expect(
      errorGen.generateContent(request, 'prompt-safe-error'),
    ).rejects.toThrow('api-boom');
  });

  it('does not propagate logging-side throws on a successful stream', async () => {
    const generator = makeGenerator(
      {
        stream: streams(
          resp('resp-stream-safe-1', 'hello'),
          resp('resp-stream-safe-2', ' world'),
        ),
      },
      OPENAI_LOGS,
    );
    openaiLogger().logInteraction.mockRejectedValueOnce(
      new Error('log-fail-on-stream-success'),
    );

    const seen = await streamFrom(
      generator,
      'prompt-stream-safe-success',
      textRequest('hi'),
    );

    // All chunks must reach the consumer; the logger throw must not surface.
    expect(seen).toHaveLength(2);
    expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);
  });

  it('does not let logging-side throws replace the original stream error', async () => {
    const generator = makeGenerator(
      {
        stream: failingStream(
          new Error('stream-api-fail'),
          resp('resp-stream-err', 'partial'),
        ),
      },
      OPENAI_LOGS,
    );
    openaiLogger().logInteraction.mockRejectedValueOnce(
      new Error('log-fail-on-stream-error'),
    );

    const stream = await generator.generateContentStream(
      textRequest('hi'),
      'prompt-stream-safe-error',
    );

    await expect(drain(stream)).rejects.toThrow('stream-api-fail');
    expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);
  });

  it.each(
    (['generateContent', 'generateContentStream'] as const).flatMap((method) =>
      [
        'prompt_suggestion',
        'forked_query',
        'speculation',
        'side-query:session-title',
      ].map((promptId) => [promptId, method] as const),
    ),
  )(
    'skips logApiRequest but writes tagged OpenAI logging for internal promptId %s (%s)',
    async (promptId, method) => {
      const stream = method === 'generateContentStream';
      const response = {
        responseId: stream ? 'stream-resp' : 'internal-resp',
        modelVersion: 'test-model',
        candidates: [{ content: { parts: [{ text: 'suggestion' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      } as unknown as GenerateContentResponse;
      const gen = new LoggingContentGenerator(
        createWrappedGenerator(
          stream ? vi.fn() : resolving(response),
          stream ? streams(response) : vi.fn(),
        ),
        createConfig(),
        {
          model: 'test-model',
          enableOpenAILogging: true,
          openAILoggingDir: '/tmp/test-logs',
        },
      );
      const request = textRequest('test');

      if (stream) await streamFrom(gen, promptId, request);
      else await gen.generateContent(request, promptId);

      // logApiRequest should NOT be called for internal prompts
      expect(logApiRequest).not.toHaveBeenCalled();
      expect(spanOptions()?.contextUsage).toBeUndefined();
      // logApiResponse SHOULD be called (for /stats token tracking)
      expect(logApiResponse).toHaveBeenCalled();
      expect(loggedResponse().response_text).toBeUndefined();
      // OpenAI file logging is explicit diagnostic output, so internal prompts
      // are written with a tag instead of being dropped.
      expect(OpenAILogger).toHaveBeenCalled();
      expect(openaiLogger().logInteraction).toHaveBeenCalledTimes(1);
      const [openaiRequest, openaiResponse, openaiError, options] =
        openaiLogger().logInteraction.mock.calls[0];
      expect(openaiRequest).toEqual(
        expect.objectContaining({
          model: 'test-model',
          messages: [{ role: 'user', content: 'converted' }],
        }),
      );
      expect(openaiResponse).toEqual(
        expect.objectContaining({ id: 'openai-response' }),
      );
      expect(openaiError).toBeUndefined();
      expect(options).toBe(promptId);
    },
  );
});

// =========================================================================
// Phase 4b — retryContext ALS propagation into LoggingContentGenerator.
// Asserts the contract: when the LLM call runs inside a retryContext.run()
// frame, endLLMRequestSpan receives the frame's values. When no frame is
// present (warmup, side-query, direct call), `attempt` defaults to 1 and
// requestSetupMs/retryTotalDelayMs stay undefined.
// =========================================================================
describe('LoggingContentGenerator — Phase 4b retry context propagation', () => {
  beforeEach(() => {
    loggingSpanRecords.length = 0;
    vi.mocked(logApiRequest).mockClear();
    vi.mocked(logApiResponse).mockClear();
    vi.mocked(logApiError).mockClear();
  });

  const expectNoRetryFrame = () => {
    const meta = llmSpan().endMetadata!;
    expect(meta.attempt).toBe(1);
    expect(meta.requestSetupMs).toBeUndefined();
    expect(meta.retryTotalDelayMs).toBeUndefined();
  };

  it('non-stream: forwards retryContext.attempt/requestSetupMs/retryTotalDelayMs to endLLMRequestSpan', async () => {
    const { retryContext } = await import('../../utils/retryContext.js');
    const generator = makeGenerator({
      generate: resolving(
        createResponse('r-1', 'test-model', [{ text: 'ok' }], usage(10, 5)),
      ),
    });

    // Simulate being invoked from within `retryWithBackoff`'s ALS frame —
    // the LoggingContentGenerator must read these values and forward them.
    await retryContext.run(
      { attempt: 3, requestSetupMs: 1200, retryTotalDelayMs: 1000 },
      async () => {
        await generator.generateContent(helloRequest(), 'prompt-retry');
      },
    );

    expect(llmSpan().endMetadata).toMatchObject({
      success: true,
      attempt: 3,
      requestSetupMs: 1200,
      retryTotalDelayMs: 1000,
    });
  });

  it('non-stream: defaults attempt=1 and leaves setup/delay undefined when no retry context (direct call / warmup)', async () => {
    // No retryContext.run() — direct invocation.
    await runContent(
      resolving(
        createResponse('r-2', 'test-model', [{ text: 'ok' }], usage(10, 5)),
      ),
      'prompt-direct',
    );

    expectNoRetryFrame();
  });

  it('stream: snapshots retry context in synchronous prelude and forwards through stream wrapper finally block', async () => {
    const { retryContext } = await import('../../utils/retryContext.js');
    const generator = makeGenerator({
      stream: streams(
        resp('r-s1', 'a'),
        createResponse('r-s2', 'test-model', [{ text: 'b' }], usage(50, 20)),
      ),
    });

    // Critical: the stream wrapper is iterated AFTER retryContext.run resolves
    // its synchronous body. The closure-captured snapshot must carry values
    // through to the finally block's endLLMRequestSpan call.
    await retryContext.run(
      { attempt: 2, requestSetupMs: 500, retryTotalDelayMs: 400 },
      async () => {
        await streamFrom(generator, 'prompt-retry-stream');
      },
    );

    expect(llmSpan().endMetadata).toMatchObject({
      success: true,
      attempt: 2,
      requestSetupMs: 500,
      retryTotalDelayMs: 400,
      inputTokens: 50,
      outputTokens: 20,
    });
  });

  it('stream: defaults attempt=1 when iterated outside any retry frame', async () => {
    await runStream(streams(resp('r-s3', 'a')), 'prompt-stream-direct');

    expectNoRetryFrame();
  });

  it('stream idle-timeout path: retrySnapshot propagates to the setTimeout-fired endLLMRequestSpan (R2 #8)', async () => {
    // Review comment R2 #8: the idle-timeout `setTimeout` fires in a separate
    // macrotask; the closure-captured retrySnapshot must reach its
    // endLLMRequestSpan call. Fake timers must be on from the START so the
    // 5-min setTimeout inside loggingStreamWrapper uses the fake clock.
    vi.useFakeTimers();

    const { retryContext } = await import('../../utils/retryContext.js');

    // Holds the first .next() until released after the timers advance past
    // the idle timeout, without actually hanging the test runner.
    const streamBlocker = deferred();
    const generator = makeGenerator({
      stream: resolving(
        (async function* () {
          await streamBlocker.promise;
          yield resp('never', 'x');
        })(),
      ),
    });
    let iterator: AsyncGenerator<GenerateContentResponse> | undefined;
    let pendingNext:
      | Promise<IteratorResult<GenerateContentResponse>>
      | undefined;

    // generateContentStream captures the retrySnapshot inside the retry
    // frame. The first .next() enters the for-await, resets the idle timer
    // and blocks on streamBlocker, so the 5-min timeout is already scheduled.
    await retryContext.run(
      { attempt: 4, requestSetupMs: 3000, retryTotalDelayMs: 2500 },
      async () => {
        const stream = await generator.generateContentStream(
          helloRequest(),
          'prompt-idle-timeout',
        );
        iterator = stream[Symbol.asyncIterator]();
        pendingNext = iterator.next();
      },
    );

    // Advance past the 5-minute idle timeout (STREAM_IDLE_TIMEOUT_MS).
    await vi.advanceTimersByTimeAsync(6 * 60_000);

    streamBlocker.resolve(); // so the generator can clean up
    const lateChunk = await pendingNext;
    expect(lateChunk?.done).toBe(false);
    await iterator?.return(undefined);

    vi.useRealTimers();

    const timeoutRecord = loggingSpanRecords.find(
      (r) =>
        r.name === 'qwen-code.llm_request' &&
        r.endMetadata !== undefined &&
        r.endMetadata.error === 'Stream span timed out (idle)',
    );
    expect(timeoutRecord).toBeDefined();
    expect(timeoutRecord!.attributes[TTFC]).toBeUndefined();
    const meta = timeoutRecord!.endMetadata!;
    expect(meta.attempt).toBe(4);
    expect(meta.requestSetupMs).toBe(3000);
    expect(meta.retryTotalDelayMs).toBe(2500);
    expect(meta.error).toBe('Stream span timed out (idle)');
  });
});

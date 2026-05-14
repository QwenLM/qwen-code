/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  GenerateContentParameters,
  GenerateContentResponseUsageMetadata,
} from '@google/genai';
import { GenerateContentResponse } from '@google/genai';
import { SpanStatusCode } from '@opentelemetry/api';
import type { Config } from '../../config/config.js';
import type { ContentGenerator } from '../contentGenerator.js';
import { AuthType } from '../contentGenerator.js';
import { LoggingContentGenerator } from './index.js';
import { OpenAIContentConverter } from '../openaiContentGenerator/converter.js';
import { openaiRequestCaptureContext } from '../openaiContentGenerator/requestCaptureContext.js';
import {
  logApiRequest,
  logApiResponse,
  logApiError,
} from '../../telemetry/loggers.js';
import { OpenAILogger } from '../../utils/openaiLogger.js';
import type OpenAI from 'openai';

const activeOtelContext = vi.hoisted(() => ({ current: 'root' }));
const loggingSpanRecords = vi.hoisted(
  (): Array<{
    name: string;
    attributes: Record<string, string | number | boolean>;
    statuses: Array<{ code: number; message?: string }>;
    ended: boolean;
  }> => [],
);
const loggingSpanNamesWithSetStatusFailure = vi.hoisted(
  () => new Set<string>(),
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

vi.mock('../../telemetry/tracer.js', () => {
  function createSpan(
    name: string,
    attributes: Record<string, string | number | boolean>,
  ) {
    const record = {
      name,
      attributes,
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
      setAttribute: vi.fn(),
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
    API_CALL_FAILED_SPAN_STATUS_MESSAGE: 'API call failed',
    safeSetStatus: (
      span: { setStatus: (status: { code: number; message?: string }) => void },
      status: { code: number; message?: string },
    ) => {
      try {
        span.setStatus(status);
      } catch {
        // Match production best-effort telemetry behavior.
      }
    },
    withSpan: vi.fn(
      async (
        name: string,
        attributes: Record<string, string | number | boolean>,
        fn: (span: ReturnType<typeof createSpan>) => Promise<unknown>,
      ) => {
        const span = createSpan(name, attributes);
        let statusSet = false;
        const wrappedSpan = {
          ...span,
          setStatus(status: { code: number; message?: string }) {
            statusSet = true;
            return span.setStatus(status);
          },
        };
        try {
          const result = await fn(wrappedSpan);
          if (!statusSet) {
            span.setStatus({ code: 1 });
          }
          return result;
        } catch (error) {
          if (!statusSet) {
            span.setStatus({
              code: 2,
              message: error instanceof Error ? error.message : String(error),
            });
          }
          throw error;
        } finally {
          span.end();
        }
      },
    ),
    startSpanWithContext: vi.fn(
      (name: string, attributes: Record<string, string | number | boolean>) => {
        const span = createSpan(name, attributes);
        return {
          span,
          runInContext: <T>(fn: () => T): T => runWithActive(name, fn),
        };
      },
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

const realConvertGeminiRequestToOpenAI =
  OpenAIContentConverter.convertGeminiRequestToOpenAI;
const convertGeminiRequestToOpenAISpy = vi
  .spyOn(OpenAIContentConverter, 'convertGeminiRequestToOpenAI')
  .mockReturnValue([{ role: 'user', content: 'converted' }]);
const convertGeminiToolsToOpenAISpy = vi
  .spyOn(OpenAIContentConverter, 'convertGeminiToolsToOpenAI')
  .mockResolvedValue([{ type: 'function', function: { name: 'tool' } }]);
const convertGeminiResponseToOpenAISpy = vi
  .spyOn(OpenAIContentConverter, 'convertGeminiResponseToOpenAI')
  .mockReturnValue({
    id: 'openai-response',
    object: 'chat.completion',
    created: 123456789,
    model: 'test-model',
    choices: [],
  } as OpenAI.Chat.ChatCompletion);

const createConfig = (overrides: Record<string, unknown> = {}): Config => {
  const configContent = {
    authType: 'openai',
    enableOpenAILogging: false,
    ...overrides,
  };
  return {
    getContentGeneratorConfig: () => configContent,
    getAuthType: () => configContent.authType as AuthType | undefined,
    getWorkingDir: () => process.cwd(),
  } as Config;
};

const createWrappedGenerator = (
  generateContent: ContentGenerator['generateContent'],
  generateContentStream: ContentGenerator['generateContentStream'],
): ContentGenerator =>
  ({
    generateContent,
    generateContentStream,
    countTokens: vi.fn(),
    embedContent: vi.fn(),
    useSummarizedThinking: vi.fn().mockReturnValue(false),
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

const getStreamSpanRecord = () => {
  const spanRecord = loggingSpanRecords.find(
    (record) => record.name === 'api.generateContentStream',
  );
  if (!spanRecord) {
    throw new Error('api.generateContentStream span was not created');
  }
  return spanRecord;
};

const getGenerateContentSpanRecord = () => {
  const spanRecord = loggingSpanRecords.find(
    (record) => record.name === 'api.generateContent',
  );
  if (!spanRecord) {
    throw new Error('api.generateContent span was not created');
  }
  return spanRecord;
};

const MAX_RESPONSE_TEXT_LENGTH = 4096;
const RESPONSE_TEXT_TRUNCATION_SUFFIX = '...[truncated]';

describe('LoggingContentGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeOtelContext.current = 'root';
    loggingSpanRecords.length = 0;
    loggingSpanNamesWithSetStatusFailure.clear();
  });

  afterEach(() => {
    convertGeminiRequestToOpenAISpy.mockClear();
    convertGeminiToolsToOpenAISpy.mockClear();
    convertGeminiResponseToOpenAISpy.mockClear();
  });

  it('logs request/response, normalizes thought parts, and logs OpenAI interaction', async () => {
    const wrapped = createWrappedGenerator(
      vi.fn().mockResolvedValue(
        createResponse(
          'resp-1',
          'model-v2',
          [{ text: 'ok' }, { text: 'hidden thought', thought: true }],
          {
            promptTokenCount: 3,
            candidatesTokenCount: 5,
            totalTokenCount: 8,
          },
          'STOP',
        ),
      ),
      vi.fn(),
    );
    const generatorConfig = {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
      openAILoggingDir: 'logs',
      schemaCompliance: 'openapi_30' as const,
    };
    const generator = new LoggingContentGenerator(
      wrapped,
      createConfig(),
      generatorConfig,
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
    const [, requestEvent] = vi.mocked(logApiRequest).mock.calls[0];
    const loggedContents = JSON.parse(requestEvent.request_text || '[]');
    expect(loggedContents[0].parts[0]).toEqual({
      text: 'Hello\n[Thought: internal]',
    });
    expect(loggedContents[0].parts[1]).toEqual({
      functionCall: { id: 'call-1', name: 'tool', args: '{}' },
    });

    expect(logApiResponse).toHaveBeenCalledTimes(1);
    const [, responseEvent] = vi.mocked(logApiResponse).mock.calls[0];
    expect(responseEvent.response_id).toBe('resp-1');
    expect(responseEvent.model).toBe('model-v2');
    expect(responseEvent.prompt_id).toBe('prompt-1');
    expect(responseEvent.input_token_count).toBe(3);
    expect(responseEvent.response_text).toBe('ok');

    expect(convertGeminiRequestToOpenAISpy).toHaveBeenCalledTimes(1);
    expect(convertGeminiToolsToOpenAISpy).toHaveBeenCalledTimes(1);
    expect(convertGeminiResponseToOpenAISpy).toHaveBeenCalledTimes(1);

    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results[0]
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    expect(openaiLoggerInstance.logInteraction).toHaveBeenCalledTimes(1);
    const [openaiRequest, openaiResponse, openaiError] =
      openaiLoggerInstance.logInteraction.mock.calls[0];
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

  it('creates and closes the non-stream API span on success', async () => {
    const wrapped = createWrappedGenerator(
      vi
        .fn()
        .mockResolvedValue(
          createResponse('resp-span', 'test-model', [{ text: 'ok' }]),
        ),
      vi.fn(),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
    });

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    await generator.generateContent(request, 'prompt-span');

    const spanRecord = getGenerateContentSpanRecord();
    expect(spanRecord.attributes).toEqual({
      model: 'test-model',
      prompt_id: 'prompt-span',
    });
    expect(spanRecord.statuses).toEqual([{ code: SpanStatusCode.OK }]);
    expect(spanRecord.ended).toBe(true);
  });

  it('preserves non-stream success when response and OpenAI logging fail', async () => {
    vi.mocked(logApiResponse).mockImplementationOnce(() => {
      throw new Error('response-log-fail');
    });
    const wrapped = createWrappedGenerator(
      vi
        .fn()
        .mockResolvedValue(
          createResponse('resp-safe', 'test-model', [{ text: 'ok' }]),
        ),
      vi.fn(),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
    });
    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results.at(-1)
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    openaiLoggerInstance.logInteraction.mockRejectedValueOnce(
      new Error('openai-log-fail'),
    );

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    const response = await generator.generateContent(request, 'prompt-safe');

    expect(response.responseId).toBe('resp-safe');
    expect(logApiResponse).toHaveBeenCalledTimes(1);
    expect(openaiLoggerInstance.logInteraction).toHaveBeenCalledTimes(1);
    expect(getGenerateContentSpanRecord().statuses).toEqual([
      { code: SpanStatusCode.OK },
    ]);
  });

  it('truncates long response text in API response telemetry', async () => {
    const longText = 'x'.repeat(MAX_RESPONSE_TEXT_LENGTH + 100);
    const wrapped = createWrappedGenerator(
      vi
        .fn()
        .mockResolvedValue(
          createResponse('resp-long', 'test-model', [{ text: longText }]),
        ),
      vi.fn(),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
    });

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    await generator.generateContent(request, 'prompt-long');

    const [, responseEvent] = vi.mocked(logApiResponse).mock.calls[0];
    expect(responseEvent.response_text).toHaveLength(MAX_RESPONSE_TEXT_LENGTH);
    expect(responseEvent.response_text).toBe(
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
    const wrapped = createWrappedGenerator(
      vi
        .fn()
        .mockResolvedValue(createResponse('resp-empty', 'test-model', parts)),
      vi.fn(),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
    });

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    await generator.generateContent(request, 'prompt-empty');

    const [, responseEvent] = vi.mocked(logApiResponse).mock.calls[0];
    expect(responseEvent.response_text).toBeUndefined();
  });

  it('logs errors with status code and request id, then rethrows', async () => {
    const error = Object.assign(new Error('boom'), {
      status: 429,
      request_id: 'req-99',
      type: 'rate_limit',
    });
    const wrapped = createWrappedGenerator(
      vi.fn().mockRejectedValue(error),
      vi.fn(),
    );
    const generatorConfig = {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
    };
    const generator = new LoggingContentGenerator(
      wrapped,
      createConfig(),
      generatorConfig,
    );

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    await expect(
      generator.generateContent(request, 'prompt-2'),
    ).rejects.toThrow('boom');

    expect(logApiError).toHaveBeenCalledTimes(1);
    const [, errorEvent] = vi.mocked(logApiError).mock.calls[0];
    expect(errorEvent.response_id).toBe('req-99');
    expect(errorEvent.status_code).toBe(429);
    expect(errorEvent.error_type).toBe('rate_limit');
    expect(errorEvent.prompt_id).toBe('prompt-2');

    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results[0]
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    const [, , loggedError] = openaiLoggerInstance.logInteraction.mock.calls[0];
    expect(loggedError).toBeInstanceOf(Error);
    expect((loggedError as Error).message).toBe('boom');

    const spanRecord = getGenerateContentSpanRecord();
    expect(spanRecord.statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'API call failed' },
    ]);
    expect(JSON.stringify(spanRecord.statuses)).not.toContain('boom');
    expect(spanRecord.ended).toBe(true);
  });

  it('sanitizes non-stream request logging errors in span status', async () => {
    const generateContent = vi.fn();
    vi.mocked(logApiRequest).mockImplementationOnce(() => {
      throw new Error('request-log-secret');
    });
    const wrapped = createWrappedGenerator(generateContent, vi.fn());
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
    });

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    await expect(
      generator.generateContent(request, 'prompt-log-prep'),
    ).rejects.toThrow('request-log-secret');

    expect(generateContent).not.toHaveBeenCalled();
    expect(logApiError).toHaveBeenCalledTimes(1);
    const spanRecord = getGenerateContentSpanRecord();
    expect(spanRecord.statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'API call failed' },
    ]);
    expect(JSON.stringify(spanRecord.statuses)).not.toContain(
      'request-log-secret',
    );
    expect(spanRecord.ended).toBe(true);
  });

  it('logs streaming responses and consolidates tool calls', async () => {
    const usage1 = {
      promptTokenCount: 1,
    } as GenerateContentResponseUsageMetadata;
    const usage2 = {
      promptTokenCount: 2,
      candidatesTokenCount: 4,
      totalTokenCount: 6,
    } as GenerateContentResponseUsageMetadata;

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
      usage2,
      'STOP',
    );

    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockResolvedValue(
        (async function* () {
          yield response1;
          yield response2;
        })(),
      ),
    );
    const generatorConfig = {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
    };
    const generator = new LoggingContentGenerator(
      wrapped,
      createConfig(),
      generatorConfig,
    );

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(request, 'prompt-3');
    const seen: GenerateContentResponse[] = [];
    for await (const item of stream) {
      seen.push(item);
    }
    expect(seen).toHaveLength(2);

    expect(logApiResponse).toHaveBeenCalledTimes(1);
    const [, responseEvent] = vi.mocked(logApiResponse).mock.calls[0];
    expect(responseEvent.response_id).toBe('resp-1');
    expect(responseEvent.input_token_count).toBe(2);
    expect(responseEvent.response_text).toBe('Hello world');

    expect(convertGeminiResponseToOpenAISpy).toHaveBeenCalledTimes(1);
    const [consolidatedResponse] =
      convertGeminiResponseToOpenAISpy.mock.calls[0];
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

    const spanRecord = getStreamSpanRecord();
    expect(spanRecord.statuses).toEqual([{ code: SpanStatusCode.OK }]);
    expect(spanRecord.ended).toBe(true);
  });

  it('preserves stream success when response and OpenAI logging fail', async () => {
    vi.mocked(logApiResponse).mockImplementationOnce(() => {
      throw new Error('response-log-fail');
    });
    const response = createResponse('resp-safe-stream', 'model-stream', [
      { text: 'ok' },
    ]);
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockResolvedValue(
        (async function* () {
          yield response;
        })(),
      ),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
    });
    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results.at(-1)
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    openaiLoggerInstance.logInteraction.mockRejectedValueOnce(
      new Error('openai-log-fail'),
    );

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(
      request,
      'prompt-safe-stream',
    );
    const seen: GenerateContentResponse[] = [];
    for await (const item of stream) {
      seen.push(item);
    }

    expect(seen).toEqual([response]);
    expect(logApiResponse).toHaveBeenCalledTimes(1);
    expect(openaiLoggerInstance.logInteraction).toHaveBeenCalledTimes(1);
    expect(getStreamSpanRecord().ended).toBe(true);
  });

  it('preserves stream success when the OK status update fails', async () => {
    loggingSpanNamesWithSetStatusFailure.add('api.generateContentStream');
    const response = createResponse('resp-status', 'model-stream', [
      { text: 'ok' },
    ]);
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockResolvedValue(
        (async function* () {
          yield response;
        })(),
      ),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
    });

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(
      request,
      'prompt-status',
    );
    const seen: GenerateContentResponse[] = [];
    for await (const item of stream) {
      seen.push(item);
    }

    expect(seen).toEqual([response]);
    const spanRecord = getStreamSpanRecord();
    expect(spanRecord.statuses).toEqual([]);
    expect(spanRecord.ended).toBe(true);
  });

  it('activates the stream span while the wrapped generator creates the stream', async () => {
    const response = createResponse('resp-1', 'model-stream', [
      { text: 'Hello' },
    ]);
    let activeContextDuringWrappedCall = '';
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockImplementation(async () => {
        activeContextDuringWrappedCall = activeOtelContext.current;
        return (async function* () {
          yield response;
        })();
      }),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
    });

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(request, 'prompt-3');
    for await (const _item of stream) {
      // Consume stream to trigger cleanup.
    }

    expect(activeContextDuringWrappedCall).toBe('api.generateContentStream');
  });

  it('logs stream setup errors before leaving the stream span context', async () => {
    const setupError = new Error('setup-fail');
    let activeContextDuringApiError = '';
    let spanEndedDuringApiError = true;
    vi.mocked(logApiError).mockImplementationOnce(() => {
      activeContextDuringApiError = activeOtelContext.current;
      spanEndedDuringApiError = getStreamSpanRecord().ended;
    });
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockRejectedValue(setupError),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
    });

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    await expect(
      generator.generateContentStream(request, 'prompt-setup-error'),
    ).rejects.toThrow('setup-fail');

    expect(logApiError).toHaveBeenCalledTimes(1);
    expect(activeContextDuringApiError).toBe('api.generateContentStream');
    expect(spanEndedDuringApiError).toBe(false);

    const spanRecord = getStreamSpanRecord();
    expect(spanRecord.statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'API call failed' },
    ]);
    expect(JSON.stringify(spanRecord.statuses)).not.toContain('setup-fail');
    expect(spanRecord.ended).toBe(true);
  });

  it('logs stream errors and skips response logging', async () => {
    const response1 = createResponse('resp-1', 'model-stream', [
      { text: 'partial' },
    ]);
    const streamError = new Error('stream-fail');
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockResolvedValue(
        (async function* () {
          yield response1;
          throw streamError;
        })(),
      ),
    );
    const generatorConfig = {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
    };
    const generator = new LoggingContentGenerator(
      wrapped,
      createConfig(),
      generatorConfig,
    );

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(request, 'prompt-4');
    await expect(async () => {
      for await (const _item of stream) {
        // Consume stream to trigger error.
      }
    }).rejects.toThrow('stream-fail');

    expect(logApiResponse).not.toHaveBeenCalled();
    expect(logApiError).toHaveBeenCalledTimes(1);
    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results[0]
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    expect(openaiLoggerInstance.logInteraction).toHaveBeenCalledTimes(1);

    const spanRecord = getStreamSpanRecord();
    expect(spanRecord.statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'API call failed' },
    ]);
    expect(JSON.stringify(spanRecord.statuses)).not.toContain('stream-fail');
    expect(spanRecord.ended).toBe(true);
  });

  it('preserves stream errors when error logging fails', async () => {
    const response1 = createResponse('resp-1', 'model-stream', [
      { text: 'partial' },
    ]);
    const streamError = new Error('stream-fail');
    vi.mocked(logApiError).mockImplementationOnce(() => {
      throw new Error('api-log-fail');
    });
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockResolvedValue(
        (async function* () {
          yield response1;
          throw streamError;
        })(),
      ),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
    });
    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results.at(-1)
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    openaiLoggerInstance.logInteraction.mockRejectedValueOnce(
      new Error('openai-log-fail'),
    );

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(request, 'prompt-4');
    await expect(async () => {
      for await (const _item of stream) {
        // Consume stream to trigger error.
      }
    }).rejects.toThrow('stream-fail');

    expect(logApiError).toHaveBeenCalledTimes(1);
    expect(openaiLoggerInstance.logInteraction).toHaveBeenCalledTimes(1);

    const spanRecord = getStreamSpanRecord();
    expect(spanRecord.statuses).toEqual([
      { code: SpanStatusCode.ERROR, message: 'API call failed' },
    ]);
    expect(spanRecord.ended).toBe(true);
  });

  it('preserves stream errors when the error status update fails', async () => {
    loggingSpanNamesWithSetStatusFailure.add('api.generateContentStream');
    const response1 = createResponse('resp-1', 'model-stream', [
      { text: 'partial' },
    ]);
    const streamError = new Error('stream-fail');
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockResolvedValue(
        (async function* () {
          yield response1;
          throw streamError;
        })(),
      ),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
    });

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(
      request,
      'prompt-error-status',
    );
    await expect(async () => {
      for await (const _item of stream) {
        // Consume stream to trigger error.
      }
    }).rejects.toThrow('stream-fail');

    expect(logApiError).toHaveBeenCalledTimes(1);
    const spanRecord = getStreamSpanRecord();
    expect(spanRecord.statuses).toEqual([]);
    expect(spanRecord.ended).toBe(true);
  });

  it('ends the stream span when the consumer stops early', async () => {
    const response1 = createResponse('resp-1', 'model-stream', [
      { text: 'first' },
    ]);
    const response2 = createResponse('resp-2', 'model-stream', [
      { text: 'second' },
    ]);
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockResolvedValue(
        (async function* () {
          yield response1;
          yield response2;
        })(),
      ),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: false,
    });

    const request = {
      model: 'test-model',
      contents: 'Hello',
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(request, 'prompt-4');
    for await (const _item of stream) {
      break;
    }

    const spanRecord = getStreamSpanRecord();
    expect(spanRecord.statuses).toEqual([{ code: SpanStatusCode.OK }]);
    expect(spanRecord.ended).toBe(true);
  });

  it('uses generator modalities when converting logged OpenAI requests', async () => {
    convertGeminiRequestToOpenAISpy.mockImplementationOnce(
      (request, requestContext, options) =>
        realConvertGeminiRequestToOpenAI(request, requestContext, options),
    );

    const wrapped = createWrappedGenerator(
      vi
        .fn()
        .mockResolvedValue(
          createResponse('resp-5', 'test-model', [{ text: 'ok' }]),
        ),
      vi.fn(),
    );
    const generatorConfig = {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
      modalities: { image: true },
    };
    const generator = new LoggingContentGenerator(
      wrapped,
      createConfig(),
      generatorConfig,
    );

    const request = {
      model: 'test-model',
      contents: [
        {
          role: 'user',
          parts: [
            { text: 'Inspect this' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: 'img-data',
                displayName: 'diagram.png',
              },
            },
          ],
        },
      ],
    } as unknown as GenerateContentParameters;

    await generator.generateContent(request, 'prompt-5');

    expect(convertGeminiRequestToOpenAISpy).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        model: 'test-model',
        modalities: { image: true },
      }),
      { cleanOrphanToolCalls: false },
    );

    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results[0]
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    const [openaiRequest] = openaiLoggerInstance.logInteraction.mock
      .calls[0] as [OpenAI.Chat.ChatCompletionCreateParams];
    expect(openaiRequest.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Inspect this' },
          {
            type: 'image_url',
            image_url: {
              url: 'data:image/png;base64,img-data',
            },
          },
        ],
      },
    ]);
  });

  it('logs the captured wire request including provider-injected fields (generateContent)', async () => {
    const wireRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'deepseek-v4-pro',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.5,
      max_tokens: 1024,
      // Provider-injected fields the synthetic reconstruction would drop:
      reasoning_effort: 'max',
      extra_body: { thinking: { type: 'enabled' }, enable_thinking: true },
      metadata: { dashscope_user_id: 'abc' },
    } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

    const wrapped = createWrappedGenerator(
      vi.fn().mockImplementation(async () => {
        openaiRequestCaptureContext.getStore()?.(wireRequest);
        return createResponse('resp-cap', 'deepseek-v4-pro', [{ text: 'ok' }]);
      }),
      vi.fn(),
    );

    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'deepseek-v4-pro',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
      openAILoggingDir: 'logs',
    });

    const request = {
      model: 'deepseek-v4-pro',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    } as unknown as GenerateContentParameters;

    await generator.generateContent(request, 'prompt-cap');

    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results[0]
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    expect(openaiLoggerInstance.logInteraction).toHaveBeenCalledTimes(1);
    const [loggedRequest] = openaiLoggerInstance.logInteraction.mock
      .calls[0] as [OpenAI.Chat.ChatCompletionCreateParams];
    // The logger must observe the actual wire request, not a stripped reconstruction.
    expect(loggedRequest).toBe(wireRequest);
    expect(loggedRequest).toMatchObject({
      reasoning_effort: 'max',
      extra_body: { thinking: { type: 'enabled' }, enable_thinking: true },
      metadata: { dashscope_user_id: 'abc' },
    });
  });

  it('logs the captured wire request for streaming requests (generateContentStream)', async () => {
    const wireRequest: OpenAI.Chat.ChatCompletionCreateParams = {
      model: 'glm-5.1',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true },
      extra_body: { thinking: { type: 'enabled' } },
    } as unknown as OpenAI.Chat.ChatCompletionCreateParams;

    const chunk = createResponse('resp-stream-cap', 'glm-5.1', [
      { text: 'ok' },
    ]);

    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockImplementation(async () => {
        openaiRequestCaptureContext.getStore()?.(wireRequest);
        return (async function* () {
          yield chunk;
        })();
      }),
    );

    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'glm-5.1',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
      openAILoggingDir: 'logs',
    });

    const request = {
      model: 'glm-5.1',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(
      request,
      'prompt-stream-cap',
    );
    for await (const _ of stream) {
      // drain
    }

    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results[0]
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    expect(openaiLoggerInstance.logInteraction).toHaveBeenCalledTimes(1);
    const [loggedRequest] = openaiLoggerInstance.logInteraction.mock
      .calls[0] as [OpenAI.Chat.ChatCompletionCreateParams];
    expect(loggedRequest).toBe(wireRequest);
    expect(loggedRequest).toMatchObject({
      stream: true,
      stream_options: { include_usage: true },
      extra_body: { thinking: { type: 'enabled' } },
    });
  });

  it('falls back to synthetic request when the wrapped generator does not capture', async () => {
    const wrapped = createWrappedGenerator(
      vi
        .fn()
        .mockResolvedValue(
          createResponse('resp-fallback', 'test-model', [{ text: 'ok' }]),
        ),
      vi.fn(),
    );

    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
      openAILoggingDir: 'logs',
    });

    const request = {
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
      config: { temperature: 0.4 },
    } as unknown as GenerateContentParameters;

    await generator.generateContent(request, 'prompt-fallback');

    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results[0]
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    const [loggedRequest] = openaiLoggerInstance.logInteraction.mock
      .calls[0] as [OpenAI.Chat.ChatCompletionCreateParams];
    expect(loggedRequest).toEqual(
      expect.objectContaining({
        model: 'test-model',
        temperature: 0.4,
      }),
    );
  });

  it('does not propagate logging-side throws (success and error paths)', async () => {
    const successResponse = createResponse('resp-safe', 'test-model', [
      { text: 'ok' },
    ]);
    const successWrapped = createWrappedGenerator(
      vi.fn().mockResolvedValue(successResponse),
      vi.fn(),
    );
    const successGen = new LoggingContentGenerator(
      successWrapped,
      createConfig(),
      {
        model: 'test-model',
        authType: AuthType.USE_OPENAI,
        enableOpenAILogging: true,
        openAILoggingDir: 'logs',
      },
    );

    // No capture fires, so resolve() falls through to the synthetic builder.
    // Force the synthetic build to throw, then verify the API result still surfaces.
    convertGeminiRequestToOpenAISpy.mockImplementationOnce(() => {
      throw new Error('synth-fail-success');
    });

    const request = {
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    } as unknown as GenerateContentParameters;

    await expect(
      successGen.generateContent(request, 'prompt-safe-success'),
    ).resolves.toBe(successResponse);

    const apiError = new Error('api-boom');
    const errorWrapped = createWrappedGenerator(
      vi.fn().mockRejectedValue(apiError),
      vi.fn(),
    );
    const errorGen = new LoggingContentGenerator(errorWrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
      openAILoggingDir: 'logs',
    });
    convertGeminiRequestToOpenAISpy.mockImplementationOnce(() => {
      throw new Error('synth-fail-error');
    });

    await expect(
      errorGen.generateContent(request, 'prompt-safe-error'),
    ).rejects.toThrow('api-boom');
  });

  it('does not propagate logging-side throws on a successful stream', async () => {
    const chunk1 = createResponse('resp-stream-safe-1', 'test-model', [
      { text: 'hello' },
    ]);
    const chunk2 = createResponse('resp-stream-safe-2', 'test-model', [
      { text: ' world' },
    ]);
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockResolvedValue(
        (async function* () {
          yield chunk1;
          yield chunk2;
        })(),
      ),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
      openAILoggingDir: 'logs',
    });
    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results[0]
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    openaiLoggerInstance.logInteraction.mockRejectedValueOnce(
      new Error('log-fail-on-stream-success'),
    );

    const request = {
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(
      request,
      'prompt-stream-safe-success',
    );
    const seen: GenerateContentResponse[] = [];
    for await (const item of stream) {
      seen.push(item);
    }
    // All chunks must reach the consumer; the logger throw must not surface.
    expect(seen).toHaveLength(2);
    expect(openaiLoggerInstance.logInteraction).toHaveBeenCalledTimes(1);
  });

  it('does not let logging-side throws replace the original stream error', async () => {
    const chunk = createResponse('resp-stream-err', 'test-model', [
      { text: 'partial' },
    ]);
    const apiError = new Error('stream-api-fail');
    const wrapped = createWrappedGenerator(
      vi.fn(),
      vi.fn().mockResolvedValue(
        (async function* () {
          yield chunk;
          throw apiError;
        })(),
      ),
    );
    const generator = new LoggingContentGenerator(wrapped, createConfig(), {
      model: 'test-model',
      authType: AuthType.USE_OPENAI,
      enableOpenAILogging: true,
      openAILoggingDir: 'logs',
    });
    const openaiLoggerInstance = vi.mocked(OpenAILogger).mock.results[0]
      ?.value as { logInteraction: ReturnType<typeof vi.fn> };
    openaiLoggerInstance.logInteraction.mockRejectedValueOnce(
      new Error('log-fail-on-stream-error'),
    );

    const request = {
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
    } as unknown as GenerateContentParameters;

    const stream = await generator.generateContentStream(
      request,
      'prompt-stream-safe-error',
    );
    await expect(async () => {
      for await (const _item of stream) {
        // drain
      }
    }).rejects.toThrow('stream-api-fail');
    expect(openaiLoggerInstance.logInteraction).toHaveBeenCalledTimes(1);
  });

  it.each(['prompt_suggestion', 'forked_query', 'speculation'])(
    'skips logApiRequest and OpenAI logging for internal promptId %s (generateContent)',
    async (promptId) => {
      const mockResponse = {
        responseId: 'internal-resp',
        modelVersion: 'test-model',
        candidates: [{ content: { parts: [{ text: 'suggestion' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      } as unknown as GenerateContentResponse;

      const mockWrapped = {
        generateContent: vi.fn().mockResolvedValue(mockResponse),
        generateContentStream: vi.fn(),
      } as unknown as ContentGenerator;

      const gen = new LoggingContentGenerator(mockWrapped, createConfig(), {
        model: 'test-model',
        enableOpenAILogging: true,
        openAILoggingDir: '/tmp/test-logs',
      });

      const request = {
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'test' }] }],
      } as unknown as GenerateContentParameters;

      await gen.generateContent(request, promptId);

      // logApiRequest should NOT be called for internal prompts
      expect(logApiRequest).not.toHaveBeenCalled();
      // logApiResponse SHOULD be called (for /stats token tracking)
      expect(logApiResponse).toHaveBeenCalled();
      const [, responseEvent] = vi.mocked(logApiResponse).mock.calls[0];
      expect(responseEvent.response_text).toBeUndefined();
      // OpenAI logger should be constructed, but no interaction should be logged
      expect(OpenAILogger).toHaveBeenCalled();
      const loggerInstance = (
        OpenAILogger as unknown as ReturnType<typeof vi.fn>
      ).mock.results[0]?.value;
      expect(loggerInstance.logInteraction).not.toHaveBeenCalled();
    },
  );

  it.each(['prompt_suggestion', 'forked_query', 'speculation'])(
    'skips logApiRequest and OpenAI logging for internal promptId %s (generateContentStream)',
    async (promptId) => {
      const mockChunk = {
        responseId: 'stream-resp',
        modelVersion: 'test-model',
        candidates: [{ content: { parts: [{ text: 'suggestion' }] } }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      } as unknown as GenerateContentResponse;

      async function* fakeStream() {
        yield mockChunk;
      }

      const mockWrapped = {
        generateContent: vi.fn(),
        generateContentStream: vi.fn().mockResolvedValue(fakeStream()),
      } as unknown as ContentGenerator;

      const gen = new LoggingContentGenerator(mockWrapped, createConfig(), {
        model: 'test-model',
        enableOpenAILogging: true,
        openAILoggingDir: '/tmp/test-logs',
      });

      const request = {
        model: 'test-model',
        contents: [{ role: 'user', parts: [{ text: 'test' }] }],
      } as unknown as GenerateContentParameters;

      const stream = await gen.generateContentStream(request, promptId);
      // Consume the stream
      for await (const _chunk of stream) {
        // drain
      }

      expect(logApiRequest).not.toHaveBeenCalled();
      expect(logApiResponse).toHaveBeenCalled();
      const [, responseEvent] = vi.mocked(logApiResponse).mock.calls[0];
      expect(responseEvent.response_text).toBeUndefined();
      expect(OpenAILogger).toHaveBeenCalled();
      const loggerInstance = (
        OpenAILogger as unknown as ReturnType<typeof vi.fn>
      ).mock.results[0]?.value;
      expect(loggerInstance.logInteraction).not.toHaveBeenCalled();
    },
  );
});

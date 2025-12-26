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
import type { Config } from '../../config/config.js';
import type { ContentGenerator } from '../contentGenerator.js';
import { LoggingContentGenerator } from './index.js';
import { OpenAIContentConverter } from '../openaiContentGenerator/converter.js';
import {
  logApiRequest,
  logApiResponse,
  logApiError,
} from '../../telemetry/loggers.js';
import { OpenAILogger } from '../../utils/openaiLogger.js';
import type OpenAI from 'openai';

vi.mock('../../telemetry/loggers.js', () => ({
  logApiRequest: vi.fn(),
  logApiResponse: vi.fn(),
  logApiError: vi.fn(),
}));

vi.mock('../../utils/openaiLogger.js', () => ({
  OpenAILogger: vi.fn().mockImplementation(() => ({
    logInteraction: vi.fn().mockResolvedValue(undefined),
  })),
}));

const convertGeminiRequestToOpenAISpy = vi
  .spyOn(OpenAIContentConverter.prototype, 'convertGeminiRequestToOpenAI')
  .mockReturnValue([{ role: 'user', content: 'converted' }]);
const convertGeminiToolsToOpenAISpy = vi
  .spyOn(OpenAIContentConverter.prototype, 'convertGeminiToolsToOpenAI')
  .mockResolvedValue([{ type: 'function', function: { name: 'tool' } }]);
const convertGeminiResponseToOpenAISpy = vi
  .spyOn(OpenAIContentConverter.prototype, 'convertGeminiResponseToOpenAI')
  .mockReturnValue({
    id: 'openai-response',
    object: 'chat.completion',
    created: 123456789,
    model: 'test-model',
    choices: [],
  } as OpenAI.Chat.ChatCompletion);

const createConfig = (overrides: Record<string, unknown> = {}): Config =>
  ({
    getContentGeneratorConfig: () => ({
      authType: 'openai',
      enableOpenAILogging: false,
      ...overrides,
    }),
  }) as Config;

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

describe('LoggingContentGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
          [{ text: 'ok' }],
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
    const generator = new LoggingContentGenerator(
      wrapped,
      createConfig({
        enableOpenAILogging: true,
        openAILoggingDir: 'logs',
        schemaCompliance: 'openapi_30',
      }),
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

  it('logs errors with status code and request id, then rethrows', async () => {
    const error = Object.assign(new Error('boom'), {
      code: 429,
      request_id: 'req-99',
      type: 'rate_limit',
    });
    const wrapped = createWrappedGenerator(
      vi.fn().mockRejectedValue(error),
      vi.fn(),
    );
    const generator = new LoggingContentGenerator(
      wrapped,
      createConfig({ enableOpenAILogging: true }),
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
    const generator = new LoggingContentGenerator(
      wrapped,
      createConfig({ enableOpenAILogging: true }),
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
    const generator = new LoggingContentGenerator(
      wrapped,
      createConfig({ enableOpenAILogging: true }),
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
  });
});

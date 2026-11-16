/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type OpenAI from 'openai';
import { FinishReason } from '@google/genai';
import type { ErrorHandler, PipelineConfig } from './types.js';
import { ContentGenerationPipeline } from './pipeline.js';
import { toolCallArgumentsWereIncomplete } from '../incomplete-tool-call-args.js';
import type { Config } from '../../config/config.js';
import type { AuthType, ContentGeneratorConfig } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';

vi.mock('openai');
vi.mock('../../telemetry/loggers.js', () => ({
  logProtocolTagSanitized: vi.fn(),
}));
vi.mock('../../telemetry/gen-ai-request.js', () => ({
  reportOpenAiRequest: vi.fn(),
  reportOpenAiResponse: vi.fn(),
  reportOpenAiChunk: vi.fn(),
}));

/**
 * The park/settle handshake has two ends that each own half of one contract:
 * the converter decides a rewrite is suspected and parks the provider's own
 * reason, and the pipeline settles it once the delayed usage totals land.
 * `converter.test.ts` drives the real converter against a hand-written
 * expectation of what the pipeline will do; `pipeline.test.ts` drives the real
 * pipeline against a stubbed converter that hand-writes the park. Each side can
 * therefore stay green while the seam between them breaks — which is how the
 * R1-1 guard shipped inert. These cases run both ends for real.
 *
 * The stream shape is the reference protocol's, not the convenient one: under
 * `stream_options.include_usage` the chunk carrying `finish_reason` reports no
 * usage, and the totals arrive on a later `choices: []` chunk.
 */
describe('ContentGenerationPipeline + real converter: truncation override settlement', () => {
  let pipeline: ContentGenerationPipeline;
  let mockClient: OpenAI;
  let createMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    createMock = vi.fn();
    mockClient = {
      chat: { completions: { create: createMock } },
    } as unknown as OpenAI;

    const provider = {
      buildClient: vi.fn().mockReturnValue(mockClient),
      buildRequest: vi.fn().mockImplementation((req) => req),
      buildHeaders: vi.fn().mockReturnValue({}),
      getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
    } as unknown as OpenAICompatibleProvider;

    const errorHandler = {
      handle: vi.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
      shouldSuppressErrorLogging: vi.fn().mockReturnValue(false),
    } as unknown as ErrorHandler;

    const contentGeneratorConfig = {
      model: 'test-model',
      authType: 'openai' as AuthType,
      baseUrl: 'https://api.openai.com/v1',
    } as ContentGeneratorConfig;

    const config: PipelineConfig = {
      cliConfig: {} as Config,
      provider,
      contentGeneratorConfig,
      errorHandler,
    };
    pipeline = new ContentGenerationPipeline(config);
  });

  /** Fused `write_file` arguments missing the final closing brace, then a
   * finish chunk with no usage, then the trailing totals. */
  function arrangeRealStream(completionTokens: number) {
    createMock.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield {
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
                      name: 'write_file',
                      arguments:
                        '{"file_path":"/tmp/a.txt","content":"first half',
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletionChunk;
        yield {
          id: 'chunk-finish',
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        } as unknown as OpenAI.Chat.ChatCompletionChunk;
        yield {
          id: 'chunk-usage',
          choices: [],
          usage: {
            prompt_tokens: 100,
            completion_tokens: completionTokens,
            total_tokens: 100 + completionTokens,
          },
        } as unknown as OpenAI.Chat.ChatCompletionChunk;
      },
    });
  }

  async function yieldedFinishResponse() {
    const generator = await pipeline.executeStream(
      {
        model: 'test-model',
        contents: [{ parts: [{ text: 'Hello' }], role: 'user' }],
        config: { maxOutputTokens: 8192 },
      },
      'prompt-id',
    );
    const responses = [];
    for await (const response of generator) {
      responses.push(response);
    }
    const finish = responses.find(
      (response) => response.candidates?.[0]?.finishReason !== undefined,
    );
    if (!finish) throw new Error('no finish response was yielded');
    return finish;
  }

  it('withdraws the max_tokens diagnosis but keeps the incomplete-write guard armed', async () => {
    // 185 of 8192 is not a token-limit cut, so #12970's misdiagnosis must go.
    arrangeRealStream(185);

    const response = await yieldedFinishResponse();

    expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    expect(response.usageMetadata?.candidatesTokenCount).toBe(185);

    const fnCall = response.candidates?.[0]?.content?.parts?.find(
      (part) => part.functionCall,
    )?.functionCall;
    expect(fnCall?.name).toBe('write_file');
    // The arguments really did arrive unterminated and were repaired, so the
    // scheduler must still refuse to let this write execute — with wording that
    // names the real cause instead of max_tokens.
    expect(toolCallArgumentsWereIncomplete(fnCall!)).toBe(true);
  });

  it('keeps the override when the delayed totals corroborate a real cut', async () => {
    // #4964 must not regress: the same stream shape with the budget consumed.
    arrangeRealStream(8192);

    const response = await yieldedFinishResponse();

    expect(response.candidates?.[0]?.finishReason).toBe(
      FinishReason.MAX_TOKENS,
    );
    const fnCall = response.candidates?.[0]?.content?.parts?.find(
      (part) => part.functionCall,
    )?.functionCall;
    expect(fnCall?.name).toBe('write_file');
    // MAX_TOKENS already sets wasOutputTruncated downstream, so the guard is
    // armed without the marker; the marker is the disproof path's key.
    expect(toolCallArgumentsWereIncomplete(fnCall!)).toBe(false);
  });
});

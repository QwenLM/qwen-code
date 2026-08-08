/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateContentParameters } from '@google/genai';
import { FinishReason } from '@google/genai';
import { AuthType } from '../contentGenerator.js';
import { DashScopeContentGenerator } from './dashscope-content-generator.js';
import { DashScopeStreamTruncatedError } from './errors.js';
import type { DashScopeSseFrame } from './sse.js';
import {
  FakeDashScopeTransport,
  createDashScopeGeneratorConfig,
  createFakeCliConfig,
  framesFromSseText,
} from './test-utils.js';

const mockReportDashScopeRequest = vi.hoisted(() => vi.fn());
const mockReportGeminiResponse = vi.hoisted(() => vi.fn());
const mockReportGeminiChunk = vi.hoisted(() => vi.fn());

vi.mock('../../telemetry/gen-ai-request.js', () => ({
  reportDashScopeRequest: mockReportDashScopeRequest,
  reportGeminiResponse: mockReportGeminiResponse,
  reportGeminiChunk: mockReportGeminiChunk,
}));

const STREAM_TOOLS_FIXTURE = readFileSync(
  new URL('./__fixtures__/stream-tools.sse.txt', import.meta.url),
  'utf-8',
);

function textRequest(model = 'qwen3.8-max'): GenerateContentParameters {
  return {
    model,
    contents: [{ role: 'user', parts: [{ text: 'hi' }] }],
  };
}

describe('DashScopeContentGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('generateContent', () => {
    it('sends result_format:message and converts the response', async () => {
      const transport = new FakeDashScopeTransport({
        json: [
          {
            output: {
              choices: [
                {
                  finish_reason: 'stop',
                  message: { role: 'assistant', content: [{ text: 'OK' }] },
                },
              ],
            },
            usage: { input_tokens: 5, output_tokens: 1 },
            request_id: 'req-1',
          },
        ],
      });
      const generator = new DashScopeContentGenerator(
        createDashScopeGeneratorConfig(),
        createFakeCliConfig(),
        transport,
      );
      const telemetryAttempt = {};
      mockReportDashScopeRequest.mockReturnValueOnce(telemetryAttempt);

      const response = await generator.generateContent(
        textRequest('per-request-model'),
        'prompt-1',
      );

      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0].body.model).toBe('per-request-model');
      expect(transport.calls[0].body.parameters['result_format']).toBe(
        'message',
      );
      expect(response.candidates?.[0]?.content?.parts?.[0]?.text).toBe('OK');
      expect(response.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(response.modelVersion).toBe('per-request-model');
      expect(mockReportDashScopeRequest).toHaveBeenCalledWith(
        transport.calls[0].body,
      );
      expect(mockReportGeminiResponse).toHaveBeenCalledWith(
        telemetryAttempt,
        response,
      );
    });

    it('uses mandatory-thinking capability from an override model', async () => {
      const transport = new FakeDashScopeTransport({
        json: [{ output: { choices: [{ finish_reason: 'stop' }] } }],
      });
      const cliConfig = createFakeCliConfig();
      vi.mocked(cliConfig.getResolvedModelConfig).mockReturnValue({
        id: 'mandatory-model',
        name: 'mandatory-model',
        authType: AuthType.USE_DASHSCOPE,
        baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
        generationConfig: { thinkingMandatory: true },
        capabilities: {},
      });
      const generator = new DashScopeContentGenerator(
        createDashScopeGeneratorConfig({ reasoning: false }),
        cliConfig,
        transport,
      );
      const telemetryAttempt = {};
      mockReportDashScopeRequest.mockReturnValueOnce(telemetryAttempt);

      await generator.generateContent(
        textRequest('mandatory-model'),
        'prompt-1',
      );

      expect(
        transport.calls[0].body.parameters['reasoning_effort'],
      ).toBeUndefined();
    });

    it('aborts the child controller after the request completes', async () => {
      const transport = new FakeDashScopeTransport({
        json: [{ output: { choices: [{ finish_reason: 'stop' }] } }],
      });
      const generator = new DashScopeContentGenerator(
        createDashScopeGeneratorConfig(),
        createFakeCliConfig(),
        transport,
      );

      await generator.generateContent(textRequest(), 'prompt-1');

      expect(transport.calls[0].signal.aborted).toBe(true);
    });
  });

  describe('generateContentStream', () => {
    it('streams the fixture with usage only on the final chunk and two functionCall parts', async () => {
      const frames = await framesFromSseText(STREAM_TOOLS_FIXTURE);
      const transport = new FakeDashScopeTransport({ frames: [frames] });
      const generator = new DashScopeContentGenerator(
        createDashScopeGeneratorConfig(),
        createFakeCliConfig(),
        transport,
      );
      const telemetryAttempt = {};
      mockReportDashScopeRequest.mockReturnValueOnce(telemetryAttempt);

      const stream = await generator.generateContentStream(
        textRequest('per-request-model'),
        'prompt-1',
      );
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }

      const intermediate = chunks.slice(0, -1);
      for (const chunk of intermediate) {
        expect(chunk.usageMetadata).toBeUndefined();
      }
      const finalChunk = chunks[chunks.length - 1];
      expect(finalChunk.usageMetadata).toBeDefined();
      expect(finalChunk.modelVersion).toBe('per-request-model');
      expect(transport.calls[0].body.model).toBe('per-request-model');

      const functionCallParts = chunks.flatMap(
        (chunk) =>
          chunk.candidates?.[0]?.content?.parts?.filter(
            (part) => part.functionCall,
          ) ?? [],
      );
      expect(functionCallParts).toHaveLength(2);
      expect(mockReportDashScopeRequest).toHaveBeenCalledWith(
        transport.calls[0].body,
      );
      expect(mockReportGeminiChunk).toHaveBeenCalledTimes(chunks.length);
      for (const chunk of chunks) {
        expect(mockReportGeminiChunk).toHaveBeenCalledWith(
          telemetryAttempt,
          chunk,
        );
      }
    });

    it('throws DashScopeStreamTruncatedError when the stream ends with no terminal frame and no tool calls', async () => {
      const frames: DashScopeSseFrame[] = [
        {
          data: JSON.stringify({
            output: {
              choices: [
                {
                  finish_reason: 'null',
                  message: {
                    role: 'assistant',
                    content: [{ text: 'partial' }],
                  },
                },
              ],
            },
          }),
        },
      ];
      const transport = new FakeDashScopeTransport({ frames: [frames] });
      const generator = new DashScopeContentGenerator(
        createDashScopeGeneratorConfig(),
        createFakeCliConfig(),
        transport,
      );

      const stream = await generator.generateContentStream(
        textRequest(),
        'prompt-1',
      );

      await expect(
        (async () => {
          for await (const _chunk of stream) {
            // drain
          }
        })(),
      ).rejects.toBeInstanceOf(DashScopeStreamTruncatedError);
      expect(transport.calls[0].signal.aborted).toBe(true);
    });

    it('resolves without throwing when truncated after tool calls were already emitted', async () => {
      const frames: DashScopeSseFrame[] = [
        {
          data: JSON.stringify({
            output: {
              choices: [
                {
                  finish_reason: 'tool_calls',
                  message: {
                    role: 'assistant',
                    content: [],
                    tool_calls: [
                      {
                        id: 'call_a',
                        index: 0,
                        type: 'function',
                        function: {
                          name: 'get_weather',
                          arguments: '{"city":"Paris"}',
                        },
                      },
                    ],
                  },
                },
              ],
            },
            usage: { input_tokens: 5, output_tokens: 3 },
          }),
        },
      ];
      const transport = new FakeDashScopeTransport({ frames: [frames] });
      const generator = new DashScopeContentGenerator(
        createDashScopeGeneratorConfig(),
        createFakeCliConfig(),
        transport,
      );

      const stream = await generator.generateContentStream(
        textRequest(),
        'prompt-1',
      );
      const chunks = [];
      for await (const chunk of stream) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThan(0);
    });
  });

  describe('countTokens', () => {
    it('estimates tokens without calling the transport', async () => {
      const transport = new FakeDashScopeTransport({});
      const generator = new DashScopeContentGenerator(
        createDashScopeGeneratorConfig(),
        createFakeCliConfig(),
        transport,
      );

      const result = await generator.countTokens({
        model: 'qwen3.8-max',
        contents: [{ role: 'user', parts: [{ text: 'hello there' }] }],
      });

      expect(result.totalTokens).toBeGreaterThan(0);
      expect(transport.calls).toHaveLength(0);
    });
  });

  describe('embedContent', () => {
    it('rejects — native DashScope does not support embeddings', async () => {
      const transport = new FakeDashScopeTransport({});
      const generator = new DashScopeContentGenerator(
        createDashScopeGeneratorConfig(),
        createFakeCliConfig(),
        transport,
      );

      await expect(
        generator.embedContent({
          model: 'qwen3.8-max',
          contents: [{ role: 'user', parts: [{ text: 'x' }] }],
        }),
      ).rejects.toThrow('does not support embeddings');
    });
  });

  it('useSummarizedThinking returns false', () => {
    const generator = new DashScopeContentGenerator(
      createDashScopeGeneratorConfig(),
      createFakeCliConfig(),
      new FakeDashScopeTransport({}),
    );
    expect(generator.useSummarizedThinking()).toBe(false);
  });
});

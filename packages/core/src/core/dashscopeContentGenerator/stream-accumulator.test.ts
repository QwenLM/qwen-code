/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { FinishReason } from '@google/genai';
import { DashScopeStreamAccumulator } from './stream-accumulator.js';
import { parseDashScopeSse, type DashScopeSseFrame } from './sse.js';
import { DashScopeApiError } from './errors.js';
import { getToolCallPreparations } from '../tool-call-preparation.js';

const STREAM_TOOLS_FIXTURE = readFileSync(
  new URL('./__fixtures__/stream-tools.sse.txt', import.meta.url),
  'utf-8',
);
const STREAM_TEXT_FIXTURE = readFileSync(
  new URL('./__fixtures__/stream-text.sse.txt', import.meta.url),
  'utf-8',
);
const ERROR_FRAME_FIXTURE = readFileSync(
  new URL('./__fixtures__/error-frame.sse.txt', import.meta.url),
  'utf-8',
);

function streamFromString(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function streamByteAtATime(body: string): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(body);
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= bytes.length) {
        controller.close();
        return;
      }
      controller.enqueue(bytes.slice(index, index + 1));
      index += 1;
    },
  });
}

async function collectFrames(
  stream: ReadableStream<Uint8Array>,
): Promise<DashScopeSseFrame[]> {
  const frames: DashScopeSseFrame[] = [];
  for await (const frame of parseDashScopeSse(stream)) {
    frames.push(frame);
  }
  return frames;
}

async function replay(
  fixture: string,
  model = 'qwen3.8-max',
): Promise<{
  accumulator: DashScopeStreamAccumulator;
  chunks: GenerateContentResponse[];
}> {
  const accumulator = new DashScopeStreamAccumulator(model);
  const chunks: GenerateContentResponse[] = [];
  for (const frame of await collectFrames(streamFromString(fixture))) {
    chunks.push(...accumulator.push(frame));
  }
  return { accumulator, chunks };
}

describe('DashScopeStreamAccumulator', () => {
  it('replays stream-tools.sse.txt: thoughts first, no intermediate finishReason/usageMetadata', async () => {
    const { accumulator, chunks } = await replay(STREAM_TOOLS_FIXTURE);

    expect(chunks.length).toBeGreaterThan(0);
    const finalChunk = chunks[chunks.length - 1];
    const intermediateChunks = chunks.slice(0, -1);

    for (const chunk of intermediateChunks) {
      expect(chunk.candidates?.[0]?.finishReason).toBeUndefined();
      expect(chunk.usageMetadata).toBeUndefined();
    }

    // Thought parts appear before any functionCall part across the stream.
    const firstFunctionCallChunkIndex = chunks.findIndex((chunk) =>
      chunk.candidates?.[0]?.content?.parts?.some((part) => part.functionCall),
    );
    const firstThoughtChunkIndex = chunks.findIndex((chunk) =>
      chunk.candidates?.[0]?.content?.parts?.some((part) => part.thought),
    );
    expect(firstThoughtChunkIndex).toBeGreaterThanOrEqual(0);
    expect(firstThoughtChunkIndex).toBeLessThan(firstFunctionCallChunkIndex);

    expect(finalChunk.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    expect(finalChunk.usageMetadata?.candidatesTokenCount).toBe(81);

    const functionCallParts =
      finalChunk.candidates?.[0]?.content?.parts?.filter(
        (part) => part.functionCall,
      ) ?? [];
    expect(functionCallParts).toHaveLength(2);
    expect(functionCallParts[0].functionCall?.id).toBe(
      'call_f0df466b1fd44f7590ebf389',
    );
    expect(functionCallParts[0].functionCall?.args).toEqual({
      city: 'Paris',
    });
    expect(functionCallParts[1].functionCall?.id).toBe(
      'call_85d6e563c2e94bb68c5abea3',
    );
    expect(functionCallParts[1].functionCall?.args).toEqual({
      city: 'Tokyo',
    });

    expect(accumulator.finish()).toEqual({
      truncated: false,
      emittedToolCalls: true,
    });
  });

  it('emits tool-call preparation exactly once per call, at the open frame', async () => {
    const { chunks } = await replay(STREAM_TOOLS_FIXTURE);

    const allPreparations = chunks.flatMap((chunk) =>
      getToolCallPreparations(chunk),
    );
    expect(allPreparations).toEqual([
      { callId: 'call_f0df466b1fd44f7590ebf389', toolName: 'get_weather' },
      { callId: 'call_85d6e563c2e94bb68c5abea3', toolName: 'get_weather' },
    ]);
  });

  it('does not let an empty-id continuation frame clobber the latched id', async () => {
    const { chunks } = await replay(STREAM_TOOLS_FIXTURE);
    const finalChunk = chunks[chunks.length - 1];
    const functionCallParts =
      finalChunk.candidates?.[0]?.content?.parts?.filter(
        (part) => part.functionCall,
      ) ?? [];
    for (const part of functionCallParts) {
      expect(part.functionCall?.id).toBeTruthy();
    }
  });

  it('produces identical results when fed byte-at-a-time', async () => {
    const wholeAccumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    const wholeChunks: GenerateContentResponse[] = [];
    for (const frame of await collectFrames(
      streamFromString(STREAM_TOOLS_FIXTURE),
    )) {
      wholeChunks.push(...wholeAccumulator.push(frame));
    }

    const byteAccumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    const byteChunks: GenerateContentResponse[] = [];
    for (const frame of await collectFrames(
      streamByteAtATime(STREAM_TOOLS_FIXTURE),
    )) {
      byteChunks.push(...byteAccumulator.push(frame));
    }

    expect(byteChunks).toEqual(wholeChunks);
    expect(byteAccumulator.finish()).toEqual(wholeAccumulator.finish());
  });

  it('replays stream-text.sse.txt: text-only terminal chunk with STOP + usage', async () => {
    const { accumulator, chunks } = await replay(STREAM_TEXT_FIXTURE);
    const finalChunk = chunks[chunks.length - 1];

    const combinedText = chunks
      .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
      .filter((part) => part.text && !part.thought)
      .map((part) => part.text)
      .join('');
    expect(combinedText).toBe('The answer is 42.');

    expect(finalChunk.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    expect(finalChunk.usageMetadata).toBeDefined();
    expect(accumulator.finish()).toEqual({
      truncated: false,
      emittedToolCalls: false,
    });
  });

  it('emits text from string content frames', () => {
    const accumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    const chunks = ['The answer ', 'is 42.'].flatMap((content) =>
      accumulator.push({
        data: JSON.stringify({
          output: {
            choices: [
              {
                finish_reason: 'null',
                message: { role: 'assistant', content },
              },
            ],
          },
        }),
      }),
    );

    const combinedText = chunks
      .flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text)
      .join('');
    expect(combinedText).toBe('The answer is 42.');
  });

  it('emits nothing for reasoning_content: "" frames', () => {
    const accumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    const chunks = accumulator.push({
      data: JSON.stringify({
        output: {
          choices: [
            {
              finish_reason: 'null',
              message: {
                role: 'assistant',
                content: [],
                reasoning_content: '',
              },
            },
          ],
        },
      }),
    });
    expect(chunks).toEqual([]);
  });

  it('falls back to empty args on an unparseable argument buffer', () => {
    const accumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    accumulator.push({
      data: JSON.stringify({
        output: {
          choices: [
            {
              finish_reason: 'null',
              message: {
                role: 'assistant',
                content: [],
                tool_calls: [
                  {
                    id: 'call_x',
                    index: 0,
                    type: 'function',
                    function: { name: 'get_weather', arguments: '' },
                  },
                ],
              },
            },
          ],
        },
      }),
    });
    const chunks = accumulator.push({
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
                    id: '',
                    index: 0,
                    type: 'function',
                    function: { arguments: 'not json{{{' },
                  },
                ],
              },
            },
          ],
        },
      }),
    });
    const functionCallParts =
      chunks[0]?.candidates?.[0]?.content?.parts?.filter(
        (part) => part.functionCall,
      ) ?? [];
    expect(functionCallParts).toHaveLength(1);
    expect(functionCallParts[0].functionCall?.args).toEqual({});
  });

  it('withholds tool calls when finish_reason is "length"', () => {
    const accumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    const chunks = accumulator.push({
      data: JSON.stringify({
        output: {
          choices: [
            {
              finish_reason: 'length',
              message: {
                role: 'assistant',
                content: [],
                tool_calls: [
                  {
                    id: 'call_x',
                    index: 0,
                    type: 'function',
                    function: {
                      name: 'lookup_user',
                      arguments: '{"name":"Alexander',
                    },
                  },
                ],
              },
            },
          ],
        },
      }),
    });

    expect(chunks[0]?.candidates?.[0]?.finishReason).toBe(
      FinishReason.MAX_TOKENS,
    );
    expect(chunks[0]?.candidates?.[0]?.content?.parts).toEqual([]);
    expect(accumulator.finish()).toEqual({
      truncated: false,
      emittedToolCalls: false,
    });
  });

  it('throws a DashScopeApiError for an event:error frame', async () => {
    const accumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    const frames = await collectFrames(streamFromString(ERROR_FRAME_FIXTURE));
    expect(() => accumulator.push(frames[0])).toThrow(DashScopeApiError);
    try {
      accumulator.push(frames[0]);
    } catch (err) {
      expect((err as DashScopeApiError).status).toBe(400);
    }
  });

  it('reports truncated: true when finish() is called with no terminal frame', () => {
    const accumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    accumulator.push({
      data: JSON.stringify({
        output: {
          choices: [
            {
              finish_reason: 'null',
              message: { role: 'assistant', content: [{ text: 'partial' }] },
            },
          ],
        },
      }),
    });
    expect(accumulator.finish()).toEqual({
      truncated: true,
      emittedToolCalls: false,
    });
  });

  it('returns [] for a malformed (non-JSON) frame without throwing', () => {
    const accumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    expect(() => accumulator.push({ data: 'not valid json' })).not.toThrow();
    expect(accumulator.push({ data: 'not valid json' })).toEqual([]);
  });

  it('returns [] and buffers usage when output.choices[0] is absent', () => {
    const accumulator = new DashScopeStreamAccumulator('qwen3.8-max');
    const chunks = accumulator.push({
      data: JSON.stringify({ usage: { input_tokens: 5, output_tokens: 0 } }),
    });
    expect(chunks).toEqual([]);
  });
});

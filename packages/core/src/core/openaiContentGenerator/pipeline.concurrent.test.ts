/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration test — deliberately does NOT mock `./converter.js`. Unlike
 * `pipeline.test.ts` which stubs the converter, this suite drives the real
 * `ContentGenerationPipeline` + real `OpenAIContentConverter` through two
 * streams that interleave on the event loop, and asserts that tool-call
 * arguments from one stream never bleed into the other's output.
 *
 * This is the regression test for issue #3516: before the per-stream
 * parser scoping fix, the Converter singleton held a single
 * `StreamingToolCallParser` instance. Two concurrent streams would share
 * it; each stream's entry-time reset wiped the other's partial buffers,
 * and chunks routed by `index: 0` interleaved into corrupt JSON.
 *
 * With the fix, `processStreamWithLogging` creates a fresh request context
 * with its own `toolCallParser` at stream entry, so each concurrent
 * generator has its own parser. On pre-fix code this test fails
 * deterministically: stream B's entry wipes stream A's accumulator
 * mid-flight, and A's finish chunk emits zero function calls
 * (`wasOutputTruncated`-style behavior).
 */

import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import type { GenerateContentParameters } from '@google/genai';
import type { Part } from '@google/genai';
import type { ErrorHandler, PipelineConfig } from './types.js';
import { ContentGenerationPipeline } from './pipeline.js';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig, AuthType } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import { collect, drain } from '../../test-utils/model-fixtures.js';

type Chunk = OpenAI.Chat.ChatCompletionChunk;
type ChunkFactory = () => Chunk;
type StreamFactory = () => AsyncIterable<Chunk>;

/**
 * Build a slow stream that yields to the event loop between chunks.
 * Without the `setImmediate` await, a `for await` loop on one stream
 * drains synchronously and `Promise.all` degenerates to serial execution,
 * which hides the cross-stream bug.
 */
async function* interleavingStream(
  chunks: ChunkFactory[],
): AsyncGenerator<Chunk> {
  for (const make of chunks) {
    // Yield control so the sibling stream can advance one step before we do.
    await new Promise((r) => setImmediate(r));
    yield make();
  }
}

/** A single-choice chunk; `extra` holds top-level keys after `choices`. */
function chunk(
  id: string,
  delta: Record<string, unknown>,
  finishReason: string | null,
  extra: Record<string, unknown> = {},
): Chunk {
  return {
    id,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
    ...extra,
  } as unknown as Chunk;
}

function openerChunk(id: string, name: string, firstArgs: string): Chunk {
  const toolCall = {
    index: 0,
    id,
    type: 'function',
    function: { name, arguments: firstArgs },
  };
  return chunk(`${id}-opener`, { tool_calls: [toolCall] }, null);
}

function continuationChunk(argsFragment: string): Chunk {
  const toolCall = { index: 0, function: { arguments: argsFragment } };
  return chunk('cont', { tool_calls: [toolCall] }, null);
}

function finisherChunk(): Chunk {
  return chunk('finish', {}, 'tool_calls', {
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

/** A `read_file` call split into opener + continuation, then a finisher. */
function toolCallStream(id: string, firstArgs: string, restArgs: string) {
  return () =>
    interleavingStream([
      () => openerChunk(id, 'read_file', firstArgs),
      () => continuationChunk(restArgs),
      () => finisherChunk(),
    ]);
}

function firstFunctionCall(responses: unknown[]) {
  for (const resp of responses) {
    const candidates = (
      resp as { candidates?: Array<{ content?: { parts?: Part[] } }> }
    ).candidates;
    const parts = candidates?.[0]?.content?.parts ?? [];
    const fc = parts.find((p) => p.functionCall)?.functionCall;
    if (fc) return fc;
  }
  return undefined;
}

function expectReadFileCall(
  fn: ReturnType<typeof firstFunctionCall>,
  id: string,
  args: Record<string, unknown>,
) {
  expect(fn?.name).toBe('read_file');
  expect(fn?.id).toBe(id);
  expect(fn?.args).toEqual(args);
}

describe('ContentGenerationPipeline — concurrent streams (issue #3516)', () => {
  /**
   * Builds a pipeline whose chat.completions.create consumes `streamQueue`
   * one factory per call, then starts one executeStream per queued stream
   * *before* consuming either, so both generators are alive on the event
   * loop at the same time.
   */
  async function startConcurrentStreams(streamQueue: StreamFactory[]) {
    const mockClient = {
      chat: {
        completions: {
          create: vi.fn().mockImplementation(() => {
            const next = streamQueue.shift();
            if (!next) throw new Error('unexpected extra stream request');
            return next();
          }),
        },
      },
    } as unknown as OpenAI;

    const mockProvider: OpenAICompatibleProvider = {
      buildClient: vi.fn().mockReturnValue(mockClient),
      buildRequest: vi.fn().mockImplementation((req) => req),
      buildHeaders: vi.fn().mockReturnValue({}),
      getDefaultGenerationConfig: vi.fn().mockReturnValue({}),
    } as unknown as OpenAICompatibleProvider;

    const mockErrorHandler: ErrorHandler = {
      handle: vi.fn().mockImplementation((error: unknown) => {
        throw error;
      }),
      shouldSuppressErrorLogging: vi.fn().mockReturnValue(false),
    } as unknown as ErrorHandler;

    const contentGeneratorConfig: ContentGeneratorConfig = {
      model: 'test-model',
      authType: 'openai' as AuthType,
    } as ContentGeneratorConfig;

    const config: PipelineConfig = {
      cliConfig: {} as Config,
      provider: mockProvider,
      contentGeneratorConfig,
      errorHandler: mockErrorHandler,
    };
    const pipeline = new ContentGenerationPipeline(config);

    const request: GenerateContentParameters = {
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'read the files' }] }],
    };
    return Promise.all([
      pipeline.executeStream(request, 'prompt-a'),
      pipeline.executeStream(request, 'prompt-b'),
    ]);
  }

  it('two concurrent streams keep their tool-call buffers isolated', async () => {
    const [streamA, streamB] = await startConcurrentStreams([
      toolCallStream('call_A', '{"file_path":"/a', '/one.ts"}'),
      toolCallStream('call_B', '{"file_path":"/b', '/two.ts"}'),
    ]);

    // Interleaved consumption: alternate one chunk from each to maximize
    // parser state overlap.
    const collectedA: unknown[] = [];
    const collectedB: unknown[] = [];

    const aIter = streamA[Symbol.asyncIterator]();
    const bIter = streamB[Symbol.asyncIterator]();

    while (true) {
      const [aNext, bNext] = await Promise.all([aIter.next(), bIter.next()]);
      if (!aNext.done) collectedA.push(aNext.value);
      if (!bNext.done) collectedB.push(bNext.value);
      if (aNext.done && bNext.done) break;
    }

    // Pre-fix behaviour: at least one of these would either be undefined
    // (buffer wiped by the other stream's reset) or carry the wrong args
    // (other stream's chunks merged into this bucket).
    expectReadFileCall(firstFunctionCall(collectedA), 'call_A', {
      file_path: '/a/one.ts',
    });
    expectReadFileCall(firstFunctionCall(collectedB), 'call_B', {
      file_path: '/b/two.ts',
    });
  });

  it('an error in one stream does not poison a concurrent stream (no shared reset on error)', async () => {
    // Stream A: normal tool call. Stream B yields an `error_finish` chunk
    // mid-flight, which the Pipeline wraps as StreamContentError.
    // Pre-fix: the error path ran `resetStreamingToolCalls()` on the shared
    // converter, wiping A's partial buffers. Post-fix: streamCtx is local
    // to each generator, so A is untouched.
    const [streamA, streamB] = await startConcurrentStreams([
      toolCallStream('call_A', '{"file_path":"/x', '.ts"}'),
      () =>
        interleavingStream([
          () => openerChunk('call_B', 'read_file', '{"file_path":"/y'),
          // Inject an error_finish chunk — this triggers StreamContentError
          // inside processStreamWithLogging's catch block.
          () => chunk('err', { content: 'rate limit' }, 'error_finish'),
        ]),
    ]);

    const consumeA = (async () => {
      const out: unknown[] = await collect(streamA);
      return out;
    })();
    const consumeB = (async () => {
      try {
        await drain(streamB);
        return 'completed';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    })();

    const [aResults, bOutcome] = await Promise.all([consumeA, consumeB]);

    // Stream B blew up as expected.
    expect(typeof bOutcome).toBe('string');
    expect(bOutcome).toContain('rate limit');

    // Stream A still emitted its function call cleanly, despite B's error
    // path running concurrently. On pre-fix code the error path would have
    // called converter.resetStreamingToolCalls(), wiping A's in-flight
    // buffer and causing A to emit zero function calls.
    expectReadFileCall(firstFunctionCall(aResults), 'call_A', {
      file_path: '/x.ts',
    });
  });
});

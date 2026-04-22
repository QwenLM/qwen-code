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
 * With the fix, `processStreamWithLogging` creates a fresh
 * `ConverterStreamContext` at stream entry, so each concurrent generator
 * has its own parser. This test would fail deterministically on pre-fix
 * code because stream B's entry would wipe stream A's accumulator
 * mid-flight, and A's finish chunk would emit zero function calls
 * (`wasOutputTruncated`-style behavior).
 */

import { describe, it, expect, vi } from 'vitest';
import type OpenAI from 'openai';
import type { GenerateContentParameters } from '@google/genai';
import type { Part } from '@google/genai';
import type { PipelineConfig } from './pipeline.js';
import { ContentGenerationPipeline } from './pipeline.js';
import type { Config } from '../../config/config.js';
import type { ContentGeneratorConfig, AuthType } from '../contentGenerator.js';
import type { OpenAICompatibleProvider } from './provider/index.js';
import type { ErrorHandler } from './errorHandler.js';

type ChunkFactory = () => OpenAI.Chat.ChatCompletionChunk;

/**
 * Build a slow stream that yields to the event loop between chunks.
 * Without the `setImmediate` await, a `for await` loop on one stream
 * drains synchronously and `Promise.all` degenerates to serial execution,
 * which hides the cross-stream bug.
 */
async function* interleavingStream(
  chunks: ChunkFactory[],
): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
  for (const make of chunks) {
    // Yield control so the sibling stream can advance one step before we do.
    await new Promise((r) => setImmediate(r));
    yield make();
  }
}

function openerChunk(
  id: string,
  name: string,
  firstArgs: string,
): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: `${id}-opener`,
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id,
              type: 'function',
              function: { name, arguments: firstArgs },
            },
          ],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  } as unknown as OpenAI.Chat.ChatCompletionChunk;
}

function continuationChunk(
  argsFragment: string,
): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'cont',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, function: { arguments: argsFragment } }],
        },
        finish_reason: null,
        logprobs: null,
      },
    ],
  } as unknown as OpenAI.Chat.ChatCompletionChunk;
}

function finisherChunk(): OpenAI.Chat.ChatCompletionChunk {
  return {
    id: 'finish',
    object: 'chat.completion.chunk',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: 'tool_calls',
        logprobs: null,
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  } as unknown as OpenAI.Chat.ChatCompletionChunk;
}

describe('ContentGenerationPipeline — concurrent streams (issue #3516)', () => {
  function buildPipeline(
    createStreamImpl: () => AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  ) {
    const mockClient = {
      chat: {
        completions: {
          // Each call returns a fresh stream. The real Pipeline will
          // invoke this twice — once per concurrent executeStream call.
          create: vi.fn().mockImplementation(() => createStreamImpl()),
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

    return { pipeline: new ContentGenerationPipeline(config), mockClient };
  }

  it('two concurrent streams keep their tool-call buffers isolated', async () => {
    // Queue of pending stream factories — each call to the mocked
    // chat.completions.create consumes one.
    const streamQueue: Array<
      () => AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    > = [];

    streamQueue.push(() =>
      interleavingStream([
        () => openerChunk('call_A', 'read_file', '{"file_path":"/a'),
        () => continuationChunk('/one.ts"}'),
        () => finisherChunk(),
      ]),
    );
    streamQueue.push(() =>
      interleavingStream([
        () => openerChunk('call_B', 'read_file', '{"file_path":"/b'),
        () => continuationChunk('/two.ts"}'),
        () => finisherChunk(),
      ]),
    );

    const { pipeline } = buildPipeline(() => {
      const next = streamQueue.shift();
      if (!next) throw new Error('unexpected extra stream request');
      return next();
    });

    const request: GenerateContentParameters = {
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'read the files' }] }],
    };

    // Kick off both streams *before* consuming either, so the two generators
    // are actually alive on the event loop at the same time.
    const [streamA, streamB] = await Promise.all([
      pipeline.executeStream(request, 'prompt-a'),
      pipeline.executeStream(request, 'prompt-b'),
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

    const extractFunctionCall = (responses: unknown[]) => {
      for (const resp of responses) {
        const candidates = (
          resp as { candidates?: Array<{ content?: { parts?: Part[] } }> }
        ).candidates;
        const parts = candidates?.[0]?.content?.parts ?? [];
        const fc = parts.find((p) => p.functionCall)?.functionCall;
        if (fc) return fc;
      }
      return undefined;
    };

    const fnA = extractFunctionCall(collectedA);
    const fnB = extractFunctionCall(collectedB);

    // Pre-fix behaviour: at least one of these would either be undefined
    // (buffer wiped by the other stream's reset) or carry the wrong args
    // (other stream's chunks merged into this bucket).
    expect(fnA?.name).toBe('read_file');
    expect(fnA?.id).toBe('call_A');
    expect(fnA?.args).toEqual({ file_path: '/a/one.ts' });

    expect(fnB?.name).toBe('read_file');
    expect(fnB?.id).toBe('call_B');
    expect(fnB?.args).toEqual({ file_path: '/b/two.ts' });
  });

  it('an error in one stream does not poison a concurrent stream (no shared reset on error)', async () => {
    // Stream A: normal tool call.
    // Stream B: yields an `error_finish` chunk mid-flight, which the
    // Pipeline wraps as StreamContentError.
    // Pre-fix: the error path ran `resetStreamingToolCalls()` on the shared
    // converter, wiping A's partial buffers. Post-fix: streamCtx is local
    // to each generator, so A is untouched.
    const streamQueue: Array<
      () => AsyncIterable<OpenAI.Chat.ChatCompletionChunk>
    > = [];

    streamQueue.push(() =>
      interleavingStream([
        () => openerChunk('call_A', 'read_file', '{"file_path":"/x'),
        () => continuationChunk('.ts"}'),
        () => finisherChunk(),
      ]),
    );

    streamQueue.push(() =>
      interleavingStream([
        () => openerChunk('call_B', 'read_file', '{"file_path":"/y'),
        // Inject an error_finish chunk — this triggers StreamContentError
        // inside processStreamWithLogging's catch block.
        () =>
          ({
            id: 'err',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'test',
            choices: [
              {
                index: 0,
                delta: { content: 'rate limit' },
                finish_reason: 'error_finish',
                logprobs: null,
              },
            ],
          }) as unknown as OpenAI.Chat.ChatCompletionChunk,
      ]),
    );

    const { pipeline } = buildPipeline(() => {
      const next = streamQueue.shift();
      if (!next) throw new Error('unexpected extra stream request');
      return next();
    });

    const request: GenerateContentParameters = {
      model: 'test-model',
      contents: [{ role: 'user', parts: [{ text: 'read the files' }] }],
    };

    const [streamA, streamB] = await Promise.all([
      pipeline.executeStream(request, 'prompt-a'),
      pipeline.executeStream(request, 'prompt-b'),
    ]);

    const consumeA = (async () => {
      const out: unknown[] = [];
      for await (const r of streamA) out.push(r);
      return out;
    })();
    const consumeB = (async () => {
      try {
        for await (const _ of streamB) {
          /* drain */
        }
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
    const fnA = (() => {
      for (const resp of aResults) {
        const parts =
          (resp as { candidates?: Array<{ content?: { parts?: Part[] } }> })
            .candidates?.[0]?.content?.parts ?? [];
        const fc = parts.find((p) => p.functionCall)?.functionCall;
        if (fc) return fc;
      }
      return undefined;
    })();

    expect(fnA?.name).toBe('read_file');
    expect(fnA?.id).toBe('call_A');
    expect(fnA?.args).toEqual({ file_path: '/x.ts' });
  });
});

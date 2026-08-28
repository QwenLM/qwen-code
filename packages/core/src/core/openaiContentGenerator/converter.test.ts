/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OpenAIContentConverter } from './converter.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';
import { TaggedThinkingParser } from './taggedThinkingParser.js';
import type { RequestContext } from './types.js';
import {
  Type,
  FinishReason,
  type GenerateContentResponse,
  type GenerateContentParameters,
  type Content,
  type Part,
  type Tool,
  type CallableTool,
} from '@google/genai';
import type OpenAI from 'openai';
import { convertToFunctionResponse } from '../coreToolScheduler.js';
import { getToolCallPreparations } from '../tool-call-preparation.js';
import { isOpenAIReasoningThoughtPart } from '../../utils/thoughtUtils.js';
import { getGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';

describe('OpenAIContentConverter', () => {
  let converter: typeof OpenAIContentConverter;
  let requestContext: RequestContext;

  beforeEach(() => {
    converter = OpenAIContentConverter;
    requestContext = {
      model: 'test-model',
      modalities: {
        image: true,
        pdf: true,
        audio: true,
        video: true,
      },
      startTime: 0,
    };
  });

  function withStreamParser(
    toolCallParser: StreamingToolCallParser = new StreamingToolCallParser(),
  ): RequestContext {
    return {
      ...requestContext,
      toolCallParser,
    };
  }

  function withTaggedThinkingOptions(): RequestContext {
    return {
      ...requestContext,
      responseParsingOptions: { taggedThinkingTags: true },
    };
  }

  function withTaggedThinkingStreamParser(): RequestContext {
    return {
      ...withStreamParser(),
      responseParsingOptions: { taggedThinkingTags: true },
      taggedThinkingParser: new TaggedThinkingParser(),
    };
  }

  function hasOpenAIToolCalls(
    message: OpenAI.Chat.ChatCompletionMessageParam,
  ): message is OpenAI.Chat.ChatCompletionAssistantMessageParam & {
    tool_calls: OpenAI.Chat.ChatCompletionMessageToolCall[];
  } {
    return (
      message.role === 'assistant' &&
      'tool_calls' in message &&
      Array.isArray(message.tool_calls)
    );
  }

  function isOpenAISplitMediaMessage(
    message: OpenAI.Chat.ChatCompletionMessageParam,
  ): boolean {
    return (
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some((part) => {
        const typedPart = part as { type?: string };
        return (
          typedPart.type === 'image_url' ||
          typedPart.type === 'input_audio' ||
          typedPart.type === 'video_url' ||
          typedPart.type === 'file'
        );
      })
    );
  }

  describe('stream-local parser state', () => {
    const streamChunk = (
      id: string,
      delta: Record<string, unknown>,
      finishReason: string | null = null,
    ) =>
      ({
        id,
        created: 1,
        model: 'test',
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }) as unknown as OpenAI.Chat.ChatCompletionChunk;

    const emitReasoning = (stream: RequestContext) =>
      converter.convertOpenAIChunkToLlm(
        streamChunk('reasoning', { reasoning_content: 'Let me check.' }),
        stream,
      );

    const emitToolCall = (
      stream: RequestContext,
      content: string,
      toolArguments = '{}',
    ) =>
      converter.convertOpenAIChunkToLlm(
        streamChunk('tool-call', {
          content,
          tool_calls: [
            {
              index: 0,
              id: 'call_read',
              function: { name: 'read_file', arguments: toolArguments },
            },
          ],
        }),
        stream,
      );

    const finishStream = (
      stream: RequestContext,
      finishReason = 'tool_calls',
    ) =>
      converter.convertOpenAIChunkToLlm(
        streamChunk('finish', {}, finishReason),
        stream,
      );

    it('creates fresh parser instances', () => {
      const ctx1 = new StreamingToolCallParser();
      const ctx2 = new StreamingToolCallParser();

      expect(ctx1).toBeInstanceOf(StreamingToolCallParser);
      expect(ctx2).toBeInstanceOf(StreamingToolCallParser);
      expect(ctx1).not.toBe(ctx2);
    });

    it('preserves the provider model from stream chunks', () => {
      const response = converter.convertOpenAIChunkToLlm(
        streamChunk('model', { content: 'ok' }),
        withStreamParser(),
      );

      expect(response.modelVersion).toBe('test');
    });

    it('isolates two contexts so writes to one do not leak into the other', () => {
      // Regression for issue #3516: previously the parser lived on the
      // Converter as an instance field, so two concurrent streams sharing
      // the same Config.contentGenerator would overwrite each other's
      // tool-call buffers. Per-stream contexts eliminate that contention.
      const ctx1 = new StreamingToolCallParser();
      const ctx2 = new StreamingToolCallParser();

      ctx1.addChunk(0, '{"a":1}', 'call_A', 'fn_A');
      ctx2.addChunk(0, '{"b":2}', 'call_B', 'fn_B');

      expect(ctx1.getBuffer(0)).toBe('{"a":1}');
      expect(ctx2.getBuffer(0)).toBe('{"b":2}');
      expect(ctx1.getToolCallMeta(0).id).toBe('call_A');
      expect(ctx2.getToolCallMeta(0).id).toBe('call_B');
    });

    it('ignores replay chunks after an id already has complete JSON args', () => {
      const parser = new StreamingToolCallParser();

      parser.addChunk(0, '{"cmd":"echo hi"}', 'dup_id_0001', 'shell');
      parser.addChunk(0, '{"cmd":"echo hi"}', 'dup_id_0001', 'shell');

      expect(parser.getBuffer(0)).toBe('{"cmd":"echo hi"}');
      expect(parser.getCompletedToolCalls()).toEqual([
        {
          id: 'dup_id_0001',
          name: 'shell',
          args: { cmd: 'echo hi' },
          index: 0,
        },
      ]);
    });

    it('keeps accumulating normal fragmented JSON before it is complete', () => {
      const parser = new StreamingToolCallParser();

      parser.addChunk(0, '{"cmd"', 'call_fragmented', 'shell');
      parser.addChunk(0, ':"echo hi"}', 'call_fragmented', 'shell');

      expect(parser.getCompletedToolCalls()).toEqual([
        {
          id: 'call_fragmented',
          name: 'shell',
          args: { cmd: 'echo hi' },
          index: 0,
        },
      ]);
    });

    it('demuxes interleaved chunks from two concurrent streams correctly (#3516)', () => {
      // Real-world shape: two subagents share one Config (hence one
      // Converter). Their OpenAI streams run concurrently; chunks arrive
      // interleaved at the event loop. Under the pre-fix architecture
      // this corrupted both tool calls; under per-stream contexts each
      // stream's chunks stay in their own parser and close cleanly.
      const streamA = withStreamParser(new StreamingToolCallParser());
      const streamB = withStreamParser(new StreamingToolCallParser());

      const openerA = {
        object: 'chat.completion.chunk',
        id: 'A-open',
        created: 1,
        model: 'test',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_A',
                  type: 'function' as const,
                  function: {
                    name: 'read_file',
                    arguments: '{"file_path":"/a',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const openerB = {
        ...openerA,
        id: 'B-open',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_B',
                  type: 'function' as const,
                  function: {
                    name: 'read_file',
                    arguments: '{"file_path":"/b',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const contA = {
        ...openerA,
        id: 'A-cont',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '/x.ts"}' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const contB = {
        ...openerB,
        id: 'B-cont',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '/y.ts"}' } }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const finisher = (id: string) =>
        ({
          object: 'chat.completion.chunk',
          id,
          created: 2,
          model: 'test',
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'tool_calls',
              logprobs: null,
            },
          ],
        }) as unknown as OpenAI.Chat.ChatCompletionChunk;

      // Interleave the two streams. Pre-fix this produced corrupt JSON
      // because every chunk fed the same shared parser.
      converter.convertOpenAIChunkToLlm(openerA, streamA);
      converter.convertOpenAIChunkToLlm(openerB, streamB);
      converter.convertOpenAIChunkToLlm(contA, streamA);
      converter.convertOpenAIChunkToLlm(contB, streamB);

      const resultA = converter.convertOpenAIChunkToLlm(
        finisher('A-finish'),
        streamA,
      );
      const resultB = converter.convertOpenAIChunkToLlm(
        finisher('B-finish'),
        streamB,
      );

      const fnA = resultA.candidates?.[0]?.content?.parts?.find(
        (p: Part) => p.functionCall,
      )?.functionCall;
      const fnB = resultB.candidates?.[0]?.content?.parts?.find(
        (p: Part) => p.functionCall,
      )?.functionCall;

      expect(fnA?.name).toBe('read_file');
      expect(fnA?.args).toEqual({ file_path: '/a/x.ts' });
      expect(fnA?.id).toBe('call_A');

      expect(fnB?.name).toBe('read_file');
      expect(fnB?.args).toEqual({ file_path: '/b/y.ts' });
      expect(fnB?.id).toBe('call_B');
    });

    it('emits no-argument tool calls that stream an empty arguments string', () => {
      // Providers may finish a no-argument tool call with `arguments: ""`
      // and no follow-up fragment (e.g. llama.cpp-style servers). The call
      // must reach the caller with empty args instead of being dropped,
      // which would make the whole turn look empty and trigger retries.
      const stream = withStreamParser(new StreamingToolCallParser());

      const opener = {
        object: 'chat.completion.chunk',
        id: 'noargs-open',
        created: 1,
        model: 'test',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_noargs',
                  type: 'function' as const,
                  function: { name: 'list_sessions', arguments: '' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      const finisher = {
        object: 'chat.completion.chunk',
        id: 'noargs-finish',
        created: 2,
        model: 'test',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk;

      converter.convertOpenAIChunkToLlm(opener, stream);
      const result = converter.convertOpenAIChunkToLlm(finisher, stream);

      const fn = result.candidates?.[0]?.content?.parts?.find(
        (p: Part) => p.functionCall,
      )?.functionCall;

      expect(fn?.name).toBe('list_sessions');
      expect(fn?.args).toEqual({});
      expect(fn?.id).toBe('call_noargs');
    });

    it('ignores a phantom slot beside a valid tool call', () => {
      const stream = withStreamParser();
      converter.convertOpenAIChunkToLlm(
        streamChunk('open', {
          tool_calls: [
            {
              index: 0,
              id: 'call_edit',
              function: { name: 'edit', arguments: '{}' },
            },
            { index: 1, function: {} },
          ],
        }),
        stream,
      );

      const result = converter.convertOpenAIChunkToLlm(
        streamChunk('finish', {}, 'tool_calls'),
        stream,
      );

      expect(result.candidates?.[0]?.content?.parts).toEqual([
        {
          functionCall: { id: 'call_edit', name: 'edit', args: {} },
        },
      ]);
      expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    });

    it('rejects a tool-call finish without a completed named call', () => {
      const stream = withStreamParser();
      converter.convertOpenAIChunkToLlm(
        streamChunk('open', { tool_calls: [{ index: 0, function: {} }] }),
        stream,
      );

      expect(() =>
        converter.convertOpenAIChunkToLlm(
          streamChunk('finish', {}, 'tool_calls'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'MALFORMED_TOOL_CALL' }));
    });

    it('rejects a tool call that never provides a function name', () => {
      const stream = withStreamParser();
      const partial = converter.convertOpenAIChunkToLlm(
        streamChunk('open', {
          content: 'discard me',
          tool_calls: [
            {
              index: 0,
              id: 'call_without_name',
              function: { arguments: '{"path":"a.ts"}' },
            },
          ],
        }),
        stream,
      );

      expect(partial.candidates?.[0]?.content?.parts).toEqual([]);
      expect(() =>
        converter.convertOpenAIChunkToLlm(
          streamChunk('finish', {}, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'MALFORMED_TOOL_CALL' }));
    });

    it('rejects a protocol-tag recovery with a whitespace-only function name', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      converter.convertOpenAIChunkToLlm(
        streamChunk('tool-call', {
          content: '</think>',
          tool_calls: [
            {
              index: 0,
              id: 'call_blank',
              function: { name: '   ', arguments: '{}' },
            },
          ],
        }),
        stream,
      );

      expect(() => finishStream(stream)).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
      expect(stream.protocolTagSanitized).toBeUndefined();
    });

    it('rejects the recorded cross-channel thinking-tag leak', () => {
      const stream = withStreamParser();
      const reasoning = converter.convertOpenAIChunkToLlm(
        streamChunk('reasoning', {
          reasoning_content: 'Let me check<think>',
        }),
        stream,
      );

      expect(reasoning.candidates?.[0]?.content?.parts).toEqual([]);
      expect(() =>
        converter.convertOpenAIChunkToLlm(
          streamChunk('content', { content: 'the result\n</think>\n' }),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('rejects the recorded content-only nested thinking-tag leak', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const opening = converter.convertOpenAIChunkToLlm(
        streamChunk('opening', { content: '<think>\n\n' }),
        stream,
      );
      const repeatedOpening = converter.convertOpenAIChunkToLlm(
        streamChunk('repeated-opening', { content: '</think><thi' }),
        stream,
      );

      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(repeatedOpening.candidates?.[0]?.content?.parts).toEqual([]);
      const nestedOpening = converter.convertOpenAIChunkToLlm(
        streamChunk('nested-opening', { content: 'nk>9<think>-3' }),
        stream,
      );

      expect(nestedOpening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(() => finishStream(stream)).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    it('rejects the recorded production unclosed <thinking> content leak (issue #6666)', () => {
      // Production capture shape (sanitized): a hybrid-thinking model
      // skipped the reasoning channel entirely and streamed its thinking as
      // literal <thinking> text inside content — no reasoning_content on
      // any chunk, no tool calls, and the tag is never closed before stop.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const opening = converter.convertOpenAIChunkToLlm(
        streamChunk('opening', { content: '<thi' }),
        stream,
      );
      const body = converter.convertOpenAIChunkToLlm(
        streamChunk('body', {
          content:
            'nking>\nThe user wants to query the compute resources for ' +
            'project space 10088. Let me check the available APIs.',
        }),
        stream,
      );

      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(body.candidates?.[0]?.content?.parts).toEqual([]);
      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    // issue #9348: hybrid-thinking models (qwen3-class via OpenAI-compatible
    // proxies) stream a first thinking phase through reasoning_content and may
    // then emit a second, properly balanced <thinking>...</thinking> block
    // inside content. The balanced block is legitimate — rejecting it
    // hard-fails the whole turn (retries regenerate the same shape), which
    // surfaced to users as "[API Error: Model response leaked thinking tags.]".
    it('demotes a balanced inline thinking block to the thought channel when reasoning is present (issue #9348)', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      const reasoning = converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const opening = converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>' }),
        stream,
      );
      const closing = converter.convertOpenAIChunkToGemini(
        streamChunk('closing', { content: 'user asked X</thinking>' }),
        stream,
      );
      const answer = converter.convertOpenAIChunkToGemini(
        streamChunk('answer', { content: 'Answer here.' }, 'stop'),
        stream,
      );

      expect(reasoning.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'Let me think.' },
      ]);
      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(closing.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'user asked X' },
      ]);
      const answerParts = answer.candidates?.[0]?.content?.parts ?? [];
      expect(answerParts).toEqual([{ text: 'Answer here.' }]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
    });

    it('demotes a balanced inline thinking block split across chunks (issue #9348)', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'phase one' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('tag-start', { content: '<thi' }),
        stream,
      );
      const second = converter.convertOpenAIChunkToGemini(
        streamChunk('tag-body', { content: 'nking>recheck</thi' }),
        stream,
      );
      const third = converter.convertOpenAIChunkToGemini(
        streamChunk('tag-close', { content: 'nking>Done.' }, 'stop'),
        stream,
      );

      expect(first.candidates?.[0]?.content?.parts).toEqual([]);
      expect(second.candidates?.[0]?.content?.parts).toEqual([]);
      const parts = third.candidates?.[0]?.content?.parts ?? [];
      expect(parts).toEqual([
        { thought: true, text: 'recheck' },
        { text: 'Done.' },
      ]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
    });

    it('demotes a balanced inline thinking block that arrives in a single content chunk (issue #9348)', () => {
      // Chunking-dependent shape: the first content delta already carries the
      // complete balanced block, so no pending tag candidate exists yet when
      // the inline parser first sees the opening tag.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const block = converter.convertOpenAIChunkToGemini(
        streamChunk('block', {
          content: '<thinking>user asked X</thinking>',
        }),
        stream,
      );
      const answer = converter.convertOpenAIChunkToGemini(
        streamChunk('answer', { content: 'Answer here.' }, 'stop'),
        stream,
      );

      expect(block.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'user asked X' },
      ]);
      expect(answer.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Answer here.' },
      ]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
    });

    it('holds an unclosed inline thinking block that starts in the first content chunk (issue #9348)', () => {
      // Same initial-delta path, but the block does not balance mid-stream:
      // it must be held for a closing tag, then rejected at stream end.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const opening = converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>user asked X' }),
        stream,
      );

      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>user asked X',
      });
      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    it('still rejects an unclosed inline thinking block after reasoning (issue #9348 regression guard)', () => {
      // The fix must not weaken real leak detection: an opening tag that is
      // never balanced by a closing tag remains a PROTOCOL_TAG_LEAK.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('body', { content: 'user asked X' }),
        stream,
      );

      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    it('demotes an empty balanced inline thinking block instead of failing the turn (issue #9348)', () => {
      // An empty (whitespace-only) balanced block still balances. Treating it
      // as "no block balanced" re-held the opener and hard-failed at finish
      // with the exact PROTOCOL_TAG_LEAK error this fix removes.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const answer = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'block',
          { content: '<thinking></thinking>Answer here.' },
          'stop',
        ),
        stream,
      );

      expect(answer.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Answer here.' },
      ]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
    });

    it('demotes a whitespace-only balanced inline thinking block split across chunks (issue #9348)', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const opening = converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>\n' }),
        stream,
      );
      const answer = converter.convertOpenAIChunkToGemini(
        streamChunk('closing', { content: '</thinking>Answer here.' }, 'stop'),
        stream,
      );

      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(answer.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Answer here.' },
      ]);
    });

    it('demotes consecutive balanced inline thinking blocks (issue #9348)', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const blocks = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'blocks',
          { content: '<thinking>a</thinking><thinking>b</thinking>Done.' },
          'stop',
        ),
        stream,
      );

      expect(blocks.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { thought: true, text: 'b' },
        { text: 'Done.' },
      ]);
    });

    it('holds a trailing tag prefix after a demoted block until it balances (issue #9348)', () => {
      // The only branch that keeps a trailing partial tag held after a
      // successful demotion: it must stay held mid-stream and demote once the
      // second block balances.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('first-block', { content: '<thinking>a</thinking><thi' }),
        stream,
      );

      expect(first.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({ text: '<thi' });

      const second = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'second-block',
          { content: 'nking>b</thinking>Done.' },
          'stop',
        ),
        stream,
      );

      expect(second.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { thought: true, text: 'b' },
        { text: 'Done.' },
      ]);
    });

    it('rejects an embedded thinking block after a demoted leading block (issue #9348 fail-closed)', () => {
      // The demotion mechanism exists to stop raw thinking tags from reaching
      // visible output: a complete tag inside the tail released after a
      // demotion is embedded/stray and must fail closed like pre-PR.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk(
            'embedded',
            {
              content:
                '<thinking>a</thinking>Answer <thinking>b</thinking> done',
            },
            'stop',
          ),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('rejects embedded thinking tags arriving after visible content was already emitted (issue #9348 fail-closed)', () => {
      // Chunk-split twin of the interleaved shape: once visible content
      // exists the candidate machinery no longer applies, so the later chunk
      // needs its own fail-closed gate.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );

      expect(first.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { text: 'Answer ' },
      ]);
      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk(
            'embedded',
            { content: '<thinking>b</thinking> done' },
            'stop',
          ),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('rejects an embedded thinking tag assembled across chunk boundaries after a demotion (issue #9348 fail-closed)', () => {
      // Chunk-split twin of the test above: no single chunk contains a
      // complete tag, so the per-chunk gate alone never fires. The demoted
      // turn must keep holding the trailing potential-tag suffix of emitted
      // text and gate on tail + next chunk together.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const leading = converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );

      expect(leading.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { text: 'Answer ' },
      ]);

      const fragment = converter.convertOpenAIChunkToGemini(
        streamChunk('tag-fragment', { content: '<thi' }),
        stream,
      );

      expect(fragment.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingPostDemotionTagTail).toBe('<thi');
      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('tag-completes', { content: 'nking>b</thi' }),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('rejects a thinking tag assembled across many chunks after a demotion (issue #9348 fail-closed)', () => {
      // The rolling tail must survive multiple fragment chunks before the
      // completed tag trips the gate.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('fragment-1', { content: '<thi' }),
        stream,
      );
      const middle = converter.convertOpenAIChunkToGemini(
        streamChunk('fragment-2', { content: 'nki' }),
        stream,
      );

      expect(middle.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingPostDemotionTagTail).toBe('<thinki');
      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk(
            'fragment-3',
            { content: 'ng>b</thinking> done' },
            'stop',
          ),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('fails closed at finish on an unresolved held tag tail after a demotion (issue #9348 fail-closed)', () => {
      // The held trailing suffix contains a full tag word ('<thinking'
      // truncated before '>') and never resolves before the stream ends: it
      // must fail closed instead of being released as literal text, because
      // the chunk-split twin throws via the gate once the tag completes.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      const fragment = converter.convertOpenAIChunkToGemini(
        streamChunk('tag-fragment', { content: '<thinking' }),
        stream,
      );

      expect(fragment.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingPostDemotionTagTail).toBe('<thinking');
      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    it('fails closed at finish on a held closing tag tail after a demotion (issue #9348 fail-closed)', () => {
      // Closing-tag twin of the test above: the held tail '</thinking'
      // contains a full closing tag word truncated before '>'. It pins the
      // closing branch (`\/?`) of the finish-time full-tag-word regex —
      // without that branch the tail would be released as literal text.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      const fragment = converter.convertOpenAIChunkToGemini(
        streamChunk('tag-fragment', { content: '</thinking' }),
        stream,
      );

      expect(fragment.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingPostDemotionTagTail).toBe('</thinking');
      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    it('fails closed when the demotion chunk itself ends in a tag prefix at finish (issue #9348 fail-closed)', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk(
            'demote-and-fragment',
            { content: '<thinking>a</thinking>Answer <thinking' },
            'stop',
          ),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('releases a sub-word tag fragment held at stream finish after a demotion (issue #9348)', () => {
      // max_tokens can truncate visible text on a tag-prefix boundary (e.g.
      // a generic type 'Supplier<T' cut to '<T'). A sub-word fragment cannot
      // become a tag once the stream has ended, so failing closed here would
      // hard-fail a legitimate demoted turn with the exact error the
      // demotion route exists to remove — and the tag-leak retry budget
      // would regenerate the same truncation.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      const truncated = converter.convertOpenAIChunkToGemini(
        streamChunk('truncated', { content: 'Supplier<T' }, 'length'),
        stream,
      );

      expect(truncated.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Supplier<T' },
      ]);
      expect(stream.pendingPostDemotionTagTail).toBeUndefined();
    });

    it('fails closed on an over-cap still-completable tag tail after a demotion (issue #9348 fail-closed)', () => {
      // A whitespace-padded tag assembled across chunks: the tag grammar
      // allows unbounded whitespace inside a tag, so '<thinking' + 200
      // spaces can still complete into one. Releasing the suffix once it
      // outgrows the candidate cap would let the padded tag slip past the
      // fail-closed gate, so the overflow fails closed like the candidate
      // machinery's isPossibleTag overflow branch.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('padded-tag', {
            content: `<thinking${' '.repeat(200)}`,
          }),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('fails closed when a held tag tail grows past the cap on padding alone (issue #9348 fail-closed)', () => {
      // The over-cap check must also fire when the still-completable tail
      // was held under the cap and only later padding pushes it over.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      const held = converter.convertOpenAIChunkToGemini(
        streamChunk('tag-fragment', {
          content: `<thinking${' '.repeat(100)}`,
        }),
        stream,
      );

      expect(held.candidates?.[0]?.content?.parts).toEqual([]);
      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('padding', { content: ' '.repeat(100) }),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('demotes a nested balanced inline thinking block (issue #9348)', () => {
      // The demotion split must count depth: returning at the first closer
      // would leave ' end</thinking>Answer' as rest, which the post-demotion
      // gate then hard-fails as a stray tag.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const block = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'nested-block',
          {
            content:
              '<thinking>outer <thinking>inner</thinking> end</thinking>Answer',
          },
          'stop',
        ),
        stream,
      );

      expect(block.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'outer <thinking>inner</thinking> end' },
        { text: 'Answer' },
      ]);
    });

    it('demotes a nested balanced inline thinking block split across chunks (issue #9348)', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('nested-start', {
          content: '<thinking>outer <thinking>in',
        }),
        stream,
      );
      const second = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'nested-rest',
          { content: 'ner</thinking> end</thinking>Answer' },
          'stop',
        ),
        stream,
      );

      expect(first.candidates?.[0]?.content?.parts).toEqual([]);
      expect(second.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'outer <thinking>inner</thinking> end' },
        { text: 'Answer' },
      ]);
    });

    it('demotes an uppercase inline thinking block after reasoning (issue #9348)', () => {
      // The demotion grammar is declared case-insensitive; pin it so
      // stripping the `i` flag cannot silently regress the route.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const block = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'uppercase-block',
          { content: '<THINKING>x</THINKING>Answer' },
          'stop',
        ),
        stream,
      );

      expect(block.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'x' },
        { text: 'Answer' },
      ]);
    });

    it('demotes an inline thinking block with whitespace inside the tags (issue #9348)', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const block = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'spaced-block',
          { content: '<thinking >x</thinking >Answer' },
          'stop',
        ),
        stream,
      );

      expect(block.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'x' },
        { text: 'Answer' },
      ]);
    });

    it('drops an exact replay of the demotion chunk instead of failing closed (issue #9348)', () => {
      // Providers re-send deltas (see normalizeStreamingTextDelta), and a
      // replay shorter than the normalizer's exact-repeat window passes
      // through verbatim. Re-entering the gate with the already-consumed
      // tags would hard-fail a legitimate demoted turn with
      // PROTOCOL_TAG_LEAK — the exact error the demotion route removes.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>x</thinking>Ok' }),
        stream,
      );
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'x' },
        { text: 'Ok' },
      ]);

      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk('replay', { content: '<thinking>x</thinking>Ok' }, 'stop'),
        stream,
      );

      expect(replay.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
      expect(stream.pendingPostDemotionTagTail).toBeUndefined();
    });

    it('drops a cumulative replay whose leading whitespace was emitted before demotion (issue #9348)', () => {
      // A whitespace-only content delta arriving before any reasoning_content
      // cannot be held (no structured reasoning yet) and does not set
      // hasVisibleContent (/\S/ is false), so it is emitted verbatim and
      // excluded from the demotion-seeded replay baseline. The provider's
      // cumulative re-send includes it, and inside the normalizer's short
      // exact-repeat window the replay passes through verbatim — equality and
      // startsWith against the unaligned baseline both miss, so the
      // post-demotion tag-tail defense would fail-closed a legitimate demoted
      // turn with PROTOCOL_TAG_LEAK.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      const pre = converter.convertOpenAIChunkToGemini(
        streamChunk('pre', { content: ' ' }),
        stream,
      );
      expect(pre.candidates?.[0]?.content?.parts).toEqual([{ text: ' ' }]);
      expect(stream.hasVisibleContent).toBeUndefined();

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>x</thinking>Ok' }),
        stream,
      );
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'x' },
        { text: 'Ok' },
      ]);

      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk('replay', { content: ' <thinking>x</thinking>Ok' }, 'stop'),
        stream,
      );

      expect(replay.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
      expect(stream.pendingPostDemotionTagTail).toBeUndefined();
    });

    it('strips the accepted prefix from a cumulative superset carrying pre-demotion whitespace (issue #9348)', () => {
      // startsWith twin of the leading-whitespace replay: the baseline lacks
      // the replay's leading whitespace, so the slice offset must account for
      // it or the remainder is sliced from the wrong position. A diverged
      // normalizer baseline makes the normalizer's exit-cumulative path emit
      // the replay verbatim so the converter branch actually runs.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('pre', { content: ' ' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>x</thinking>Ok' }),
        stream,
      );
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'x' },
        { text: 'Ok' },
      ]);

      stream.textDeltaState = {
        emittedText: '<diverged-baseline>',
        emittedLength: 19,
        cumulativeMode: true,
      };
      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'cumulative-replay',
          { content: ' <thinking>x</thinking>OkMore' },
          'stop',
        ),
        stream,
      );

      expect(replay.candidates?.[0]?.content?.parts).toEqual([
        { text: 'More' },
      ]);
    });

    it('strips the held candidate prefix from a renormalized cumulative superset replay before demotion (issue #9348)', () => {
      // Pre-demotion twin of the post-demotion replay alignment: while the
      // opening block is still held as a candidate, a cumulative provider
      // replay renormalized against the delta history — here the
      // renormalization stripped the leading whitespace the held candidate
      // carries — passes through normalizeStreamingTextDelta unsliced.
      // Concatenating it onto the pending candidate duplicated the held
      // prefix, guaranteed the block never balanced, and the finish chunk
      // threw PROTOCOL_TAG_LEAK on a legitimate turn — the exact error the
      // demotion route exists to remove.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const whitespace = converter.convertOpenAIChunkToGemini(
        streamChunk('whitespace', { content: ' ' }),
        stream,
      );
      const opening = converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>x' }),
        stream,
      );

      expect(whitespace.candidates?.[0]?.content?.parts).toEqual([]);
      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: ' <thinking>x',
      });

      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk('cumulative-replay', {
          content: '<thinking>xyz</thinking>Answer',
        }),
        stream,
      );

      expect(replay.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'xyz' },
        { text: 'Answer' },
      ]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
      expect(stream.inlineThinkingBlockDemoted).toBe(true);

      // The finish chunk must complete cleanly instead of throwing
      // PROTOCOL_TAG_LEAK on the balanced turn.
      const finish = converter.convertOpenAIChunkToGemini(
        streamChunk('finish', {}, 'stop'),
        stream,
      );
      expect(finish.candidates?.[0]?.content?.parts ?? []).toEqual([]);
    });

    it('preserves a genuine delta equal to the held tag tail after a demotion (issue #9348)', () => {
      // Tail equality alone is not replay evidence: adjacent genuine deltas
      // may carry identical tag-like text and both must survive.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('tag-fragment', { content: '<thi' }),
        stream,
      );
      const repeated = converter.convertOpenAIChunkToGemini(
        streamChunk('repeated', { content: '<thi' }),
        stream,
      );

      expect(repeated.candidates?.[0]?.content?.parts).toEqual([
        { text: '<thi' },
      ]);
      expect(stream.pendingPostDemotionTagTail).toBe('<thi');

      const resolved = converter.convertOpenAIChunkToGemini(
        streamChunk('resolved', { content: 's is not a tag.' }, 'stop'),
        stream,
      );
      expect(resolved.candidates?.[0]?.content?.parts).toEqual([
        { text: '<this is not a tag.' },
      ]);
    });

    it('drops an exact replay while a demotion rest is still held (issue #9348)', () => {
      // While the rest of a demotion chunk is held as a pending candidate, a
      // replayed chunk equals neither the candidate nor emitted text, so the
      // pre-demotion replay guards never fire — dropping it needs the
      // consumed-content tracking.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('block', {
          content: '<thinking>x</thinking><thinking>y',
        }),
        stream,
      );
      // The demoted thought is buffered behind the held rest (the standard
      // pending-candidate parts hold), not emitted yet.
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>y',
      });

      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk('replay', {
          content: '<thinking>x</thinking><thinking>y',
        }),
        stream,
      );
      expect(replay.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>y',
      });

      const rest = converter.convertOpenAIChunkToGemini(
        streamChunk('rest', { content: ' inner</thinking>Answer' }, 'stop'),
        stream,
      );
      expect(rest.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'x' },
        { thought: true, text: 'y inner' },
        { text: 'Answer' },
      ]);
    });

    it('drops an exact replay of a demotion chunk with a whitespace-only rest (issue #9348)', () => {
      // A whitespace-only rest releases as visible text, so the replayed
      // chunk would demote a second time and duplicate the thought part.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>x</thinking>  ' }),
        stream,
      );
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'x' },
        { text: '  ' },
      ]);

      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk('replay', { content: '<thinking>x</thinking>  ' }, 'stop'),
        stream,
      );
      expect(replay.candidates?.[0]?.content?.parts).toEqual([]);
    });

    it('preserves genuine repeated deltas and rejects genuine tag chunks after demotion (issue #9348)', () => {
      const repeated = withStreamParser();
      repeated.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        repeated,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('block', {
          content: '<thinking>a</thinking>x = a <',
        }),
        repeated,
      );
      const second = converter.convertOpenAIChunkToGemini(
        streamChunk('repeat', { content: '<' }),
        repeated,
      );
      const third = converter.convertOpenAIChunkToGemini(
        streamChunk('rest', { content: ' b' }, 'stop'),
        repeated,
      );
      expect(
        [first, second, third]
          .flatMap((response) => response.candidates?.[0]?.content?.parts ?? [])
          .filter((part) => part.thought !== true)
          .map((part) => part.text ?? '')
          .join(''),
      ).toBe('x = a << b');

      const stray = withStreamParser();
      stray.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stray,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>x</thinking>' }),
        stray,
      );
      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('stray', { content: '</thinking>' }, 'stop'),
          stray,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('strips the accepted prefix from cumulative supersets after demotion (issue #9348)', () => {
      // The leading ' ' content delta keeps textDeltaState.emittedText from
      // prefixing the cumulative replay, so the replay passes through
      // normalizeStreamingTextDelta unsliced and actually reaches the
      // converter's startsWith strip branch. Without it the normalizer
      // enters cumulative mode and slices the prefix before the converter
      // ever sees it, leaving the branch unexecuted.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      converter.convertOpenAIChunkToGemini(
        streamChunk('pre', { content: ' ' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>x</thinking>Ok' }),
        stream,
      );
      const second = converter.convertOpenAIChunkToGemini(
        streamChunk('more', { content: 'More' }),
        stream,
      );
      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'cumulative-replay',
          { content: '<thinking>x</thinking>OkMoreDone' },
          'stop',
        ),
        stream,
      );

      expect(
        [first, second, replay]
          .flatMap((response) => response.candidates?.[0]?.content?.parts ?? [])
          .filter((part) => part.thought !== true)
          .map((part) => part.text ?? '')
          .join(''),
      ).toBe('OkMoreDone');
      expect(replay.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Done' },
      ]);
    });

    it('drops a cumulative replay spanning multiple demotions (issue #9348)', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('first', { content: '<thinking>a</thinking> ' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('second', { content: '<thinking>b</thinking> ' }),
        stream,
      );
      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'replay',
          { content: '<thinking>a</thinking> <thinking>b</thinking> ' },
          'stop',
        ),
        stream,
      );

      expect(replay.candidates?.[0]?.content?.parts).toEqual([]);
    });

    it('fails closed on a tag-carrying prefix re-send after visible content instead of dropping it (issue #9348 inverted direction)', () => {
      // Inverted failure direction: a proper-prefix re-send of the baseline
      // carrying a full tag is no longer dropped, because content comparison
      // cannot tell a provider rewind apart from a genuine consecutive block
      // opener — every demotion-seeded baseline starts with '<thinking>',
      // so any genuine new block opener prefixes the baseline and the old
      // rewind drop corrupted genuine consecutive blocks (the lone
      // '<thinking>' probe). Once visible content exists the candidate
      // machinery is disengaged, so the appended complete tag fails closed
      // mid-stream — chunking-consistent with the single-chunk twin, which
      // also fails closed on a complete tag after a demotion.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>x</thinking>OkMore' }),
        stream,
      );
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'x' },
        { text: 'OkMore' },
      ]);

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('rewind-replay', {
            content: '<thinking>x</thinking>Ok',
          }),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('demotes a genuine nested opening tag arriving as its own delta (issue #9348 inverted direction)', () => {
      // Entrance A: a genuine nested opening tag arriving as its own delta —
      // chunks '<thinking>a' / '<thinking>' / 'b</thinking></thinking>Answer'
      // + stop. The lone '<thinking>' delta prefixes the held candidate, so
      // the old rewind-replay disjunct dropped it; the balance walk then
      // closed at the first closer and the leftover rest threw
      // PROTOCOL_TAG_LEAK on the legitimate turn, while the identical bytes
      // in one chunk demoted cleanly. Prefix re-sends are appended instead,
      // so the depth-counting scanner absorbs the nested block and the
      // outcome matches the single-chunk twin.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const opening = converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>a' }),
        stream,
      );
      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>a',
      });

      const nested = converter.convertOpenAIChunkToGemini(
        streamChunk('nested-opening', { content: '<thinking>' }),
        stream,
      );
      expect(nested.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>a<thinking>',
      });

      const rest = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'rest',
          { content: 'b</thinking></thinking>Answer' },
          'stop',
        ),
        stream,
      );
      expect(rest.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a<thinking>b</thinking>' },
        { text: 'Answer' },
      ]);
    });

    it('fails closed when an appended prefix re-send never re-balances (issue #9348 inverted direction)', () => {
      // Degradation side of the inversion: when the appended prefix re-send
      // is a true rewind (chunks '<thinking>x' / '<thinking>' /
      // '</thinking>Answer'), the combined candidate re-held as
      // '<thinking>x<thinking>' never balances and the finish chunk fails
      // closed instead of the old silent drop. Accepted trade: the genuine
      // nested shape above must not be dropped, and the two shapes are
      // undecidable against content comparison.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>x' }),
        stream,
      );
      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk('rewind-replay', { content: '<thinking>' }),
        stream,
      );
      expect(replay.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>x<thinking>',
      });

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('rest', { content: '</thinking>Answer' }, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('appends a demoted-block replay arriving while a sub-word rest is held and fails closed when the rest never recombines (issue #9348 inverted direction)', () => {
      // Inverted failure direction: the replay re-sending the demoted block
      // is a proper prefix of the baseline carrying a full tag. It is no
      // longer dropped (a genuine consecutive block opener is
      // indistinguishable from it); the held-candidate strip reassembles it
      // against the sub-word rest and the block re-demotes, duplicating the
      // thought inside the hidden channel. When the provider's continuation
      // then fails to recombine the sub-word rest, the complete tag fails
      // closed instead of leaking — accepted trade for keeping genuine
      // consecutive blocks intact.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>p1</thinking><think' }),
        stream,
      );
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({ text: '<think' });

      const replay = converter.convertOpenAIChunkToGemini(
        streamChunk('replay', { content: '<thinking>p1</thinking>' }),
        stream,
      );
      expect(replay.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'p1' },
        { thought: true, text: 'p1' },
      ]);
      // The baseline accumulates the post-strip reassembled content, not the
      // raw replay.
      expect(stream.postDemotionReplayText).toBe(
        '<thinking>p1</thinking><thinking>p1</thinking>',
      );

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('rest', { content: 'ing>p2</thinking>' }, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('fails closed when a superset resend arrives while a post-demotion rest is held (issue #9348 R9-3 accepted degradation)', () => {
      // The R9-3 scenario (chunks '<thinking>a</thinking><thinking>b' demote
      // block 1 and hold rest '<thinking>b', then the renormalized resend
      // '<thinking>b</thinking>X' followed by a cumulative redelivery) is
      // undecidable against content comparison from the R8-1 genuine nested
      // shape: the resend carries a full opening tag word while an
      // opening-block rest is held, exactly like a genuine nested block
      // restarting with the held candidate's bytes. The strip no longer
      // reassembles that shape (it consumed genuine nested openers), the
      // resend is appended instead, and the compounded renormalized-resend
      // + cumulative-redelivery anomaly degrades to fail-closed at finish —
      // the same degradation the inversion accepts for the sibling
      // undecidable corners. The baseline still accumulates the accepted
      // (appended) content.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('block', {
          content: '<thinking>a</thinking><thinking>b',
        }),
        stream,
      );
      // The demoted thought is buffered behind the held rest, not emitted.
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>b',
      });

      const resend = converter.convertOpenAIChunkToGemini(
        streamChunk('superset-resend', {
          content: '<thinking>b</thinking>X',
        }),
        stream,
      );
      expect(resend.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>b<thinking>b</thinking>X',
      });
      expect(stream.postDemotionReplayText).toBe(
        '<thinking>a</thinking><thinking>b<thinking>b</thinking>X',
      );

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk(
            'cumulative-redelivery',
            { content: '<thinking>a</thinking><thinking>b</thinking>XY' },
            'stop',
          ),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('demotes genuine consecutive inline thinking blocks split one opener per chunk (issue #9348 inverted direction)', () => {
      // Entrance B: after a demotion the baseline always starts with
      // '<thinking>', so a lone genuine consecutive opener used to match the
      // post-demotion rewind drop and vanish; the following body then threw
      // PROTOCOL_TAG_LEAK. Appended instead, the opener re-enters the
      // candidate machinery and the second block demotes — matching the
      // single-chunk twin [{thought:'a'},{thought:'b'},{text:'Done'}].
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('first', { content: '<thinking>a</thinking>' }),
        stream,
      );
      expect(first.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
      ]);

      const opener = converter.convertOpenAIChunkToGemini(
        streamChunk('second-opening', { content: '<thinking>' }),
        stream,
      );
      expect(opener.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>',
      });

      const second = converter.convertOpenAIChunkToGemini(
        streamChunk('second-rest', { content: 'b</thinking>Done' }, 'stop'),
        stream,
      );
      expect(second.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'b' },
        { text: 'Done' },
      ]);
      expect(stream.postDemotionReplayText).toBe(
        '<thinking>a</thinking><thinking>b</thinking>Done',
      );
    });

    it('fails closed on an unclosed block opened after visible content, chunk-consistent with the single-chunk twin (issue #9348 inverted direction)', () => {
      // Entrance B witness: '<thinking>a</thinking>Answer ' / '<thinking>' /
      // 'raw thought body' + stop. The lone opener after visible content is
      // appended (not dropped), so the post-demotion tag-tail gate fails
      // closed on the complete tag — the same outcome as the single-chunk
      // twin, which demotes block a and rejects the unclosed rest. The old
      // rewind drop leaked the unclosed block body as visible text instead.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('first', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      expect(first.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { text: 'Answer ' },
      ]);

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('second-opening', { content: '<thinking>' }),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('does not strip a net-closing superset delta that restarts with the held candidate (issue #9348 inverted direction)', () => {
      // Entrance C: a genuine nested continuation whose prefix coincidentally
      // equals the held candidate (chunks '<thinking>a' /
      // '<thinking>a</thinking></thinking>Answer' + stop) used to be
      // stripped into the early-balancing '<thinking>a</thinking>' whose
      // leftover stray closer threw mid-stream. The delta net-closes the
      // held depth (more closers than openers), which a renormalized resend
      // of the candidate never does, so the strip skips it and the
      // depth-counting scanner absorbs the nested block. The diverged
      // normalizer baseline makes the delta reach the converter unsliced.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const opening = converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>a' }),
        stream,
      );
      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>a',
      });

      stream.textDeltaState = {
        emittedText: '<diverged-baseline>',
        emittedLength: 19,
        cumulativeMode: true,
      };
      const nested = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'nested-continuation',
          { content: '<thinking>a</thinking></thinking>Answer' },
          'stop',
        ),
        stream,
      );
      expect(nested.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a<thinking>a</thinking>' },
        { text: 'Answer' },
      ]);
    });

    it('re-assembles a renormalized re-send onto a closing-shaped candidate (issue #9348 R10-1)', () => {
      // An incomplete stray closer '\n</thinki' is held without
      // closingTagName (the '>' has not arrived). Its renormalized
      // cumulative re-send '</thinking>' (the leading '\n' dropped by the
      // transport) IS net-closing — a closing-shaped candidate has no open
      // depth — so the entrance-C net-closing direction guard must not
      // apply to it: the guard's premise (a re-send re-opens at least as
      // much as it closes) holds only for opening-block candidates. With
      // the guard skipped the superset strip re-assembles the re-send onto
      // the closingTagName route instead of concatenating raw
      // '\n</thinki</thinking>' garbage into visible output.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const prefix = converter.convertOpenAIChunkToGemini(
        streamChunk('closer-prefix', { content: '\n</thinki' }),
        stream,
      );
      expect(prefix.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '\n</thinki',
      });

      const resend = converter.convertOpenAIChunkToGemini(
        streamChunk('closer-resend', { content: '</thinking>' }),
        stream,
      );
      expect(resend.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '</thinking>',
        closingTagName: 'thinking',
      });

      // The stray closer resolves via the closingTagName route (fail-closed
      // at a plain 'stop' finish), never as raw released text.
      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('finish', {}, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('re-assembles a chunk-split closing tag continuation onto the closingTagName route (issue #9348 R10-1 twin)', () => {
      // Chunk-split twin of the renormalized re-send: '\n</thinki' followed
      // by the genuine continuation 'ng>'. Both routes must land on the
      // closingTagName machinery regardless of stream chunking.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const prefix = converter.convertOpenAIChunkToGemini(
        streamChunk('closer-prefix', { content: '\n</thinki' }),
        stream,
      );
      expect(prefix.candidates?.[0]?.content?.parts).toEqual([]);

      const continuation = converter.convertOpenAIChunkToGemini(
        streamChunk('closer-rest', { content: 'ng>' }),
        stream,
      );
      expect(continuation.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '</thinking>',
        closingTagName: 'thinking',
      });

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('finish', {}, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('appends an equal re-send carrying a full opening tag word while the block is held (issue #9348 R8-1)', () => {
      // Entrance 1: content equality cannot tell a provider rewind apart
      // from a genuine nested opening tag arriving as its own delta —
      // chunks '<thinking>' / '<thinking>' /
      // 'inner</thinking>outer</thinking>Answer' used to drop the second
      // '<thinking>' (byte-equal to the held candidate) and throw
      // PROTOCOL_TAG_LEAK at finish, while the identical bytes in one chunk
      // demote cleanly. An equal re-send carrying a full opening tag word
      // is appended instead; a true rewind degrades to duplicated hidden
      // channel content (or fail-closed if it never re-balances), matching
      // the direction the inversion chose for the sibling undecidable case.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const opening = converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>' }),
        stream,
      );
      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);

      const repeated = converter.convertOpenAIChunkToGemini(
        streamChunk('repeated-opening', { content: '<thinking>' }),
        stream,
      );
      expect(repeated.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking><thinking>',
      });

      const rest = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'rest',
          { content: 'inner</thinking>outer</thinking>Answer' },
          'stop',
        ),
        stream,
      );
      expect(rest.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: '<thinking>inner</thinking>outer' },
        { text: 'Answer' },
      ]);
    });

    it('appends a consecutive block equal to a blocks-only post-demotion baseline (issue #9348 R8-1)', () => {
      // Post-demotion twin of the equality entrance: after a demotion that
      // ended exactly on a block boundary the baseline is balanced blocks
      // only, and a genuine consecutive identical block arriving as one
      // delta is byte-equal to it. Dropping the equality silently loses the
      // second block (the single-chunk twin yields two thought parts), so a
      // blocks-only baseline equality is appended; equality against a
      // baseline that already carries visible content remains an exact
      // replay and is still dropped.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('first-block', { content: '<thinking>a</thinking>' }),
        stream,
      );
      expect(first.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
      ]);

      const second = converter.convertOpenAIChunkToGemini(
        streamChunk('second-block', { content: '<thinking>a</thinking>' }),
        stream,
      );
      expect(second.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
      ]);
      expect(stream.postDemotionReplayText).toBe(
        '<thinking>a</thinking><thinking>a</thinking>',
      );

      const finish = converter.convertOpenAIChunkToGemini(
        streamChunk('finish', {}, 'stop'),
        stream,
      );
      expect(finish.candidates?.[0]?.content?.parts ?? []).toEqual([]);
    });

    it('appends a net-zero superset delta carrying a full opening tag word instead of stripping it (issue #9348 R8-1)', () => {
      // Entrance 2: a genuine nested block can restart with the held
      // candidate's bytes — chunks '<thinking>a</thinking><thinking>b' /
      // '<thinking>b</thinking>' / 'c</thinking>Answer' used to be stripped
      // (the still-open nested block is net-zero, so the net-closing guard
      // let the strip fire), consuming the nested opener and throwing
      // PROTOCOL_TAG_LEAK at finish, while the single-chunk twin demotes
      // cleanly. A superset delta carrying a full opening tag word is
      // appended instead while an opening-block candidate is held; a true
      // renormalized re-send degrades to fail-closed at finish — accepted
      // trade, see the R9-3 degradation test.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('first-block', {
          content: '<thinking>a</thinking><thinking>b',
        }),
        stream,
      );
      // The demoted thought is buffered behind the held rest (the standard
      // pending-candidate parts hold), not emitted yet.
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>b',
      });

      const nested = converter.convertOpenAIChunkToGemini(
        streamChunk('nested-restart', { content: '<thinking>b</thinking>' }),
        stream,
      );
      expect(nested.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>b<thinking>b</thinking>',
      });

      const rest = converter.convertOpenAIChunkToGemini(
        streamChunk('rest', { content: 'c</thinking>Answer' }, 'stop'),
        stream,
      );
      expect(rest.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { thought: true, text: 'b<thinking>b</thinking>c' },
        { text: 'Answer' },
      ]);
    });

    it('does not slice a nested opener off a prefix-overlapping chunk while an opening block is held (issue #9348 R8-1)', () => {
      // Entrance 3: the normalizer's prefix-overlap branch sliced the
      // nested opener off before the guard zone ever saw it — chunks
      // '<thinking>' / '<thinking>inner</thinking>' /
      // 'outer</thinking>Answer' used to throw PROTOCOL_TAG_LEAK while the
      // identical bytes in one chunk demote cleanly. While a pre-demotion
      // opening-block candidate is held, a prefix-overlapping chunk
      // carrying a full opening tag word is emitted verbatim instead of
      // being sliced against the baseline; a true cumulative rewind then
      // degrades to duplicated hidden-channel content absorbed by the
      // depth-counting scanner.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const opening = converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>' }),
        stream,
      );
      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);

      const nested = converter.convertOpenAIChunkToGemini(
        streamChunk('nested-block', { content: '<thinking>inner</thinking>' }),
        stream,
      );
      expect(nested.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking><thinking>inner</thinking>',
      });

      const rest = converter.convertOpenAIChunkToGemini(
        streamChunk('rest', { content: 'outer</thinking>Answer' }, 'stop'),
        stream,
      );
      expect(rest.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: '<thinking>inner</thinking>outer' },
        { text: 'Answer' },
      ]);
    });

    it('demotes a held balanced block delivered by per-token cumulative snapshots (issue #9348 R11-2)', () => {
      // Entrance 2 regime gate: ordinary cumulative delivery — no replay —
      // of a held balanced block used to throw PROTOCOL_TAG_LEAK at finish.
      // Monotonic snapshots '<thinking>' → '<thinking>b' → … →
      // '<thinking>body</thinking>' → '<thinking>body</thinking>Answer'
      // reach the strip zone on the tag-hold overlap-verbatim regime, where
      // the closer-leading remainder is the held block's OWN completion;
      // entrance 2 read it as a genuine nested respell and appended the
      // whole snapshot, re-spelling the opener+body into the candidate so
      // the block never balanced. The identical stream with the closer
      // split across snapshots demoted cleanly. Overlap-regime
      // closer-leading remainders strip instead; only genuinely fresh
      // deltas keep the R8-1 append direction.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      for (const snapshot of [
        '<thinking>',
        '<thinking>b',
        '<thinking>bo',
        '<thinking>bod',
        '<thinking>body',
      ]) {
        expect(
          converter.convertOpenAIChunkToGemini(
            streamChunk(`snapshot-${snapshot.length}`, { content: snapshot }),
            stream,
          ).candidates?.[0]?.content?.parts,
        ).toEqual([]);
      }

      const completed = converter.convertOpenAIChunkToGemini(
        streamChunk('snapshot-complete', {
          content: '<thinking>body</thinking>',
        }),
        stream,
      );
      expect(completed.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'body' },
      ]);

      const finish = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'answer',
          { content: '<thinking>body</thinking>Answer' },
          'stop',
        ),
        stream,
      );
      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Answer' },
      ]);
    });

    it('recombines a sub-word held candidate with its cumulative re-send instead of leaking raw tags (issue #9348 R11-2)', () => {
      // Sub-word entrance: tagHoldActive used to fire for sub-word held
      // candidates ('<t', '<thi'), verbatim-emitting a cumulative re-send
      // the superset strip is gated off for (the strip needs a full tag
      // word in the candidate). The re-send concatenated onto the
      // candidate and reached visible output as raw tags —
      // '<t<thinking>body</thinking>Answer' — where the single-chunk twin
      // demoted cleanly. Sub-word candidates are restricted out of the
      // verbatim guard: slicing the overlap recombines the suffix with the
      // held prefix in the guard zone.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const subword = converter.convertOpenAIChunkToGemini(
        streamChunk('sub-word', { content: '<t' }),
        stream,
      );
      expect(subword.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({ text: '<t' });

      const resend = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'cumulative-resend',
          { content: '<thinking>body</thinking>Answer' },
          'stop',
        ),
        stream,
      );
      expect(resend.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'body' },
        { text: 'Answer' },
      ]);
    });

    it('appends a fresh nested respell whose body ends in whitespace (issue #9348 R11-2)', () => {
      // Entrance 2's closer anchor used to require the closing tag
      // immediately after the candidate prefix: a nested body ending in
      // whitespace ('<thinking>b </thinking>' as a fresh respell delta)
      // missed the anchor, was stripped, demoted early, and the turn threw
      // PROTOCOL_TAG_LEAK when the genuine outer closer arrived. The anchor
      // is whitespace-tolerant on genuinely fresh deltas.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const demoted = converter.convertOpenAIChunkToGemini(
        streamChunk('first-block', {
          content: '<thinking>a</thinking><thinking>b',
        }),
        stream,
      );
      expect(demoted.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>b',
      });

      const nested = converter.convertOpenAIChunkToGemini(
        streamChunk('nested-respell', { content: '<thinking>b </thinking>' }),
        stream,
      );
      expect(nested.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>b<thinking>b </thinking>',
      });

      const rest = converter.convertOpenAIChunkToGemini(
        streamChunk('rest', { content: 'c</thinking>Answer' }, 'stop'),
        stream,
      );
      expect(rest.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { thought: true, text: 'b<thinking>b </thinking>c' },
        { text: 'Answer' },
      ]);
    });

    it('does not inflate emittedLength when the tag-hold overlap guard fires on a long snapshot (issue #9348 R11-3)', () => {
      // `state.emittedLength += rawDelta.length` on the non-cumulative
      // tag-hold overlap guard double-counted the overlap bytes — the held
      // candidate, already counted when first normalized. Once the guard
      // fired on a snapshot at or above the detection window, the inflated
      // total made baselineFrozenAtCap fire on the next cumulative
      // transition and re-emit the whole cumulative text, including the raw
      // thinking block, as a fresh visible delta. The cumulative-mode twin
      // guard already assigns; the non-cumulative guard must too.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>' }),
        stream,
      );
      const seeded = converter.convertOpenAIChunkToGemini(
        streamChunk('seed', { content: '<thinking>x' }),
        stream,
      );
      expect(seeded.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>x',
      });

      const body = `x${'y'.repeat(1100)}`;
      const snapshot = `<thinking>${body}</thinking>`;
      const completed = converter.convertOpenAIChunkToGemini(
        streamChunk('snapshot', { content: snapshot }),
        stream,
      );
      expect(completed.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: body },
      ]);
      expect(stream.textDeltaState?.emittedLength).toBe(snapshot.length);

      const finish = converter.convertOpenAIChunkToGemini(
        streamChunk('answer', { content: `${snapshot}Answer` }, 'stop'),
        stream,
      );
      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Answer' },
      ]);
    });

    it('emits a >=64-byte held-candidate respell through the tag-hold guard instead of suppressing it (issue #9348)', () => {
      // The exact-repeat branch suppressed >=64-byte re-sends of the held
      // snapshot before the guard zone existed — and with them a genuine
      // nested re-spell byte-equal to the held candidate. The nested opener
      // was lost, the block never balanced, and the turn failed closed when
      // the closers arrived, chunking-dependently against the single-chunk
      // twin (measured boundary: a 63-byte candidate survived, 64-byte
      // threw). The tag-hold verbatim guard now covers the exact-repeat
      // branch like the two prefix-overlap branches: the respell is emitted
      // with the regime signal and the guard zone's equality entrance
      // appends it, matching the pinned R8-1 horn the sub-64-byte short
      // exact repeat already rides. A >=64-byte TRUE re-send degrades to
      // the same duplicated/fail-closed hidden-channel horn as its
      // sub-64-byte twin.
      const candidate = `<thinking>${'x'.repeat(54)}`; // 64 bytes
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('held', { content: candidate }),
        stream,
      );
      const respell = converter.convertOpenAIChunkToGemini(
        streamChunk('nested-respell', { content: candidate }),
        stream,
      );
      expect(respell.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: candidate + candidate,
      });

      const rest = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'rest',
          { content: '</thinking></thinking>Answer' },
          'stop',
        ),
        stream,
      );
      // Matches the single-chunk twin.
      expect(rest.candidates?.[0]?.content?.parts).toEqual([
        {
          thought: true,
          text: `${'x'.repeat(54)}<thinking>${'x'.repeat(54)}</thinking>`,
        },
        { text: 'Answer' },
      ]);
    });

    it('keeps a blocks-only prefix replay whole instead of stripping the repeated block (issue #9348)', () => {
      // The post-demotion prefix strip lacked the equality branch's
      // blocks-only exception: after demoting '<thinking>a</thinking>', a
      // genuine consecutive identical block run chunked together with a
      // further block (' <thinking>a</thinking> <thinking>b</thinking>')
      // prefix-matched the blocks-only baseline and was stripped to
      // ' <thinking>b</thinking>', silently losing the repeated thought
      // where both single-chunk twins yield it. The exception now covers
      // the prefix branch: a blocks-only stripped prefix is appended, and a
      // true cumulative superset degrades to a duplicated thought inside
      // the hidden channel, matching the equality branch's pinned horn.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('first-block', { content: '<thinking>a</thinking>' }),
        stream,
      );
      expect(first.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
      ]);

      const bundled = converter.convertOpenAIChunkToGemini(
        streamChunk('bundled-blocks', {
          content: ' <thinking>a</thinking> <thinking>b</thinking>',
        }),
        stream,
      );
      expect(bundled.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { thought: true, text: 'b' },
      ]);
      expect(stream.postDemotionReplayText).toBe(
        '<thinking>a</thinking> <thinking>a</thinking> <thinking>b</thinking>',
      );

      const finish = converter.convertOpenAIChunkToGemini(
        streamChunk('finish', {}, 'stop'),
        stream,
      );
      expect(finish.candidates?.[0]?.content?.parts ?? []).toEqual([]);
    });

    it('fails closed when a nested respell extends past the held candidate before its closer (issue #9348 R8-1 accepted degradation)', () => {
      // R13 probe: chunks '<thinking>a</thinking><thinking>b' /
      // '<thinking>bc</thinking>' / '</thinking>Answer' — the delta
      // prefix-overlaps the held candidate '<thinking>b' with a remainder
      // starting with body text ('c</thinking>'). The bytes are
      // undecidable between a renormalized partial re-send EXTENDING the
      // candidate (strip re-assembles '<thinking>bc</thinking>' and the
      // turn completes) and a genuine nested block whose body extends past
      // the candidate before its closer (append keeps the block whole and
      // the single-chunk twin demotes cleanly). No transport-level
      // sequence metadata exists at this layer to tell them apart, so the
      // strip horn stays pinned — consistent with the R9-3 accepted
      // degradation for the sibling corner: the genuine nested reading
      // fails closed instead of the re-send reading corrupting silently.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('first-block', {
          content: '<thinking>a</thinking><thinking>b',
        }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('nested-respell', { content: '<thinking>bc</thinking>' }),
        stream,
      );
      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('rest', { content: '</thinking>Answer' }, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('fails closed when a sub-64-byte equal re-send never re-balances (issue #9348 R8-1 accepted degradation)', () => {
      // R13 probe: chunks '<thinking>body' / '<thinking>body' (re-send) /
      // '</thinking>Answer' — a short exact repeat of the held snapshot
      // rides the pinned R8-1 append horn for equal opening-word re-sends
      // (the byte-identical genuine shape is a nested opener arriving as
      // its own delta, which the append horn keeps and the R11-2
      // chunk-split twin relies on). The re-send therefore compounds into
      // '<thinking>body<thinking>body'; when the stream closes only the
      // inner block, the outer never balances and the finish chunk fails
      // closed — the documented degradation for a true rewind that never
      // re-balances. Undecidable at this layer without transport-level
      // sequence metadata; the append horn stays pinned.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>body' }),
        stream,
      );
      const resend = converter.convertOpenAIChunkToGemini(
        streamChunk('equal-resend', { content: '<thinking>body' }),
        stream,
      );
      expect(resend.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '<thinking>body<thinking>body',
      });

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('rest', { content: '</thinking>Answer' }, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('fails closed when a first-block respell rides the overlap regime (issue #9348 R11-2 accepted degradation)', () => {
      // R13 probe: chunks '<thinking>b' / '<thinking>b</thinking>' /
      // '</thinking>Answer' — pre-demotion the held candidate IS the
      // entire normalizer baseline, so a genuine fresh respell of the
      // first held block necessarily prefix-overlaps it and rides the
      // tag-hold overlap-verbatim regime. The identical regime signal is
      // what the R11-2 per-token cumulative pin relies on to strip the
      // held block's OWN completing snapshot; the two readings are
      // byte-identical at the decision site and undecidable without
      // transport-level sequence metadata. The strip horn stays pinned:
      // the genuine first-block respell fails closed instead of the
      // ordinary cumulative completion never balancing (the R11-2
      // regression).
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<thinking>b' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('overlap-respell', { content: '<thinking>b</thinking>' }),
        stream,
      );
      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('rest', { content: '</thinking>Answer' }, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('keeps genuine content intact when a sub-word "<" candidate is held (issue #9348)', () => {
      // The held-candidate prefix strip fired on sub-word candidates too:
      // with a lone '<' held, a genuine '<EOF' delta lost its leading '<'
      // because the strip consumed the candidate as if the delta re-sent
      // it. The strip is gated on the candidate already carrying a full
      // tag word; a sub-word candidate recombines with its genuine
      // continuation without the strip.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      const pre = converter.convertOpenAIChunkToGemini(
        streamChunk('pre', { content: ' ' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const opening = converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<' }),
        stream,
      );

      expect(pre.candidates?.[0]?.content?.parts).toEqual([{ text: ' ' }]);
      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.pendingThinkingTagCandidate).toEqual({ text: '<' });

      const continuation = converter.convertOpenAIChunkToGemini(
        streamChunk('continuation', { content: '<EOF' }, 'stop'),
        stream,
      );
      expect(continuation.candidates?.[0]?.content?.parts).toEqual([
        { text: '<<EOF' },
      ]);
    });

    it('does not demote literal "<<" content through a held sub-word candidate (issue #9348)', () => {
      // With a lone '<' held, the strip also reassembled a genuine
      // '<thinking>x</thinking>' delta into a balanced block and demoted
      // literal '<<thinking>…' content into the hidden thought channel. A
      // diverged normalizer baseline makes the normalizer's exit-cumulative
      // path emit the delta verbatim so the converter branch actually runs.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('opening', { content: '<' }),
        stream,
      );

      stream.textDeltaState = {
        emittedText: '<diverged-baseline>',
        emittedLength: 19,
        cumulativeMode: true,
      };
      const continuation = converter.convertOpenAIChunkToGemini(
        streamChunk('continuation', { content: '<thinking>x</thinking>' }),
        stream,
      );
      expect(continuation.candidates?.[0]?.content?.parts).toEqual([
        { text: '<<thinking>x</thinking>' },
      ]);
      expect(stream.inlineThinkingBlockDemoted).toBeUndefined();
    });

    it('drops post-finish redelivery instead of failing the completed turn (issue #9348)', () => {
      // A post-finish redelivery carrying the demoted block missed the
      // replay guards and threw PROTOCOL_TAG_LEAK after the finish response
      // was already converted, rolling back the completed turn. The
      // whitespace-renormalized shape below misses every replay branch
      // (equality, superset and rewind), so only the finish-state gate
      // closes it: the pipeline treats post-finish content as droppable,
      // and the converter aligns by recording the finish state and dropping
      // later visible content instead of failing closed on it.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>x</thinking>Ok' }),
        stream,
      );
      const finish = converter.convertOpenAIChunkToGemini(
        streamChunk('finish', {}, 'stop'),
        stream,
      );
      expect(finish.candidates?.[0]?.finishReason).toBeDefined();
      expect(stream.finishChunkConverted).toBe(true);

      const renormalizedRedelivery = converter.convertOpenAIChunkToGemini(
        streamChunk('redelivery', {
          content: ' <thinking>x</thinking> Ok',
        }),
        stream,
      );
      expect(renormalizedRedelivery.candidates?.[0]?.content?.parts).toEqual(
        [],
      );

      const redelivery = converter.convertOpenAIChunkToGemini(
        streamChunk('prefix-redelivery', {
          content: '<thinking>x</thinking>O',
        }),
        stream,
      );
      expect(redelivery.candidates?.[0]?.content?.parts).toEqual([]);

      const fullRedelivery = converter.convertOpenAIChunkToGemini(
        streamChunk('full-redelivery', {
          content: '<thinking>x</thinking>Ok',
        }),
        stream,
      );
      expect(fullRedelivery.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.postDemotionReplayText).toBe('<thinking>x</thinking>Ok');
    });

    it('drops reasoning-only post-finish redelivery, including thought parts (issue #9348 R9-4)', () => {
      // The finish-state gate used to drop only visible-text parts, and only
      // when visible text existed: thought parts created from redelivered
      // reasoning_content pass getVisibleText (it returns '' for thought
      // parts), and a reasoning-only redelivery has no visible text at all,
      // so the gate never fired. Any surviving part trips the pipeline's
      // pendingFinishProtocolTagSanitized latch ('Model response continued
      // after a finish reason.', PROTOCOL_TAG_LEAK) on sanitized turns,
      // hard-failing the completed turn. The gate must drop every part.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('block', { content: '<thinking>x</thinking>Ok' }),
        stream,
      );
      const finish = converter.convertOpenAIChunkToGemini(
        streamChunk('finish', {}, 'stop'),
        stream,
      );
      expect(finish.candidates?.[0]?.finishReason).toBeDefined();
      expect(stream.finishChunkConverted).toBe(true);

      const reasoningRedelivery = converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning-redelivery', {
          reasoning_content: 'Let me think.',
        }),
        stream,
      );
      expect(reasoningRedelivery.candidates?.[0]?.content?.parts).toEqual([]);

      const mixedRedelivery = converter.convertOpenAIChunkToGemini(
        streamChunk('mixed-redelivery', {
          reasoning_content: 'More reasoning.',
          content: 'More text.',
        }),
        stream,
      );
      expect(mixedRedelivery.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.postDemotionReplayText).toBe('<thinking>x</thinking>Ok');
    });

    it('absorbs post-finish redelivered tool-call fragments without failing the completed turn (issue #9348)', () => {
      // The finish-state gate used to clear parts/visibleText only AFTER
      // the channels ran: a redelivered id-less arguments-continuation
      // fragment reached toolCallParser.addChunk pre-gate, found every
      // buffer complete, and allocated a NEW nameless index via
      // findMostRecentIncompleteIndex(); the redelivered finish chunk then
      // threw MALFORMED_TOOL_CALL on a turn the finish response had already
      // closed. The post-finish skip keeps redelivered deltas out of the
      // parser entirely, so the redelivered finish converts against the
      // pristine pre-finish parser state.
      const stream = withStreamParser();
      converter.convertOpenAIChunkToGemini(
        streamChunk('tool-call', {
          tool_calls: [
            {
              index: 0,
              id: 'call_read',
              function: { name: 'read_file', arguments: '{"path":"/tmp/x"}' },
            },
          ],
        }),
        stream,
      );
      const finish = converter.convertOpenAIChunkToGemini(
        streamChunk('finish', {}, 'tool_calls'),
        stream,
      );
      expect(stream.finishChunkConverted).toBe(true);
      const finishParts = finish.candidates?.[0]?.content?.parts ?? [];
      expect(finishParts).toEqual([
        {
          functionCall: {
            id: 'call_read',
            name: 'read_file',
            args: { path: '/tmp/x' },
          },
        },
      ]);

      // Redelivered id-less arguments fragment: dropped before the parser.
      const redeliveredArgs = converter.convertOpenAIChunkToGemini(
        streamChunk('redelivered-args', {
          tool_calls: [{ index: 0, function: { arguments: '"}' } }],
        }),
        stream,
      );
      expect(redeliveredArgs.candidates?.[0]?.content?.parts).toEqual([]);
      expect(stream.toolCallParser?.hasNamelessToolCall()).toBe(false);

      // Redelivered finish: no MALFORMED_TOOL_CALL, same function call.
      const redeliveredFinish = converter.convertOpenAIChunkToGemini(
        streamChunk('redelivered-finish', {}, 'tool_calls'),
        stream,
      );
      expect(redeliveredFinish.candidates?.[0]?.content?.parts).toEqual(
        finishParts,
      );
      expect(stream.toolCallParser?.hasNamelessToolCall()).toBe(false);
    });

    it('keeps thoughtsTokenCount at pre-finish values when reasoning deltas are redelivered after finish (issue #9348)', () => {
      // Redelivered reasoning deltas used to pass the normalizer verbatim
      // pre-gate and re-add estimateTextTokenUnits to emittedTokenUnits; a
      // redelivered usage chunk then computed thoughtsTokenCount from the
      // inflated counter and the pipeline merged it into the already-yielded
      // finish response. The post-finish skip keeps redelivered reasoning
      // out of the counter, so redelivered usage repeats the pre-finish
      // estimate.
      const stream = withStreamParser();
      for (const piece of ['Let me ', 'think ', 'hard.']) {
        converter.convertOpenAIChunkToGemini(
          streamChunk(`reasoning-${piece}`, { reasoning_content: piece }),
          stream,
        );
      }
      converter.convertOpenAIChunkToGemini(
        streamChunk('finish', {}, 'stop'),
        stream,
      );
      const usage = {
        prompt_tokens: 10,
        completion_tokens: 10000,
        total_tokens: 10010,
      };
      const original = converter.convertOpenAIChunkToGemini(
        {
          id: 'usage-1',
          created: 1,
          model: 'test',
          choices: [],
          usage,
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        stream,
      );
      const originalThoughts = original.usageMetadata?.thoughtsTokenCount ?? 0;
      expect(originalThoughts).toBeGreaterThan(0);

      for (const piece of ['Let me ', 'think ', 'hard.']) {
        const redelivered = converter.convertOpenAIChunkToGemini(
          streamChunk(`redelivered-${piece}`, { reasoning_content: piece }),
          stream,
        );
        expect(redelivered.candidates?.[0]?.content?.parts).toEqual([]);
      }
      const redeliveredUsage = converter.convertOpenAIChunkToGemini(
        {
          id: 'usage-2',
          created: 1,
          model: 'test',
          choices: [],
          usage,
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        stream,
      );
      expect(redeliveredUsage.usageMetadata?.thoughtsTokenCount).toBe(
        originalThoughts,
      );
    });

    it('releases a held tag-like tail once it resolves into ordinary text after a demotion (issue #9348)', () => {
      // The hold must not swallow or corrupt ordinary text: a held suffix
      // that turns out not to be a tag is emitted verbatim and the turn
      // succeeds.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      const fragment = converter.convertOpenAIChunkToGemini(
        streamChunk('tag-fragment', { content: '<thi' }),
        stream,
      );

      expect(fragment.candidates?.[0]?.content?.parts).toEqual([]);

      const resolved = converter.convertOpenAIChunkToGemini(
        streamChunk('resolved', { content: 's is not a tag.' }, 'stop'),
        stream,
      );

      expect(resolved.candidates?.[0]?.content?.parts).toEqual([
        { text: '<this is not a tag.' },
      ]);
      expect(stream.pendingPostDemotionTagTail).toBeUndefined();
    });

    it('fails closed when a split tag prefix follows a benign < in the same chunk (issue #9348 fail-closed)', () => {
      // The held suffix must start at the LAST '<' of the emitted text:
      // selecting from the first '<' would make the suffix '<T> and <thi',
      // which cannot be a tag prefix, so nothing is held, the '<thi'
      // fragment leaks into visible output, and the next chunk (carrying no
      // '<') never trips the gate — the turn would succeed with an assembled
      // raw '<thinking>' in user-visible output.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      const fragment = converter.convertOpenAIChunkToGemini(
        streamChunk('mixed-fragment', { content: 'Supplier<T> and <thi' }),
        stream,
      );

      expect(fragment.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Supplier<T> and ' },
      ]);
      expect(stream.pendingPostDemotionTagTail).toBe('<thi');
      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk('tag-completes', { content: 'nking> done' }, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('keeps a benign < when a split tag-like tail resolves into ordinary text after a demotion (issue #9348)', () => {
      // Twin of the test above: the same chunking where the held tail turns
      // out not to be a tag must release verbatim, preserving the earlier
      // benign '<'.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('leading-block', {
          content: '<thinking>a</thinking>Answer ',
        }),
        stream,
      );
      const fragment = converter.convertOpenAIChunkToGemini(
        streamChunk('mixed-fragment', { content: 'Supplier<T> and <thi' }),
        stream,
      );
      const resolved = converter.convertOpenAIChunkToGemini(
        streamChunk('resolved', { content: 's plain text' }, 'stop'),
        stream,
      );

      expect(fragment.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Supplier<T> and ' },
      ]);
      expect(resolved.candidates?.[0]?.content?.parts).toEqual([
        { text: '<this plain text' },
      ]);
      expect(stream.pendingPostDemotionTagTail).toBeUndefined();
    });

    it('rejects a stray closing tag after a demoted leading block (issue #9348 fail-closed)', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );

      expect(() =>
        converter.convertOpenAIChunkToGemini(
          streamChunk(
            'stray-closer',
            { content: '<thinking>a</thinking>b</thinking>' },
            'stop',
          ),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('releases a sub-word tag fragment after a balanced block at stream finish (issue #9348)', () => {
      // '<thi' is one visible char short of the '<think' tag word, so it can
      // no longer become a tag once the stream has ended. The post-demotion
      // tag-tail finish release and the pipeline EOF backstop already release
      // the identical fragment (e.g. one visible char later, 'A<thi'), so the
      // demotion-rest finish check must agree instead of hard-failing a
      // truncated turn that the tag-leak retry would regenerate verbatim.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );

      const truncated = converter.convertOpenAIChunkToGemini(
        streamChunk(
          'truncated-prefix',
          { content: '<thinking>a</thinking><thi' },
          'stop',
        ),
        stream,
      );

      expect(truncated.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { text: '<thi' },
      ]);
      expect(stream.pendingPostDemotionTagTail).toBeUndefined();
    });

    it('releases a split sub-word tag fragment held at stream finish (issue #9348)', () => {
      // Chunk-split twin of the test above: the sub-word fragment is re-held
      // after the demotion and the stream then finishes. The held candidate
      // contains no full tag word, so the finish-time candidate check must
      // release it as literal text like the single-chunk shape.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('first-block', { content: '<thinking>a</thinking><thi' }),
        stream,
      );

      expect(first.candidates?.[0]?.content?.parts).toEqual([]);
      const finish = finishStream(stream, 'stop');
      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'a' },
        { text: '<thi' },
      ]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
    });

    it('still fails closed on a split full tag word held at stream finish (issue #9348 fail-closed)', () => {
      // Regression guard for the sub-word release: a held fragment containing
      // a full tag word ('<think') must keep failing closed at finish,
      // because its chunk-split twin throws via the hold path once the tag
      // completes.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const first = converter.convertOpenAIChunkToGemini(
        streamChunk('first-block', {
          content: '<thinking>a</thinking><think',
        }),
        stream,
      );

      expect(first.candidates?.[0]?.content?.parts).toEqual([]);
      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    it('releases a sub-word tag candidate at finish before any demotion (issue #9348)', () => {
      // A structured-reasoning turn truncated by max_tokens before any
      // complete tag: the held candidate is a sub-word fragment that can no
      // longer become a tag, so finish releases it as literal text — aligned
      // with the demotion-rest, tag-tail, and EOF-backstop paths.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      const fragment = converter.convertOpenAIChunkToGemini(
        streamChunk('fragment', { content: '<thi' }),
        stream,
      );

      expect(fragment.candidates?.[0]?.content?.parts).toEqual([]);
      const finish = finishStream(stream, 'length');
      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        { text: '<thi' },
      ]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
    });

    it('still fails closed on a full tag word candidate at finish before any demotion (issue #9348 fail-closed)', () => {
      // Twin of the test above with a full tag word: '<think' can still
      // complete into a tag in the chunk-split twin, so it stays fail-closed.
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      converter.convertOpenAIChunkToGemini(
        streamChunk('reasoning', { reasoning_content: 'Let me think.' }),
        stream,
      );
      converter.convertOpenAIChunkToGemini(
        streamChunk('fragment', { content: '<think' }),
        stream,
      );

      expect(() => finishStream(stream, 'length')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    it('holds a long confirmed opening tag until its closing tag arrives', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const text = `<thinking>${'x'.repeat(200)}</thinking>`;

      const opening = converter.convertOpenAIChunkToLlm(
        streamChunk('long-balanced', {
          content: `<thinking>${'x'.repeat(200)}`,
        }),
        stream,
      );
      const closing = converter.convertOpenAIChunkToLlm(
        streamChunk('long-balanced', { content: '</thinking>' }, 'stop'),
        stream,
      );

      expect(opening.candidates?.[0]?.content?.parts).toEqual([]);
      expect(closing.candidates?.[0]?.content?.parts).toEqual([{ text }]);
    });

    it('leaks the production <thinking> shape without provider provenance', () => {
      // Control for the test above: without contentOnlyThinkingTagLeaks the
      // same stream passes through verbatim — the defense is provider-gated,
      // so endpoints whose provider does not opt in remain exposed.
      const stream = withStreamParser();
      const response = converter.convertOpenAIChunkToLlm(
        streamChunk(
          'literal',
          {
            content:
              '<thinking>\nThe user wants to query the compute resources.',
          },
          'stop',
        ),
        stream,
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        {
          text: '<thinking>\nThe user wants to query the compute resources.',
        },
      ]);
    });

    it.each([
      ['split literal block', ['<thi', 'nk>literal</think>']],
      ['empty block with a separate finish chunk', ['<think>\n\n</think>', '']],
      [
        'two split valid blocks',
        ['<think>\n\n', '</think><thi', 'nk>literal</think>'],
      ],
      ['long empty block', [`<thinking>${' '.repeat(128)}</thinking>`, '']],
    ])('preserves content-only %s', (_name, chunks) => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const parts = chunks.flatMap((content, index) => {
        const response = converter.convertOpenAIChunkToLlm(
          streamChunk(
            `literal-${index}`,
            { content },
            index === chunks.length - 1 ? 'stop' : null,
          ),
          stream,
        );
        return response.candidates?.[0]?.content?.parts ?? [];
      });

      expect(parts.map((part) => part.text).join('')).toBe(chunks.join(''));
      expect(parts.every((part) => part.thought !== true)).toBe(true);
    });

    it('releases a long unconfirmed prefix before the stream finishes', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const text = `<think${' '.repeat(257)}`;

      const response = converter.convertOpenAIChunkToLlm(
        streamChunk('literal', { content: text }),
        stream,
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([{ text }]);
    });

    it('rejects an unclosed whitespace-only block at stream finish', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const response = converter.convertOpenAIChunkToLlm(
        streamChunk('unclosed', {
          content: `<thinking>${' '.repeat(128)}`,
        }),
        stream,
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([]);
      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    it('preserves a leak-shaped literal without provider provenance', () => {
      const stream = withStreamParser();
      const text = '<think>\n\n</think><think>9<think>-3';
      const response = converter.convertOpenAIChunkToLlm(
        streamChunk('literal', { content: text }, 'stop'),
        stream,
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([{ text }]);
    });

    it.each([
      [
        'at the start of the stream',
        ['<think></think><think>outer <think>literal', '</think></think>'],
      ],
      [
        'after visible content',
        [
          'Explanation: ',
          '<think></think><think>outer <think>literal</think></think>',
        ],
      ],
    ])('preserves balanced nested literals %s', (_name, chunks) => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const parts = chunks.flatMap((content, index) => {
        const response = converter.convertOpenAIChunkToLlm(
          streamChunk(
            `balanced-${index}`,
            { content },
            index === chunks.length - 1 ? 'stop' : null,
          ),
          stream,
        );
        return response.candidates?.[0]?.content?.parts ?? [];
      });

      expect(parts.map((part) => part.text).join('')).toBe(chunks.join(''));
    });

    it('rejects an unclosed outer block containing a balanced nested block', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      expect(() =>
        converter.convertOpenAIChunkToLlm(
          streamChunk(
            'nested-unclosed',
            {
              content: '<thinking><thinking>inner</thinking>outer text',
            },
            'stop',
          ),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('fails closed for a long suspicious prefix at stream finish', () => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const content = '<think></think><think>9<think>' + 'x'.repeat(257);

      const response = converter.convertOpenAIChunkToLlm(
        streamChunk('long-leak', { content }),
        stream,
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([]);
      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
    });

    it.each([
      '<thinking></thinking><thinking>9<thinking>-3',
      '<think ></think ><think >9<think >-3',
    ])('rejects provider-tag grammar variant %s', (content) => {
      const stream = withStreamParser();
      stream.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };

      expect(() =>
        converter.convertOpenAIChunkToLlm(
          streamChunk('variant', { content }, 'stop'),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('rejects closing-tag recovery after a tag leaked in reasoning', () => {
      const stream = withStreamParser();
      converter.convertOpenAIChunkToLlm(
        streamChunk('reasoning', {
          reasoning_content: 'Let me check<think>',
        }),
        stream,
      );
      emitToolCall(stream, '</think>');

      expect(() => finishStream(stream)).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
      expect(stream.protocolTagSanitized).toBeUndefined();
    });

    it.each([
      ['think', '\n</think>\n\n'],
      ['thinking', ' </thinking> '],
    ] as const)(
      'sanitizes a standalone closing %s tag with complete tool calls',
      (tagName, tag) => {
        const stream = withStreamParser();
        const reasoning = emitReasoning(stream);
        const leakedTag = emitToolCall(stream, tag);
        const finish = finishStream(stream);

        expect(reasoning.candidates?.[0]?.content?.parts).toEqual([
          { thought: true, text: 'Let me check.' },
        ]);
        expect(leakedTag.candidates?.[0]?.content?.parts).toEqual([]);
        expect(finish.candidates?.[0]?.content?.parts).toEqual([
          {
            functionCall: { id: 'call_read', name: 'read_file', args: {} },
          },
        ]);
        expect(stream.protocolTagSanitized).toEqual({
          tagName,
          toolCallCount: 1,
        });
      },
    );

    it('sanitizes a standalone closing thinking tag split across chunks', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      const firstHalf = converter.convertOpenAIChunkToLlm(
        streamChunk('tag-start', { content: '\n</thi' }),
        stream,
      );
      const secondHalf = emitToolCall(stream, 'nk>\n');
      const finish = finishStream(stream);

      expect(firstHalf.candidates?.[0]?.content?.parts).toEqual([]);
      expect(secondHalf.candidates?.[0]?.content?.parts).toEqual([]);
      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        {
          functionCall: { id: 'call_read', name: 'read_file', args: {} },
        },
      ]);
      expect(stream.protocolTagSanitized).toEqual({
        tagName: 'think',
        toolCallCount: 1,
      });
    });

    it('sanitizes a standalone closing thinking tag with multiple tool calls', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      converter.convertOpenAIChunkToLlm(
        streamChunk('tool-calls', {
          content: '</think>',
          tool_calls: [
            {
              index: 0,
              id: 'call_read',
              function: { name: 'read_file', arguments: '{}' },
            },
            {
              index: 1,
              id: 'call_list',
              function: { name: 'list_directory', arguments: '{}' },
            },
          ],
        }),
        stream,
      );
      const finish = finishStream(stream);

      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        {
          functionCall: { id: 'call_read', name: 'read_file', args: {} },
        },
        {
          functionCall: { id: 'call_list', name: 'list_directory', args: {} },
        },
      ]);
      expect(stream.protocolTagSanitized).toEqual({
        tagName: 'think',
        toolCallCount: 2,
      });
    });

    it('recovers complete same-index tool calls with distinct IDs', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      converter.convertOpenAIChunkToLlm(
        streamChunk('tool-calls', {
          content: '</think>',
          tool_calls: [
            {
              index: 0,
              id: 'call_read',
              function: { name: 'read_file', arguments: '{}' },
            },
            {
              index: 0,
              id: 'call_list',
              function: { name: 'list_directory', arguments: '{}' },
            },
          ],
        }),
        stream,
      );
      const finish = finishStream(stream);

      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        {
          functionCall: { id: 'call_read', name: 'read_file', args: {} },
        },
        {
          functionCall: {
            id: 'call_list',
            name: 'list_directory',
            args: {},
          },
        },
      ]);
      expect(stream.protocolTagSanitized).toEqual({
        tagName: 'think',
        toolCallCount: 2,
      });
    });

    it.each([
      ['complete', '{"path":"old.txt"}', ''],
      ['incomplete', '{"path":"old.txt"', '}'],
    ] as const)(
      'rejects a protocol-tag recovery when a new id relabels %s nameless arguments',
      (_state, oldArguments, newArguments) => {
        const stream = withStreamParser();
        emitReasoning(stream);
        converter.convertOpenAIChunkToLlm(
          streamChunk('old-arguments', {
            content: '</think>',
            tool_calls: [
              {
                index: 0,
                id: 'call_old',
                function: { arguments: oldArguments },
              },
            ],
          }),
          stream,
        );
        converter.convertOpenAIChunkToLlm(
          streamChunk('new-name', {
            tool_calls: [
              {
                index: 0,
                id: 'call_new',
                function: { name: 'read_file', arguments: newArguments },
              },
            ],
          }),
          stream,
        );

        expect(() => finishStream(stream)).toThrowError(
          expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
        );
        expect(stream.protocolTagSanitized).toBeUndefined();
      },
    );

    it('buffers leading whitespace before a split standalone closing tag', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      const whitespace = converter.convertOpenAIChunkToLlm(
        streamChunk('whitespace', { content: '\n' }),
        stream,
      );
      const tag = emitToolCall(stream, '</think>');
      const finish = finishStream(stream);

      expect(whitespace.candidates?.[0]?.content?.parts).toEqual([]);
      expect(tag.candidates?.[0]?.content?.parts).toEqual([]);
      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        {
          functionCall: { id: 'call_read', name: 'read_file', args: {} },
        },
      ]);
      expect(stream.protocolTagSanitized).toEqual({
        tagName: 'think',
        toolCallCount: 1,
      });
    });

    it('buffers long whitespace without treating it as a protocol tag', () => {
      const stream = withStreamParser();
      const whitespace = ' '.repeat(129);
      emitReasoning(stream);

      const pending = converter.convertOpenAIChunkToLlm(
        streamChunk('whitespace', { content: whitespace }),
        stream,
      );
      const finish = finishStream(stream, 'stop');

      expect(pending.candidates?.[0]?.content?.parts).toEqual([]);
      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        { text: whitespace },
      ]);
    });

    it('emits trailing whitespace when the stream finishes', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      const whitespace = converter.convertOpenAIChunkToLlm(
        streamChunk('whitespace', { content: ' \n' }),
        stream,
      );
      const finish = finishStream(stream, 'stop');

      expect(whitespace.candidates?.[0]?.content?.parts).toEqual([]);
      expect(finish.candidates?.[0]?.content?.parts).toEqual([{ text: ' \n' }]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
    });

    it('ignores an exact cumulative replay of a deferred closing tag', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      converter.convertOpenAIChunkToLlm(
        streamChunk('tag', { content: '</THINK>' }),
        stream,
      );
      const finish = converter.convertOpenAIChunkToLlm(
        streamChunk(
          'finish',
          {
            content: '</THINK>',
            tool_calls: [
              {
                index: 0,
                id: 'call_read',
                function: { name: 'read_file', arguments: '{}' },
              },
            ],
          },
          'tool_calls',
        ),
        stream,
      );

      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        {
          functionCall: { id: 'call_read', name: 'read_file', args: {} },
        },
      ]);
      expect(stream.protocolTagSanitized).toEqual({
        tagName: 'think',
        toolCallCount: 1,
      });
    });

    it('ignores cumulative replays of an incomplete closing tag', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      const first = converter.convertOpenAIChunkToLlm(
        streamChunk('tag-prefix', { content: '</thi' }),
        stream,
      );
      const replay = converter.convertOpenAIChunkToLlm(
        streamChunk('tag-prefix-replay', { content: '</thi' }),
        stream,
      );
      const tag = emitToolCall(stream, '</think>');
      const finish = finishStream(stream);

      expect(first.candidates?.[0]?.content?.parts).toEqual([]);
      expect(replay.candidates?.[0]?.content?.parts).toEqual([]);
      expect(tag.candidates?.[0]?.content?.parts).toEqual([]);
      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        {
          functionCall: { id: 'call_read', name: 'read_file', args: {} },
        },
      ]);
      expect(stream.protocolTagSanitized).toEqual({
        tagName: 'think',
        toolCallCount: 1,
      });
    });

    it('rejects an invalid tool-call index on a stop finish', () => {
      const stream = withStreamParser();
      converter.convertOpenAIChunkToLlm(
        streamChunk('invalid-tool-call', {
          tool_calls: [
            {
              index: Number.MAX_SAFE_INTEGER + 1,
              id: 'call_invalid',
              function: { name: 'read_file', arguments: '{}' },
            },
          ],
        }),
        stream,
      );

      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'MALFORMED_TOOL_CALL' }),
      );
    });

    it('rejects valid tool calls accompanied by an invalid index', () => {
      const stream = withStreamParser();
      converter.convertOpenAIChunkToLlm(
        streamChunk('mixed-tool-calls', {
          tool_calls: [
            {
              index: 0,
              id: 'call_read',
              function: { name: 'read_file', arguments: '{}' },
            },
            {
              index: Number.MAX_SAFE_INTEGER + 1,
              id: 'call_invalid',
              function: { name: 'write_file', arguments: '{}' },
            },
          ],
        }),
        stream,
      );

      expect(() => finishStream(stream)).toThrowError(
        expect.objectContaining({ type: 'MALFORMED_TOOL_CALL' }),
      );
    });

    it('releases a split tag-like prefix when it becomes ordinary text', () => {
      const stream = withStreamParser();
      converter.convertOpenAIChunkToLlm(
        streamChunk('reasoning', { reasoning_content: 'Explain the syntax.' }),
        stream,
      );
      const prefix = converter.convertOpenAIChunkToLlm(
        streamChunk('prefix', { content: '</thi' }),
        stream,
      );
      const suffix = converter.convertOpenAIChunkToLlm(
        streamChunk('suffix', { content: 'ng is not a tag.' }),
        stream,
      );

      expect(prefix.candidates?.[0]?.content?.parts).toEqual([]);
      expect(suffix.candidates?.[0]?.content?.parts).toEqual([
        { text: '</thing is not a tag.' },
      ]);
      expect(stream.protocolTagSanitized).toBeUndefined();
    });

    it('does not accumulate whitespace after a complete closing tag candidate', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      emitToolCall(stream, '</think>');

      for (let i = 0; i < 1_000; i++) {
        converter.convertOpenAIChunkToLlm(
          streamChunk(`whitespace-${i}`, { content: ' ' }),
          stream,
        );
      }

      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '</think>',
        closingTagName: 'think',
      });
      finishStream(stream);
      expect(stream.protocolTagSanitized).toEqual({
        tagName: 'think',
        toolCallCount: 1,
      });
    });

    it('rejects a standalone closing thinking tag without a complete tool call', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      const leakedTag = converter.convertOpenAIChunkToLlm(
        streamChunk('content', { content: '</think>' }),
        stream,
      );

      expect(leakedTag.candidates?.[0]?.content?.parts).toEqual([]);
      expect(() => finishStream(stream, 'stop')).toThrowError(
        expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
      );
      expect(stream.protocolTagSanitized).toBeUndefined();
    });

    it.each(['stop', 'length', 'content_filter', 'unknown'])(
      'rejects recovery when the stream finishes with %s',
      (finishReason) => {
        const stream = withStreamParser();
        emitReasoning(stream);
        emitToolCall(stream, '</think>');

        expect(() => finishStream(stream, finishReason)).toThrowError(
          expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
        );
        expect(stream.protocolTagSanitized).toBeUndefined();
      },
    );

    it('rejects visible content after a deferred closing thinking tag', () => {
      const stream = withStreamParser();
      emitReasoning(stream);
      converter.convertOpenAIChunkToLlm(
        streamChunk('content', { content: '</think>' }),
        stream,
      );

      expect(() =>
        converter.convertOpenAIChunkToLlm(
          streamChunk('content-after-tag', { content: 'unexpected' }),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
      expect(stream.protocolTagSanitized).toBeUndefined();
    });

    it.each(['{"path":', '{bad}', 'null', '[]', '42', '   '])(
      'rejects a standalone closing thinking tag with unsafe tool arguments %s',
      (toolArguments) => {
        const stream = withStreamParser();
        emitReasoning(stream);
        emitToolCall(stream, '</think>', toolArguments);

        expect(() => finishStream(stream)).toThrowError(
          expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }),
        );
        expect(stream.protocolTagSanitized).toBeUndefined();
      },
    );

    it('rejects a closing tag split after a visible line break', () => {
      const stream = withStreamParser();
      converter.convertOpenAIChunkToLlm(
        streamChunk('reasoning', {
          reasoning_content: 'Let me check<think>',
        }),
        stream,
      );
      converter.convertOpenAIChunkToLlm(
        streamChunk('content', { content: 'the result\n' }),
        stream,
      );
      converter.convertOpenAIChunkToLlm(
        streamChunk('blank-lines', { content: '\n'.repeat(256) }),
        stream,
      );

      expect(() =>
        converter.convertOpenAIChunkToLlm(
          streamChunk('closing-tag', { content: '</think>\n' }),
          stream,
        ),
      ).toThrowError(expect.objectContaining({ type: 'PROTOCOL_TAG_LEAK' }));
    });

    it('preserves a split literal closing tag after ordinary reasoning', () => {
      const stream = withStreamParser();
      const reasoning = converter.convertOpenAIChunkToLlm(
        streamChunk('reasoning', { reasoning_content: 'Explain the syntax.' }),
        stream,
      );
      const prefix = converter.convertOpenAIChunkToLlm(
        streamChunk('prefix', { content: 'Use ' }),
        stream,
      );
      const closingTag = converter.convertOpenAIChunkToLlm(
        streamChunk('closing-tag', { content: '</think> to close the tag.' }),
        stream,
      );

      expect(reasoning.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'Explain the syntax.' },
      ]);
      expect(prefix.candidates?.[0]?.content?.parts).toEqual([
        { text: 'Use ' },
      ]);
      expect(closingTag.candidates?.[0]?.content?.parts).toEqual([
        { text: '</think> to close the tag.' },
      ]);
    });

    it('releases inline thinking-tag references in both channels', () => {
      const stream = withStreamParser();
      const reasoning = converter.convertOpenAIChunkToLlm(
        streamChunk('reasoning', {
          reasoning_content: 'The format may contain <think> tags.',
        }),
        stream,
      );
      const content = converter.convertOpenAIChunkToLlm(
        streamChunk('content', { content: 'Use </think> to close the tag.' }),
        stream,
      );
      const finish = converter.convertOpenAIChunkToLlm(
        streamChunk('finish', {}, 'stop'),
        stream,
      );

      expect(reasoning.candidates?.[0]?.content?.parts).toEqual([]);
      expect(content.candidates?.[0]?.content?.parts).toEqual([]);
      expect(finish.candidates?.[0]?.content?.parts).toEqual([
        { thought: true, text: 'The format may contain <think> tags.' },
        { text: 'Use </think> to close the tag.' },
      ]);
    });
  });

  describe('convertLlmRequestToOpenAI', () => {
    const createRequestWithFunctionResponse = (
      response: Record<string, unknown>,
    ): GenerateContentParameters => {
      const contents: Content[] = [
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_1',
                name: 'shell',
                args: {},
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_1',
                name: 'shell',
                response,
              },
            },
          ],
        },
      ];
      return {
        model: 'models/test',
        contents,
      };
    };

    it('normalizes legacy dotted MCP names before sending history', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_legacy_mcp',
                  name: 'mcp__zybio__literature.search_pubmed',
                  args: { query: 'IVD' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_legacy_mcp',
                  name: 'mcp__zybio__literature.search_pubmed',
                  response: { output: 'ok' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );
      const assistant = messages.find(hasOpenAIToolCalls);
      const name = assistant?.tool_calls[0]?.function.name;

      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      expect(name).not.toContain('.');
    });

    it('preserves ordered multi-part startup reminder user content', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'user',
            parts: [
              { text: '<system-reminder>\ndeferred tools' },
              { text: '<system-reminder>\nstartup context' },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(request, {
        ...requestContext,
        splitToolMedia: true,
      });

      expect(messages).toEqual([
        {
          role: 'user',
          content: [
            { type: 'text', text: '<system-reminder>\ndeferred tools' },
            { type: 'text', text: '<system-reminder>\nstartup context' },
          ],
        },
      ]);
    });

    it('should extract raw output from function response objects', () => {
      const request = createRequestWithFunctionResponse({
        output: 'Raw output text',
      });

      const messages = converter.convertLlmRequestToOpenAI(request, {
        ...requestContext,
        splitToolMedia: true,
      });
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Raw output text');
    });

    it('should prioritize error field when present', () => {
      const request = createRequestWithFunctionResponse({
        error: 'Command failed',
      });

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Command failed');
    });

    it('should stringify non-string responses', () => {
      const request = createRequestWithFunctionResponse({
        data: { value: 42 },
      });

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('{"data":{"value":42}}');
    });

    it('should convert function responses with inlineData to tool message with embedded image_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Image content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'base64encodedimagedata',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and image content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect((toolMessage as { tool_call_id?: string }).tool_call_id).toBe(
        'call_1',
      );
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Image content');
      expect(contentArray[1].type).toBe('image_url');
      expect(contentArray[1].image_url?.url).toBe(
        'data:image/png;base64,base64encodedimagedata',
      );

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should split tool-result media into a follow-up user message when splitToolMedia is enabled (issue #3616)', () => {
      // Same shape as the embedded-image test above, but with the strict
      // OpenAI-compat opt-in flag set. The tool message must stay
      // spec-compliant (string / text-part content only) and the image must
      // arrive in a follow-up user message.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Image content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'base64encodedimagedata',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertLlmRequestToOpenAI(
        request,
        strictContext,
      );

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      // Tool message content is a plain string (or text-part array) — no media
      expect(typeof toolMessage?.content === 'string').toBe(true);
      expect(toolMessage?.content).toContain('Image content');

      // The image lives in a follow-up user message
      const userMessage = messages.find((m) => m.role === 'user');
      expect(userMessage).toBeDefined();
      const userContent = userMessage?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(Array.isArray(userContent)).toBe(true);
      const imagePart = userContent.find((p) => p.type === 'image_url');
      expect(imagePart?.image_url?.url).toBe(
        'data:image/png;base64,base64encodedimagedata',
      );
    });

    it('should keep all tool messages contiguous and merge split media into a single follow-up user message for parallel tool calls (issue #3616)', () => {
      // Two assistant tool calls in parallel. Both responses come back in the
      // same `user` content as separate functionResponse parts. The first
      // returns an image; the second returns text only. OpenAI Chat
      // Completions requires every `role: "tool"` response to appear
      // contiguously before any non-tool message, so the synthesised user
      // message carrying split media MUST come after BOTH tool messages,
      // not interleaved between them.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_screenshot',
                  name: 'browser_take_screenshot',
                  args: {},
                },
              },
              {
                functionCall: {
                  id: 'call_console',
                  name: 'browser_console_messages',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_screenshot',
                  name: 'browser_take_screenshot',
                  response: { output: 'Captured screenshot' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'shotbase64',
                      },
                    },
                  ],
                },
              },
              {
                functionResponse: {
                  id: 'call_console',
                  name: 'browser_console_messages',
                  response: { output: 'no console messages' },
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertLlmRequestToOpenAI(
        request,
        strictContext,
      );

      // Locate the assistant turn (with the two tool calls) and assert that
      // the next two messages are both `tool`, contiguously, before any
      // user message.
      const assistantIdx = messages.findIndex((m) => m.role === 'assistant');
      expect(assistantIdx).toBeGreaterThanOrEqual(0);
      expect(messages[assistantIdx + 1]?.role).toBe('tool');
      expect(messages[assistantIdx + 2]?.role).toBe('tool');
      expect(messages[assistantIdx + 3]?.role).toBe('user');

      // Both tool messages have spec-compliant content (string OR array of
      // text-typed parts only — no image_url / input_audio / video_url /
      // file parts allowed by OpenAI on tool messages).
      const isSpecCompliantToolContent = (content: unknown): boolean => {
        if (typeof content === 'string') return true;
        if (!Array.isArray(content)) return false;
        return (content as Array<{ type: string }>).every(
          (p) => p.type === 'text',
        );
      };
      expect(
        isSpecCompliantToolContent(
          (messages[assistantIdx + 1] as { content: unknown }).content,
        ),
      ).toBe(true);
      expect(
        isSpecCompliantToolContent(
          (messages[assistantIdx + 2] as { content: unknown }).content,
        ),
      ).toBe(true);

      // Exactly one synthesised user message exists, and it carries the
      // single image from the first tool response.
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(1);
      const userContent = userMessages[0].content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      const imageParts = userContent.filter((p) => p.type === 'image_url');
      expect(imageParts).toHaveLength(1);
      expect(imageParts[0].image_url?.url).toBe(
        'data:image/png;base64,shotbase64',
      );
    });

    it('should merge media from multiple media-bearing parallel tool responses into one follow-up user message (issue #3616)', () => {
      // Both tool responses return images. The accumulator must combine them
      // into a single user message — we should NOT see two separate user
      // messages (which would still violate the contiguity rule because the
      // first user message would split the tool messages apart).
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call_a', name: 'shot_a', args: {} },
              },
              {
                functionCall: { id: 'call_b', name: 'shot_b', args: {} },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_a',
                  name: 'shot_a',
                  response: { output: 'A' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'aaa' } },
                  ],
                },
              },
              {
                functionResponse: {
                  id: 'call_b',
                  name: 'shot_b',
                  response: { output: 'B' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'bbb' } },
                  ],
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertLlmRequestToOpenAI(
        request,
        strictContext,
      );

      const toolMessages = messages.filter((m) => m.role === 'tool');
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(toolMessages).toHaveLength(2);
      expect(userMessages).toHaveLength(1);

      const userContent = userMessages[0].content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      const imageUrls = userContent
        .filter((p) => p.type === 'image_url')
        .map((p) => p.image_url?.url);
      expect(imageUrls).toEqual([
        'data:image/png;base64,aaa',
        'data:image/png;base64,bbb',
      ]);
    });

    it('should not synthesise a follow-up user message when splitToolMedia is enabled but the response has no media (issue #3616)', () => {
      // Regression guard: when the flag is on but a tool response is text-only,
      // the synthesis path must not emit any user message. Without this guard,
      // a future refactor that always emits the follow-up could regress silently.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { id: 'c', name: 'echo', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'c',
                  name: 'echo',
                  response: { output: 'plain text result' },
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertLlmRequestToOpenAI(
        request,
        strictContext,
      );

      const toolMessages = messages.filter((m) => m.role === 'tool');
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(toolMessages).toHaveLength(1);
      expect(userMessages).toHaveLength(0);
    });

    it('should fall back to a placeholder string when the tool response is media-only (issue #3616)', () => {
      // When extractFunctionResponseContent returns empty AND parts contain
      // only media, the tool message must end up with the placeholder string
      // rather than an empty array (which would be invalid spec).
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { id: 'c', name: 'shot', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'c',
                  name: 'shot',
                  // null response triggers extractFunctionResponseContent
                  // to return "" — the empty-text branch we want to cover.
                  response: null as unknown as Record<string, unknown>,
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'xxx' } },
                  ],
                },
              },
            ],
          },
        ],
      };

      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };
      const messages = converter.convertLlmRequestToOpenAI(
        request,
        strictContext,
      );

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toBe(
        '[media attached in following user message]',
      );
      const userMessage = messages.find((m) => m.role === 'user');
      const userContent = userMessage?.content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      const img = userContent.find((p) => p.type === 'image_url');
      expect(img?.image_url?.url).toBe('data:image/png;base64,xxx');
    });

    it('should preserve embedded-media behavior when splitToolMedia is explicitly false (opt-out) on parallel tool calls (issue #3616, #4876)', () => {
      // Same input as the parallel-tool-calls split test, but with the flag
      // explicitly off. Since #4876 the default is true (spec-compliant), so
      // this asserts the opt-out path: media stays embedded in the tool
      // message and no follow-up user message is synthesised.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              { functionCall: { id: 'c1', name: 's1', args: {} } },
              { functionCall: { id: 'c2', name: 's2', args: {} } },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'c1',
                  name: 's1',
                  response: { output: 'r1' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'aaa' } },
                  ],
                },
              },
              {
                functionResponse: {
                  id: 'c2',
                  name: 's2',
                  response: { output: 'r2' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(request, {
        ...requestContext,
        splitToolMedia: false,
      });

      const toolMessages = messages.filter((m) => m.role === 'tool');
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(toolMessages).toHaveLength(2);
      expect(userMessages).toHaveLength(0);
      // First tool message should still carry the embedded image
      const firstToolContent = toolMessages[0].content as Array<{
        type: string;
        image_url?: { url: string };
      }>;
      const img = firstToolContent.find((p) => p.type === 'image_url');
      expect(img?.image_url?.url).toBe('data:image/png;base64,aaa');
    });

    it('should keep embedded media as content parts when string tool content is requested but splitToolMedia is false', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { id: 'c1', name: 'shot', args: {} } }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'c1',
                  name: 'shot',
                  response: { output: 'screenshot' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'aaa' } },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(request, {
        ...requestContext,
        splitToolMedia: false,
        toolResultContentFormat: 'string',
      });

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const toolContent = toolMessage?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(toolContent.find((p) => p.type === 'text')?.text).toBe(
        'screenshot',
      );
      expect(
        toolContent.find((p) => p.type === 'image_url')?.image_url?.url,
      ).toBe('data:image/png;base64,aaa');
    });

    it('should convert function responses with fileData to tool message with embedded image_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'File content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'image/jpeg',
                        fileUri: 'base64imagedata',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and image content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('File content');
      expect(contentArray[1].type).toBe('image_url');
      expect(contentArray[1].image_url?.url).toBe('base64imagedata');

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should convert PDF inlineData to tool message with embedded input_file', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'PDF content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'application/pdf',
                        data: 'base64pdfdata',
                        displayName: 'document.pdf',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and file content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        file?: { filename: string; file_data: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('PDF content');
      expect(contentArray[1].type).toBe('file');
      expect(contentArray[1].file?.filename).toBe('document.pdf');
      expect(contentArray[1].file?.file_data).toBe(
        'data:application/pdf;base64,base64pdfdata',
      );

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should convert audio parts to tool message with embedded input_audio', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Record',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Record',
                  response: { output: 'Audio recorded' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'audio/wav',
                        data: 'audiobase64data',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and audio content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        input_audio?: { data: string; format: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Audio recorded');
      expect(contentArray[1].type).toBe('input_audio');
      expect(contentArray[1].input_audio?.data).toBe(
        'data:audio/wav;base64,audiobase64data',
      );
      expect(contentArray[1].input_audio?.format).toBe('wav');

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should convert image fileData URL to tool message with embedded image_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Image content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'image/jpeg',
                        fileUri:
                          'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
                        displayName: 'ant.jpg',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Image content');
      expect(contentArray[1].type).toBe('image_url');
      expect(contentArray[1].image_url?.url).toBe(
        'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
      );
    });

    it('should convert PDF fileData URL to tool message with embedded file', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'PDF content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'application/pdf',
                        fileUri:
                          'https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf',
                        displayName: 'document.pdf',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        file?: { filename: string; file_data: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('PDF content');
      expect(contentArray[1].type).toBe('file');
      expect(contentArray[1].file?.filename).toBe('document.pdf');
      expect(contentArray[1].file?.file_data).toBe(
        'https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf',
      );
    });

    it('should convert video inlineData to tool message with embedded video_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Video content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'video/mp4',
                        data: 'videobase64data',
                        displayName: 'recording.mp4',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      // Should have tool message with both text and video content
      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        video_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Video content');
      expect(contentArray[1].type).toBe('video_url');
      expect(contentArray[1].video_url?.url).toBe(
        'data:video/mp4;base64,videobase64data',
      );

      // No separate user message should be created
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should convert video fileData URL to tool message with embedded video_url', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'Video content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'video/mp4',
                        fileUri: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
                        displayName: 'recording.mp4',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
        video_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Video content');
      expect(contentArray[1].type).toBe('video_url');
      expect(contentArray[1].video_url?.url).toBe(
        'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      );
    });

    it('should render unsupported inlineData file types as a text block', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'File content' },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'application/zip',
                        data: 'base64zipdata',
                        displayName: 'archive.zip',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('File content');
      expect(contentArray[1].type).toBe('text');
      expect(contentArray[1].text).toContain('Unsupported inline media type');
      expect(contentArray[1].text).toContain('application/zip');
      expect(contentArray[1].text).toContain('archive.zip');
    });

    it('should render unsupported fileData types (including audio) as a text block', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'Read',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'Read',
                  response: { output: 'File content' },
                  parts: [
                    {
                      fileData: {
                        mimeType: 'audio/mpeg',
                        fileUri: 'https://example.com/audio.mp3',
                        displayName: 'audio.mp3',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((message) => message.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('File content');
      expect(contentArray[1].type).toBe('text');
      expect(contentArray[1].text).toContain('Unsupported file media type');
      expect(contentArray[1].text).toContain('audio/mpeg');
      expect(contentArray[1].text).toContain('audio.mp3');
    });

    it('should create tool message with text-only content when no media parts', () => {
      const request = createRequestWithFunctionResponse({
        output: 'Plain text output',
      });

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const contentArray = toolMessage?.content as Array<{
        type: string;
        text?: string;
      }>;
      expect(contentArray).toHaveLength(1);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Plain text output');

      // No user message should be created when there's no media
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should serialize text-only tool content as a string when requested', () => {
      const request = createRequestWithFunctionResponse({
        output: 'Plain text output',
      });

      const messages = converter.convertLlmRequestToOpenAI(request, {
        ...requestContext,
        toolResultContentFormat: 'string',
      });
      const toolMessage = messages.find((message) => message.role === 'tool');

      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toBe('Plain text output');
      const userMessage = messages.find((message) => message.role === 'user');
      expect(userMessage).toBeUndefined();
    });

    it('should create tool message with empty content for empty function responses', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                text: 'Let me read that file.',
              },
              {
                functionCall: {
                  id: 'call_1',
                  name: 'read_file',
                  args: { path: 'test.txt' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'read_file',
                  response: { output: '' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      // Should create an assistant message with tool call and a tool message with empty content
      // This is required because OpenAI API expects every tool call to have a corresponding response
      expect(messages.length).toBeGreaterThanOrEqual(2);

      const toolMessage = messages.find(
        (m) =>
          m.role === 'tool' &&
          'tool_call_id' in m &&
          m.tool_call_id === 'call_1',
      );
      expect(toolMessage).toBeDefined();
      expect(toolMessage).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_1',
        content: '',
      });
    });

    it('should drop tool responses that are not adjacent to their assistant tool call', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_a',
                  name: 'read_file',
                  args: { path: 'a.txt' },
                },
              },
              {
                functionCall: {
                  id: 'call_b',
                  name: 'grep',
                  args: { pattern: 'needle' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_a',
                  name: 'read_file',
                  response: { output: 'A' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [{ text: 'history text inserted between tool results' }],
          },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_c',
                  name: 'list_files',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_c',
                  name: 'list_files',
                  response: { output: 'C' },
                },
              },
              {
                functionResponse: {
                  id: 'call_b',
                  name: 'grep',
                  response: { output: 'B' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );
      const assistantWithCallA = messages.find(
        (message): message is OpenAI.Chat.ChatCompletionAssistantMessageParam =>
          message.role === 'assistant' &&
          'tool_calls' in message &&
          Array.isArray(message.tool_calls) &&
          message.tool_calls.some((toolCall) => toolCall.id === 'call_a'),
      );

      expect(
        assistantWithCallA?.tool_calls?.map((toolCall) => toolCall.id),
      ).toEqual(['call_a']);

      const toolCallIds = messages
        .filter(
          (message): message is OpenAI.Chat.ChatCompletionToolMessageParam =>
            message.role === 'tool' && 'tool_call_id' in message,
        )
        .map((message) => message.tool_call_id);

      expect(toolCallIds).toEqual(['call_a', 'call_c']);
    });

    it('should keep assistant text when all tool calls are orphaned', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'I can answer without the tool.' },
              {
                functionCall: {
                  id: 'call_missing',
                  name: 'read_file',
                  args: { path: 'missing.txt' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [{ text: 'continue' }],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );
      const assistant = messages.find(
        (message): message is OpenAI.Chat.ChatCompletionAssistantMessageParam =>
          message.role === 'assistant',
      );

      expect(assistant?.content).toBe('I can answer without the tool.');
      expect('tool_calls' in (assistant ?? {})).toBe(false);
      expect(messages.some((message) => message.role === 'tool')).toBe(false);
    });

    it('should drop assistant-only tool calls when all responses are orphaned', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_missing',
                  name: 'read_file',
                  args: { path: 'missing.txt' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [{ text: 'break adjacency' }],
          },
          {
            role: 'user',
            parts: [{ text: 'continue' }],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages.some((message) => message.role === 'assistant')).toBe(
        false,
      );
      expect(messages.some((message) => message.role === 'tool')).toBe(false);
    });

    it('should drop later assistant tool calls that reuse a previous surviving id', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'dup_id_0001',
                  name: 'read_file',
                  args: { file_path: 'a.ts' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup_id_0001',
                  name: 'read_file',
                  response: { output: 'A' },
                },
              },
            ],
          },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'dup_id_0001',
                  name: 'read_file',
                  args: { file_path: 'b.ts' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup_id_0001',
                  name: 'read_file',
                  response: { output: 'B' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      const assistantToolCallIds = messages.flatMap((message) =>
        hasOpenAIToolCalls(message)
          ? message.tool_calls.map((toolCall) => toolCall.id)
          : [],
      );
      const toolResultIds = messages
        .filter(
          (message): message is OpenAI.Chat.ChatCompletionToolMessageParam =>
            message.role === 'tool' && 'tool_call_id' in message,
        )
        .map((message) => message.tool_call_id);

      expect(assistantToolCallIds).toEqual(['dup_id_0001']);
      expect(toolResultIds).toEqual(['dup_id_0001']);
    });

    it('should drop duplicate tool call IDs within a single assistant message', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'dup_id_0001',
                  name: 'read_file',
                  args: { file_path: 'a.ts' },
                },
              },
              {
                functionCall: {
                  id: 'dup_id_0001',
                  name: 'read_file',
                  args: { file_path: 'b.ts' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'dup_id_0001',
                  name: 'read_file',
                  response: { output: 'A' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );
      const assistant = messages.find(hasOpenAIToolCalls);

      expect(assistant?.tool_calls).toHaveLength(1);
      expect(assistant?.tool_calls?.[0].id).toBe('dup_id_0001');
      expect(assistant?.tool_calls?.[0].function.arguments).toBe(
        JSON.stringify({ file_path: 'a.ts' }),
      );
    });

    it('should keep only the first adjacent tool response and its split media for a surviving id', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_image',
                  name: 'screenshot',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_image',
                  name: 'screenshot',
                  response: { output: 'first' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'first' } },
                  ],
                },
              },
              {
                functionResponse: {
                  id: 'call_image',
                  name: 'screenshot',
                  response: { output: 'second' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'second' } },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(request, {
        ...requestContext,
        splitToolMedia: true,
      });
      const toolMessages = messages.filter(
        (message): message is OpenAI.Chat.ChatCompletionToolMessageParam =>
          message.role === 'tool' && 'tool_call_id' in message,
      );
      const splitMediaMessages = messages.filter(isOpenAISplitMediaMessage);

      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.content).toBe('first');
      expect(splitMediaMessages).toHaveLength(1);
      expect(JSON.stringify(splitMediaMessages[0])).toContain('first');
      expect(JSON.stringify(splitMediaMessages[0])).not.toContain('second');
    });

    it('should keep a tool response after an empty-id tool message', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_a',
                  name: 'read_file',
                  args: { path: 'a.txt' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: 'empty_id',
                  response: { output: 'no id' },
                },
              },
              {
                functionResponse: {
                  id: 'call_a',
                  name: 'read_file',
                  response: { output: 'A' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );
      const toolCallIds = messages
        .filter(
          (message): message is OpenAI.Chat.ChatCompletionToolMessageParam =>
            message.role === 'tool' && 'tool_call_id' in message,
        )
        .map((message) => message.tool_call_id);

      expect(toolCallIds).toEqual(['call_a']);
    });

    it('should clean after merging consecutive assistant turns', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_a',
                  name: 'read_file',
                  args: { path: 'a.txt' },
                },
              },
            ],
          },
          {
            role: 'model',
            parts: [{ text: 'A short follow-up.' }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_a',
                  name: 'read_file',
                  response: { output: 'A' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages[0]).toMatchObject({
        role: 'assistant',
        content: 'A short follow-up.',
      });
      expect(
        (
          messages[0] as OpenAI.Chat.ChatCompletionAssistantMessageParam
        ).tool_calls?.map((toolCall) => toolCall.id),
      ).toEqual(['call_a']);
      expect(messages[1]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_a',
      });
    });

    it('should keep split media after all adjacent tool responses across content items', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call_a', name: 'shot_a', args: {} },
              },
              {
                functionCall: { id: 'call_b', name: 'shot_b', args: {} },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_a',
                  name: 'shot_a',
                  response: { output: 'A' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'aaa' } },
                  ],
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_b',
                  name: 'shot_b',
                  response: { output: 'B' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'bbb' } },
                  ],
                },
              },
            ],
          },
        ],
      };
      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        strictContext,
      );
      const assistantIndex = messages.findIndex(
        (message) => message.role === 'assistant',
      );

      expect(messages[assistantIndex + 1]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_a',
      });
      expect(messages[assistantIndex + 2]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_b',
      });
      expect(messages[assistantIndex + 3]?.role).toBe('user');
      expect(messages[assistantIndex + 4]?.role).toBe('user');
    });

    it('should not keep split media from orphaned tool responses', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call_a', name: 'shot_a', args: {} },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_x',
                  name: 'shot_x',
                  response: { output: 'X' },
                  parts: [
                    { inlineData: { mimeType: 'image/png', data: 'xxx' } },
                  ],
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_a',
                  name: 'shot_a',
                  response: { output: 'A' },
                },
              },
            ],
          },
        ],
      };
      const strictContext: RequestContext = {
        ...requestContext,
        splitToolMedia: true,
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        strictContext,
      );

      expect(messages.map((message) => message.role)).toEqual([
        'assistant',
        'tool',
      ]);
      expect(messages[1]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_a',
      });
    });

    it('should merge assistant turns created by orphan cleanup', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call_a', name: 'read_file', args: {} },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_a',
                  name: 'read_file',
                  response: { output: 'A' },
                },
              },
            ],
          },
          {
            role: 'model',
            parts: [{ text: 'Next I will call another tool.' }],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_orphan',
                  name: 'stale_tool',
                  response: { output: 'stale' },
                },
              },
            ],
          },
          {
            role: 'model',
            parts: [
              {
                functionCall: { id: 'call_b', name: 'grep', args: {} },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_b',
                  name: 'grep',
                  response: { output: 'B' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      for (let index = 1; index < messages.length; index += 1) {
        expect([messages[index - 1].role, messages[index].role]).not.toEqual([
          'assistant',
          'assistant',
        ]);
      }
      expect(
        messages
          .filter(
            (message): message is OpenAI.Chat.ChatCompletionToolMessageParam =>
              message.role === 'tool' && 'tool_call_id' in message,
          )
          .map((message) => message.tool_call_id),
      ).toEqual(['call_a', 'call_b']);
    });

    describe('assistant message with reasoning-only content (issue #3421)', () => {
      /**
       * Regression tests for https://github.com/QwenLM/qwen-code/issues/3421
       *
       * When a model (e.g. Ollama qwen3.5:9b) returns a response that contains
       * reasoning content but an empty text body, the converted assistant message
       * must use content: "" instead of content: null.
       * Some OpenAI-compatible providers reject content: null with HTTP 400 when
       * reasoning_content is also present.
       */
      it('should use empty string instead of null for content when assistant has only reasoning parts', () => {
        const request: GenerateContentParameters = {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Think about this.' }] },
            {
              // Assistant turn that only produced a thought, no visible text
              role: 'model',
              parts: [{ text: 'I reasoned about it.', thought: true }],
            },
            { role: 'user', parts: [{ text: 'What did you conclude?' }] },
          ],
        };

        const messages = converter.convertLlmRequestToOpenAI(
          request,
          requestContext,
        );

        const assistantMsg = messages.find((m) => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        // Must NOT be null – Ollama and other providers reject null content
        // when reasoning_content is present (HTTP 400).
        expect((assistantMsg as { content: unknown }).content).toBe('');
        // reasoning_content should still be preserved
        expect(
          (assistantMsg as { reasoning_content?: string }).reasoning_content,
        ).toBe('I reasoned about it.');
      });

      it('should keep reasoning content when orphaned tool calls are removed', () => {
        const request: GenerateContentParameters = {
          model: 'models/test',
          contents: [
            {
              role: 'model',
              parts: [
                { text: 'I need to inspect this.', thought: true },
                {
                  functionCall: {
                    id: 'call_missing',
                    name: 'read_file',
                    args: {},
                  },
                },
              ],
            },
            { role: 'user', parts: [{ text: 'break adjacency' }] },
          ],
        };

        const messages = converter.convertLlmRequestToOpenAI(
          request,
          requestContext,
        );

        const assistantMsg = messages.find((m) => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect((assistantMsg as { content: unknown }).content).toBe('');
        expect(
          (assistantMsg as { reasoning_content?: string }).reasoning_content,
        ).toBe('I need to inspect this.');
        expect('tool_calls' in (assistantMsg ?? {})).toBe(false);
      });

      it('should keep content null when assistant has only tool_calls and no reasoning', () => {
        const request: GenerateContentParameters = {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Call the tool.' }] },
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call_1',
                    name: 'some_tool',
                    args: {},
                  },
                },
              ],
            },
            {
              role: 'user',
              parts: [
                {
                  functionResponse: {
                    id: 'call_1',
                    name: 'some_tool',
                    response: { output: 'done' },
                  },
                },
              ],
            },
          ],
        };

        const messages = converter.convertLlmRequestToOpenAI(
          request,
          requestContext,
        );

        const assistantMsg = messages.find((m) => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        // Tool-call-only messages follow the OpenAI spec: content should be null
        expect((assistantMsg as { content: unknown }).content).toBeNull();
      });

      it('should use actual text content when assistant has both reasoning and text', () => {
        const request: GenerateContentParameters = {
          model: 'models/test',
          contents: [
            { role: 'user', parts: [{ text: 'Explain.' }] },
            {
              role: 'model',
              parts: [
                { text: 'My hidden reasoning.', thought: true },
                { text: 'Here is my answer.' },
              ],
            },
          ],
        };

        const messages = converter.convertLlmRequestToOpenAI(
          request,
          requestContext,
        );

        const assistantMsg = messages.find((m) => m.role === 'assistant');
        expect(assistantMsg).toBeDefined();
        expect((assistantMsg as { content: unknown }).content).toBe(
          'Here is my answer.',
        );
        expect(
          (assistantMsg as { reasoning_content?: string }).reasoning_content,
        ).toBe('My hidden reasoning.');
      });
    });
  });

  describe('MCP multi-part tool results (issue #1520)', () => {
    /**
     * Regression tests for https://github.com/QwenLM/qwen-code/issues/1520
     *
     * Ensures that when an MCP tool returns multiple content blocks
     * (e.g., text + image, or multiple text sections), all content
     * ends up inside the tool message – NOT in a separate user message.
     *
     * These tests simulate the data shape produced by the *fixed*
     * convertToFunctionResponse(), where all text is joined into
     * `response.output` and media is placed in `response.parts`.
     */

    it('should include all text content in tool message when function response has joined text', () => {
      // After the fix, convertToFunctionResponse joins multiple text parts
      // into the FunctionResponse.response.output.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_mcp_1',
                  name: 'figma_get_code',
                  args: { nodeId: '38:521' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_mcp_1',
                  name: 'figma_get_code',
                  response: {
                    output:
                      '<div data-node-id="38:521">...</div>\nSUPER CRITICAL: The generated React+Tailwind code MUST be converted...',
                  },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect((toolMessage as { tool_call_id?: string }).tool_call_id).toBe(
        'call_mcp_1',
      );

      // All content is in the tool message
      const toolContent = toolMessage?.content;
      expect(Array.isArray(toolContent)).toBe(true);
      const toolTexts = (toolContent as Array<{ type: string; text?: string }>)
        .filter((p) => p.type === 'text')
        .map((p) => p.text);
      expect(toolTexts).toHaveLength(1);
      expect(toolTexts[0]).toContain('data-node-id');
      expect(toolTexts[0]).toContain('SUPER CRITICAL');

      // No user message should be created
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(0);
    });

    it('should include text and image in tool message when function response has media parts', () => {
      // After the fix, convertToFunctionResponse puts media into
      // FunctionResponse.parts, which the OpenAI converter picks up
      // in createToolMessage().
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_mcp_2',
                  name: 'figma_get_screenshot',
                  args: { nodeId: '38:521' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_mcp_2',
                  name: 'figma_get_screenshot',
                  response: {
                    output:
                      "[Tool 'figma' provided the following image data with mime-type: image/png]",
                  },
                  parts: [
                    {
                      inlineData: {
                        mimeType: 'image/png',
                        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      expect((toolMessage as { tool_call_id?: string }).tool_call_id).toBe(
        'call_mcp_2',
      );

      // Tool message should contain both text and image
      const toolContent = toolMessage?.content;
      expect(Array.isArray(toolContent)).toBe(true);
      const contentArray = toolContent as Array<{
        type: string;
        text?: string;
        image_url?: { url: string };
      }>;
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toContain('image data');
      expect(contentArray[1].type).toBe('image_url');
      expect(contentArray[1].image_url?.url).toContain('data:image/png');

      // No user message should be created
      const userMessages = messages.filter((m) => m.role === 'user');
      expect(userMessages).toHaveLength(0);
    });

    it('passes text-only nested parts (e.g. compaction slimmer placeholders) through to the tool message', () => {
      // The compaction slimming module replaces inlineData inside
      // functionResponse.parts with `{ text: '[image: image/png]' }`
      // before the side-query. createToolMessage must surface those
      // text placeholders, otherwise the summary model receives an
      // empty tool response with no signal that an image existed.
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_strip',
                  name: 'read_file',
                  args: { path: '/x.png' },
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_strip',
                  name: 'read_file',
                  response: { output: '' },
                  // After slimming: nested part is a text placeholder.
                  parts: [{ text: '[image: image/png]' }] as unknown as Part[],
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      const toolMessage = messages.find((m) => m.role === 'tool');
      expect(toolMessage).toBeDefined();
      const toolContent = toolMessage?.content;
      // Either string or array, depending on how OpenAI shapes single-part
      // content. Either way the placeholder must be visible verbatim.
      const flattened =
        typeof toolContent === 'string'
          ? toolContent
          : JSON.stringify(toolContent);
      expect(flattened).toContain('[image: image/png]');
      // Crucially, NO base64 image bytes leaked through.
      expect(flattened).not.toContain('data:image/');
    });
  });

  describe('convertOpenAIResponseToLlm', () => {
    it('should handle empty choices array without crashing', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-empty',
          created: 123,
          model: 'test-model',
          choices: [],
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      expect(response.candidates).toEqual([]);
      expect(response.modelVersion).toBe('test-model');
    });

    it('maps uppercase finish_reason values case-insensitively', () => {
      const stop = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-stop',
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'done' },
              finish_reason: 'STOP',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );
      const truncated = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-max-tokens',
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'cut off' },
              finish_reason: 'MAX_TOKENS',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      expect(stop.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(truncated.candidates?.[0]?.finishReason).toBe(
        FinishReason.MAX_TOKENS,
      );
    });

    it('does not throw on a non-string finish_reason from a malformed gateway', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-malformed',
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'done' },
              finish_reason: 42,
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      expect(response.candidates?.[0]?.finishReason).toBe(
        FinishReason.FINISH_REASON_UNSPECIFIED,
      );
    });

    it('omits the input/output breakdown when only total tokens are reported', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-usage',
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 'hi' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 5 },
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      const usage = response.usageMetadata;
      expect(usage?.totalTokenCount).toBe(5);
      expect(usage?.promptTokenCount).toBeUndefined();
      expect(usage?.candidatesTokenCount).toBeUndefined();
      expect(getGenAiUsageProvenance(usage)).toMatchObject({
        cachedInputTokensReported: false,
      });
    });

    it('omits the streaming input/output breakdown when only total tokens are reported', () => {
      const response = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-usage',
          created: 123,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 5 },
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        withStreamParser(),
      );

      const usage = response.usageMetadata;
      expect(usage?.totalTokenCount).toBe(5);
      expect(usage?.promptTokenCount).toBeUndefined();
      expect(usage?.candidatesTokenCount).toBeUndefined();
      expect(getGenAiUsageProvenance(usage)).toMatchObject({
        cachedInputTokensReported: false,
      });
    });

    it('distinguishes an absent cache field from an explicitly reported zero', () => {
      const base = {
        object: 'chat.completion',
        id: 'chatcmpl-cache',
        created: 123,
        model: 'provider-model',
        choices: [],
      } as const;
      const absent = converter.convertOpenAIResponseToLlm(
        {
          ...base,
          usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );
      const zero = converter.convertOpenAIResponseToLlm(
        {
          ...base,
          usage: {
            prompt_tokens: 3,
            completion_tokens: 1,
            total_tokens: 4,
            prompt_tokens_details: { cached_tokens: 0 },
          },
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      expect(absent.modelVersion).toBe('provider-model');
      expect(
        getGenAiUsageProvenance(absent.usageMetadata)
          ?.cachedInputTokensReported,
      ).toBe(false);
      expect(
        getGenAiUsageProvenance(zero.usageMetadata)?.cachedInputTokensReported,
      ).toBe(true);
    });

    it('estimates missing reasoning tokens from non-streaming content', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-reasoning-usage',
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'answer',
                reasoning_content: '先仔细想',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 },
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(5);
    });

    it('estimates missing reasoning tokens from non-streaming reasoning field', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-reasoning-field-usage',
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'answer',
                reasoning: '先仔细想',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 },
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(5);
    });

    it('clamps estimated non-streaming reasoning tokens to completion tokens', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-reasoning-clamped-usage',
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'answer',
                reasoning_content: '想'.repeat(10),
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(3);
    });

    it.each([0, 42])(
      'preserves provider reasoning tokens for non-streaming content: %s',
      (reasoningTokens) => {
        const response = converter.convertOpenAIResponseToLlm(
          {
            object: 'chat.completion',
            id: 'chatcmpl-provider-reasoning-usage',
            created: 123,
            model: 'test-model',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'answer',
                  reasoning_content: '先仔细想',
                },
                finish_reason: 'stop',
                logprobs: null,
              },
            ],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 10,
              total_tokens: 11,
              completion_tokens_details: {
                reasoning_tokens: reasoningTokens,
              },
            },
          } as unknown as OpenAI.Chat.ChatCompletion,
          requestContext,
        );

        expect(response.usageMetadata?.thoughtsTokenCount).toBe(
          reasoningTokens,
        );
      },
    );

    it('estimates reasoning tokens past the streaming detection window', () => {
      const context = withStreamParser();
      const reasoningChunk = (id: string, reasoning_content: string) =>
        ({
          object: 'chat.completion.chunk',
          id,
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: { reasoning_content },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }) as unknown as OpenAI.Chat.ChatCompletionChunk;

      converter.convertOpenAIChunkToLlm(
        reasoningChunk('chunk-reasoning-1', '想'.repeat(1024)),
        context,
      );
      converter.convertOpenAIChunkToLlm(
        reasoningChunk('chunk-reasoning-2', '想'),
        context,
      );
      const response = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-reasoning-usage',
          created: 123,
          model: 'test-model',
          choices: [],
          usage: {
            prompt_tokens: 1,
            completion_tokens: 1200,
            total_tokens: 1201,
          },
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(1128);
    });

    it('estimates reasoning tokens for short streaming content', () => {
      const context = withStreamParser();
      const reasoningChunk = (id: string, reasoning_content: string) =>
        ({
          object: 'chat.completion.chunk',
          id,
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: { reasoning_content },
              finish_reason: null,
              logprobs: null,
            },
          ],
        }) as unknown as OpenAI.Chat.ChatCompletionChunk;

      converter.convertOpenAIChunkToLlm(
        reasoningChunk('chunk-short-reasoning-1', '先'),
        context,
      );
      converter.convertOpenAIChunkToLlm(
        reasoningChunk('chunk-short-reasoning-2', '仔细想'),
        context,
      );
      const response = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-short-reasoning-usage',
          created: 123,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 10, total_tokens: 11 },
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(5);
    });

    it('estimates normalized cumulative reasoning without a completion count', () => {
      const context = withStreamParser();
      for (const reasoning_content of ['先仔细想', '先仔细想再检查']) {
        converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: 'chunk-cumulative-reasoning',
            created: 123,
            model: 'test-model',
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          context,
        );
      }
      const response = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-cumulative-reasoning-usage',
          created: 123,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 0, total_tokens: 1 },
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(8);
    });

    it('clamps estimated streaming reasoning tokens to completion tokens', () => {
      const context = withStreamParser();
      converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-clamped-reasoning',
          created: 123,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: { reasoning_content: '想'.repeat(10) },
              finish_reason: null,
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const response = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-clamped-reasoning-usage',
          created: 123,
          model: 'test-model',
          choices: [],
          usage: { prompt_tokens: 1, completion_tokens: 3, total_tokens: 4 },
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(3);
    });

    it.each([0, 42])(
      'preserves provider reasoning tokens for streaming content: %s',
      (reasoningTokens) => {
        const context = withStreamParser();
        converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: 'chunk-provider-reasoning',
            created: 123,
            model: 'test-model',
            choices: [
              {
                index: 0,
                delta: { reasoning_content: '先仔细想' },
                finish_reason: null,
                logprobs: null,
              },
            ],
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          context,
        );
        const response = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: 'chunk-provider-reasoning-usage',
            created: 123,
            model: 'test-model',
            choices: [],
            usage: {
              prompt_tokens: 1,
              completion_tokens: 10,
              total_tokens: 11,
              completion_tokens_details: {
                reasoning_tokens: reasoningTokens,
              },
            },
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          context,
        );

        expect(response.usageMetadata?.thoughtsTokenCount).toBe(
          reasoningTokens,
        );
      },
    );
  });

  describe('OpenAI -> Gemini reasoning content', () => {
    it('should convert reasoning_content to a thought part for non-streaming responses', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-1',
          created: 123,
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'final answer',
                reasoning_content: 'chain-of-thought',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      const parts = response.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'chain-of-thought' }),
      );
      expect(isOpenAIReasoningThoughtPart(parts?.[0] as Part)).toBe(true);
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'final answer' }),
      );
    });

    it('should convert reasoning to a thought part for non-streaming responses', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-2',
          created: 123,
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'final answer',
                reasoning: 'chain-of-thought',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        requestContext,
      );

      const parts = response.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'chain-of-thought' }),
      );
      expect(isOpenAIReasoningThoughtPart(parts?.[0] as Part)).toBe(true);
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'final answer' }),
      );
    });

    it('should convert streaming reasoning_content delta to a thought part', () => {
      const chunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-1',
          created: 456,
          choices: [
            {
              index: 0,
              delta: {
                content: 'visible text',
                reasoning_content: 'thinking...',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        withStreamParser(new StreamingToolCallParser()),
      );

      const parts = chunk.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'thinking...' }),
      );
      expect(isOpenAIReasoningThoughtPart(parts?.[0] as Part)).toBe(true);
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'visible text' }),
      );
    });

    it('should convert streaming reasoning delta to a thought part', () => {
      const chunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-1b',
          created: 456,
          choices: [
            {
              index: 0,
              delta: {
                content: 'visible text',
                reasoning: 'thinking...',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        withStreamParser(new StreamingToolCallParser()),
      );

      const parts = chunk.candidates?.[0]?.content?.parts;
      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: 'thinking...' }),
      );
      expect(parts?.[1]).toEqual(
        expect.objectContaining({ text: 'visible text' }),
      );
    });

    it('should not throw when streaming chunk has no delta', () => {
      const chunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-2',
          created: 456,
          choices: [
            {
              index: 0,
              // Some OpenAI-compatible providers may omit delta entirely.
              delta: undefined,
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        withStreamParser(new StreamingToolCallParser()),
      );

      const parts = chunk.candidates?.[0]?.content?.parts;
      expect(parts).toEqual([]);
    });

    it('should normalize cumulative streaming content deltas to suffixes', () => {
      const ctx = withStreamParser();
      const chunks = [
        'Here',
        'Here is a Flowchart Syntax Reference:',
        'Here is a Flowchart Syntax Reference:\n| `flowchart TD` | Direction |',
        'Here is a Flowchart Syntax Reference:\n| `flowchart TD` | Direction |\n| `A[Text]` | Node |',
      ];

      const emitted = chunks.map((content, index) => {
        const chunk = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: `chunk-cumulative-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        return chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      });

      expect(emitted).toEqual([
        'Here',
        ' is a Flowchart Syntax Reference:',
        '\n| `flowchart TD` | Direction |',
        '\n| `A[Text]` | Node |',
      ]);
      expect(emitted.join('')).toBe(chunks[chunks.length - 1]);
    });

    it('should ignore repeated cumulative chunks with no new suffix', () => {
      const ctx = withStreamParser();
      // Must be ≥ CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH (64 chars) so the
      // exact-repeat branch enters cumulative mode rather than treating this
      // as a short legitimate repeat. Realistic cumulative providers replay
      // buffers of hundreds of bytes, so this length is representative.
      const content =
        'The following section starts with more than enough text for cumulative-mode detection.';
      const emitted = [content, content].map((chunkContent, index) => {
        const chunk = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: `chunk-cumulative-repeat-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { content: chunkContent },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        return chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      });

      expect(emitted).toEqual([content, '']);
    });

    it('should preserve repeated short incremental content chunks', () => {
      const ctx = withStreamParser();
      const emitted = ['ha', 'ha'].map((content, index) => {
        const chunk = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: `chunk-repeat-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        return chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      });

      expect(emitted).toEqual(['ha', 'ha']);
    });

    it('should normalize cumulative streaming reasoning_content deltas to suffixes', () => {
      const ctx = withStreamParser();
      const chunks = [
        'Let me think',
        'Let me think about the request carefully.',
        'Let me think about the request carefully.\nFirst, identify the table format.',
      ];

      const emitted = chunks.map((reasoning_content, index) => {
        const chunk = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-cumulative-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        const part = chunk.candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      expect(emitted).toEqual([
        { text: 'Let me think', thought: true },
        { text: ' about the request carefully.', thought: true },
        { text: '\nFirst, identify the table format.', thought: true },
      ]);
      expect(emitted.map((e) => e.text).join('')).toBe(
        chunks[chunks.length - 1],
      );
    });

    it('should exit cumulative mode when a chunk does not match prior accumulated text', () => {
      const ctx = withStreamParser();
      // Three chunks that establish cumulative mode, then one that breaks it.
      const chunks = [
        'Step one is to gather inputs.',
        'Step one is to gather inputs.\nStep two is to validate them.',
        'Brand new unrelated message.',
      ];

      const emitted = chunks.map((content, index) => {
        const chunk = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: `chunk-cumulative-exit-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        );

        return chunk.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      });

      // Chunk 1: emits as-is (initial)
      // Chunk 2: cumulative mode entered, emits suffix only
      // Chunk 3: NOT a prefix-extension — cumulative mode must exit and the
      //          new chunk must be appended verbatim (no silent loss)
      expect(emitted[0]).toBe('Step one is to gather inputs.');
      expect(emitted[1]).toBe('\nStep two is to validate them.');
      expect(emitted[2]).toBe('Brand new unrelated message.');
    });

    it('should resume prefix detection cleanly after exiting cumulative mode', () => {
      const ctx = withStreamParser();
      // Establish cumulative mode, then break it, then send another cumulative
      // stream — the fresh baseline should allow re-entry into cumulative mode.
      const chunks = [
        'Step one is to gather inputs.',
        'Step one is to gather inputs.\nStep two is to validate them.',
        'Brand new unrelated message.',
        'Brand new unrelated message. And more.',
      ];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-reentry-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      expect(emitted[0]).toBe('Step one is to gather inputs.');
      expect(emitted[1]).toBe('\nStep two is to validate them.');
      // Cumulative mode exits; fresh baseline = chunk 3
      expect(emitted[2]).toBe('Brand new unrelated message.');
      // Chunk 4 prefix-extends chunk 3 — re-enters cumulative, emits suffix only
      expect(emitted[3]).toBe(' And more.');
    });

    it('should not poison the baseline when short chunks repeat before threshold', () => {
      const ctx = withStreamParser();
      // Short exact-repeat followed by a prefix-extending chunk.
      // The repeat must NOT corrupt emittedText so the extension is detected.
      const chunks = ['Hi', 'Hi', 'Hi there, how are you today?'];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-short-repeat-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial
      expect(emitted[0]).toBe('Hi');
      // Chunk 2: short exact repeat — passthrough, baseline stays 'Hi'
      expect(emitted[1]).toBe('Hi');
      // Chunk 3: prefix-extends 'Hi' — enters cumulative, emits suffix
      expect(emitted[2]).toBe(' there, how are you today?');
    });

    it('should normalize cumulative reasoning_content deltas across multi-line growth (newline-prefixed suffixes)', () => {
      // Distinct from the single-line cumulative reasoning test above:
      // this case grows the accumulated text across newline boundaries so the
      // emitted suffixes themselves begin with '\n', exercising the slice
      // arithmetic at the newline.
      const ctx = withStreamParser();
      const chunks = [
        'Let me reason step by step.',
        'Let me reason step by step.\nFirst: check the inputs.',
        'Let me reason step by step.\nFirst: check the inputs.\nSecond: validate.',
      ];

      const emitted = chunks.map((reasoning_content, index) => {
        const part = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-cumulative2-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      expect(emitted[0]).toEqual({
        text: 'Let me reason step by step.',
        thought: true,
      });
      expect(emitted[1]).toEqual({
        text: '\nFirst: check the inputs.',
        thought: true,
      });
      expect(emitted[2]).toEqual({
        text: '\nSecond: validate.',
        thought: true,
      });
    });

    it('should ignore repeated cumulative reasoning_content chunks with no new suffix', () => {
      // Mirrors the content-channel `should ignore repeated cumulative chunks
      // with no new suffix` test: the reasoning channel uses a separate state
      // object, so the exact-repeat entry path is exercised independently.
      const ctx = withStreamParser();
      // Must be ≥ CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH (64 chars).
      const reasoning =
        'The reasoning section also starts with more than enough text to pass detection.';
      const emitted = [reasoning, reasoning].map((reasoning_content, index) => {
        const part = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-repeat-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      // Chunk 1: emits as a thought part.
      expect(emitted[0]).toEqual({ text: reasoning, thought: true });
      // Chunk 2: exact repeat — enters cumulative mode, suppressed (no part).
      expect(emitted[1]).toEqual({ text: '', thought: false });
    });

    it('should exit cumulative mode on reasoning_content channel when chunk does not match prior accumulated text', () => {
      // Mirrors the content-channel `should exit cumulative mode` test against
      // the reasoning channel's independent state.
      const ctx = withStreamParser();
      const chunks = [
        'Step one of my reasoning is to gather inputs.',
        'Step one of my reasoning is to gather inputs.\nStep two: validate.',
        'Brand new unrelated reasoning.',
      ];

      const emitted = chunks.map((reasoning_content, index) => {
        const part = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-exit-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      // Chunk 1: initial passthrough.
      expect(emitted[0]).toEqual({
        text: 'Step one of my reasoning is to gather inputs.',
        thought: true,
      });
      // Chunk 2: cumulative mode entered, emits suffix only.
      expect(emitted[1]).toEqual({
        text: '\nStep two: validate.',
        thought: true,
      });
      // Chunk 3: NOT a prefix-extension — cumulative mode must exit and the
      //          new chunk must be appended verbatim (no silent loss).
      expect(emitted[2]).toEqual({
        text: 'Brand new unrelated reasoning.',
        thought: true,
      });
    });

    it('should resume prefix detection on reasoning_content channel after exiting cumulative mode', () => {
      // Mirrors the content-channel `should resume prefix detection cleanly
      // after exiting cumulative mode` test. After the exit path resets the
      // baseline to the new chunk, the reasoning channel must be able to
      // re-enter cumulative mode on the next prefix-extending chunk.
      const ctx = withStreamParser();
      const chunks = [
        'Step one of my reasoning is to gather inputs.',
        'Step one of my reasoning is to gather inputs.\nStep two: validate.',
        'Brand new unrelated reasoning.',
        'Brand new unrelated reasoning. And further reflection.',
      ];

      const emitted = chunks.map((reasoning_content, index) => {
        const part = converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: `chunk-reasoning-reentry-${index}`,
            created: 456 + index,
            choices: [
              {
                index: 0,
                delta: { reasoning_content },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });

      expect(emitted[0]).toEqual({
        text: 'Step one of my reasoning is to gather inputs.',
        thought: true,
      });
      expect(emitted[1]).toEqual({
        text: '\nStep two: validate.',
        thought: true,
      });
      // Cumulative mode exits; fresh baseline = chunk 3.
      expect(emitted[2]).toEqual({
        text: 'Brand new unrelated reasoning.',
        thought: true,
      });
      // Chunk 4 prefix-extends chunk 3 — re-enters cumulative, emits suffix only.
      expect(emitted[3]).toEqual({
        text: ' And further reflection.',
        thought: true,
      });
    });

    it('should deduplicate interleaved reasoning_content and content channels independently', () => {
      const ctx = withStreamParser();
      // reasoning_content and content each use a separate state object;
      // cumulative detection in one channel must not bleed into the other.
      const chunks: Array<{ reasoning_content?: string; content?: string }> = [
        { reasoning_content: 'Let me think about this carefully.' },
        { content: 'Here' },
        { reasoning_content: 'Let me think about this carefully.\nStep two.' },
        { content: 'Here is the answer.' },
      ];

      const emitted = chunks.map(
        (delta, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-interleaved-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta,
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts ?? [],
      );

      // Reasoning chunk 1: emits as thought
      expect(emitted[0]).toEqual([
        { text: 'Let me think about this carefully.', thought: true },
      ]);
      // Content chunk 1: emits as text (independent state)
      expect(emitted[1]).toEqual([{ text: 'Here' }]);
      // Reasoning chunk 2: cumulative extension — emits suffix only
      expect(emitted[2]).toEqual([{ text: '\nStep two.', thought: true }]);
      // Content chunk 2: cumulative extension of content channel
      expect(emitted[3]).toEqual([{ text: ' is the answer.' }]);
    });

    it('should enter cumulative mode on exact 64-char repeat (at threshold)', () => {
      const ctx = withStreamParser();
      // Exactly 64 chars — meets CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH.
      // The threshold sits well above realistic legit-repeat lengths (e.g. a
      // duplicate `import { foo } from './module';` is ~31 chars) so that
      // legitimate repeats are never silently suppressed.
      const atThreshold = 'A'.repeat(64);
      const chunks = [atThreshold, atThreshold, atThreshold + ' and more'];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-threshold64-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial passthrough
      expect(emitted[0]).toBe(atThreshold);
      // Chunk 2: exact 64-char repeat — enters cumulative mode, suppressed
      expect(emitted[1]).toBe('');
      // Chunk 3: cumulative extension — emits suffix only
      expect(emitted[2]).toBe(' and more');
    });

    it('should pass through 63-char exact repeat without entering cumulative mode (below threshold)', () => {
      const ctx = withStreamParser();
      // 63 chars — one short of CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH
      const belowThreshold = 'A'.repeat(63);
      const chunks = [
        belowThreshold,
        belowThreshold,
        belowThreshold + ' extra',
      ];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-threshold63-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial passthrough
      expect(emitted[0]).toBe(belowThreshold);
      // Chunk 2: 63-char repeat — below threshold, passes through unchanged
      expect(emitted[1]).toBe(belowThreshold);
      // Chunk 3: prefix-extends prior — enters cumulative, emits suffix only
      expect(emitted[2]).toBe(' extra');
    });

    it('should preserve legitimate duplicate import-line chunks (regression: silent data loss)', () => {
      // Regression for https://github.com/QwenLM/qwen-code/pull/3896 review
      // (wenshao, 2026-05-13 CHANGES_REQUESTED, finding #1). Realistic
      // incremental streams emit duplicate import/boilerplate lines and the
      // exact-repeat threshold must be high enough that those legitimate
      // repeats are NOT silently suppressed. A duplicate ~31-char import is
      // the canonical motivating case.
      const ctx = withStreamParser();
      const importLine = "import { foo } from './module';"; // 31 chars
      const chunks = [importLine, importLine, '\nconst x = 1;'];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-import-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // All three chunks must reach the user — no suppression.
      expect(emitted[0]).toBe(importLine);
      expect(emitted[1]).toBe(importLine);
      expect(emitted[2]).toBe('\nconst x = 1;');
      // Sanity: the reassembled stream equals the user-visible total.
      expect(emitted.join('')).toBe(importLine + importLine + '\nconst x = 1;');
    });

    it('should pass incremental chunks through verbatim past the detection window cap (none of them overlap)', () => {
      // Incremental providers send fresh, non-overlapping chunks. Even after
      // emittedText growth exceeds CUMULATIVE_DETECTION_WINDOW_BYTES (1024)
      // and the baseline stops growing, every subsequent chunk that lacks
      // prefix overlap with the frozen baseline must still be emitted
      // verbatim (i.e., it must fall through to the final passthrough
      // branch). This guards against any future regression that would, e.g.,
      // wrongly short-circuit the passthrough path once the cap is reached.
      //
      // Note: this test does NOT cover the (currently unhandled) case where a
      // later chunk happens to start with the frozen baseline — that chunk
      // would still trigger prefix-overlap detection against a stale
      // baseline. Such a chunk is vanishingly unlikely on a true incremental
      // stream (≥1024 bytes of exact-prefix coincidence) but is not
      // explicitly defended against here.
      const ctx = withStreamParser();
      // 100 distinct incremental chunks of 20 chars = 2000 chars, well past the cap.
      const incrementalChunks = Array.from(
        { length: 100 },
        (_, i) => `chunk${String(i).padStart(3, '0')}-payload__`,
      );
      const allEmitted = incrementalChunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-cap-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Every chunk should pass through verbatim — none of them overlap
      // with prior emittedText, so prefix/exact-repeat detection never fires.
      expect(allEmitted).toEqual(incrementalChunks);
    });

    it('should detect cumulative mode even when the first chunk exceeds the detection window cap', () => {
      // Regression for https://github.com/QwenLM/qwen-code/pull/3896 review:
      // Some cumulative providers ship a large initial chunk (>1024 chars)
      // and then accumulate more text on subsequent chunks. The detection
      // window cap must not short-circuit prefix-overlap detection before the
      // second chunk gets a chance to be classified, otherwise the entire
      // first chunk gets duplicated.
      const ctx = withStreamParser();
      const firstChunk = 'A'.repeat(1500); // well past CUMULATIVE_DETECTION_WINDOW_BYTES (1024)
      const secondChunk = firstChunk + 'B'.repeat(200); // cumulative extension
      const thirdChunk = secondChunk + 'C'.repeat(50); // further cumulative extension

      const emitted = [firstChunk, secondChunk, thirdChunk].map(
        (content, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-large-first-${index}`,
              created: 789 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial passthrough.
      expect(emitted[0]).toBe(firstChunk);
      // Chunk 2: prefix-extends → cumulative mode, emits the 200-char suffix only.
      expect(emitted[1]).toBe('B'.repeat(200));
      // Chunk 3: continues in cumulative mode, emits only the new 50-char suffix.
      expect(emitted[2]).toBe('C'.repeat(50));
    });

    it('should not duplicate emitted bytes when an incremental stream transitions into cumulative mode past the window cap', () => {
      // Regression for https://github.com/QwenLM/qwen-code/pull/3896 review
      // (wenshao, 2026-05-13 CHANGES_REQUESTED, finding #2). Hybrid scenario:
      // upstream emits 200 distinct incremental chunks of 8 bytes each (1600
      // bytes of user-visible content, well past the 1024-byte detection-
      // window cap), then sends a single cumulative chunk that replays the
      // full 1600 bytes and appends new content. The internal baseline froze
      // at 1024 bytes; without tracking the true emitted length, the suffix
      // would be sliced from byte 1024 of the cumulative chunk and the user
      // would see bytes 1024..1600 a second time. The fix tracks emittedLength
      // separately so the slice starts from the real user-visible boundary
      // (1600). The chunks must be DISTINCT (otherwise the short-exact-repeat
      // branch keeps emittedText pinned and the cap is never reached).
      const ctx = withStreamParser();
      const incremental = Array.from(
        { length: 200 },
        (_, i) => `c${String(i).padStart(3, '0')}=AB_`, // 8 bytes, distinct per chunk
      );
      const accumulated = incremental.join(''); // 1600 bytes
      const tail = '|CONTINUATION|'; // 14 bytes
      const cumulativeChunk = accumulated + tail; // 1614 bytes

      const incrementalEmitted = incremental.map(
        (content, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-hybrid-incr-${index}`,
              created: 1000 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      const cumulativeEmitted =
        converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: 'chunk-hybrid-cum',
            created: 2000,
            choices: [
              {
                index: 0,
                delta: { content: cumulativeChunk },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts?.[0]?.text ?? '';

      // Incremental phase: every chunk passes through verbatim.
      expect(incrementalEmitted).toEqual(incremental);
      // Cumulative chunk: only the new 14-byte tail must be emitted — not the
      // ~576 bytes between the cap (1024) and the true emitted total (1600).
      expect(cumulativeEmitted).toBe(tail);
      // Sanity: reassembled stream equals the original accumulated text.
      const userVisible = incrementalEmitted.join('') + cumulativeEmitted;
      expect(userVisible).toBe(cumulativeChunk);
      expect(userVisible.length).toBe(1614);
    });

    it('should suppress cumulative rewind (provider re-sends shorter accumulated string)', () => {
      const ctx = withStreamParser();
      // Scenario: provider sends Hello → Hello World (extension) → Hello (rewind) → Hello World! (extension again)
      const chunks = ['Hello', 'Hello World', 'Hello', 'Hello World!'];

      const emitted = chunks.map(
        (content, index) =>
          converter.convertOpenAIChunkToLlm(
            {
              object: 'chat.completion.chunk',
              id: `chunk-rewind-${index}`,
              created: 456 + index,
              choices: [
                {
                  index: 0,
                  delta: { content },
                  finish_reason: null,
                  logprobs: null,
                },
              ],
              model: 'gpt-test',
            } as unknown as OpenAI.Chat.ChatCompletionChunk,
            ctx,
          ).candidates?.[0]?.content?.parts?.[0]?.text ?? '',
      );

      // Chunk 1: initial passthrough
      expect(emitted[0]).toBe('Hello');
      // Chunk 2: prefix-extends 'Hello' → enters cumulative, emits suffix
      expect(emitted[1]).toBe(' World');
      // Chunk 3: rewind — 'Hello' is a strict prefix of emitted 'Hello World' → suppressed
      expect(emitted[2]).toBe('');
      // Chunk 4: extension resumes from 'Hello World' → emits '!'
      expect(emitted[3]).toBe('!');
    });

    it('should still call into convertOpenAITextToParts on finish_reason when the cumulative-mode normalized delta is empty', () => {
      // Targets the `normalizedContent || choice.finish_reason` guard on the
      // content path: in cumulative mode an exact-repeat final chunk yields a
      // normalized delta of '' but must still flush buffered tagged-thinking
      // content (and any other finish-time side effects) via
      // convertOpenAITextToParts. The earlier cumulative tests all use
      // `finish_reason: null`, so this exercises the empty-normalized +
      // non-null finish_reason path in a cumulative context.
      const ctx = withStreamParser();
      // 1) Prefix-extension chunk pair establishes cumulative mode and primes
      //    `emittedText` so the next exact-repeat is the cumulative branch.
      converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-cum-empty-finish-0',
          created: 456,
          choices: [
            {
              index: 0,
              delta: { content: 'Answer: forty-two' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        ctx,
      );
      converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-cum-empty-finish-1',
          created: 457,
          choices: [
            {
              index: 0,
              delta: { content: 'Answer: forty-two and more.' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        ctx,
      );

      // 2) Final chunk: re-sends the accumulated string verbatim along with
      //    `finish_reason: 'stop'`. The normalized delta is '' (cumulative
      //    suffix-of-self), but the finish_reason must still drive
      //    convertOpenAITextToParts.
      const finalChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-cum-empty-finish-2',
          created: 458,
          choices: [
            {
              index: 0,
              delta: { content: 'Answer: forty-two and more.' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'gpt-test',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        ctx,
      );

      // The cumulative-suppressed empty delta produces no text part, but
      // because finish_reason is set, the converter still reaches the parts
      // pipeline; on a clean (no buffered tag) state this yields parts: [].
      // The crucial invariant: no exception thrown, finishReason propagates,
      // and no spurious duplicate text emerges.
      expect(finalChunk.candidates?.[0]?.finishReason).toBe('STOP');
      const finalText =
        finalChunk.candidates?.[0]?.content?.parts
          ?.filter((p) => 'text' in p)
          ?.map((p) => (p as { text: string }).text)
          ?.join('') ?? '';
      expect(finalText).toBe('');
    });

    it('should handle a single chunk delta with both reasoning_content and content simultaneously', () => {
      const ctx = withStreamParser();
      ctx.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const part =
        converter.convertOpenAIChunkToLlm(
          {
            object: 'chat.completion.chunk',
            id: 'chunk-dual-1',
            created: 456,
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: 'I need to think.',
                  content: 'Here is my answer.',
                },
                finish_reason: null,
                logprobs: null,
              },
            ],
            model: 'gpt-test',
          } as unknown as OpenAI.Chat.ChatCompletionChunk,
          ctx,
        ).candidates?.[0]?.content?.parts ?? [];

      // Both channels should emit independently in the same response
      const thoughtPart = part.find((p) => p.thought === true);
      const textPart = part.find((p) => !p.thought);
      expect(thoughtPart?.text).toBe('I need to think.');
      expect(textPart?.text).toBe('Here is my answer.');
    });
  });

  describe('OpenAI -> Gemini tagged thinking content', () => {
    it('should convert MiniMax <think> content to thought parts for non-streaming responses', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-minimax-1',
          created: 123,
          model: 'MiniMax-M2.7',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<think>internal reasoning</think>final answer',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        withTaggedThinkingOptions(),
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: 'internal reasoning', thought: true },
        { text: 'final answer' },
      ]);
    });

    it('should preserve ordering around <thinking> blocks', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-minimax-2',
          created: 123,
          model: 'MiniMax-M2.7',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'before<thinking>hidden</thinking>after',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        withTaggedThinkingOptions(),
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: 'before' },
        { text: 'hidden', thought: true },
        { text: 'after' },
      ]);
    });

    it('should parse multiple tagged thinking blocks case-insensitively', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-minimax-3',
          created: 123,
          model: 'MiniMax-M2.7',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<THINK>a</THINK>visible<Thinking>b</Thinking>',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        withTaggedThinkingOptions(),
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: 'a', thought: true },
        { text: 'visible' },
        { text: 'b', thought: true },
      ]);
    });

    it('should leave tags visible when tagged thinking parsing is disabled', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-openai-1',
          created: 123,
          model: 'gpt-test',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: '<think>visible xml example</think>',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        {
          ...requestContext,
          responseParsingOptions: { contentOnlyThinkingTagLeaks: true },
        },
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: '<think>visible xml example</think>' },
      ]);
    });

    it('should preserve incomplete tags as visible text on final non-streaming parse', () => {
      const response = converter.convertOpenAIResponseToLlm(
        {
          object: 'chat.completion',
          id: 'chatcmpl-minimax-4',
          created: 123,
          model: 'MiniMax-M2.7',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'final answer <thi',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletion,
        withTaggedThinkingOptions(),
      );

      expect(response.candidates?.[0]?.content?.parts).toEqual([
        { text: 'final answer <thi' },
      ]);
    });

    it('should parse streaming tags split across chunks', () => {
      const context = withTaggedThinkingStreamParser();

      const firstChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-minimax-1',
          created: 456,
          choices: [
            {
              index: 0,
              delta: { content: 'pre <thi' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'MiniMax-M2.7',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const secondChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-minimax-2',
          created: 457,
          choices: [
            {
              index: 0,
              delta: { content: 'nk>hidden</thi' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'MiniMax-M2.7',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const finalChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-minimax-3',
          created: 458,
          choices: [
            {
              index: 0,
              delta: { content: 'nk> visible' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'MiniMax-M2.7',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(firstChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'pre ' },
      ]);
      expect(secondChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'hidden', thought: true },
      ]);
      expect(finalChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: ' visible' },
      ]);
    });

    it('should suppress reasoning_content when the same streaming chunk has tagged thinking content', () => {
      const context = withTaggedThinkingStreamParser();

      const chunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-dual-tagged',
          created: 456,
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: 'duplicate reasoning channel',
                content: '<think>tagged reasoning</think>final answer',
              },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(chunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'tagged reasoning', thought: true },
        { text: 'final answer' },
      ]);
    });

    it('should suppress late reasoning_content after streaming tagged thinking content', () => {
      const context = withTaggedThinkingStreamParser();

      const firstChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-late-reasoning-1',
          created: 456,
          choices: [
            {
              index: 0,
              delta: { content: '<think>tagged reasoning</think>' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const secondChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-late-reasoning-2',
          created: 457,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: 'late reasoning' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(firstChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'tagged reasoning', thought: true },
      ]);
      expect(secondChunk.candidates?.[0]?.content?.parts).toEqual([]);
    });

    it('should suppress buffered reasoning_content when later streaming content has tagged thinking', () => {
      const context = withTaggedThinkingStreamParser();

      const firstChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-buffered-reasoning-1',
          created: 456,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: 'duplicate reasoning channel' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const secondChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-buffered-reasoning-2',
          created: 457,
          choices: [
            {
              index: 0,
              delta: { content: '<think>tagged reasoning</think>' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const finalChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-buffered-reasoning-3',
          created: 458,
          choices: [
            {
              index: 0,
              delta: { content: 'final answer' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(firstChunk.candidates?.[0]?.content?.parts).toEqual([]);
      expect(secondChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'tagged reasoning', thought: true },
      ]);
      expect(finalChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'final answer' },
      ]);
    });

    it('should flush buffered content before later tagged thinking content', () => {
      const context = withTaggedThinkingStreamParser();

      const firstChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-buffered-content-before-tag-1',
          created: 456,
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: 'duplicate reasoning channel',
                content: 'early visible ',
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const secondChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-buffered-content-before-tag-2',
          created: 457,
          choices: [
            {
              index: 0,
              delta: { content: '<think>tagged reasoning</think>final answer' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(firstChunk.candidates?.[0]?.content?.parts).toEqual([]);
      expect(secondChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'early visible ' },
        { text: 'tagged reasoning', thought: true },
        { text: 'final answer' },
      ]);
    });

    it('should flush buffered content before current content when reasoning flushes on finish', () => {
      const context = withTaggedThinkingStreamParser();

      const firstChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-buffered-content-order-1',
          created: 456,
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: 'step 1',
                content: 'hello ',
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const finalChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-buffered-content-order-2',
          created: 457,
          choices: [
            {
              index: 0,
              delta: { content: 'world' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(firstChunk.candidates?.[0]?.content?.parts).toEqual([]);
      expect(finalChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'step 1', thought: true },
        { text: 'hello ' },
        { text: 'world' },
      ]);
    });

    it('should flush buffered reasoning_content when tagged streaming content has no thinking tags', () => {
      const context = withTaggedThinkingStreamParser();

      const firstChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-reasoning-only-1',
          created: 456,
          choices: [
            {
              index: 0,
              delta: {
                reasoning_content: 'separate reasoning channel',
                content: 'final ',
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const finalChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-reasoning-only-2',
          created: 457,
          choices: [
            {
              index: 0,
              delta: { content: 'answer' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      const finalParts = finalChunk.candidates?.[0]?.content?.parts;

      expect(firstChunk.candidates?.[0]?.content?.parts).toEqual([]);
      expect(finalParts).toEqual([
        { text: 'separate reasoning channel', thought: true },
        { text: 'final ' },
        { text: 'answer' },
      ]);
      expect(isOpenAIReasoningThoughtPart(finalParts?.[0] as Part)).toBe(true);
    });

    it('should flush reasoning-only chunks when tagged streaming content has no thinking tags', () => {
      const context = withTaggedThinkingStreamParser();

      const firstChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-reasoning-only-no-content-1',
          created: 456,
          choices: [
            {
              index: 0,
              delta: { reasoning_content: 'step 1' },
              finish_reason: null,
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
      const finalChunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-glm-reasoning-only-no-content-2',
          created: 457,
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'glm-5.2',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(firstChunk.candidates?.[0]?.content?.parts).toEqual([]);
      expect(finalChunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'step 1', thought: true },
      ]);
    });

    it('should flush unclosed streaming thinking content on finish', () => {
      const context = withTaggedThinkingStreamParser();

      const chunk = converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-minimax-unclosed',
          created: 456,
          choices: [
            {
              index: 0,
              delta: { content: 'answer <think>still thinking' },
              finish_reason: 'stop',
              logprobs: null,
            },
          ],
          model: 'MiniMax-M2.7',
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );

      expect(chunk.candidates?.[0]?.content?.parts).toEqual([
        { text: 'answer ' },
        { text: 'still thinking', thought: true },
      ]);
    });
  });

  describe('convertLlmToolsToOpenAI', () => {
    it('removes uniqueItems from function-calling wire schemas', async () => {
      const parametersJsonSchema = {
        type: 'object',
        properties: {
          blockedBy: {
            type: 'array',
            uniqueItems: true,
            items: { type: 'string' },
          },
        },
      };
      const tools = [
        {
          functionDeclarations: [
            {
              name: 'todo_write',
              description: 'Update the todo list',
              parametersJsonSchema,
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertLlmToolsToOpenAI(tools);

      expect(result).toEqual([
        {
          type: 'function',
          function: {
            name: 'todo_write',
            description: 'Update the todo list',
            parameters: {
              type: 'object',
              properties: {
                blockedBy: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
            },
          },
        },
      ]);
      expect(parametersJsonSchema.properties.blockedBy.uniqueItems).toBe(true);
    });

    it('should convert Gemini tools with parameters field', async () => {
      const llmTools = [
        {
          functionDeclarations: [
            {
              name: 'get_weather',
              description: 'Get weather for a location',
              parameters: {
                type: Type.OBJECT,
                properties: {
                  location: { type: Type.STRING },
                },
                required: ['location'],
              },
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertLlmToolsToOpenAI(llmTools);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: 'object',
            properties: {
              location: { type: 'string' },
            },
            required: ['location'],
          },
        },
      });
    });

    // Regression for #7315: the wire schema must not carry
    // additionalProperties:false on levels with optional properties —
    // OpenAI-compatible gateways promote every property to required,
    // forcing mutually exclusive optional fields (Agent working_dir vs
    // isolation) into every call.
    it('relaxes additionalProperties:false for schemas with optional fields', async () => {
      const agentLikeTools = [
        {
          functionDeclarations: [
            {
              name: 'agent',
              description: 'Launch a new agent',
              parametersJsonSchema: {
                $schema: 'http://json-schema.org/draft-07/schema#',
                type: 'object',
                properties: {
                  description: { type: 'string' },
                  prompt: { type: 'string' },
                  working_dir: { type: 'string' },
                  isolation: { type: 'string', enum: ['worktree'] },
                },
                required: ['description', 'prompt'],
                additionalProperties: false,
              },
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertLlmToolsToOpenAI(agentLikeTools);
      const params = result[0]!.function.parameters as Record<string, unknown>;
      expect(params['additionalProperties']).toBeUndefined();
      expect(params['$schema']).toBeUndefined();
      // Required stays exactly as authored — optional fields remain optional.
      expect(params['required']).toEqual(['description', 'prompt']);
    });

    it('keeps additionalProperties:false when every property is required', async () => {
      const strictTools = [
        {
          functionDeclarations: [
            {
              name: 'strict_tool',
              description: 'All fields required',
              parametersJsonSchema: {
                type: 'object',
                properties: { path: { type: 'string' } },
                required: ['path'],
                additionalProperties: false,
              },
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertLlmToolsToOpenAI(strictTools);
      const params = result[0]!.function.parameters as Record<string, unknown>;
      expect(params['additionalProperties']).toBe(false);
    });

    it('should convert MCP tools with parametersJsonSchema field', async () => {
      // MCP tools use parametersJsonSchema which contains plain JSON schema (not Gemini types)
      const mcpTools = [
        {
          functionDeclarations: [
            {
              name: 'read_file',
              description: 'Read a file from disk',
              parametersJsonSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string' },
                },
                required: ['path'],
              },
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertLlmToolsToOpenAI(mcpTools);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        type: 'function',
        function: {
          name: 'read_file',
          description: 'Read a file from disk',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
      });
    });

    it('should handle CallableTool by resolving tool function', async () => {
      const callableTools = [
        {
          tool: async () => ({
            functionDeclarations: [
              {
                name: 'dynamic_tool',
                description: 'A dynamically resolved tool',
                parameters: {
                  type: Type.OBJECT,
                  properties: {},
                },
              },
            ],
          }),
        },
      ] as CallableTool[];

      const result = await converter.convertLlmToolsToOpenAI(callableTools);

      expect(result).toHaveLength(1);
      expect(result[0].function.name).toBe('dynamic_tool');
    });

    it('should preserve functions without description and skip functions without name', async () => {
      const llmTools = [
        {
          functionDeclarations: [
            {
              name: 'valid_tool',
              description: 'A valid tool',
            },
            {
              name: 'missing_description',
              // no description
            },
            {
              // no name
              description: 'Missing name',
            },
          ],
        },
      ] as Tool[];

      const result = await converter.convertLlmToolsToOpenAI(llmTools);

      expect(result).toHaveLength(2);
      expect(result[0].function.name).toBe('valid_tool');
      expect(result[0].function.description).toBe('A valid tool');
      expect(result[1].function.name).toBe('missing_description');
      expect(result[1].function.description).toBe('');
    });

    it('should handle tools without functionDeclarations', async () => {
      const emptyTools: Tool[] = [{} as Tool, { functionDeclarations: [] }];

      const result = await converter.convertLlmToolsToOpenAI(emptyTools);

      expect(result).toHaveLength(0);
    });

    it('should handle functions without parameters', async () => {
      const llmTools: Tool[] = [
        {
          functionDeclarations: [
            {
              name: 'no_params_tool',
              description: 'A tool without parameters',
            },
          ],
        },
      ];

      const result = await converter.convertLlmToolsToOpenAI(llmTools);

      expect(result).toHaveLength(1);
      expect(result[0].function.parameters).toBeUndefined();
    });

    it('should not mutate original parametersJsonSchema', async () => {
      const originalSchema = {
        type: 'object',
        properties: { foo: { type: 'string' } },
      };
      const mcpTools: Tool[] = [
        {
          functionDeclarations: [
            {
              name: 'test_tool',
              description: 'Test tool',
              parametersJsonSchema: originalSchema,
            },
          ],
        } as Tool,
      ];

      const result = await converter.convertLlmToolsToOpenAI(mcpTools);

      // Verify the result is a copy, not the same reference
      expect(result[0].function.parameters).not.toBe(originalSchema);
      expect(result[0].function.parameters).toEqual(originalSchema);
    });
  });

  describe('convertLlmToolParametersToOpenAI', () => {
    it('should convert type names to lowercase', () => {
      const params = {
        type: 'OBJECT',
        properties: {
          count: { type: 'INTEGER' },
          amount: { type: 'NUMBER' },
          name: { type: 'STRING' },
        },
      };

      const result = converter.convertLlmToolParametersToOpenAI(params);

      expect(result).toEqual({
        type: 'object',
        properties: {
          count: { type: 'integer' },
          amount: { type: 'number' },
          name: { type: 'string' },
        },
      });
    });

    it('converts subschemas of properties named after schema keywords', () => {
      // A tool can declare a parameter literally called `maximum` or
      // `minItems`. Those are property NAMES, not constraints, so their
      // subschemas must still be converted like any other property.
      const params = {
        type: 'OBJECT',
        properties: {
          maximum: {
            type: 'INTEGER',
            description: 'upper bound',
            minimum: '5',
          },
          minItems: { type: 'STRING' },
          normalProp: { type: 'STRING' },
        },
      };

      const result = converter.convertLlmToolParametersToOpenAI(params);
      const properties = result?.['properties'] as Record<string, unknown>;

      expect(properties?.['maximum']).toEqual({
        type: 'integer',
        description: 'upper bound',
        minimum: 5,
      });
      expect(properties?.['minItems']).toEqual({ type: 'string' });
      expect(properties?.['normalProp']).toEqual({ type: 'string' });
    });

    it('should convert string numeric constraints to numbers', () => {
      const params = {
        type: 'object',
        properties: {
          value: {
            type: 'number',
            minimum: '0',
            maximum: '100',
            multipleOf: '0.5',
          },
        },
      };

      const result = converter.convertLlmToolParametersToOpenAI(params);
      const properties = result?.['properties'] as Record<string, unknown>;

      expect(properties?.['value']).toEqual({
        type: 'number',
        minimum: 0,
        maximum: 100,
        multipleOf: 0.5,
      });
    });

    it('should convert string length constraints to integers', () => {
      const params = {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            minLength: '1',
            maxLength: '100',
          },
          items: {
            type: 'array',
            minItems: '0',
            maxItems: '10',
          },
        },
      };

      const result = converter.convertLlmToolParametersToOpenAI(params);
      const properties = result?.['properties'] as Record<string, unknown>;

      expect(properties?.['text']).toEqual({
        type: 'string',
        minLength: 1,
        maxLength: 100,
      });
      expect(properties?.['items']).toEqual({
        type: 'array',
        minItems: 0,
        maxItems: 10,
      });
    });

    it('should not truncate non-integer length constraints', () => {
      const params = {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            minLength: '1.5',
            maxLength: '   ',
          },
          items: {
            type: 'array',
            minItems: '10px',
            maxItems: '1.5',
          },
        },
      };

      const result = converter.convertLlmToolParametersToOpenAI(params);
      const properties = result?.['properties'] as Record<string, unknown>;

      expect(properties?.['text']).toEqual({
        type: 'string',
        minLength: '1.5',
        maxLength: '   ',
      });
      expect(properties?.['items']).toEqual({
        type: 'array',
        minItems: '10px',
        maxItems: '1.5',
      });
    });

    it('should handle nested objects', () => {
      const params = {
        type: 'object',
        properties: {
          nested: {
            type: 'object',
            properties: {
              deep: {
                type: 'INTEGER',
                minimum: '0',
              },
            },
          },
        },
      };

      const result = converter.convertLlmToolParametersToOpenAI(params);
      const properties = result?.['properties'] as Record<string, unknown>;
      const nested = properties?.['nested'] as Record<string, unknown>;
      const nestedProperties = nested?.['properties'] as Record<
        string,
        unknown
      >;

      expect(nestedProperties?.['deep']).toEqual({
        type: 'integer',
        minimum: 0,
      });
    });

    it('should handle arrays', () => {
      const params = {
        type: 'array',
        items: {
          type: 'INTEGER',
        },
      };

      const result = converter.convertLlmToolParametersToOpenAI(params);

      expect(result).toEqual({
        type: 'array',
        items: {
          type: 'integer',
        },
      });
    });

    it('should return undefined for null or non-object input', () => {
      expect(
        converter.convertLlmToolParametersToOpenAI(
          null as unknown as Record<string, unknown>,
        ),
      ).toBeNull();
      expect(
        converter.convertLlmToolParametersToOpenAI(
          undefined as unknown as Record<string, unknown>,
        ),
      ).toBeUndefined();
    });

    it('should not mutate the original parameters', () => {
      const original = {
        type: 'OBJECT',
        properties: {
          count: { type: 'INTEGER' },
        },
      };
      const originalCopy = JSON.parse(JSON.stringify(original));

      converter.convertLlmToolParametersToOpenAI(original);

      expect(original).toEqual(originalCopy);
    });
  });

  describe('mergeConsecutiveAssistantMessages', () => {
    it('should preserve reasoning_content from every merged assistant turn', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              { text: 'First reasoning.', thought: true },
              { text: 'First answer.' },
            ],
          },
          {
            role: 'model',
            parts: [
              { text: 'Second reasoning.', thought: true },
              { text: 'Second answer.' },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe('First answer.Second answer.');
      // The reasoning of the merged-away turn must not be silently dropped.
      expect(
        (messages[0] as { reasoning_content?: string }).reasoning_content,
      ).toBe('First reasoning.Second reasoning.');
    });

    it('should merge two consecutive assistant messages with string content', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'First part' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Second part' }],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe('First partSecond part');
    });

    it('should merge multiple consecutive assistant messages', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'Part 1' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Part 2' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Part 3' }],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('assistant');
      expect(messages[0].content).toBe('Part 1Part 2Part 3');
    });

    it('should merge tool_calls from consecutive assistant messages', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_1',
                  name: 'tool_1',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_1',
                  name: 'tool_1',
                  response: { output: 'result_1' },
                },
              },
            ],
          },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_2',
                  name: 'tool_2',
                  args: {},
                },
              },
            ],
          },
          {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'call_2',
                  name: 'tool_2',
                  response: { output: 'result_2' },
                },
              },
            ],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
        {
          cleanOrphanToolCalls: false,
        },
      );

      // Should have: assistant (tool_call_1), tool (result_1), assistant (tool_call_2), tool (result_2)
      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe('assistant');
      expect(messages[1].role).toBe('tool');
      expect(messages[2].role).toBe('assistant');
      expect(messages[3].role).toBe('tool');
    });

    it('should not merge assistant messages separated by user messages', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'First assistant' }],
          },
          {
            role: 'user',
            parts: [{ text: 'User message' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Second assistant' }],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe('assistant');
      expect(messages[1].role).toBe('user');
      expect(messages[2].role).toBe('assistant');
    });

    it('should handle merging when one message has array content and another has string', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'Text part' }],
          },
          {
            role: 'model',
            parts: [{ text: 'Another text' }],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Text partAnother text');
    });

    it('should merge empty content correctly', () => {
      const request: GenerateContentParameters = {
        model: 'models/test',
        contents: [
          {
            role: 'model',
            parts: [{ text: 'First' }],
          },
          {
            role: 'model',
            parts: [],
          },
          {
            role: 'model',
            parts: [{ text: 'Second' }],
          },
        ],
      };

      const messages = converter.convertLlmRequestToOpenAI(
        request,
        requestContext,
      );

      // Empty messages should be filtered out
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('FirstSecond');
    });
  });
});

describe('MCP tool result end-to-end through OpenAI converter (issue #1520)', () => {
  /**
   * End-to-end regression tests for https://github.com/QwenLM/qwen-code/issues/1520
   *
   * Simulates the full pipeline:
   *   transformMcpContentToParts → convertToFunctionResponse → OpenAI converter
   *
   * Verifies that multi-part MCP tool results are properly carried through
   * into the OpenAI tool message, with no content leaking into user messages.
   */
  let converter: typeof OpenAIContentConverter;
  let requestContext: RequestContext;

  beforeEach(() => {
    converter = OpenAIContentConverter;
    requestContext = {
      model: 'test-model',
      modalities: {
        image: true,
        pdf: true,
        audio: true,
        video: true,
      },
      startTime: 0,
    };
  });

  it('should preserve MCP multi-text content in tool message (not leak to user message)', () => {
    // Step 1: Simulate what transformMcpContentToParts returns for a Figma
    // tool that returns code + instructions as two text blocks
    const mcpTransformedParts: Part[] = [
      { text: '<div data-node-id="38:521"><h1>Welcome</h1></div>' },
      {
        text: 'SUPER CRITICAL: Convert the React+Tailwind code to match the target stack.',
      },
    ];

    // Step 2: convertToFunctionResponse wraps the MCP result
    const callId = 'call_figma_1';
    const toolName = 'figma_get_code';
    const responseParts = convertToFunctionResponse(
      toolName,
      callId,
      mcpTransformedParts,
    );

    // Step 3: Build the conversation history (model tool call + tool result)
    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: callId,
              name: toolName,
              args: { nodeId: '38:521' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: responseParts,
      },
    ];

    // Step 4: Convert to OpenAI format
    const request: GenerateContentParameters = {
      model: 'models/test',
      contents,
    };
    const messages = converter.convertLlmRequestToOpenAI(
      request,
      requestContext,
    );

    const toolMessages = messages.filter((m) => m.role === 'tool');
    const userMessages = messages.filter((m) => m.role === 'user');
    const assistantMessages = messages.filter((m) => m.role === 'assistant');

    expect(toolMessages).toHaveLength(1);
    expect(assistantMessages).toHaveLength(1);
    // No content should leak into a user message
    expect(userMessages).toHaveLength(0);

    // Tool message should contain the actual MCP content
    const toolMsg = toolMessages[0];
    expect((toolMsg as { tool_call_id: string }).tool_call_id).toBe(callId);

    const toolContent = toolMsg.content;
    expect(Array.isArray(toolContent)).toBe(true);
    const toolTexts = (toolContent as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text);
    expect(toolTexts).toHaveLength(1);
    expect(toolTexts[0]).toContain('data-node-id');
    expect(toolTexts[0]).toContain('SUPER CRITICAL');
  });

  it('should preserve MCP text+image content in tool message', () => {
    // Simulates MCP tool returning text description + image (e.g., get_screenshot)
    const mcpTransformedParts: Part[] = [
      {
        text: "[Tool 'figma' provided the following image data with mime-type: image/png]",
      },
      {
        inlineData: {
          mimeType: 'image/png',
          data: 'iVBORw0KGgo=',
        },
      },
    ];

    const callId = 'call_figma_2';
    const toolName = 'figma_get_screenshot';
    const responseParts = convertToFunctionResponse(
      toolName,
      callId,
      mcpTransformedParts,
    );

    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: callId,
              name: toolName,
              args: { nodeId: '38:521' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: responseParts,
      },
    ];

    const request: GenerateContentParameters = {
      model: 'models/test',
      contents,
    };
    const messages = converter.convertLlmRequestToOpenAI(
      request,
      requestContext,
    );

    const toolMessages = messages.filter((m) => m.role === 'tool');
    const userMessages = messages.filter((m) => m.role === 'user');

    expect(toolMessages).toHaveLength(1);
    // No content should leak into a user message
    expect(userMessages).toHaveLength(0);

    // Tool message should contain both text description and image
    const toolMsg = toolMessages[0];
    const toolContent = toolMsg.content;
    expect(Array.isArray(toolContent)).toBe(true);
    const contentArray = toolContent as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;
    expect(contentArray).toHaveLength(2);
    expect(contentArray[0].type).toBe('text');
    expect(contentArray[0].text).toContain('image data');
    expect(contentArray[1].type).toBe('image_url');
    expect(contentArray[1].image_url?.url).toContain('data:image/png');
  });

  it('should work correctly when MCP tool returns a single text part', () => {
    // Single text part — the control case that has always worked
    const mcpTransformedParts: Part[] = [
      { text: 'Single text response from MCP tool' },
    ];

    const callId = 'call_mcp_single';
    const toolName = 'mcp_tool';
    const responseParts = convertToFunctionResponse(
      toolName,
      callId,
      mcpTransformedParts,
    );

    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: callId,
              name: toolName,
              args: {},
            },
          },
        ],
      },
      {
        role: 'user',
        parts: responseParts,
      },
    ];

    const request: GenerateContentParameters = {
      model: 'models/test',
      contents,
    };
    const messages = converter.convertLlmRequestToOpenAI(
      request,
      requestContext,
    );

    const toolMessages = messages.filter((m) => m.role === 'tool');
    const userMessages = messages.filter((m) => m.role === 'user');

    expect(toolMessages).toHaveLength(1);
    expect(userMessages).toHaveLength(0);

    const toolMsg = toolMessages[0];
    const toolContent = toolMsg.content;
    expect(Array.isArray(toolContent)).toBe(true);
    const toolTexts = (toolContent as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === 'text')
      .map((p) => p.text);
    expect(toolTexts).toHaveLength(1);
    expect(toolTexts[0]).toBe('Single text response from MCP tool');
  });

  it('should preserve MCP multi-text + multi-image content in tool message', () => {
    // Simulates a complex MCP response with multiple text blocks and images
    const mcpTransformedParts: Part[] = [
      { text: 'Here is the design mockup:' },
      {
        text: "[Tool 'pencil' provided the following image data with mime-type: image/png]",
      },
      {
        inlineData: {
          mimeType: 'image/png',
          data: 'screenshotBase64Data',
        },
      },
      { text: 'And here are the node details...' },
    ];

    const callId = 'call_pencil_1';
    const toolName = 'mcp__pencil__get_screenshot';
    const responseParts = convertToFunctionResponse(
      toolName,
      callId,
      mcpTransformedParts,
    );

    const contents: Content[] = [
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: callId,
              name: toolName,
              args: { nodeId: 'vHOGa' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: responseParts,
      },
    ];

    const request: GenerateContentParameters = {
      model: 'models/test',
      contents,
    };
    const messages = converter.convertLlmRequestToOpenAI(
      request,
      requestContext,
    );

    const toolMessages = messages.filter((m) => m.role === 'tool');
    const userMessages = messages.filter((m) => m.role === 'user');

    expect(toolMessages).toHaveLength(1);
    expect(userMessages).toHaveLength(0);

    const toolMsg = toolMessages[0];
    expect((toolMsg as { tool_call_id: string }).tool_call_id).toBe(callId);

    const toolContent = toolMsg.content;
    expect(Array.isArray(toolContent)).toBe(true);
    const contentArray = toolContent as Array<{
      type: string;
      text?: string;
      image_url?: { url: string };
    }>;

    // Should have text (all joined) + image
    expect(contentArray).toHaveLength(2);
    expect(contentArray[0].type).toBe('text');
    expect(contentArray[0].text).toContain('design mockup');
    expect(contentArray[0].text).toContain('image data');
    expect(contentArray[0].text).toContain('node details');
    expect(contentArray[1].type).toBe('image_url');
    expect(contentArray[1].image_url?.url).toContain('data:image/png');
  });
});

describe('Truncated tool call detection in streaming', () => {
  let converter: typeof OpenAIContentConverter;

  beforeEach(() => {
    converter = OpenAIContentConverter;
  });

  function createStreamingRequestContext(model = 'test-model'): RequestContext {
    return {
      model,
      modalities: {},
      startTime: 0,
      toolCallParser: new StreamingToolCallParser(),
    };
  }

  /**
   * Helper: feed streaming chunks then a final chunk with finish_reason,
   * and return the Gemini response for the final chunk.
   */
  function feedToolCallChunks(
    conv: typeof OpenAIContentConverter,
    toolCallChunks: Array<{
      index: number;
      id?: string;
      name?: string;
      arguments: string;
    }>,
    finishReason: string,
  ) {
    // One stream-local context covers every chunk of this simulated stream.
    const ctx = createStreamingRequestContext();

    // Feed argument chunks (no finish_reason yet)
    for (const tc of toolCallChunks) {
      conv.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-stream',
          created: 100,
          model: 'test-model',
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  {
                    index: tc.index,
                    id: tc.id,
                    type: 'function' as const,
                    function: {
                      name: tc.name,
                      arguments: tc.arguments,
                    },
                  },
                ],
              },
              finish_reason: null,
              logprobs: null,
            },
          ],
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        ctx,
      );
    }

    // Final chunk with finish_reason
    return conv.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-final',
        created: 101,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: finishReason,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      ctx,
    );
  }

  it('emits tool preparation metadata before the complete function call', () => {
    const context = createStreamingRequestContext();
    const opener = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-open',
        created: 100,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'read_file', arguments: '' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );
    const args = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-args',
        created: 101,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: { arguments: '{"file_path":"a.sql"}' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );
    const finish = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-finish',
        created: 102,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );

    expect(getToolCallPreparations(opener)).toEqual([
      { callId: 'call-1', toolName: 'read_file' },
    ]);
    expect(getToolCallPreparations(args)).toEqual([]);
    expect(getToolCallPreparations(finish)).toEqual([]);
    expect(opener.functionCalls).toBeUndefined();
    expect(finish.functionCalls).toEqual([
      { id: 'call-1', name: 'read_file', args: { file_path: 'a.sql' } },
    ]);
  });

  it('does not duplicate tool preparation metadata for a replayed opener', () => {
    const context = createStreamingRequestContext();
    const opener = {
      object: 'chat.completion.chunk',
      id: 'chunk-open',
      created: 100,
      model: 'test-model',
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                type: 'function',
                function: { name: 'read_file', arguments: '' },
              },
            ],
          },
          finish_reason: null,
          logprobs: null,
        },
      ],
    } as unknown as OpenAI.Chat.ChatCompletionChunk;

    const first = converter.convertOpenAIChunkToLlm(opener, context);
    const replay = converter.convertOpenAIChunkToLlm(opener, context);

    expect(getToolCallPreparations(first)).toEqual([
      { callId: 'call-1', toolName: 'read_file' },
    ]);
    expect(getToolCallPreparations(replay)).toEqual([]);
  });

  it('emits preparation after split identity deltas using the remapped parser index', () => {
    const context = createStreamingRequestContext();

    const firstCall = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-first-call',
        created: 100,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'read_file',
                    arguments: '{"file_path":"a.sql"}',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );
    const secondCallId = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-second-id',
        created: 101,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call-2', type: 'function' }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );
    const secondCallName = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-second-name',
        created: 102,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: '{"file_path":"b.sql"}',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );
    const thirdCallName = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-third-name',
        created: 103,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: {
                    name: 'delete_file',
                    arguments: '',
                  },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );
    const thirdCallArguments = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-third-arguments',
        created: 104,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  type: 'function',
                  function: { arguments: '{"file_path":"c.sql"}' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );
    const thirdCallId = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-third-id',
        created: 105,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'call-3', type: 'function' }],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );
    const finish = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-finish',
        created: 106,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'tool_calls',
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      context,
    );

    expect(getToolCallPreparations(firstCall)).toEqual([
      { callId: 'call-1', toolName: 'read_file' },
    ]);
    expect(getToolCallPreparations(secondCallId)).toEqual([]);
    expect(getToolCallPreparations(secondCallName)).toEqual([
      { callId: 'call-2', toolName: 'write_file' },
    ]);
    expect(getToolCallPreparations(thirdCallName)).toEqual([]);
    expect(getToolCallPreparations(thirdCallArguments)).toEqual([]);
    expect(getToolCallPreparations(thirdCallId)).toEqual([
      { callId: 'call-3', toolName: 'delete_file' },
    ]);
    expect(firstCall.functionCalls).toBeUndefined();
    expect(secondCallId.functionCalls).toBeUndefined();
    expect(secondCallName.functionCalls).toBeUndefined();
    expect(thirdCallName.functionCalls).toBeUndefined();
    expect(thirdCallArguments.functionCalls).toBeUndefined();
    expect(thirdCallId.functionCalls).toBeUndefined();
    expect(finish.functionCalls).toEqual([
      { id: 'call-1', name: 'read_file', args: { file_path: 'a.sql' } },
      { id: 'call-2', name: 'write_file', args: { file_path: 'b.sql' } },
      { id: 'call-3', name: 'delete_file', args: { file_path: 'c.sql' } },
    ]);
  });

  it.each([
    {
      label: 'call ID is missing',
      toolCall: {
        index: 0,
        type: 'function' as const,
        function: { name: 'read_file', arguments: '' },
      },
    },
    {
      label: 'tool name is missing',
      toolCall: {
        index: 0,
        id: 'call-1',
        type: 'function' as const,
        function: { arguments: '' },
      },
    },
  ])('does not emit tool preparation metadata when $label', ({ toolCall }) => {
    const response = converter.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'chunk-open',
        created: 100,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: { tool_calls: [toolCall] },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      createStreamingRequestContext(),
    );

    expect(getToolCallPreparations(response)).toEqual([]);
  });

  it('should override finishReason to MAX_TOKENS when tool call JSON is truncated and provider reports "stop"', () => {
    // Simulate: write_file call truncated mid-JSON, provider says "stop"
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments: '{"file_path": "/tmp/test.cpp"',
          // Missing closing brace and content field — truncated
        },
      ],
      'stop',
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should override finishReason to MAX_TOKENS when provider reports "tool_calls" but JSON is truncated', () => {
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments:
            '{"file_path": "/tmp/test.cpp", "content": "partial content',
          // Truncated mid-string
        },
      ],
      'tool_calls',
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should preserve finishReason STOP when tool call JSON is complete', () => {
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments: '{"file_path": "/tmp/test.cpp", "content": "hello"}',
        },
      ],
      'stop',
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
  });

  it('should preserve finishReason MAX_TOKENS when provider already reports "length"', () => {
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments: '{"file_path": "/tmp/test.cpp"',
        },
      ],
      'length',
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should still emit the (repaired) function call even when truncated', () => {
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'write_file',
          arguments: '{"file_path": "/tmp/test.cpp"',
        },
      ],
      'stop',
    );

    const parts = result.candidates?.[0]?.content?.parts ?? [];
    const fnCall = parts.find((p: Part) => p.functionCall);
    expect(fnCall).toBeDefined();
    expect(fnCall?.functionCall?.name).toBe('write_file');
    expect(fnCall?.functionCall?.args).toEqual({
      file_path: '/tmp/test.cpp',
    });
  });

  it('should detect truncation with multi-chunk streaming arguments', () => {
    // Feed arguments in multiple small chunks like real streaming
    const conv = OpenAIContentConverter;
    const ctx = createStreamingRequestContext();

    // Chunk 1: start of JSON with tool metadata
    conv.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'c1',
        created: 100,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_1',
                  type: 'function' as const,
                  function: { name: 'write_file', arguments: '{"file_' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      ctx,
    );

    // Chunk 2: more arguments
    conv.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'c2',
        created: 100,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: { arguments: 'path": "/tmp/f.txt", "conten' },
                },
              ],
            },
            finish_reason: null,
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      ctx,
    );

    // Final chunk: finish_reason "stop" but JSON is still incomplete
    const result = conv.convertOpenAIChunkToLlm(
      {
        object: 'chat.completion.chunk',
        id: 'c3',
        created: 101,
        model: 'test-model',
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: 'stop',
            logprobs: null,
          },
        ],
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      ctx,
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });
});

describe('mapLlmFinishReasonToOpenAI', () => {
  it.each([
    [FinishReason.STOP, 'stop'],
    [FinishReason.MAX_TOKENS, 'length'],
    [FinishReason.SAFETY, 'content_filter'],
    [FinishReason.RECITATION, 'content_filter'],
    [FinishReason.BLOCKLIST, 'content_filter'],
    [FinishReason.PROHIBITED_CONTENT, 'content_filter'],
    [FinishReason.SPII, 'content_filter'],
    [FinishReason.IMAGE_SAFETY, 'content_filter'],
    [FinishReason.IMAGE_RECITATION, 'content_filter'],
    [FinishReason.IMAGE_PROHIBITED_CONTENT, 'content_filter'],
    [FinishReason.IMAGE_OTHER, 'content_filter'],
    [FinishReason.NO_IMAGE, 'stop'],
    [undefined, 'stop'],
  ])('maps %s to %s', (llmReason, expected) => {
    const response = OpenAIContentConverter.convertLlmResponseToOpenAI(
      {
        candidates: [{ finishReason: llmReason, content: { parts: [] } }],
      } as unknown as GenerateContentResponse,
      {
        model: 'test-model',
        modalities: {
          image: true,
          pdf: true,
          audio: true,
          video: true,
        },
        startTime: 0,
      },
    );
    expect(response.choices[0].finish_reason).toBe(expected);
  });
});

describe('modality filtering', () => {
  function makeRequest(parts: Part[]): GenerateContentParameters {
    return {
      model: 'test-model',
      contents: [{ role: 'user', parts }],
    };
  }

  function makeRequestContext(
    model: string,
    modalities: RequestContext['modalities'],
  ): RequestContext {
    return {
      model,
      modalities,
      startTime: 0,
    };
  }

  function getUserContentParts(
    messages: OpenAI.Chat.ChatCompletionMessageParam[],
  ): Array<{ type: string; text?: string }> {
    const userMsg = messages.find((m) => m.role === 'user');
    if (
      !userMsg ||
      !('content' in userMsg) ||
      !Array.isArray(userMsg.content)
    ) {
      return [];
    }
    return userMsg.content as Array<{ type: string; text?: string }>;
  }

  it('replaces image with placeholder when image modality is disabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'image/png', data: 'abc123' },
        displayName: 'screenshot.png',
      } as unknown as Part,
    ]);
    const messages = conv.convertLlmRequestToOpenAI(
      request,
      makeRequestContext('deepseek-chat', {}),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('image file');
    expect(parts[0].text).toContain('does not support image input');
  });

  it('keeps BMP image data when image modality is enabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'image/bmp', data: 'abc123' },
      } as unknown as Part,
    ]);
    const messages = conv.convertLlmRequestToOpenAI(
      request,
      makeRequestContext('gpt-4o', { image: true }),
    );
    const parts = getUserContentParts(messages) as Array<{
      type: string;
      image_url?: { url: string };
    }>;
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('image_url');
    expect(parts[0].image_url?.url).toBe('data:image/bmp;base64,abc123');
  });

  it('replaces PDF with placeholder when pdf modality is disabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: 'pdf-data',
          displayName: 'doc.pdf',
        },
      } as unknown as Part,
    ]);
    const messages = conv.convertLlmRequestToOpenAI(
      request,
      makeRequestContext('test-model', { image: true }),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('pdf file');
    expect(parts[0].text).toContain('does not support PDF input');
  });

  it('keeps PDF when pdf modality is enabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: 'pdf-data',
          displayName: 'doc.pdf',
        },
      } as unknown as Part,
    ]);
    const messages = conv.convertLlmRequestToOpenAI(
      request,
      makeRequestContext('claude-sonnet', { image: true, pdf: true }),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('file');
  });

  it('replaces video with placeholder when video modality is disabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'video/mp4', data: 'vid-data' },
      } as unknown as Part,
    ]);
    const messages = conv.convertLlmRequestToOpenAI(
      request,
      makeRequestContext('test-model', {}),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('video file');
  });

  it('replaces audio with placeholder when audio modality is disabled', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'audio/wav', data: 'audio-data' },
      } as unknown as Part,
    ]);
    const messages = conv.convertLlmRequestToOpenAI(
      request,
      makeRequestContext('test-model', {}),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('audio file');
  });

  it('handles mixed content: keeps text + supported media, replaces unsupported', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      { text: 'Analyze these files' },
      {
        inlineData: { mimeType: 'image/png', data: 'img-data' },
      } as unknown as Part,
      {
        inlineData: { mimeType: 'video/mp4', data: 'vid-data' },
      } as unknown as Part,
    ]);
    const messages = conv.convertLlmRequestToOpenAI(
      request,
      makeRequestContext('gpt-4o', { image: true }),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(3);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toBe('Analyze these files');
    expect(parts[1].type).toBe('image_url');
    expect(parts[2].type).toBe('text');
    expect(parts[2].text).toContain('video file');
  });

  it('defaults to text-only when no modalities are specified', () => {
    const conv = OpenAIContentConverter;
    const request = makeRequest([
      {
        inlineData: { mimeType: 'image/png', data: 'img-data' },
      } as unknown as Part,
    ]);
    const messages = conv.convertLlmRequestToOpenAI(
      request,
      makeRequestContext('unknown-model', {}),
    );
    const parts = getUserContentParts(messages);
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('image file');
  });
});

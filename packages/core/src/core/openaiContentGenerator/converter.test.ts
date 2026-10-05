/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { OpenAIContentConverter } from './converter.js';
import { toolCallArgumentsWereIncomplete } from '../incomplete-tool-call-args.js';
import { StreamingToolCallParser } from './streamingToolCallParser.js';
import { TaggedThinkingParser } from './taggedThinkingParser.js';
import type { RequestContext } from './types.js';
import {
  Type,
  FinishReason,
  type GenerateContentResponse,
  type GenerateContentParameters,
  type Content,
  type FunctionCall,
  type Part,
  type Tool,
  type CallableTool,
} from '@google/genai';
import type OpenAI from 'openai';
import {
  InMemoryImagePayloadStore,
  buildReattachParts,
  replaceImagePayloadsInPlace,
  trailingReattachPartCount,
} from '../../services/image-payload-references.js';
import { convertToFunctionResponse } from '../coreToolScheduler.js';
import { getToolCallPreparations } from '../tool-call-preparation.js';
import { isOpenAIReasoningThoughtPart } from '../../utils/thoughtUtils.js';
import { getGenAiUsageProvenance } from '../../telemetry/gen-ai-usage.js';
import { SchemaValidator } from '../../utils/schemaValidator.js';
import {
  content,
  fnCall,
  fnResponse,
  modelText,
  userText,
} from '../../test-utils/model-fixtures.js';

type Message = OpenAI.Chat.ChatCompletionMessageParam;
/** Loose view of an OpenAI content part, for reading converted messages. */
type WirePart = {
  type: string;
  text?: string;
  image_url?: { url: string };
  input_audio?: { data: string; format: string };
  video_url?: { url: string };
  file?: { filename: string; file_data: string };
};

const baseRequestContext = (): RequestContext => ({
  model: 'test-model',
  modalities: { image: true, pdf: true, audio: true, video: true },
  startTime: 0,
});

function openAIStreamChunk(
  delta: Record<string, unknown>,
  finishReason: string | null = null,
): OpenAI.Chat.ChatCompletionChunk {
  return {
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  } as unknown as OpenAI.Chat.ChatCompletionChunk;
}

const partsOf = (response: GenerateContentResponse) =>
  response.candidates?.[0]?.content?.parts;

/** Streams one delta chunk and returns the converted parts. */
const streamParts = (
  ctx: RequestContext,
  delta: Record<string, unknown>,
  finishReason: string | null = null,
) =>
  partsOf(
    OpenAIContentConverter.convertOpenAIChunkToLlm(
      openAIStreamChunk(delta, finishReason),
      ctx,
    ),
  );

/**
 * Streams each step's delta through `ctx`, then expects each step's parts in
 * order; returns the parts.
 */
const expectSteps = (
  ctx: RequestContext,
  steps: Array<[Record<string, unknown>, Part[], string?]>,
) => {
  const results = steps.map(([delta, , finishReason = null]) =>
    streamParts(ctx, delta, finishReason),
  );
  steps.forEach(([, expected], i) => expect(results[i]).toEqual(expected));
  return results;
};

const expectThrowType = (act: () => unknown, type: string) =>
  expect(act).toThrowError(expect.objectContaining({ type }));

/** One assertion each for the call's name, args and id. */
const expectFnCall = (
  fn: FunctionCall | undefined,
  id: string,
  name: string,
  args: Record<string, unknown>,
) => {
  expect(fn?.name).toBe(name);
  expect(fn?.args).toEqual(args);
  expect(fn?.id).toBe(id);
};

/** One assertion per expected item, in order. */
const expectEach = (actual: unknown[], expected: unknown[]) =>
  expected.forEach((value, index) => expect(actual[index]).toEqual(value));

const thoughtPart = (text: string): Part => ({ text, thought: true });

const inline = (
  mimeType: string,
  data: string,
  displayName?: string,
): Part => ({
  inlineData: {
    mimeType,
    data,
    ...(displayName !== undefined ? { displayName } : {}),
  },
});

const fileRef = (
  mimeType: string,
  fileUri: string,
  displayName?: string,
): Part => ({
  fileData: {
    mimeType,
    fileUri,
    ...(displayName !== undefined ? { displayName } : {}),
  },
});

/** A `functionResponse` part that also carries nested `parts`. */
const fnResult = (
  name: string,
  response: Record<string, unknown>,
  id: string,
  parts: unknown[],
): Part => ({
  functionResponse: { id, name, response, parts: parts as Part[] },
});

/** A model turn calling `name` as `id`, then the user turn answering it. */
const exchange = (
  id: string,
  name: string,
  response: Record<string, unknown>,
  parts?: unknown[],
  args: Record<string, unknown> = {},
): Content[] => [
  content('model', fnCall(name, args, id)),
  content(
    'user',
    parts
      ? fnResult(name, response, id, parts)
      : fnResponse(name, response, id),
  ),
];

const req = (...contents: Content[]): GenerateContentParameters => ({
  model: 'models/test',
  contents,
});

const byRole = (messages: Message[], role: Message['role']) =>
  messages.filter((m) => m.role === role);
const findRole = (messages: Message[], role: Message['role']) =>
  messages.find((m) => m.role === role);
const wireParts = (message: Message | undefined) =>
  message?.content as WirePart[];
/** The tool message's parts, after checking it exists with array content. */
const toolPartsOf = (messages: Message[]) => {
  const toolMessage = findRole(messages, 'tool');
  expect(toolMessage).toBeDefined();
  expect(Array.isArray(toolMessage?.content)).toBe(true);
  return wireParts(toolMessage);
};
const typesOf = (parts: WirePart[]) => parts.map((p) => p.type);
const partOf = (parts: WirePart[], type: string) =>
  parts.find((p) => p.type === type);
const imageUrlOf = (parts: WirePart[]) =>
  partOf(parts, 'image_url')?.image_url?.url;
const toolReply = (tool_call_id: string) => ({ role: 'tool', tool_call_id });
const textsOf = (parts: WirePart[]) =>
  parts.filter((p) => p.type === 'text').map((p) => p.text);
/** Expects exactly [text containing each fragment, PNG image_url]. */
const expectTextThenPng = (parts: WirePart[], ...fragments: string[]) => {
  expect(parts).toHaveLength(2);
  expect(parts[0].type).toBe('text');
  for (const fragment of fragments) {
    expect(parts[0].text).toContain(fragment);
  }
  expect(parts[1].type).toBe('image_url');
  expect(parts[1].image_url?.url).toContain('data:image/png');
};
/** Ids of an assistant message's tool calls (undefined when it has none). */
const callIdsOf = (message: Message | undefined) =>
  (
    message as OpenAI.Chat.ChatCompletionAssistantMessageParam | undefined
  )?.tool_calls?.map((toolCall) => toolCall.id);
const toolCallIdsOf = (messages: Message[]) =>
  messages
    .filter(
      (message): message is OpenAI.Chat.ChatCompletionToolMessageParam =>
        message.role === 'tool' && 'tool_call_id' in message,
    )
    .map((message) => message.tool_call_id);

describe('OpenAIContentConverter', () => {
  let converter: typeof OpenAIContentConverter;
  let requestContext: RequestContext;

  beforeEach(() => {
    converter = OpenAIContentConverter;
    requestContext = baseRequestContext();
  });

  const toOpenAI = (
    request: GenerateContentParameters,
    overrides: Partial<RequestContext> = {},
  ) =>
    converter.convertLlmRequestToOpenAI(request, {
      ...requestContext,
      ...overrides,
    });

  /** Converts a request holding `contents`, overriding the default context. */
  const toMessagesWith = (
    overrides: Partial<RequestContext>,
    ...contents: Content[]
  ) => toOpenAI(req(...contents), overrides);
  const toMessages = (...contents: Content[]) =>
    toMessagesWith({}, ...contents);
  /** Same, with strict OpenAI tool-result media splitting (splitToolMedia). */
  const toSplitMessages = (...contents: Content[]) =>
    toMessagesWith({ splitToolMedia: true }, ...contents);

  const toLlm = (
    choices: unknown[],
    extra: Record<string, unknown> = {},
    ctx: RequestContext = requestContext,
  ) =>
    converter.convertOpenAIResponseToLlm(
      {
        object: 'chat.completion',
        id: 'chatcmpl',
        created: 123,
        model: 'test-model',
        choices,
        ...extra,
      } as unknown as OpenAI.Chat.ChatCompletion,
      ctx,
    );
  const choice = (
    message: Record<string, unknown>,
    finish_reason: unknown = 'stop',
  ) => ({
    index: 0,
    message: { role: 'assistant', ...message },
    finish_reason,
    logprobs: null,
  });

  it('re-encodes Freeform exec history as Chat function messages', () => {
    const source = String.raw`text("one\\ntwo");`;
    const messages = toMessages(
      ...exchange('call_exec', 'exec', { output: 'done' }, undefined, {
        source,
      }),
    );

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'call_exec',
            type: 'function',
            function: { name: 'exec', arguments: JSON.stringify({ source }) },
          },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'call_exec',
        content: [{ type: 'text', text: 'done' }],
      },
    ]);
  });

  const withStreamParser = (
    toolCallParser = new StreamingToolCallParser(),
  ): RequestContext => ({ ...requestContext, toolCallParser });
  const withTaggedThinkingOptions = (): RequestContext => ({
    ...requestContext,
    responseParsingOptions: { taggedThinkingTags: true },
  });
  const withTaggedThinkingStreamParser = (): RequestContext => ({
    ...withStreamParser(),
    responseParsingOptions: { taggedThinkingTags: true },
    taggedThinkingParser: new TaggedThinkingParser(),
  });
  const withQwen3TaggedThinkingStreamParser = (): RequestContext => ({
    ...withStreamParser(),
    model: 'qwen3.8-max',
    responseParsingOptions: {
      contentOnlyThinkingTagLeaks: true,
      taggedThinkingTagsAfterReasoning: true,
    },
  });

  const hasOpenAIToolCalls = (
    message: Message,
  ): message is OpenAI.Chat.ChatCompletionAssistantMessageParam & {
    tool_calls: OpenAI.Chat.ChatCompletionMessageToolCall[];
  } =>
    message.role === 'assistant' &&
    'tool_calls' in message &&
    Array.isArray(message.tool_calls);

  const isOpenAISplitMediaMessage = (message: Message) =>
    message.role === 'user' &&
    Array.isArray(message.content) &&
    message.content.some((part) =>
      ['image_url', 'input_audio', 'video_url', 'file'].includes(
        (part as { type?: string }).type ?? '',
      ),
    );

  describe('stream-local parser state', () => {
    /** Sends one chunk (provider model 'test') and returns the converted response. */
    const send = (
      stream: RequestContext,
      delta: Record<string, unknown>,
      finishReason: string | null = null,
    ) =>
      converter.convertOpenAIChunkToLlm(
        {
          ...openAIStreamChunk(delta, finishReason),
          id: 'chunk',
          created: 1,
          model: 'test',
        },
        stream,
      );

    const toolCall = (
      index: number,
      id: string,
      name: string,
      args = '{}',
    ) => ({
      index,
      id,
      function: { name, arguments: args },
    });

    const readCallPart = {
      functionCall: { id: 'call_read', name: 'read_file', args: {} },
    };

    const contentOnlyStream = () => ({
      ...withStreamParser(),
      responseParsingOptions: { contentOnlyThinkingTagLeaks: true },
    });

    const emitReasoning = (stream: RequestContext, text = 'Let me check.') =>
      send(stream, { reasoning_content: text });
    /** A plain-parser stream that has already emitted `text` as reasoning. */
    const afterReasoning = (text?: string) => {
      const stream = withStreamParser();
      emitReasoning(stream, text);
      return stream;
    };

    const emitToolCall = (
      stream: RequestContext,
      content: string,
      toolArguments = '{}',
    ) =>
      send(stream, {
        content,
        tool_calls: [toolCall(0, 'call_read', 'read_file', toolArguments)],
      });

    const finishStream = (
      stream: RequestContext,
      finishReason = 'tool_calls',
    ) => send(stream, {}, finishReason);
    const finishedCall = (stream: RequestContext) =>
      partsOf(finishStream(stream))?.find((p: Part) => p.functionCall)
        ?.functionCall;
    const openCall = (id: string, name: string, args: string) => ({
      tool_calls: [
        { ...toolCall(0, id, name, args), type: 'function' as const },
      ],
    });
    const expectHeld = (...responses: GenerateContentResponse[]) =>
      responses.forEach((response) => expect(partsOf(response)).toEqual([]));
    const expectLeakOn = (
      stream: RequestContext,
      delta: Record<string, unknown>,
      finishReason: string | null = null,
    ) =>
      expectThrowType(
        () => send(stream, delta, finishReason),
        'PROTOCOL_TAG_LEAK',
      );

    const expectSanitized = (
      stream: RequestContext,
      tagName: string,
      toolCallCount: number,
    ) =>
      expect(stream.protocolTagSanitized).toEqual({ tagName, toolCallCount });

    const expectUnsanitizedLeak = (
      stream: RequestContext,
      act: () => unknown = () => finishStream(stream),
    ) => {
      expectThrowType(act, 'PROTOCOL_TAG_LEAK');
      expect(stream.protocolTagSanitized).toBeUndefined();
    };

    /** Sends each content chunk, finishing with 'stop' on the last one. */
    const sendAll = (stream: RequestContext, chunks: string[]) =>
      chunks.flatMap(
        (content, index) =>
          partsOf(
            send(
              stream,
              { content },
              index === chunks.length - 1 ? 'stop' : null,
            ),
          ) ?? [],
      );

    /** Holds each content chunk and the tool-call chunk carrying `tag`, then recovers the call. */
    const expectRecovered = (held: string[], tag: string) => {
      const stream = afterReasoning();
      const responses = held.map((content) => send(stream, { content }));
      responses.push(emitToolCall(stream, tag));
      const finish = finishStream(stream);

      expectHeld(...responses);
      expect(partsOf(finish)).toEqual([readCallPart]);
      expectSanitized(stream, 'think', 1);
    };

    it('creates fresh parser instances', () => {
      const ctx1 = new StreamingToolCallParser();
      const ctx2 = new StreamingToolCallParser();

      expect(ctx1).toBeInstanceOf(StreamingToolCallParser);
      expect(ctx2).toBeInstanceOf(StreamingToolCallParser);
      expect(ctx1).not.toBe(ctx2);
    });

    it('preserves the provider model from stream chunks', () => {
      const response = send(withStreamParser(), { content: 'ok' });

      expect(response.modelVersion).toBe('test');
    });

    it('isolates two contexts so writes to one do not leak into the other', () => {
      // Regression for issue #3516: the parser used to be a Converter instance
      // field, so two concurrent streams sharing one Config.contentGenerator
      // overwrote each other's tool-call buffers.
      const ctx1 = new StreamingToolCallParser();
      const ctx2 = new StreamingToolCallParser();

      ctx1.addChunk(0, '{"a":1}', 'call_A', 'fn_A');
      ctx2.addChunk(0, '{"b":2}', 'call_B', 'fn_B');

      expect(ctx1.getBuffer(0)).toBe('{"a":1}');
      expect(ctx2.getBuffer(0)).toBe('{"b":2}');
      expect(ctx1.getToolCallMeta(0).id).toBe('call_A');
      expect(ctx2.getToolCallMeta(0).id).toBe('call_B');
    });

    const shellCall = (id: string) => [
      { id, name: 'shell', args: { cmd: 'echo hi' }, index: 0 },
    ];

    it('ignores replay chunks after an id already has complete JSON args', () => {
      const parser = new StreamingToolCallParser();
      parser.addChunk(0, '{"cmd":"echo hi"}', 'dup_id_0001', 'shell');
      parser.addChunk(0, '{"cmd":"echo hi"}', 'dup_id_0001', 'shell');

      expect(parser.getBuffer(0)).toBe('{"cmd":"echo hi"}');
      expect(parser.getCompletedToolCalls()).toEqual(shellCall('dup_id_0001'));
    });

    it('keeps accumulating normal fragmented JSON before it is complete', () => {
      const parser = new StreamingToolCallParser();
      parser.addChunk(0, '{"cmd"', 'call_fragmented', 'shell');
      parser.addChunk(0, ':"echo hi"}', 'call_fragmented', 'shell');

      expect(parser.getCompletedToolCalls()).toEqual(
        shellCall('call_fragmented'),
      );
    });

    it('demuxes interleaved chunks from two concurrent streams correctly (#3516)', () => {
      // Two subagents share one Config (hence one Converter) and their streams
      // interleave. Pre-fix every chunk fed one shared parser and both calls
      // were corrupted; per-stream contexts keep each stream's chunks apart.
      const streamA = withStreamParser();
      const streamB = withStreamParser();
      const args = (argsText: string) => ({
        tool_calls: [{ index: 0, function: { arguments: argsText } }],
      });

      send(streamA, openCall('call_A', 'read_file', '{"file_path":"/a'));
      send(streamB, openCall('call_B', 'read_file', '{"file_path":"/b'));
      send(streamA, args('/x.ts"}'));
      send(streamB, args('/y.ts"}'));

      expectFnCall(finishedCall(streamA), 'call_A', 'read_file', {
        file_path: '/a/x.ts',
      });
      expectFnCall(finishedCall(streamB), 'call_B', 'read_file', {
        file_path: '/b/y.ts',
      });
    });

    it('emits no-argument tool calls that stream an empty arguments string', () => {
      // Providers (e.g. llama.cpp-style servers) may finish a no-argument call
      // with `arguments: ""` and no follow-up fragment. Dropping it would make
      // the turn look empty and trigger retries.
      const stream = withStreamParser();
      send(stream, openCall('call_noargs', 'list_sessions', ''));

      expectFnCall(finishedCall(stream), 'call_noargs', 'list_sessions', {});
    });

    it('ignores a phantom slot beside a valid tool call', () => {
      const stream = withStreamParser();
      send(stream, {
        tool_calls: [
          toolCall(0, 'call_edit', 'edit'),
          { index: 1, function: {} },
        ],
      });

      const result = finishStream(stream);

      expect(partsOf(result)).toEqual([
        { functionCall: { id: 'call_edit', name: 'edit', args: {} } },
      ]);
      expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    });

    it.each([
      [
        'rejects a tool-call finish without a completed named call',
        [{ index: 0, function: {} }],
        'tool_calls',
      ],
      [
        'rejects an invalid tool-call index on a stop finish',
        [toolCall(Number.MAX_SAFE_INTEGER + 1, 'call_invalid', 'read_file')],
        'stop',
      ],
      [
        'rejects valid tool calls accompanied by an invalid index',
        [
          toolCall(0, 'call_read', 'read_file'),
          toolCall(Number.MAX_SAFE_INTEGER + 1, 'call_invalid', 'write_file'),
        ],
        'tool_calls',
      ],
    ])('%s', (_title, tool_calls, finishReason) => {
      const stream = withStreamParser();
      send(stream, { tool_calls });

      expectThrowType(
        () => finishStream(stream, finishReason),
        'MALFORMED_TOOL_CALL',
      );
    });

    it('rejects a tool call that never provides a function name', () => {
      const stream = withStreamParser();
      const partial = send(stream, {
        content: 'discard me',
        tool_calls: [
          {
            index: 0,
            id: 'call_without_name',
            function: { arguments: '{"path":"a.ts"}' },
          },
        ],
      });

      expect(partsOf(partial)).toEqual([]);
      expectThrowType(
        () => finishStream(stream, 'stop'),
        'MALFORMED_TOOL_CALL',
      );
    });

    it('rejects a protocol-tag recovery with a whitespace-only function name', () => {
      const stream = afterReasoning();
      send(stream, {
        content: '</think>',
        tool_calls: [toolCall(0, 'call_blank', '   ')],
      });

      expectUnsanitizedLeak(stream);
    });

    it('rejects the recorded cross-channel thinking-tag leak', () => {
      const stream = withStreamParser();
      const reasoning = emitReasoning(stream, 'Let me check<think>');

      expect(partsOf(reasoning)).toEqual([]);
      expectLeakOn(stream, { content: 'the result\n</think>\n' });
    });

    it.each([
      [
        'rejects the recorded content-only nested thinking-tag leak',
        ['<think>\n\n', '</think><thi', 'nk>9<think>-3'],
        'tool_calls',
      ],
      [
        // Sanitized production capture: a hybrid-thinking model skipped the
        // reasoning channel and streamed its thinking as literal <thinking>
        // content (no reasoning_content, no tool calls), never closing the tag.
        'rejects the recorded production unclosed <thinking> content leak (issue #6666)',
        [
          '<thi',
          'nking>\nThe user wants to query the compute resources for ' +
            'project space 10088. Let me check the available APIs.',
        ],
        'stop',
      ],
      [
        'rejects an unclosed whitespace-only block at stream finish',
        [`<thinking>${' '.repeat(128)}`],
        'stop',
      ],
      [
        'fails closed for a long suspicious prefix at stream finish',
        ['<think></think><think>9<think>' + 'x'.repeat(257)],
        'stop',
      ],
    ])('%s', (_title, chunks, finishReason) => {
      const stream = contentOnlyStream();

      expectHeld(...chunks.map((content) => send(stream, { content })));
      expectThrowType(
        () => finishStream(stream, finishReason),
        'PROTOCOL_TAG_LEAK',
      );
    });

    it('holds a long confirmed opening tag until its closing tag arrives', () => {
      const stream = contentOnlyStream();
      const text = `<thinking>${'x'.repeat(200)}</thinking>`;

      const opening = send(stream, {
        content: `<thinking>${'x'.repeat(200)}`,
      });
      const closing = send(stream, { content: '</thinking>' }, 'stop');

      expect(partsOf(opening)).toEqual([]);
      expect(partsOf(closing)).toEqual([{ text }]);
    });

    it.each([
      [
        // Control for the #6666 leak: without contentOnlyThinkingTagLeaks the
        // stream passes through verbatim; the defense is provider-gated, so
        // endpoints whose provider does not opt in remain exposed.
        'leaks the production <thinking> shape without provider provenance',
        withStreamParser,
        '<thinking>\nThe user wants to query the compute resources.',
        'stop',
      ],
      [
        'preserves a leak-shaped literal without provider provenance',
        withStreamParser,
        '<think>\n\n</think><think>9<think>-3',
        'stop',
      ],
      [
        'releases a long unconfirmed prefix before the stream finishes',
        contentOnlyStream,
        `<think${' '.repeat(257)}`,
        null,
      ],
    ])('%s', (_title, makeStream, text, finishReason) => {
      const response = send(makeStream(), { content: text }, finishReason);

      expect(partsOf(response)).toEqual([{ text }]);
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
      const parts = sendAll(contentOnlyStream(), chunks);

      expect(parts.map((part) => part.text).join('')).toBe(chunks.join(''));
      expect(parts.every((part) => part.thought !== true)).toBe(true);
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
      const parts = sendAll(contentOnlyStream(), chunks);

      expect(parts.map((part) => part.text).join('')).toBe(chunks.join(''));
    });

    it('rejects an unclosed outer block containing a balanced nested block', () => {
      expectLeakOn(
        contentOnlyStream(),
        { content: '<thinking><thinking>inner</thinking>outer text' },
        'stop',
      );
    });

    it.each([
      '<thinking></thinking><thinking>9<thinking>-3',
      '<think ></think ><think >9<think >-3',
    ])('rejects provider-tag grammar variant %s', (content) => {
      expectLeakOn(contentOnlyStream(), { content }, 'stop');
    });

    it('rejects closing-tag recovery after a tag leaked in reasoning', () => {
      const stream = afterReasoning('Let me check<think>');
      emitToolCall(stream, '</think>');

      expectUnsanitizedLeak(stream);
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

        expect(partsOf(reasoning)).toEqual([thoughtPart('Let me check.')]);
        expect(partsOf(leakedTag)).toEqual([]);
        expect(partsOf(finish)).toEqual([readCallPart]);
        expectSanitized(stream, tagName, 1);
      },
    );

    it('sanitizes a standalone closing thinking tag split across chunks', () => {
      expectRecovered(['\n</thi'], 'nk>\n');
    });

    it.each([
      [
        'sanitizes a standalone closing thinking tag with multiple tool calls',
        1,
      ],
      ['recovers complete same-index tool calls with distinct IDs', 0],
    ])('%s', (_title, secondIndex) => {
      const stream = afterReasoning();
      send(stream, {
        content: '</think>',
        tool_calls: [
          toolCall(0, 'call_read', 'read_file'),
          toolCall(secondIndex, 'call_list', 'list_directory'),
        ],
      });
      const finish = finishStream(stream);

      expect(partsOf(finish)).toEqual([
        readCallPart,
        { functionCall: { id: 'call_list', name: 'list_directory', args: {} } },
      ]);
      expectSanitized(stream, 'think', 2);
    });

    it.each([
      ['complete', '{"path":"old.txt"}', ''],
      ['incomplete', '{"path":"old.txt"', '}'],
    ] as const)(
      'rejects a protocol-tag recovery when a new id relabels %s nameless arguments',
      (_state, oldArguments, newArguments) => {
        const stream = afterReasoning();
        send(stream, {
          content: '</think>',
          tool_calls: [
            { index: 0, id: 'call_old', function: { arguments: oldArguments } },
          ],
        });
        send(stream, {
          tool_calls: [toolCall(0, 'call_new', 'read_file', newArguments)],
        });

        expectUnsanitizedLeak(stream);
      },
    );

    it('buffers leading whitespace before a split standalone closing tag', () => {
      expectRecovered(['\n'], '</think>');
    });

    it.each([
      [
        'buffers long whitespace without treating it as a protocol tag',
        ' '.repeat(129),
      ],
      ['emits trailing whitespace when the stream finishes', ' \n'],
    ])('%s', (_title, whitespace) => {
      const stream = afterReasoning();
      const pending = send(stream, { content: whitespace });
      const finish = finishStream(stream, 'stop');

      expect(partsOf(pending)).toEqual([]);
      expect(partsOf(finish)).toEqual([{ text: whitespace }]);
      expect(stream.pendingThinkingTagCandidate).toBeUndefined();
    });

    it('ignores an exact cumulative replay of a deferred closing tag', () => {
      const stream = afterReasoning();
      send(stream, { content: '</THINK>' });
      const finish = send(
        stream,
        {
          content: '</THINK>',
          tool_calls: [toolCall(0, 'call_read', 'read_file')],
        },
        'tool_calls',
      );

      expect(partsOf(finish)).toEqual([readCallPart]);
      expectSanitized(stream, 'think', 1);
    });

    it('ignores cumulative replays of an incomplete closing tag', () => {
      expectRecovered(['</thi', '</thi'], '</think>');
    });

    it('releases a split tag-like prefix when it becomes ordinary text', () => {
      const stream = afterReasoning('Explain the syntax.');
      const prefix = send(stream, { content: '</thi' });
      const suffix = send(stream, { content: 'ng is not a tag.' });

      expect(partsOf(prefix)).toEqual([]);
      expect(partsOf(suffix)).toEqual([{ text: '</thing is not a tag.' }]);
      expect(stream.protocolTagSanitized).toBeUndefined();
    });

    it('does not accumulate whitespace after a complete closing tag candidate', () => {
      const stream = afterReasoning();
      emitToolCall(stream, '</think>');

      for (let i = 0; i < 1_000; i++) {
        send(stream, { content: ' ' });
      }

      expect(stream.pendingThinkingTagCandidate).toEqual({
        text: '</think>',
        closingTagName: 'think',
      });
      finishStream(stream);
      expectSanitized(stream, 'think', 1);
    });

    it('rejects a standalone closing thinking tag without a complete tool call', () => {
      const stream = afterReasoning();
      const leakedTag = send(stream, { content: '</think>' });

      expect(partsOf(leakedTag)).toEqual([]);
      expectUnsanitizedLeak(stream, () => finishStream(stream, 'stop'));
    });

    it.each(['stop', 'length', 'content_filter', 'unknown'])(
      'rejects recovery when the stream finishes with %s',
      (finishReason) => {
        const stream = afterReasoning();
        emitToolCall(stream, '</think>');

        expectUnsanitizedLeak(stream, () => finishStream(stream, finishReason));
      },
    );

    it('rejects visible content after a deferred closing thinking tag', () => {
      const stream = afterReasoning();
      send(stream, { content: '</think>' });

      expectUnsanitizedLeak(stream, () =>
        send(stream, { content: 'unexpected' }),
      );
    });

    it.each(['{"path":', '{bad}', 'null', '[]', '42', '   '])(
      'rejects a standalone closing thinking tag with unsafe tool arguments %s',
      (toolArguments) => {
        const stream = afterReasoning();
        emitToolCall(stream, '</think>', toolArguments);

        expectUnsanitizedLeak(stream);
      },
    );

    it('rejects a closing tag split after a visible line break', () => {
      const stream = afterReasoning('Let me check<think>');
      send(stream, { content: 'the result\n' });
      send(stream, { content: '\n'.repeat(256) });

      expectLeakOn(stream, { content: '</think>\n' });
    });

    it('preserves a split literal closing tag after ordinary reasoning', () => {
      const stream = withStreamParser();
      const reasoning = emitReasoning(stream, 'Explain the syntax.');
      const prefix = send(stream, { content: 'Use ' });
      const closingTag = send(stream, {
        content: '</think> to close the tag.',
      });

      expect(partsOf(reasoning)).toEqual([thoughtPart('Explain the syntax.')]);
      expect(partsOf(prefix)).toEqual([{ text: 'Use ' }]);
      expect(partsOf(closingTag)).toEqual([
        { text: '</think> to close the tag.' },
      ]);
    });

    it('releases inline thinking-tag references in both channels', () => {
      const stream = withStreamParser();
      const reasoning = emitReasoning(
        stream,
        'The format may contain <think> tags.',
      );
      const content = send(stream, {
        content: 'Use </think> to close the tag.',
      });
      const finish = finishStream(stream, 'stop');

      expectHeld(reasoning, content);
      expect(partsOf(finish)).toEqual([
        thoughtPart('The format may contain <think> tags.'),
        { text: 'Use </think> to close the tag.' },
      ]);
    });
  });

  describe('convertLlmRequestToOpenAI', () => {
    /** Converts one `call_1` exchange and checks the tool message leads with the output text. */
    const expectToolMessageParts = (
      name: string,
      output: string,
      media: Part,
    ) => {
      const messages = toMessages(
        ...exchange('call_1', name, { output }, [media]),
      );
      const contentArray = toolPartsOf(messages);
      expect(contentArray).toHaveLength(2);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe(output);
      return { messages, media: contentArray[1] };
    };

    it('normalizes legacy dotted MCP names before sending history', () => {
      const messages = toMessages(
        ...exchange(
          'call_legacy_mcp',
          'mcp__zybio__literature.search_pubmed',
          { output: 'ok' },
          undefined,
          { query: 'IVD' },
        ),
      );
      const name =
        messages.find(hasOpenAIToolCalls)?.tool_calls[0]?.function.name;

      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*$/);
      expect(name).not.toContain('.');
    });

    // DashScope places its cache breakpoint `trailingReattachPartCount`
    // blocks before the end of the last message (#11627), so every part of
    // the reattach region, labels included, must stay exactly one block.
    it('emits one wire block per reattach region part', () => {
      const store = new InMemoryImagePayloadStore();
      const history: Content[] = ['a', 'b'].map((data) =>
        content('user', inline('image/png', data)),
      );
      const replaced = replaceImagePayloadsInPlace(history, store);
      const contents: Content[] = [
        content(
          'user',
          { text: 'what changed?' },
          inline('image/png', 'new-shot'),
          ...buildReattachParts(replaced, 2),
        ),
      ];

      const messages = toMessages(...contents);
      const blocks = messages.at(-1)?.content as Array<{ type: string }>;
      const regionCount = trailingReattachPartCount(contents);

      expect(regionCount).toBe(5);
      expect(blocks.map((block) => block.type)).toEqual([
        'text',
        'image_url',
        'text',
        'text',
        'image_url',
        'text',
        'image_url',
      ]);
      expect(blocks.length - regionCount).toBe(2);
    });

    it('preserves ordered multi-part startup reminder user content', () => {
      const messages = toSplitMessages(
        content(
          'user',
          { text: '<system-reminder>\ndeferred tools' },
          { text: '<system-reminder>\nstartup context' },
        ),
      );

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

    it.each<[string, Record<string, unknown>, string, Partial<RequestContext>]>(
      [
        [
          'should extract raw output from function response objects',
          { output: 'Raw output text' },
          'Raw output text',
          { splitToolMedia: true },
        ],
        [
          'should prioritize error field when present',
          { error: 'Command failed' },
          'Command failed',
          {},
        ],
        [
          'should stringify non-string responses',
          { data: { value: 42 } },
          '{"data":{"value":42}}',
          {},
        ],
      ],
    )('%s', (_title, response, text, overrides) => {
      const parts = toolPartsOf(
        toMessagesWith(overrides, ...exchange('call_1', 'shell', response)),
      );

      expect(parts[0].type).toBe('text');
      expect(parts[0].text).toBe(text);
    });

    /** Media stays embedded next to the output text when splitToolMedia is off. */
    const expectEmbeddedMedia = (
      name: string,
      output: string,
      media: Part,
      expected: Record<string, string>,
    ) => {
      const result = expectToolMessageParts(name, output, media);
      for (const [path, value] of Object.entries(expected)) {
        expect(result.media).toHaveProperty(path, value);
      }
      return result;
    };

    // These also check the tool call id and that no separate user message is
    // created.
    it.each<[string, string, string, Part, Record<string, string>]>([
      [
        'should convert function responses with inlineData to tool message with embedded image_url',
        'Read',
        'Image content',
        inline('image/png', 'base64encodedimagedata'),
        {
          type: 'image_url',
          'image_url.url': 'data:image/png;base64,base64encodedimagedata',
        },
      ],
      [
        'should convert function responses with fileData to tool message with embedded image_url',
        'Read',
        'File content',
        fileRef('image/jpeg', 'base64imagedata'),
        { type: 'image_url', 'image_url.url': 'base64imagedata' },
      ],
      [
        'should convert PDF inlineData to tool message with embedded input_file',
        'Read',
        'PDF content',
        inline('application/pdf', 'base64pdfdata', 'document.pdf'),
        {
          type: 'file',
          'file.filename': 'document.pdf',
          'file.file_data': 'data:application/pdf;base64,base64pdfdata',
        },
      ],
      [
        'should convert audio parts to tool message with embedded input_audio',
        'Record',
        'Audio recorded',
        inline('audio/wav', 'audiobase64data'),
        {
          type: 'input_audio',
          'input_audio.data': 'data:audio/wav;base64,audiobase64data',
          'input_audio.format': 'wav',
        },
      ],
      [
        'should convert video inlineData to tool message with embedded video_url',
        'Read',
        'Video content',
        inline('video/mp4', 'videobase64data', 'recording.mp4'),
        {
          type: 'video_url',
          'video_url.url': 'data:video/mp4;base64,videobase64data',
        },
      ],
      [
        'should convert image fileData URL to tool message with embedded image_url',
        'Read',
        'Image content',
        fileRef(
          'image/jpeg',
          'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
          'ant.jpg',
        ),
        {
          type: 'image_url',
          'image_url.url':
            'https://upload.wikimedia.org/wikipedia/commons/a/a7/Camponotus_flavomarginatus_ant.jpg',
        },
      ],
      [
        'should convert PDF fileData URL to tool message with embedded file',
        'Read',
        'PDF content',
        fileRef(
          'application/pdf',
          'https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf',
          'document.pdf',
        ),
        {
          type: 'file',
          'file.filename': 'document.pdf',
          'file.file_data':
            'https://assets.anthropic.com/m/1cd9d098ac3e6467/original/Claude-3-Model-Card-October-Addendum.pdf',
        },
      ],
      [
        'should convert video fileData URL to tool message with embedded video_url',
        'Read',
        'Video content',
        fileRef(
          'video/mp4',
          'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
          'recording.mp4',
        ),
        {
          type: 'video_url',
          'video_url.url': 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        },
      ],
    ])('%s', (_title, name, output, media, expected) => {
      const { messages } = expectEmbeddedMedia(name, output, media, expected);

      expect(findRole(messages, 'tool')).toMatchObject(toolReply('call_1'));
      expect(findRole(messages, 'user')).toBeUndefined();
    });

    /** Parallel `shot_a` / `shot_b` calls, and each one's result with a PNG. */
    const shotCalls = () =>
      content(
        'model',
        fnCall('shot_a', {}, 'call_a'),
        fnCall('shot_b', {}, 'call_b'),
      );
    const shotA = () =>
      fnResult('shot_a', { output: 'A' }, 'call_a', [
        inline('image/png', 'aaa'),
      ]);
    const shotB = () =>
      fnResult('shot_b', { output: 'B' }, 'call_b', [
        inline('image/png', 'bbb'),
      ]);

    /** Converts one split `call_1` Read result; returns the tool and user messages. */
    const splitRead = (output: string, parts: Part[]) => {
      const messages = toSplitMessages(
        ...exchange('call_1', 'Read', { output }, parts),
      );
      return {
        toolMessage: findRole(messages, 'tool'),
        userMessage: findRole(messages, 'user'),
      };
    };

    it('should split tool-result media into a follow-up user message when splitToolMedia is enabled (issue #3616)', () => {
      // Same shape as the embedded-image case but with the strict
      // OpenAI-compat opt-in: the tool message stays spec-compliant (string /
      // text-part content only) and the image moves to a follow-up user message.
      const { toolMessage, userMessage } = splitRead('Image content', [
        inline('image/png', 'base64encodedimagedata'),
      ]);

      expect(toolMessage).toBeDefined();
      expect(typeof toolMessage?.content === 'string').toBe(true);
      expect(toolMessage?.content).toContain('Image content');
      expect(userMessage).toBeDefined();
      const userContent = wireParts(userMessage);
      expect(Array.isArray(userContent)).toBe(true);
      expect(imageUrlOf(userContent)).toBe(
        'data:image/png;base64,base64encodedimagedata',
      );
    });

    it('moves an omni degradation disclosure together with its media part when splitting tool media', () => {
      // The omni pipeline emits a disclosure text Part IMMEDIATELY before each
      // lossy derivative's media Part. When splitToolMedia relocates the media,
      // the disclosure must move WITH it: stranded in the text-only tool
      // message, the model could not attribute it. Ordinary text stays behind.
      const { toolMessage, userMessage } = splitRead('Image content', [
        { text: 'ordinary tool text' },
        { text: '【媒体降质】photo.png：downsampled to 1568px' },
        inline('image/png', 'base64encodedimagedata'),
      ]);

      expect(toolMessage?.content).toBe('Image content\nordinary tool text');
      const userContent = wireParts(userMessage);
      expect(typesOf(userContent)).toEqual(['text', 'text', 'image_url']);
      expect(userContent[0].text).toBe(
        '(attached media from previous tool call)',
      );
      expect(userContent[1].text).toBe(
        '【媒体降质】photo.png：downsampled to 1568px',
      );
      expect(userContent[2].image_url?.url).toBe(
        'data:image/png;base64,base64encodedimagedata',
      );
    });

    it('moves a bare keyframe timestamp marker together with its frame', () => {
      // Per-frame markers (`<MM:SS>`) carry no 【媒体降质】 prefix (the notice
      // rode once on the first frame's header) but must still migrate WITH
      // their image so each frame keeps its label.
      const { toolMessage, userMessage } = splitRead('frames', [
        { text: '<00:34>' },
        inline('image/jpeg', 'framebytes'),
      ]);

      expect(toolMessage?.content).toBe('frames');
      const userContent = wireParts(userMessage);
      expect(typesOf(userContent)).toEqual(['text', 'text', 'image_url']);
      expect(userContent[1].text).toBe('<00:34>');
    });

    it('gives a disclosure only to the media part directly following it', () => {
      // Two media parts after one disclosure: only the adjacent one owns it;
      // the second must not pull the disclosure past the first
      // (prev-tracking, not "last disclosure seen").
      const userContent = wireParts(
        splitRead('two images', [
          { text: '【媒体降质】a.png：lossy' },
          inline('image/png', 'first'),
          inline('image/png', 'second'),
        ]).userMessage,
      );

      expect(typesOf(userContent)).toEqual([
        'text',
        'text',
        'image_url',
        'image_url',
      ]);
      expect(userContent[1].text).toBe('【媒体降质】a.png：lossy');
      expect(userContent[2].image_url?.url).toBe('data:image/png;base64,first');
    });

    it('should keep all tool messages contiguous and merge split media into a single follow-up user message for parallel tool calls (issue #3616)', () => {
      // Two parallel tool calls answered in one user content: the first returns
      // an image, the second text only. Chat Completions requires every `tool`
      // message to be contiguous before any non-tool message, so the
      // synthesised media user message MUST follow BOTH tool messages.
      const messages = toSplitMessages(
        content(
          'model',
          fnCall('browser_take_screenshot', {}, 'call_screenshot'),
          fnCall('browser_console_messages', {}, 'call_console'),
        ),
        content(
          'user',
          fnResult(
            'browser_take_screenshot',
            { output: 'Captured screenshot' },
            'call_screenshot',
            [inline('image/png', 'shotbase64')],
          ),
          fnResponse(
            'browser_console_messages',
            { output: 'no console messages' },
            'call_console',
          ),
        ),
      );

      const assistantIdx = messages.findIndex((m) => m.role === 'assistant');
      expect(assistantIdx).toBeGreaterThanOrEqual(0);
      expect(messages[assistantIdx + 1]?.role).toBe('tool');
      expect(messages[assistantIdx + 2]?.role).toBe('tool');
      expect(messages[assistantIdx + 3]?.role).toBe('user');

      // Tool content must be a string or text-typed parts only: OpenAI allows
      // no image_url / input_audio / video_url / file parts on tool messages.
      for (const offset of [1, 2]) {
        const toolContent = messages[assistantIdx + offset].content;
        expect(
          typeof toolContent === 'string' ||
            (Array.isArray(toolContent) &&
              toolContent.every((p) => p.type === 'text')),
        ).toBe(true);
      }

      const userMessages = byRole(messages, 'user');
      expect(userMessages).toHaveLength(1);
      const imageParts = wireParts(userMessages[0]).filter(
        (p) => p.type === 'image_url',
      );
      expect(imageParts).toHaveLength(1);
      expect(imageParts[0].image_url?.url).toBe(
        'data:image/png;base64,shotbase64',
      );
    });

    it('should merge media from multiple media-bearing parallel tool responses into one follow-up user message (issue #3616)', () => {
      // Two separate user messages would still break the contiguity rule:
      // the first would split the tool messages apart.
      const messages = toSplitMessages(
        shotCalls(),
        content('user', shotA(), shotB()),
      );

      const userMessages = byRole(messages, 'user');
      expect(byRole(messages, 'tool')).toHaveLength(2);
      expect(userMessages).toHaveLength(1);
      expect(
        wireParts(userMessages[0])
          .filter((p) => p.type === 'image_url')
          .map((p) => p.image_url?.url),
      ).toEqual(['data:image/png;base64,aaa', 'data:image/png;base64,bbb']);
    });

    it('should not synthesise a follow-up user message when splitToolMedia is enabled but the response has no media (issue #3616)', () => {
      // Regression guard: a future refactor that always emits the follow-up
      // user message would otherwise regress silently.
      const messages = toSplitMessages(
        ...exchange('c', 'echo', { output: 'plain text result' }),
      );

      expect(byRole(messages, 'tool')).toHaveLength(1);
      expect(byRole(messages, 'user')).toHaveLength(0);
    });

    it('should fall back to a placeholder string when the tool response is media-only (issue #3616)', () => {
      // A null response makes extractFunctionResponseContent return "" (the
      // empty-text branch); with media-only parts the tool message must get the
      // placeholder string rather than an invalid empty array.
      const messages = toSplitMessages(
        ...exchange('c', 'shot', null as unknown as Record<string, unknown>, [
          inline('image/png', 'xxx'),
        ]),
      );

      const toolMessage = findRole(messages, 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toBe(
        '[media attached in following user message]',
      );
      expect(imageUrlOf(wireParts(findRole(messages, 'user')))).toBe(
        'data:image/png;base64,xxx',
      );
    });

    it('should preserve embedded-media behavior when splitToolMedia is explicitly false (opt-out) on parallel tool calls (issue #3616, #4876)', () => {
      // Since #4876 the default is true (spec-compliant); this covers the
      // opt-out: media stays embedded and no follow-up user message appears.
      const messages = toMessagesWith(
        { splitToolMedia: false },
        content('model', fnCall('s1', {}, 'c1'), fnCall('s2', {}, 'c2')),
        content(
          'user',
          fnResult('s1', { output: 'r1' }, 'c1', [inline('image/png', 'aaa')]),
          fnResponse('s2', { output: 'r2' }, 'c2'),
        ),
      );

      const toolMessages = byRole(messages, 'tool');
      expect(toolMessages).toHaveLength(2);
      expect(byRole(messages, 'user')).toHaveLength(0);
      expect(imageUrlOf(wireParts(toolMessages[0]))).toBe(
        'data:image/png;base64,aaa',
      );
    });

    it('should keep embedded media as content parts when string tool content is requested but splitToolMedia is false', () => {
      const messages = toMessagesWith(
        { splitToolMedia: false, toolResultContentFormat: 'string' },
        ...exchange('c1', 'shot', { output: 'screenshot' }, [
          inline('image/png', 'aaa'),
        ]),
      );

      const toolMessage = findRole(messages, 'tool');
      expect(Array.isArray(toolMessage?.content)).toBe(true);
      const toolContent = wireParts(toolMessage);
      expect(partOf(toolContent, 'text')?.text).toBe('screenshot');
      expect(imageUrlOf(toolContent)).toBe('data:image/png;base64,aaa');
    });

    it('should pass oss:// video fileData in a user message through to video_url unchanged (omni upload delivery)', () => {
      const url =
        'oss://dashscope-instant/uploads/model/abc/12345678-video.mp4';
      const messages = toMessages(
        content(
          'user',
          { text: 'Describe this video' },
          fileRef('video/mp4', url, 'video.mp4'),
        ),
      );

      const userMessage = findRole(messages, 'user');
      expect(userMessage).toBeDefined();
      expect(partOf(wireParts(userMessage), 'video_url')?.video_url?.url).toBe(
        url,
      );
    });

    it('should convert oss:// audio fileData to input_audio with the bare URL (omni upload delivery)', () => {
      const url = 'oss://dashscope-instant/uploads/model/abc/12345678-tone.mp3';
      const messages = toMessages(
        content(
          'user',
          { text: 'What is this sound?' },
          fileRef('audio/mpeg', url, 'tone.mp3'),
        ),
      );

      const audioPart = partOf(
        wireParts(findRole(messages, 'user')),
        'input_audio',
      );
      // Bare oss URL — no data: prefix (unlike the inline branch).
      expect(audioPart?.input_audio?.data).toBe(url);
      expect(audioPart?.input_audio?.format).toBe('mp3');
    });

    const audioFormats = [
      ['audio/flac', 'flac'],
      ['audio/ogg', 'ogg'],
      ['audio/mp4', 'm4a'],
    ] as const;
    const userParts = (part: Part) =>
      wireParts(findRole(toMessages(content('user', part)), 'user'));

    it('should convert flac/ogg/m4a audio fileData instead of textifying', () => {
      for (const [mime, format] of audioFormats) {
        const contentArray = userParts(
          fileRef(mime, 'oss://bucket/key', 'clip'),
        );
        const audioPart = partOf(contentArray, 'input_audio');
        expect(audioPart?.input_audio?.format).toBe(format);
        expect(
          contentArray.some((p) =>
            p.text?.includes('Unsupported file media type'),
          ),
        ).toBe(false);
      }
    });

    it('should convert inline flac/ogg/m4a audio instead of textifying', () => {
      // Mirrors the fileData case: the inline branch shares getAudioFormat,
      // and a regression that re-textifies inline flac/ogg/m4a must not ship
      // green.
      for (const [mime, format] of audioFormats) {
        const contentArray = userParts(inline(mime, 'YXVkaW8=', 'clip'));
        const audioPart = partOf(contentArray, 'input_audio');
        expect(audioPart?.input_audio?.format).toBe(format);
        expect(audioPart?.input_audio?.data).toBe(
          `data:${mime};base64,YXVkaW8=`,
        );
        expect(
          contentArray.some((p) =>
            p.text?.includes('Unsupported inline media type'),
          ),
        ).toBe(false);
      }
    });

    it.each([
      [
        'should render unsupported inlineData file types as a text block',
        inline('application/zip', 'base64zipdata', 'archive.zip'),
        'Unsupported inline media type',
      ],
      [
        'should render unsupported fileData types as a text block',
        fileRef(
          'application/zip',
          'https://example.com/archive.zip',
          'archive.zip',
        ),
        'Unsupported file media type',
      ],
    ])('%s', (_title, media, notice) => {
      const { media: wire } = expectToolMessageParts(
        'Read',
        'File content',
        media,
      );

      expect(wire.type).toBe('text');
      expect(wire.text).toContain(notice);
      expect(wire.text).toContain('application/zip');
      expect(wire.text).toContain('archive.zip');
    });

    it('should create tool message with text-only content when no media parts', () => {
      const messages = toMessages(
        ...exchange('call_1', 'shell', { output: 'Plain text output' }),
      );
      const contentArray = toolPartsOf(messages);

      expect(contentArray).toHaveLength(1);
      expect(contentArray[0].type).toBe('text');
      expect(contentArray[0].text).toBe('Plain text output');
      expect(findRole(messages, 'user')).toBeUndefined();
    });

    it('should serialize text-only tool content as a string when requested', () => {
      const messages = toMessagesWith(
        { toolResultContentFormat: 'string' },
        ...exchange('call_1', 'shell', { output: 'Plain text output' }),
      );
      const toolMessage = findRole(messages, 'tool');

      expect(toolMessage).toBeDefined();
      expect(toolMessage?.content).toBe('Plain text output');
      expect(findRole(messages, 'user')).toBeUndefined();
    });

    it('should create tool message with empty content for empty function responses', () => {
      const messages = toMessages(
        content(
          'model',
          { text: 'Let me read that file.' },
          fnCall('read_file', { path: 'test.txt' }, 'call_1'),
        ),
        content('user', fnResponse('read_file', { output: '' }, 'call_1')),
      );

      // OpenAI expects every tool call to have a matching response, so an
      // empty result still yields a tool message (after the assistant one).
      expect(messages.length).toBeGreaterThanOrEqual(2);
      const toolMessage = findRole(messages, 'tool');
      expect(toolMessage).toBeDefined();
      expect(toolMessage).toMatchObject({
        ...toolReply('call_1'),
        content: '',
      });
    });

    it('should drop tool responses that are not adjacent to their assistant tool call', () => {
      const messages = toMessages(
        content(
          'model',
          fnCall('read_file', { path: 'a.txt' }, 'call_a'),
          fnCall('grep', { pattern: 'needle' }, 'call_b'),
        ),
        content('user', fnResponse('read_file', { output: 'A' }, 'call_a')),
        userText('history text inserted between tool results'),
        content('model', fnCall('list_files', {}, 'call_c')),
        content(
          'user',
          fnResponse('list_files', { output: 'C' }, 'call_c'),
          fnResponse('grep', { output: 'B' }, 'call_b'),
        ),
      );
      const assistantWithCallA = messages.find((message) =>
        callIdsOf(message)?.includes('call_a'),
      );

      expect(callIdsOf(assistantWithCallA)).toEqual(['call_a']);
      expect(toolCallIdsOf(messages)).toEqual(['call_a', 'call_c']);
    });

    it('should keep assistant text when all tool calls are orphaned', () => {
      const messages = toMessages(
        content(
          'model',
          { text: 'I can answer without the tool.' },
          fnCall('read_file', { path: 'missing.txt' }, 'call_missing'),
        ),
        userText('continue'),
      );
      const assistant = findRole(messages, 'assistant') as
        | OpenAI.Chat.ChatCompletionAssistantMessageParam
        | undefined;

      expect(assistant?.content).toBe('I can answer without the tool.');
      expect('tool_calls' in (assistant ?? {})).toBe(false);
      expect(messages.some((message) => message.role === 'tool')).toBe(false);
    });

    it('should drop assistant-only tool calls when all responses are orphaned', () => {
      const messages = toMessages(
        content(
          'model',
          fnCall('read_file', { path: 'missing.txt' }, 'call_missing'),
        ),
        userText('break adjacency'),
        userText('continue'),
      );

      expect(findRole(messages, 'assistant')).toBeUndefined();
      expect(messages.some((message) => message.role === 'tool')).toBe(false);
    });

    it('should drop later assistant tool calls that reuse a previous surviving id', () => {
      const messages = toMessages(
        ...exchange('dup_id_0001', 'read_file', { output: 'A' }, undefined, {
          file_path: 'a.ts',
        }),
        ...exchange('dup_id_0001', 'read_file', { output: 'B' }, undefined, {
          file_path: 'b.ts',
        }),
      );

      expect(messages.flatMap((message) => callIdsOf(message) ?? [])).toEqual([
        'dup_id_0001',
      ]);
      expect(toolCallIdsOf(messages)).toEqual(['dup_id_0001']);
    });

    it('should drop duplicate tool call IDs within a single assistant message', () => {
      const messages = toMessages(
        content(
          'model',
          fnCall('read_file', { file_path: 'a.ts' }, 'dup_id_0001'),
          fnCall('read_file', { file_path: 'b.ts' }, 'dup_id_0001'),
        ),
        content(
          'user',
          fnResponse('read_file', { output: 'A' }, 'dup_id_0001'),
        ),
      );
      const assistant = messages.find(hasOpenAIToolCalls);

      expect(assistant?.tool_calls).toHaveLength(1);
      expect(assistant?.tool_calls?.[0].id).toBe('dup_id_0001');
      expect(assistant?.tool_calls?.[0].function.arguments).toBe(
        JSON.stringify({ file_path: 'a.ts' }),
      );
    });

    it('should keep only the first adjacent tool response and its split media for a surviving id', () => {
      const messages = toSplitMessages(
        content('model', fnCall('screenshot', {}, 'call_image')),
        content(
          'user',
          ...['first', 'second'].map((data) =>
            fnResult('screenshot', { output: data }, 'call_image', [
              inline('image/png', data),
            ]),
          ),
        ),
      );
      const toolMessages = byRole(messages, 'tool');
      const splitMediaMessages = messages.filter(isOpenAISplitMediaMessage);

      expect(toolMessages).toHaveLength(1);
      expect(toolMessages[0]?.content).toBe('first');
      expect(splitMediaMessages).toHaveLength(1);
      expect(JSON.stringify(splitMediaMessages[0])).toContain('first');
      expect(JSON.stringify(splitMediaMessages[0])).not.toContain('second');
    });

    it('should keep a tool response after an empty-id tool message', () => {
      const messages = toMessages(
        content('model', fnCall('read_file', { path: 'a.txt' }, 'call_a')),
        content(
          'user',
          fnResponse('empty_id', { output: 'no id' }),
          fnResponse('read_file', { output: 'A' }, 'call_a'),
        ),
      );

      expect(toolCallIdsOf(messages)).toEqual(['call_a']);
    });

    it('should clean after merging consecutive assistant turns', () => {
      const messages = toMessages(
        content('model', fnCall('read_file', { path: 'a.txt' }, 'call_a')),
        modelText('A short follow-up.'),
        content('user', fnResponse('read_file', { output: 'A' }, 'call_a')),
      );

      expect(messages[0]).toMatchObject({
        role: 'assistant',
        content: 'A short follow-up.',
      });
      expect(callIdsOf(messages[0])).toEqual(['call_a']);
      expect(messages[1]).toMatchObject(toolReply('call_a'));
    });

    it('should keep split media after all adjacent tool responses across content items', () => {
      const messages = toSplitMessages(
        shotCalls(),
        content('user', shotA()),
        content('user', shotB()),
      );
      const assistantIndex = messages.findIndex(
        (message) => message.role === 'assistant',
      );

      expect(messages[assistantIndex + 1]).toMatchObject(toolReply('call_a'));
      expect(messages[assistantIndex + 2]).toMatchObject(toolReply('call_b'));
      expect(messages[assistantIndex + 3]?.role).toBe('user');
      expect(messages[assistantIndex + 4]?.role).toBe('user');
    });

    it('should not keep split media from orphaned tool responses', () => {
      const messages = toSplitMessages(
        content('model', fnCall('shot_a', {}, 'call_a')),
        content(
          'user',
          fnResult('shot_x', { output: 'X' }, 'call_x', [
            inline('image/png', 'xxx'),
          ]),
        ),
        content('user', fnResponse('shot_a', { output: 'A' }, 'call_a')),
      );

      expect(messages.map((message) => message.role)).toEqual([
        'assistant',
        'tool',
      ]);
      expect(messages[1]).toMatchObject(toolReply('call_a'));
    });

    it('should merge assistant turns created by orphan cleanup', () => {
      const messages = toMessages(
        ...exchange('call_a', 'read_file', { output: 'A' }),
        modelText('Next I will call another tool.'),
        content(
          'user',
          fnResponse('stale_tool', { output: 'stale' }, 'call_orphan'),
        ),
        ...exchange('call_b', 'grep', { output: 'B' }),
      );

      for (let index = 1; index < messages.length; index += 1) {
        expect([messages[index - 1].role, messages[index].role]).not.toEqual([
          'assistant',
          'assistant',
        ]);
      }
      expect(toolCallIdsOf(messages)).toEqual(['call_a', 'call_b']);
    });

    describe('assistant message with reasoning-only content (issue #3421)', () => {
      // Regression for #3421: when a model (e.g. Ollama qwen3.5:9b) returns
      // reasoning but an empty text body, the assistant message must use
      // content: "" instead of null; some OpenAI-compatible providers reject
      // content: null with HTTP 400 when reasoning_content is also present.
      const assistantOf = (...contents: Content[]) => {
        const assistantMsg = findRole(toMessages(...contents), 'assistant');
        expect(assistantMsg).toBeDefined();
        return assistantMsg as {
          content: unknown;
          reasoning_content?: string;
        };
      };

      it('should use empty string instead of null for content when assistant has only reasoning parts', () => {
        const assistantMsg = assistantOf(
          userText('Think about this.'),
          // Assistant turn that only produced a thought, no visible text
          content('model', thoughtPart('I reasoned about it.')),
          userText('What did you conclude?'),
        );

        // Must NOT be null (see the describe comment); reasoning is preserved.
        expect(assistantMsg.content).toBe('');
        expect(assistantMsg.reasoning_content).toBe('I reasoned about it.');
      });

      it('should keep reasoning content when orphaned tool calls are removed', () => {
        const assistantMsg = assistantOf(
          content(
            'model',
            thoughtPart('I need to inspect this.'),
            fnCall('read_file', {}, 'call_missing'),
          ),
          userText('break adjacency'),
        );

        expect(assistantMsg.content).toBe('');
        expect(assistantMsg.reasoning_content).toBe('I need to inspect this.');
        expect('tool_calls' in assistantMsg).toBe(false);
      });

      it('should keep content null when assistant has only tool_calls and no reasoning', () => {
        const assistantMsg = assistantOf(
          userText('Call the tool.'),
          ...exchange('call_1', 'some_tool', { output: 'done' }),
        );

        // Tool-call-only messages follow the OpenAI spec: content should be null
        expect(assistantMsg.content).toBeNull();
      });

      it('should use actual text content when assistant has both reasoning and text', () => {
        const assistantMsg = assistantOf(
          userText('Explain.'),
          content('model', thoughtPart('My hidden reasoning.'), {
            text: 'Here is my answer.',
          }),
        );

        expect(assistantMsg.content).toBe('Here is my answer.');
        expect(assistantMsg.reasoning_content).toBe('My hidden reasoning.');
      });
    });
  });

  describe('MCP multi-part tool results (issue #1520)', () => {
    // Regression tests for https://github.com/QwenLM/qwen-code/issues/1520:
    // when an MCP tool returns several content blocks (text + image, or
    // multiple text sections), all content must end up in the tool message,
    // NOT in a separate user message. Inputs mimic the fixed
    // convertToFunctionResponse(): text joined into `response.output`,
    // media placed in `response.parts`.
    const toolMessageOf = (messages: Message[], id: string) => {
      expect(findRole(messages, 'tool')).toMatchObject(toolReply(id));
      return toolPartsOf(messages);
    };

    it('should include all text content in tool message when function response has joined text', () => {
      const messages = toMessages(
        ...exchange(
          'call_mcp_1',
          'figma_get_code',
          {
            output:
              '<div data-node-id="38:521">...</div>\nSUPER CRITICAL: The generated React+Tailwind code MUST be converted...',
          },
          undefined,
          { nodeId: '38:521' },
        ),
      );

      const toolTexts = textsOf(toolMessageOf(messages, 'call_mcp_1'));
      expect(toolTexts).toHaveLength(1);
      expect(toolTexts[0]).toContain('data-node-id');
      expect(toolTexts[0]).toContain('SUPER CRITICAL');
      expect(byRole(messages, 'user')).toHaveLength(0);
    });

    it('should include text and image in tool message when function response has media parts', () => {
      // convertToFunctionResponse puts media into FunctionResponse.parts,
      // which createToolMessage() picks up.
      const messages = toMessages(
        ...exchange(
          'call_mcp_2',
          'figma_get_screenshot',
          {
            output:
              "[Tool 'figma' provided the following image data with mime-type: image/png]",
          },
          [
            inline(
              'image/png',
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACklEQVR4nGMAAQAABQABDQottAAAAABJRU5ErkJggg==',
            ),
          ],
          { nodeId: '38:521' },
        ),
      );

      expectTextThenPng(toolMessageOf(messages, 'call_mcp_2'), 'image data');
      expect(byRole(messages, 'user')).toHaveLength(0);
    });

    it('passes text-only nested parts (e.g. compaction slimmer placeholders) through to the tool message', () => {
      // Compaction slimming replaces inlineData inside functionResponse.parts
      // with `{ text: '[image: image/png]' }` before the side-query.
      // createToolMessage must surface the placeholder, otherwise the summary
      // model gets an empty tool response with no sign an image existed.
      const messages = toMessages(
        ...exchange(
          'call_strip',
          'read_file',
          { output: '' },
          [{ text: '[image: image/png]' }],
          { path: '/x.png' },
        ),
      );

      const toolMessage = findRole(messages, 'tool');
      expect(toolMessage).toBeDefined();
      const toolContent = toolMessage?.content;
      // String or array depending on single-part shaping; either way the
      // placeholder must be visible verbatim.
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
    const usage = (
      prompt_tokens: number,
      completion_tokens: number,
      total_tokens: number,
      extra: Record<string, unknown> = {},
    ) => ({ prompt_tokens, completion_tokens, total_tokens, ...extra });
    const usageChunk = (
      context: RequestContext,
      chunkUsage: Record<string, unknown>,
    ) =>
      converter.convertOpenAIChunkToLlm(
        {
          object: 'chat.completion.chunk',
          id: 'chunk-usage',
          created: 123,
          model: 'test-model',
          choices: [],
          usage: chunkUsage,
        } as unknown as OpenAI.Chat.ChatCompletionChunk,
        context,
      );
    /** Streams each reasoning_content delta, then a usage-only chunk. */
    const streamReasoningUsage = (
      deltas: string[],
      chunkUsage: Record<string, unknown>,
    ) => {
      const context = withStreamParser();
      for (const reasoning_content of deltas) {
        streamParts(context, { reasoning_content });
      }
      return usageChunk(context, chunkUsage);
    };

    it('should handle empty choices array without crashing', () => {
      const response = toLlm([]);

      expect(response.candidates).toEqual([]);
      expect(response.modelVersion).toBe('test-model');
    });

    it('maps uppercase finish_reason values case-insensitively', () => {
      const stop = toLlm([choice({ content: 'done' }, 'STOP')]);
      const truncated = toLlm([choice({ content: 'cut off' }, 'MAX_TOKENS')]);

      expect(stop.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
      expect(truncated.candidates?.[0]?.finishReason).toBe(
        FinishReason.MAX_TOKENS,
      );
    });

    it('does not throw on a non-string finish_reason from a malformed gateway', () => {
      const response = toLlm([choice({ content: 'done' }, 42)]);

      expect(response.candidates?.[0]?.finishReason).toBe(
        FinishReason.FINISH_REASON_UNSPECIFIED,
      );
    });

    it.each([
      [
        'omits the input/output breakdown when only total tokens are reported',
        () => toLlm([choice({ content: 'hi' })], { usage: usage(0, 0, 5) }),
      ],
      [
        'omits the streaming input/output breakdown when only total tokens are reported',
        () => usageChunk(withStreamParser(), usage(0, 0, 5)),
      ],
    ])('%s', (_title, convert) => {
      const usageMetadata = convert().usageMetadata;

      expect(usageMetadata?.totalTokenCount).toBe(5);
      expect(usageMetadata?.promptTokenCount).toBeUndefined();
      expect(usageMetadata?.candidatesTokenCount).toBeUndefined();
      expect(getGenAiUsageProvenance(usageMetadata)).toMatchObject({
        cachedInputTokensReported: false,
      });
    });

    it('distinguishes an absent cache field from an explicitly reported zero', () => {
      const convert = (extra: Record<string, unknown> = {}) =>
        toLlm([], {
          id: 'chatcmpl-cache',
          model: 'provider-model',
          usage: usage(3, 1, 4, extra),
        });
      const absent = convert();
      const zero = convert({ prompt_tokens_details: { cached_tokens: 0 } });

      expect(absent.modelVersion).toBe('provider-model');
      expect(
        getGenAiUsageProvenance(absent.usageMetadata)
          ?.cachedInputTokensReported,
      ).toBe(false);
      expect(
        getGenAiUsageProvenance(zero.usageMetadata)?.cachedInputTokensReported,
      ).toBe(true);
    });

    it.each([
      [
        'estimates missing reasoning tokens from non-streaming content',
        { reasoning_content: '先仔细想' },
        usage(1, 10, 11),
        5,
      ],
      [
        'estimates missing reasoning tokens from non-streaming reasoning field',
        { reasoning: '先仔细想' },
        usage(1, 10, 11),
        5,
      ],
      [
        'clamps estimated non-streaming reasoning tokens to completion tokens',
        { reasoning_content: '想'.repeat(10) },
        usage(1, 3, 4),
        3,
      ],
    ])('%s', (_title, reasoning, responseUsage, expected) => {
      const response = toLlm([choice({ content: 'answer', ...reasoning })], {
        usage: responseUsage,
      });

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(expected);
    });

    it.each([0, 42])(
      'preserves provider reasoning tokens for non-streaming content: %s',
      (reasoningTokens) => {
        const response = toLlm(
          [choice({ content: 'answer', reasoning_content: '先仔细想' })],
          {
            usage: usage(1, 10, 11, {
              completion_tokens_details: { reasoning_tokens: reasoningTokens },
            }),
          },
        );

        expect(response.usageMetadata?.thoughtsTokenCount).toBe(
          reasoningTokens,
        );
      },
    );

    it.each([
      [
        'estimates reasoning tokens past the streaming detection window',
        ['想'.repeat(1024), '想'],
        usage(1, 1200, 1201),
        1128,
      ],
      [
        'estimates reasoning tokens for short streaming content',
        ['先', '仔细想'],
        usage(1, 10, 11),
        5,
      ],
      [
        'estimates normalized cumulative reasoning without a completion count',
        ['先仔细想', '先仔细想再检查'],
        usage(1, 0, 1),
        8,
      ],
      [
        'clamps estimated streaming reasoning tokens to completion tokens',
        ['想'.repeat(10)],
        usage(1, 3, 4),
        3,
      ],
    ])('%s', (_title, deltas, chunkUsage, expected) => {
      const response = streamReasoningUsage(deltas, chunkUsage);

      expect(response.usageMetadata?.thoughtsTokenCount).toBe(expected);
    });

    it.each([0, 42])(
      'preserves provider reasoning tokens for streaming content: %s',
      (reasoningTokens) => {
        const response = streamReasoningUsage(
          ['先仔细想'],
          usage(1, 10, 11, {
            completion_tokens_details: { reasoning_tokens: reasoningTokens },
          }),
        );

        expect(response.usageMetadata?.thoughtsTokenCount).toBe(
          reasoningTokens,
        );
      },
    );
  });

  describe('OpenAI -> Gemini reasoning content', () => {
    /** Streams content deltas through one context; returns each chunk's first-part text ('' when none). */
    const streamContent = (chunks: string[]) => {
      const ctx = withStreamParser();
      return chunks.map(
        (content) => streamParts(ctx, { content })?.[0]?.text ?? '',
      );
    };
    /** Same for reasoning_content, returning `{ text, thought }` of each chunk's first part. */
    const streamReasoning = (chunks: string[]) => {
      const ctx = withStreamParser();
      return chunks.map((reasoning_content) => {
        const part = streamParts(ctx, { reasoning_content })?.[0];
        return { text: part?.text ?? '', thought: part?.thought ?? false };
      });
    };

    it.each([
      [
        'should convert reasoning_content to a thought part for non-streaming responses',
        () =>
          toLlm([
            choice({
              content: 'final answer',
              reasoning_content: 'chain-of-thought',
            }),
          ]),
        'chain-of-thought',
        'final answer',
      ],
      [
        'should convert reasoning to a thought part for non-streaming responses',
        () =>
          toLlm([
            choice({ content: 'final answer', reasoning: 'chain-of-thought' }),
          ]),
        'chain-of-thought',
        'final answer',
      ],
      [
        'should convert streaming reasoning_content delta to a thought part',
        () =>
          converter.convertOpenAIChunkToLlm(
            openAIStreamChunk(
              { content: 'visible text', reasoning_content: 'thinking...' },
              'stop',
            ),
            withStreamParser(),
          ),
        'thinking...',
        'visible text',
      ],
      [
        'should convert streaming reasoning delta to a thought part',
        () =>
          converter.convertOpenAIChunkToLlm(
            openAIStreamChunk(
              { content: 'visible text', reasoning: 'thinking...' },
              'stop',
            ),
            withStreamParser(),
          ),
        'thinking...',
        'visible text',
      ],
    ])('%s', (_title, convert, thought, text) => {
      const parts = partsOf(convert());

      expect(parts?.[0]).toEqual(
        expect.objectContaining({ thought: true, text: thought }),
      );
      expect(isOpenAIReasoningThoughtPart(parts?.[0] as Part)).toBe(true);
      expect(parts?.[1]).toEqual(expect.objectContaining({ text }));
    });

    it('should not throw when streaming chunk has no delta', () => {
      // Some OpenAI-compatible providers may omit delta entirely.
      const parts = streamParts(
        withStreamParser(),
        undefined as unknown as Record<string, unknown>,
      );

      expect(parts).toEqual([]);
    });

    it('should normalize cumulative streaming content deltas to suffixes', () => {
      const chunks = [
        'Here',
        'Here is a Flowchart Syntax Reference:',
        'Here is a Flowchart Syntax Reference:\n| `flowchart TD` | Direction |',
        'Here is a Flowchart Syntax Reference:\n| `flowchart TD` | Direction |\n| `A[Text]` | Node |',
      ];
      const emitted = streamContent(chunks);

      expect(emitted).toEqual([
        'Here',
        ' is a Flowchart Syntax Reference:',
        '\n| `flowchart TD` | Direction |',
        '\n| `A[Text]` | Node |',
      ]);
      expect(emitted.join('')).toBe(chunks[chunks.length - 1]);
    });

    it('should ignore repeated cumulative chunks with no new suffix', () => {
      // ≥ CUMULATIVE_DELTA_EXACT_REPEAT_MIN_LENGTH (64) so the exact repeat
      // enters cumulative mode instead of passing as a short legit repeat.
      const content =
        'The following section starts with more than enough text for cumulative-mode detection.';

      expect(streamContent([content, content])).toEqual([content, '']);
    });

    it('should preserve repeated short incremental content chunks', () => {
      expect(streamContent(['ha', 'ha'])).toEqual(['ha', 'ha']);
    });

    it('should normalize cumulative streaming reasoning_content deltas to suffixes', () => {
      const chunks = [
        'Let me think',
        'Let me think about the request carefully.',
        'Let me think about the request carefully.\nFirst, identify the table format.',
      ];
      const emitted = streamReasoning(chunks);

      expect(emitted).toEqual([
        thoughtPart('Let me think'),
        thoughtPart(' about the request carefully.'),
        thoughtPart('\nFirst, identify the table format.'),
      ]);
      expect(emitted.map((e) => e.text).join('')).toBe(
        chunks[chunks.length - 1],
      );
    });

    it('should exit cumulative mode when a chunk does not match prior accumulated text', () => {
      // Chunk 2 enters cumulative mode; chunk 3 is not a prefix extension, so
      // the mode exits and it is appended verbatim (no silent loss).
      expectEach(
        streamContent([
          'Step one is to gather inputs.',
          'Step one is to gather inputs.\nStep two is to validate them.',
          'Brand new unrelated message.',
        ]),
        [
          'Step one is to gather inputs.',
          '\nStep two is to validate them.',
          'Brand new unrelated message.',
        ],
      );
    });

    it('should resume prefix detection cleanly after exiting cumulative mode', () => {
      // After the exit (chunk 3 becomes the fresh baseline), chunk 4
      // prefix-extends it and re-enters cumulative mode: suffix only.
      expectEach(
        streamContent([
          'Step one is to gather inputs.',
          'Step one is to gather inputs.\nStep two is to validate them.',
          'Brand new unrelated message.',
          'Brand new unrelated message. And more.',
        ]),
        [
          'Step one is to gather inputs.',
          '\nStep two is to validate them.',
          'Brand new unrelated message.',
          ' And more.',
        ],
      );
    });

    it('should not poison the baseline when short chunks repeat before threshold', () => {
      // The short repeat must not corrupt emittedText (baseline stays 'Hi').
      expectEach(streamContent(['Hi', 'Hi', 'Hi there, how are you today?']), [
        'Hi',
        'Hi',
        ' there, how are you today?',
      ]);
    });

    it('should normalize cumulative reasoning_content deltas across multi-line growth (newline-prefixed suffixes)', () => {
      // Suffixes start with '\n', exercising the slice arithmetic there.
      expectEach(
        streamReasoning([
          'Let me reason step by step.',
          'Let me reason step by step.\nFirst: check the inputs.',
          'Let me reason step by step.\nFirst: check the inputs.\nSecond: validate.',
        ]),
        [
          thoughtPart('Let me reason step by step.'),
          thoughtPart('\nFirst: check the inputs.'),
          thoughtPart('\nSecond: validate.'),
        ],
      );
    });

    it('should ignore repeated cumulative reasoning_content chunks with no new suffix', () => {
      // The reasoning channel has its own state, so its exact-repeat entry
      // (≥ 64 chars) is exercised separately; the repeat yields no part.
      const reasoning =
        'The reasoning section also starts with more than enough text to pass detection.';

      expectEach(streamReasoning([reasoning, reasoning]), [
        thoughtPart(reasoning),
        { text: '', thought: false },
      ]);
    });

    it('should exit cumulative mode on reasoning_content channel when chunk does not match prior accumulated text', () => {
      // Content-channel exit case, against the reasoning channel's own state.
      expectEach(
        streamReasoning([
          'Step one of my reasoning is to gather inputs.',
          'Step one of my reasoning is to gather inputs.\nStep two: validate.',
          'Brand new unrelated reasoning.',
        ]),
        [
          thoughtPart('Step one of my reasoning is to gather inputs.'),
          thoughtPart('\nStep two: validate.'),
          thoughtPart('Brand new unrelated reasoning.'),
        ],
      );
    });

    it('should resume prefix detection on reasoning_content channel after exiting cumulative mode', () => {
      // Content-channel re-entry case, against the reasoning channel's state.
      expectEach(
        streamReasoning([
          'Step one of my reasoning is to gather inputs.',
          'Step one of my reasoning is to gather inputs.\nStep two: validate.',
          'Brand new unrelated reasoning.',
          'Brand new unrelated reasoning. And further reflection.',
        ]),
        [
          thoughtPart('Step one of my reasoning is to gather inputs.'),
          thoughtPart('\nStep two: validate.'),
          thoughtPart('Brand new unrelated reasoning.'),
          thoughtPart(' And further reflection.'),
        ],
      );
    });

    it('should deduplicate interleaved reasoning_content and content channels independently', () => {
      // Cumulative detection in one channel must not bleed into the other.
      expectSteps(withStreamParser(), [
        [
          { reasoning_content: 'Let me think about this carefully.' },
          [thoughtPart('Let me think about this carefully.')],
        ],
        [{ content: 'Here' }, [{ text: 'Here' }]],
        [
          {
            reasoning_content: 'Let me think about this carefully.\nStep two.',
          },
          [thoughtPart('\nStep two.')],
        ],
        [{ content: 'Here is the answer.' }, [{ text: ' is the answer.' }]],
      ]);
    });

    it('should enter cumulative mode on exact 64-char repeat (at threshold)', () => {
      // Exactly the 64-char threshold: the repeat is suppressed and chunk 3
      // emits its suffix. The threshold sits well above realistic legit
      // repeats (a duplicate import line is ~31 chars).
      const atThreshold = 'A'.repeat(64);

      expectEach(
        streamContent([atThreshold, atThreshold, atThreshold + ' and more']),
        [atThreshold, '', ' and more'],
      );
    });

    it('should pass through 63-char exact repeat without entering cumulative mode (below threshold)', () => {
      // One short: the repeat passes through; chunk 3 enters cumulative mode.
      const belowThreshold = 'A'.repeat(63);

      expectEach(
        streamContent([
          belowThreshold,
          belowThreshold,
          belowThreshold + ' extra',
        ]),
        [belowThreshold, belowThreshold, ' extra'],
      );
    });

    it('should preserve legitimate duplicate import-line chunks (regression: silent data loss)', () => {
      // Regression for PR #3896 review (wenshao, 2026-05-13, finding #1):
      // incremental streams emit duplicate import/boilerplate lines, which the
      // exact-repeat threshold must not silently suppress.
      const importLine = "import { foo } from './module';"; // 31 chars
      const emitted = streamContent([importLine, importLine, '\nconst x = 1;']);

      expectEach(emitted, [importLine, importLine, '\nconst x = 1;']);
      expect(emitted.join('')).toBe(importLine + importLine + '\nconst x = 1;');
    });

    it('should pass incremental chunks through verbatim past the detection window cap (none of them overlap)', () => {
      // Past CUMULATIVE_DETECTION_WINDOW_BYTES (1024) the baseline stops
      // growing; non-overlapping chunks must still pass through verbatim
      // rather than short-circuiting once the cap is reached. Unhandled: a
      // later chunk starting with the frozen baseline would still match it,
      // but that needs ≥1024 bytes of exact-prefix coincidence.
      // 100 distinct 20-char chunks = 2000 chars, well past the cap.
      const incrementalChunks = Array.from(
        { length: 100 },
        (_, i) => `chunk${String(i).padStart(3, '0')}-payload__`,
      );

      expect(streamContent(incrementalChunks)).toEqual(incrementalChunks);
    });

    it('should detect cumulative mode even when the first chunk exceeds the detection window cap', () => {
      // Regression for PR #3896 review: a large (>1024 char) first chunk must
      // not short-circuit prefix detection, or the whole chunk is duplicated.
      const firstChunk = 'A'.repeat(1500); // past CUMULATIVE_DETECTION_WINDOW_BYTES (1024)
      const secondChunk = firstChunk + 'B'.repeat(200);
      const thirdChunk = secondChunk + 'C'.repeat(50);

      expectEach(streamContent([firstChunk, secondChunk, thirdChunk]), [
        firstChunk,
        'B'.repeat(200),
        'C'.repeat(50),
      ]);
    });

    it('should not duplicate emitted bytes when an incremental stream transitions into cumulative mode past the window cap', () => {
      // Regression for PR #3896 review (wenshao, 2026-05-13, finding #2):
      // 200 distinct 8-byte chunks (past the 1024-byte cap), then one
      // cumulative replay plus new content. The baseline froze at 1024, so
      // without the separately tracked emittedLength bytes 1024..1600 would be
      // shown twice. Chunks must be distinct, or the short-repeat branch pins
      // emittedText and the cap is never reached.
      const incremental = Array.from(
        { length: 200 },
        (_, i) => `c${String(i).padStart(3, '0')}=AB_`, // 8 bytes, distinct per chunk
      );
      const tail = '|CONTINUATION|'; // 14 bytes
      const cumulativeChunk = incremental.join('') + tail; // 1614 bytes

      const emitted = streamContent([...incremental, cumulativeChunk]);
      const incrementalEmitted = emitted.slice(0, -1);
      const cumulativeEmitted = emitted.at(-1);

      expect(incrementalEmitted).toEqual(incremental);
      // Only the new 14-byte tail, not the ~576 bytes between cap and total.
      expect(cumulativeEmitted).toBe(tail);
      const userVisible = incrementalEmitted.join('') + cumulativeEmitted;
      expect(userVisible).toBe(cumulativeChunk);
      expect(userVisible.length).toBe(1614);
    });

    it('should suppress cumulative rewind (provider re-sends shorter accumulated string)', () => {
      // 'Hello' after 'Hello World' is a rewind (strict prefix): suppressed.
      expectEach(
        streamContent(['Hello', 'Hello World', 'Hello', 'Hello World!']),
        ['Hello', ' World', '', '!'],
      );
    });

    it('should still call into convertOpenAITextToParts on finish_reason when the cumulative-mode normalized delta is empty', () => {
      // Targets the `normalizedContent || choice.finish_reason` guard: an
      // exact-repeat final chunk normalizes to '' in cumulative mode (set up by
      // the prefix-extension pair) but must still reach the text conversion
      // for finish-time effects such as flushing buffered tagged thinking. The
      // other cumulative cases all use `finish_reason: null`.
      const ctx = withStreamParser();
      streamParts(ctx, { content: 'Answer: forty-two' });
      streamParts(ctx, { content: 'Answer: forty-two and more.' });
      const finalChunk = converter.convertOpenAIChunkToLlm(
        openAIStreamChunk({ content: 'Answer: forty-two and more.' }, 'stop'),
        ctx,
      );

      // Clean state (no buffered tag): no exception, finishReason propagates,
      // no duplicate text.
      expect(finalChunk.candidates?.[0]?.finishReason).toBe('STOP');
      expect(
        partsOf(finalChunk)
          ?.map((p) => p.text ?? '')
          .join(''),
      ).toBe('');
    });

    it('should handle a single chunk delta with both reasoning_content and content simultaneously', () => {
      const ctx = withStreamParser();
      ctx.responseParsingOptions = { contentOnlyThinkingTagLeaks: true };
      const parts =
        streamParts(ctx, {
          reasoning_content: 'I need to think.',
          content: 'Here is my answer.',
        }) ?? [];

      expect(parts.find((p) => p.thought === true)?.text).toBe(
        'I need to think.',
      );
      expect(parts.find((p) => !p.thought)?.text).toBe('Here is my answer.');
    });
  });

  describe('OpenAI -> Gemini tagged thinking content', () => {
    const responseParts = (
      content: string,
      ctx: RequestContext = withTaggedThinkingOptions(),
    ) => partsOf(toLlm([choice({ content })], {}, ctx));

    it.each<[string, string, Part[]]>([
      [
        'should convert MiniMax <think> content to thought parts for non-streaming responses',
        '<think>internal reasoning</think>final answer',
        [thoughtPart('internal reasoning'), { text: 'final answer' }],
      ],
      [
        'should preserve ordering around <thinking> blocks',
        'before<thinking>hidden</thinking>after',
        [{ text: 'before' }, thoughtPart('hidden'), { text: 'after' }],
      ],
      [
        'should parse multiple tagged thinking blocks case-insensitively',
        '<THINK>a</THINK>visible<Thinking>b</Thinking>',
        [thoughtPart('a'), { text: 'visible' }, thoughtPart('b')],
      ],
      [
        'should preserve incomplete tags as visible text on final non-streaming parse',
        'final answer <thi',
        [{ text: 'final answer <thi' }],
      ],
    ])('%s', (_title, content, expected) => {
      expect(responseParts(content)).toEqual(expected);
    });

    it('should leave tags visible when tagged thinking parsing is disabled', () => {
      const parts = responseParts('<think>visible xml example</think>', {
        ...requestContext,
        responseParsingOptions: { contentOnlyThinkingTagLeaks: true },
      });

      expect(parts).toEqual([{ text: '<think>visible xml example</think>' }]);
    });

    it('should parse streaming tags split across chunks', () => {
      expectSteps(withTaggedThinkingStreamParser(), [
        [{ content: 'pre <thi' }, [{ text: 'pre ' }]],
        [{ content: 'nk>hidden</thi' }, [thoughtPart('hidden')]],
        [{ content: 'nk> visible' }, [{ text: ' visible' }], 'stop'],
      ]);
    });

    it('should suppress reasoning_content when the same streaming chunk has tagged thinking content', () => {
      const parts = streamParts(
        withTaggedThinkingStreamParser(),
        {
          reasoning_content: 'duplicate reasoning channel',
          content: '<think>tagged reasoning</think>final answer',
        },
        'stop',
      );

      expect(parts).toEqual([
        thoughtPart('tagged reasoning'),
        { text: 'final answer' },
      ]);
    });

    it('should suppress late reasoning_content after streaming tagged thinking content', () => {
      expectSteps(withTaggedThinkingStreamParser(), [
        [
          { content: '<think>tagged reasoning</think>' },
          [thoughtPart('tagged reasoning')],
        ],
        [{ reasoning_content: 'late reasoning' }, []],
      ]);
    });

    it('should suppress buffered reasoning_content when later streaming content has tagged thinking', () => {
      expectSteps(withTaggedThinkingStreamParser(), [
        [{ reasoning_content: 'duplicate reasoning channel' }, []],
        [
          { content: '<think>tagged reasoning</think>' },
          [thoughtPart('tagged reasoning')],
        ],
        [{ content: 'final answer' }, [{ text: 'final answer' }], 'stop'],
      ]);
    });

    it('should flush buffered content before later tagged thinking content', () => {
      expectSteps(withTaggedThinkingStreamParser(), [
        [
          {
            reasoning_content: 'duplicate reasoning channel',
            content: 'early visible ',
          },
          [],
        ],
        [
          { content: '<think>tagged reasoning</think>final answer' },
          [
            { text: 'early visible ' },
            thoughtPart('tagged reasoning'),
            { text: 'final answer' },
          ],
        ],
      ]);
    });

    it('should flush buffered content before current content when reasoning flushes on finish', () => {
      expectSteps(withTaggedThinkingStreamParser(), [
        [{ reasoning_content: 'step 1', content: 'hello ' }, []],
        [
          { content: 'world' },
          [thoughtPart('step 1'), { text: 'hello ' }, { text: 'world' }],
          'stop',
        ],
      ]);
    });

    it('should flush buffered reasoning_content when tagged streaming content has no thinking tags', () => {
      const [, finalParts] = expectSteps(withTaggedThinkingStreamParser(), [
        [
          {
            reasoning_content: 'separate reasoning channel',
            content: 'final ',
          },
          [],
        ],
        [
          { content: 'answer' },
          [
            thoughtPart('separate reasoning channel'),
            { text: 'final ' },
            { text: 'answer' },
          ],
          'stop',
        ],
      ]);

      expect(isOpenAIReasoningThoughtPart(finalParts?.[0] as Part)).toBe(true);
    });

    it('should flush reasoning-only chunks when tagged streaming content has no thinking tags', () => {
      expectSteps(withTaggedThinkingStreamParser(), [
        [{ reasoning_content: 'step 1' }, []],
        [{}, [thoughtPart('step 1')], 'stop'],
      ]);
    });

    it('should flush unclosed streaming thinking content on finish', () => {
      const parts = streamParts(
        withTaggedThinkingStreamParser(),
        { content: 'answer <think>still thinking' },
        'stop',
      );

      expect(parts).toEqual([
        { text: 'answer ' },
        thoughtPart('still thinking'),
      ]);
    });

    /** A Qwen3 tagged-thinking stream that has already emitted reasoning 'step 1'. */
    const qwen3AfterReasoning = () => {
      const context = withQwen3TaggedThinkingStreamParser();
      streamParts(context, { reasoning_content: 'step 1' });
      return context;
    };

    it('should stream ordinary Qwen3 reasoning and content immediately', () => {
      expectSteps(withQwen3TaggedThinkingStreamParser(), [
        [{ reasoning_content: 'step 1' }, [thoughtPart('step 1')]],
        [{ content: 'answer' }, [{ text: 'answer' }]],
      ]);
    });

    it('should parse a balanced Qwen3 thinking block after reasoning', () => {
      expectSteps(qwen3AfterReasoning(), [
        [{ content: '<thi' }, []],
        [
          { content: 'nking>step 2</thinking>answer' },
          [thoughtPart('step 2'), { text: 'answer' }],
          'stop',
        ],
      ]);
    });

    it('should reject an unclosed Qwen3 thinking block after reasoning', () => {
      const context = qwen3AfterReasoning();

      expectThrowType(
        () => streamParts(context, { content: '<thinking>step 2' }, 'stop'),
        'PROTOCOL_TAG_LEAK',
      );
    });

    it('should suppress a replayed short Qwen3 thinking block', () => {
      expectSteps(qwen3AfterReasoning(), [
        [{ content: '<think>x</think>' }, [thoughtPart('x')]],
        [{ content: '<think>x</think>' }, []],
      ]);
    });

    it('should suppress a replayed short Qwen3 thinking opener', () => {
      const context = qwen3AfterReasoning();
      streamParts(context, { content: '<think>' });

      expectSteps(context, [
        [{ content: '<think>' }, []],
        [
          { content: 'x</think>answer' },
          [thoughtPart('x'), { text: 'answer' }],
          'stop',
        ],
      ]);
    });

    it('should suppress a replayed Qwen3 snapshot beyond the detection window', () => {
      const context = qwen3AfterReasoning();
      const block = `<thinking>${'x'.repeat(1200)}</thinking>answer`;
      for (let offset = 0; offset < block.length; offset += 100) {
        streamParts(context, { content: block.slice(offset, offset + 100) });
      }

      expectSteps(context, [
        [{ content: block }, []],
        [{ content: block.slice(0, -1) }, []],
        [{ content: `${block}!` }, [{ text: '!' }]],
      ]);
    });

    it('should preserve repeated short blocks for eager tagged parsing', () => {
      expectSteps(withTaggedThinkingStreamParser(), [
        [{ content: '<think>x</think>' }, [thoughtPart('x')]],
        [{ content: '<think>x</think>' }, [thoughtPart('x')]],
      ]);
    });
  });

  describe('convertLlmToolsToOpenAI', () => {
    const toolsOf = (...functionDeclarations: unknown[]) =>
      [{ functionDeclarations }] as Tool[];
    const convertDeclarations = (
      declarations: unknown[],
      schemaFormat?: Parameters<typeof converter.convertLlmToolsToOpenAI>[1],
    ) =>
      converter.convertLlmToolsToOpenAI(toolsOf(...declarations), schemaFormat);
    const declarationsOf = async (
      declarations: unknown[],
      schemaFormat?: Parameters<typeof converter.convertLlmToolsToOpenAI>[1],
    ) =>
      (await convertDeclarations(declarations, schemaFormat)).map(
        ({ function: declaration }) => declaration,
      );
    const paramsOf = async (declaration: unknown) =>
      (await convertDeclarations([declaration]))[0]!.function
        .parameters as Record<string, unknown>;
    const schemaTool = (name: string, parametersJsonSchema: unknown) => ({
      name,
      parametersJsonSchema,
    });
    const closedEmpty = () => ({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
    /** An expected wire declaration: empty description, `parameters` only when given. */
    const decl = (name: string, parameters?: unknown) => ({
      name,
      description: '',
      ...(parameters === undefined ? {} : { parameters }),
    });

    it('compiles a stable tool schema only once', async () => {
      const tools = toolsOf(
        schemaTool('stable', {
          type: 'object',
          properties: { value: { type: 'string', maxLength: 1999 } },
        }),
      );
      const compileStrict = vi.spyOn(SchemaValidator, 'compileStrict');

      try {
        await converter.convertLlmToolsToOpenAI(tools);
        await converter.convertLlmToolsToOpenAI(tools);
        expect(compileStrict).toHaveBeenCalledTimes(1);
      } finally {
        compileStrict.mockRestore();
      }
    });

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

      const result = await convertDeclarations([
        {
          name: 'todo_write',
          description: 'Update the todo list',
          parametersJsonSchema,
        },
      ]);

      expect(result).toEqual([
        {
          type: 'function',
          function: {
            name: 'todo_write',
            description: 'Update the todo list',
            parameters: {
              type: 'object',
              properties: {
                blockedBy: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      ]);
      expect(parametersJsonSchema.properties.blockedBy.uniqueItems).toBe(true);
    });

    it('only relaxes grammar constraints backed by local validation', async () => {
      const supportedSchema = closedEmpty();
      const unsupportedSchema = {
        $schema: 'https://json-schema.org/draft/2019-09/schema',
        ...closedEmpty(),
      };
      const unsupportedVocabularySchema = {
        type: 'object',
        properties: { tuple: { type: 'array', prefixItems: [closedEmpty()] } },
      };

      const declarations = await declarationsOf([
        schemaTool('supported', supportedSchema),
        schemaTool('open', { type: 'object', properties: {} }),
        schemaTool('draft_2020', {
          $schema: 'https://json-schema.org/draft/2020-12/schema',
          ...closedEmpty(),
        }),
        schemaTool('annotated', {
          type: 'object',
          properties: {},
          title: 'NoArgs',
        }),
        schemaTool('closed', { type: 'object', additionalProperties: false }),
        schemaTool('constrained', {
          type: 'object',
          properties: {},
          minProperties: 1,
        }),
        schemaTool('nullable', { type: ['object', 'null'], properties: {} }),
        // Says nothing about its arguments -- not the same claim as an empty
        // argument list, so it keeps `parameters`.
        schemaTool('unspecified', { type: 'object' }),
        // Explicitly accepts arguments it does not name; also keeps them.
        schemaTool('permissive', {
          type: 'object',
          properties: {},
          additionalProperties: true,
        }),
        schemaTool('unsupported', unsupportedSchema),
        schemaTool('unsupported_vocabulary', unsupportedVocabularySchema),
        {
          name: 'without_local_schema',
          parameters: { ...closedEmpty(), type: Type.OBJECT },
        },
      ]);

      expect(declarations).toEqual([
        decl('supported'),
        decl('open'),
        decl('draft_2020'),
        decl('annotated'),
        decl('closed'),
        decl('constrained', { type: 'object', minProperties: 1 }),
        decl('nullable', { type: ['object', 'null'] }),
        decl('unspecified', { type: 'object' }),
        decl('permissive', { type: 'object', additionalProperties: true }),
        decl('unsupported', closedEmpty()),
        decl('unsupported_vocabulary', unsupportedVocabularySchema),
        decl('without_local_schema', closedEmpty()),
      ]);
      expect(JSON.stringify(declarations.slice(0, 5))).not.toContain(
        'parameters',
      );
      expect(supportedSchema).toEqual(closedEmpty());
      expect(unsupportedSchema.$schema).toBe(
        'https://json-schema.org/draft/2019-09/schema',
      );
      expect(
        unsupportedVocabularySchema.properties.tuple.prefixItems[0]
          .additionalProperties,
      ).toBe(false);
    });

    it('does not omit constraints lost during OpenAPI 3.0 conversion', async () => {
      const declarations = await declarationsOf(
        [
          schemaTool('patterned', {
            type: 'object',
            properties: {},
            patternProperties: { '^x': { type: 'string' } },
            additionalProperties: false,
          }),
          schemaTool('dependent', {
            type: 'object',
            properties: {},
            dependencies: { a: ['b'] },
          }),
          schemaTool('nullable', { type: ['object', 'null'], properties: {} }),
        ],
        'openapi_30',
      );

      expect(declarations).toEqual([
        decl('patterned', { type: 'object' }),
        decl('dependent', { type: 'object' }),
        decl('nullable', { type: 'object', nullable: true }),
      ]);
    });

    it('keeps grammar constraints for schemas with a top-level $id', async () => {
      const properties = () => ({ value: { type: 'string', maxLength: 1999 } });
      const makeSchema = () => ({
        $id: 'https://qwen-code.test/shared-tool-schema',
        type: 'object',
        properties: properties(),
      });

      const declarations = await declarationsOf([
        schemaTool('first', makeSchema()),
        schemaTool('second', makeSchema()),
      ]);

      expect(declarations).toEqual(
        ['first', 'second'].map((name) =>
          decl(name, { type: 'object', properties: properties() }),
        ),
      );
    });

    it.each([
      [
        'should convert Gemini tools with parameters field',
        {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: Type.OBJECT,
            properties: { location: { type: Type.STRING } },
            required: ['location'],
          },
        },
        {
          name: 'get_weather',
          description: 'Get weather for a location',
          parameters: {
            type: 'object',
            properties: { location: { type: 'string' } },
            required: ['location'],
          },
        },
      ],
      [
        // MCP tools carry plain JSON schema (not Gemini types).
        'should convert MCP tools with parametersJsonSchema field',
        {
          name: 'read_file',
          description: 'Read a file from disk',
          parametersJsonSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
        {
          name: 'read_file',
          description: 'Read a file from disk',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    ])('%s', async (_title, declaration, expected) => {
      const result = await convertDeclarations([declaration]);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ type: 'function', function: expected });
    });

    // Regression for #7315: the wire schema must not carry
    // additionalProperties:false on levels with optional properties.
    // OpenAI-compatible gateways promote every property to required, forcing
    // mutually exclusive optional fields (Agent working_dir vs isolation)
    // into every call.
    it('relaxes additionalProperties:false for schemas with optional fields', async () => {
      const params = await paramsOf({
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
      });

      expect(params['additionalProperties']).toBeUndefined();
      expect(params['$schema']).toBeUndefined();
      // Required stays exactly as authored — optional fields remain optional.
      expect(params['required']).toEqual(['description', 'prompt']);
    });

    it('keeps additionalProperties:false when every property is required', async () => {
      const params = await paramsOf({
        name: 'strict_tool',
        description: 'All fields required',
        parametersJsonSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
          additionalProperties: false,
        },
      });

      expect(params['additionalProperties']).toBe(false);
    });

    it('should handle CallableTool by resolving tool function', async () => {
      const callableTools = [
        {
          tool: async () =>
            toolsOf({
              name: 'dynamic_tool',
              description: 'A dynamically resolved tool',
              parameters: { type: Type.OBJECT, properties: {} },
            })[0],
        },
      ] as CallableTool[];

      const result = await converter.convertLlmToolsToOpenAI(callableTools);

      expect(result).toHaveLength(1);
      expect(result[0].function.name).toBe('dynamic_tool');
    });

    it('should preserve functions without description and skip functions without name', async () => {
      const result = await convertDeclarations([
        { name: 'valid_tool', description: 'A valid tool' },
        { name: 'missing_description' },
        { description: 'Missing name' },
      ]);

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
      const result = await convertDeclarations([
        { name: 'no_params_tool', description: 'A tool without parameters' },
      ]);

      expect(result).toHaveLength(1);
      expect(result[0].function.parameters).toBeUndefined();
    });

    it('should not mutate original parametersJsonSchema', async () => {
      const originalSchema = {
        type: 'object',
        properties: { foo: { type: 'string' } },
      };

      const result = await convertDeclarations([
        {
          name: 'test_tool',
          description: 'Test tool',
          parametersJsonSchema: originalSchema,
        },
      ]);

      expect(result[0].function.parameters).not.toBe(originalSchema);
      expect(result[0].function.parameters).toEqual(originalSchema);
    });
  });

  describe('convertLlmToolParametersToOpenAI', () => {
    const convertedProperties = (
      properties: Record<string, unknown>,
      type = 'object',
    ) =>
      converter.convertLlmToolParametersToOpenAI({ type, properties })?.[
        'properties'
      ] as Record<string, unknown> | undefined;

    it('should convert type names to lowercase', () => {
      const result = converter.convertLlmToolParametersToOpenAI({
        type: 'OBJECT',
        properties: {
          count: { type: 'INTEGER' },
          amount: { type: 'NUMBER' },
          name: { type: 'STRING' },
        },
      });

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
      const properties = convertedProperties(
        {
          maximum: {
            type: 'INTEGER',
            description: 'upper bound',
            minimum: '5',
          },
          minItems: { type: 'STRING' },
          normalProp: { type: 'STRING' },
        },
        'OBJECT',
      );

      expect(properties?.['maximum']).toEqual({
        type: 'integer',
        description: 'upper bound',
        minimum: 5,
      });
      expect(properties?.['minItems']).toEqual({ type: 'string' });
      expect(properties?.['normalProp']).toEqual({ type: 'string' });
    });

    it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
      [
        'should convert string numeric constraints to numbers',
        {
          value: {
            type: 'number',
            minimum: '0',
            maximum: '100',
            multipleOf: '0.5',
          },
        },
        {
          value: { type: 'number', minimum: 0, maximum: 100, multipleOf: 0.5 },
        },
      ],
      [
        'should convert string length constraints to integers',
        {
          text: { type: 'string', minLength: '1', maxLength: '100' },
          items: { type: 'array', minItems: '0', maxItems: '10' },
        },
        {
          text: { type: 'string', minLength: 1, maxLength: 100 },
          items: { type: 'array', minItems: 0, maxItems: 10 },
        },
      ],
      [
        'should not truncate non-integer length constraints',
        {
          text: { type: 'string', minLength: '1.5', maxLength: '   ' },
          items: { type: 'array', minItems: '10px', maxItems: '1.5' },
        },
        {
          text: { type: 'string', minLength: '1.5', maxLength: '   ' },
          items: { type: 'array', minItems: '10px', maxItems: '1.5' },
        },
      ],
    ])('%s', (_title, input, expected) => {
      const properties = convertedProperties(input);

      for (const [name, schema] of Object.entries(expected)) {
        expect(properties?.[name]).toEqual(schema);
      }
    });

    it('should handle nested objects', () => {
      const nested = convertedProperties({
        nested: {
          type: 'object',
          properties: { deep: { type: 'INTEGER', minimum: '0' } },
        },
      })?.['nested'] as { properties?: Record<string, unknown> } | undefined;

      expect(nested?.properties?.['deep']).toEqual({
        type: 'integer',
        minimum: 0,
      });
    });

    it('should handle arrays', () => {
      const result = converter.convertLlmToolParametersToOpenAI({
        type: 'array',
        items: { type: 'INTEGER' },
      });

      expect(result).toEqual({ type: 'array', items: { type: 'integer' } });
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
        properties: { count: { type: 'INTEGER' } },
      };
      const originalCopy = JSON.parse(JSON.stringify(original));

      converter.convertLlmToolParametersToOpenAI(original);

      expect(original).toEqual(originalCopy);
    });
  });

  describe('mergeConsecutiveAssistantMessages', () => {
    /** Converts `contents` and expects them merged into a single message. */
    const mergeAll = (...contents: Content[]) => {
      const messages = toMessages(...contents);
      expect(messages).toHaveLength(1);
      return messages[0];
    };

    it('should preserve reasoning_content from every merged assistant turn', () => {
      const merged = mergeAll(
        content('model', thoughtPart('First reasoning.'), {
          text: 'First answer.',
        }),
        content('model', thoughtPart('Second reasoning.'), {
          text: 'Second answer.',
        }),
      );

      expect(merged.role).toBe('assistant');
      expect(merged.content).toBe('First answer.Second answer.');
      // The reasoning of the merged-away turn must not be silently dropped.
      expect((merged as { reasoning_content?: string }).reasoning_content).toBe(
        'First reasoning.Second reasoning.',
      );
    });

    it.each<[string, Content[], string]>([
      [
        'should merge two consecutive assistant messages with string content',
        [modelText('First part'), modelText('Second part')],
        'First partSecond part',
      ],
      [
        'should merge multiple consecutive assistant messages',
        [modelText('Part 1'), modelText('Part 2'), modelText('Part 3')],
        'Part 1Part 2Part 3',
      ],
      [
        'should handle merging when one message has array content and another has string',
        [modelText('Text part'), modelText('Another text')],
        'Text partAnother text',
      ],
      [
        // Empty messages should be filtered out
        'should merge empty content correctly',
        [modelText('First'), content('model'), modelText('Second')],
        'FirstSecond',
      ],
    ])('%s', (_title, contents, text) => {
      const merged = mergeAll(...contents);

      expect(merged.role).toBe('assistant');
      expect(merged.content).toBe(text);
    });

    it('should merge tool_calls from consecutive assistant messages', () => {
      const messages = converter.convertLlmRequestToOpenAI(
        req(
          ...exchange('call_1', 'tool_1', { output: 'result_1' }),
          ...exchange('call_2', 'tool_2', { output: 'result_2' }),
        ),
        requestContext,
        { cleanOrphanToolCalls: false },
      );

      expect(messages).toHaveLength(4);
      expect(messages[0].role).toBe('assistant');
      expect(messages[1].role).toBe('tool');
      expect(messages[2].role).toBe('assistant');
      expect(messages[3].role).toBe('tool');
    });

    it('should not merge assistant messages separated by user messages', () => {
      const messages = toMessages(
        modelText('First assistant'),
        userText('User message'),
        modelText('Second assistant'),
      );

      expect(messages).toHaveLength(3);
      expect(messages[0].role).toBe('assistant');
      expect(messages[1].role).toBe('user');
      expect(messages[2].role).toBe('assistant');
    });
  });
});

describe('MCP tool result end-to-end through OpenAI converter (issue #1520)', () => {
  // End-to-end regression tests for https://github.com/QwenLM/qwen-code/issues/1520.
  // Simulates transformMcpContentToParts → convertToFunctionResponse → OpenAI
  // converter and verifies multi-part MCP results land in the OpenAI tool
  // message, with no content leaking into user messages.
  /**
   * Wraps what transformMcpContentToParts returned via convertToFunctionResponse,
   * converts the call + result history, and checks there is exactly one tool
   * message (array content) and no user message.
   */
  const convertMcpResult = (
    toolName: string,
    callId: string,
    args: Record<string, unknown>,
    mcpTransformedParts: Part[],
  ) => {
    const messages = OpenAIContentConverter.convertLlmRequestToOpenAI(
      req(
        content('model', fnCall(toolName, args, callId)),
        content(
          'user',
          ...convertToFunctionResponse(toolName, callId, mcpTransformedParts),
        ),
      ),
      baseRequestContext(),
    );
    const toolMessages = byRole(messages, 'tool');

    expect(toolMessages).toHaveLength(1);
    expect(byRole(messages, 'user')).toHaveLength(0);
    expect(Array.isArray(toolMessages[0].content)).toBe(true);
    return {
      messages,
      toolMsg: toolMessages[0],
      contentArray: wireParts(toolMessages[0]),
    };
  };

  it('should preserve MCP multi-text content in tool message (not leak to user message)', () => {
    // A Figma tool returning code + instructions as two text blocks.
    const { messages, toolMsg, contentArray } = convertMcpResult(
      'figma_get_code',
      'call_figma_1',
      { nodeId: '38:521' },
      [
        { text: '<div data-node-id="38:521"><h1>Welcome</h1></div>' },
        {
          text: 'SUPER CRITICAL: Convert the React+Tailwind code to match the target stack.',
        },
      ],
    );

    expect(byRole(messages, 'assistant')).toHaveLength(1);
    expect(toolMsg).toMatchObject(toolReply('call_figma_1'));
    const toolTexts = textsOf(contentArray);
    expect(toolTexts).toHaveLength(1);
    expect(toolTexts[0]).toContain('data-node-id');
    expect(toolTexts[0]).toContain('SUPER CRITICAL');
  });

  it('should preserve MCP text+image content in tool message', () => {
    // MCP tool returning a text description + image (e.g. get_screenshot).
    const { contentArray } = convertMcpResult(
      'figma_get_screenshot',
      'call_figma_2',
      { nodeId: '38:521' },
      [
        {
          text: "[Tool 'figma' provided the following image data with mime-type: image/png]",
        },
        inline('image/png', 'iVBORw0KGgo='),
      ],
    );

    expectTextThenPng(contentArray, 'image data');
  });

  it('should work correctly when MCP tool returns a single text part', () => {
    // Single text part — the control case that has always worked
    const { contentArray } = convertMcpResult(
      'mcp_tool',
      'call_mcp_single',
      {},
      [{ text: 'Single text response from MCP tool' }],
    );

    const toolTexts = textsOf(contentArray);
    expect(toolTexts).toHaveLength(1);
    expect(toolTexts[0]).toBe('Single text response from MCP tool');
  });

  it('should preserve MCP multi-text + multi-image content in tool message', () => {
    const { toolMsg, contentArray } = convertMcpResult(
      'mcp__pencil__get_screenshot',
      'call_pencil_1',
      { nodeId: 'vHOGa' },
      [
        { text: 'Here is the design mockup:' },
        {
          text: "[Tool 'pencil' provided the following image data with mime-type: image/png]",
        },
        inline('image/png', 'screenshotBase64Data'),
        { text: 'And here are the node details...' },
      ],
    );

    expect(toolMsg).toMatchObject(toolReply('call_pencil_1'));
    // All text joined into one part, then the image.
    expectTextThenPng(
      contentArray,
      'design mockup',
      'image data',
      'node details',
    );
  });
});

describe('Truncated tool call detection in streaming', () => {
  const converter = OpenAIContentConverter;

  function createStreamingRequestContext(model = 'test-model'): RequestContext {
    return {
      model,
      modalities: {},
      startTime: 0,
      toolCallParser: new StreamingToolCallParser(),
    };
  }

  /** Sends one chunk carrying a single index-0 tool-call delta. */
  const sendToolDelta = (
    ctx: RequestContext,
    toolCall: Record<string, unknown>,
  ) =>
    converter.convertOpenAIChunkToLlm(
      openAIStreamChunk({ tool_calls: [{ index: 0, ...toolCall }] }),
      ctx,
    );

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
    options?: {
      usage?: OpenAI.Chat.ChatCompletionChunk['usage'];
      maxOutputTokens?: number;
      /**
       * Receives the live stream context so a test can inspect state the
       * converter parks on it for the pipeline to settle later.
       */
      captureContext?: (ctx: RequestContext) => void;
    },
  ) {
    // One stream-local context covers every chunk of this simulated stream.
    const ctx = createStreamingRequestContext();
    if (options?.maxOutputTokens !== undefined) {
      ctx.maxOutputTokens = options.maxOutputTokens;
    }
    options?.captureContext?.(ctx);

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
        usage: options?.usage,
      } as unknown as OpenAI.Chat.ChatCompletionChunk,
      ctx,
    );
  }

  const finish = (ctx: RequestContext, finishReason = 'tool_calls') =>
    converter.convertOpenAIChunkToLlm(openAIStreamChunk({}, finishReason), ctx);

  /**
   * Streams one write_file call (call_1) with `args`, then a final chunk with
   * `finishReason`; returns the Gemini response for the final chunk.
   */
  function feedWriteFileCall(args: string, finishReason: string) {
    const ctx = createStreamingRequestContext();
    sendToolDelta(ctx, {
      id: 'call_1',
      function: { name: 'write_file', arguments: args },
    });
    return finish(ctx, finishReason);
  }

  it('emits tool preparation metadata before the complete function call', () => {
    const context = createStreamingRequestContext();
    const opener = sendToolDelta(context, {
      id: 'call-1',
      function: { name: 'read_file', arguments: '' },
    });
    const args = sendToolDelta(context, {
      function: { arguments: '{"file_path":"a.sql"}' },
    });
    const finishResponse = finish(context);

    expect(getToolCallPreparations(opener)).toEqual([
      { callId: 'call-1', toolName: 'read_file' },
    ]);
    expect(getToolCallPreparations(args)).toEqual([]);
    expect(getToolCallPreparations(finishResponse)).toEqual([]);
    expect(opener.functionCalls).toBeUndefined();
    expect(finishResponse.functionCalls).toEqual([
      { id: 'call-1', name: 'read_file', args: { file_path: 'a.sql' } },
    ]);
  });

  it('does not duplicate tool preparation metadata for a replayed opener', () => {
    const context = createStreamingRequestContext();
    const opener = {
      id: 'call-1',
      function: { name: 'read_file', arguments: '' },
    };

    const first = sendToolDelta(context, opener);
    const replay = sendToolDelta(context, opener);

    expect(getToolCallPreparations(first)).toEqual([
      { callId: 'call-1', toolName: 'read_file' },
    ]);
    expect(getToolCallPreparations(replay)).toEqual([]);
  });

  it('emits preparation after split identity deltas using the remapped parser index', () => {
    const context = createStreamingRequestContext();
    const responses = [
      {
        id: 'call-1',
        function: { name: 'read_file', arguments: '{"file_path":"a.sql"}' },
      },
      { id: 'call-2' },
      { function: { name: 'write_file', arguments: '{"file_path":"b.sql"}' } },
      { function: { name: 'delete_file', arguments: '' } },
      { function: { arguments: '{"file_path":"c.sql"}' } },
      { id: 'call-3' },
    ].map((toolCall) => sendToolDelta(context, toolCall));
    const finishResponse = finish(context);

    // [firstCall, secondCallId, secondCallName, thirdCallName,
    //  thirdCallArguments, thirdCallId]
    expectEach(responses.map(getToolCallPreparations), [
      [{ callId: 'call-1', toolName: 'read_file' }],
      [],
      [{ callId: 'call-2', toolName: 'write_file' }],
      [],
      [],
      [{ callId: 'call-3', toolName: 'delete_file' }],
    ]);
    for (const response of responses) {
      expect(response.functionCalls).toBeUndefined();
    }
    expect(finishResponse.functionCalls).toEqual([
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
    const response = sendToolDelta(createStreamingRequestContext(), toolCall);

    expect(getToolCallPreparations(response)).toEqual([]);
  });

  it.each([
    [
      // write_file truncated mid-JSON (no closing brace or content field).
      'should override finishReason to MAX_TOKENS when tool call JSON is truncated and provider reports "stop"',
      '{"file_path": "/tmp/test.cpp"',
      'stop',
      FinishReason.MAX_TOKENS,
    ],
    [
      // Truncated mid-string.
      'should override finishReason to MAX_TOKENS when provider reports "tool_calls" but JSON is truncated',
      '{"file_path": "/tmp/test.cpp", "content": "partial content',
      'tool_calls',
      FinishReason.MAX_TOKENS,
    ],
    [
      'should preserve finishReason STOP when tool call JSON is complete',
      '{"file_path": "/tmp/test.cpp", "content": "hello"}',
      'stop',
      FinishReason.STOP,
    ],
    [
      'should preserve finishReason MAX_TOKENS when provider already reports "length"',
      '{"file_path": "/tmp/test.cpp"',
      'length',
      FinishReason.MAX_TOKENS,
    ],
  ])('%s', (_title, args, finishReason, expected) => {
    const result = feedWriteFileCall(args, finishReason);

    expect(result.candidates?.[0]?.finishReason).toBe(expected);
  });

  it('should still emit the (repaired) function call even when truncated', () => {
    const result = feedWriteFileCall('{"file_path": "/tmp/test.cpp"', 'stop');

    const call = (partsOf(result) ?? []).find((p: Part) => p.functionCall);
    expect(call).toBeDefined();
    expect(call?.functionCall?.name).toBe('write_file');
    expect(call?.functionCall?.args).toEqual({ file_path: '/tmp/test.cpp' });
  });

  it('should detect truncation with multi-chunk streaming arguments', () => {
    // Arguments arrive in several small chunks like real streaming; the final
    // chunk says "stop" while the JSON is still incomplete.
    const ctx = createStreamingRequestContext();
    sendToolDelta(ctx, {
      id: 'call_1',
      type: 'function' as const,
      function: { name: 'write_file', arguments: '{"file_' },
    });
    sendToolDelta(ctx, {
      function: { arguments: 'path": "/tmp/f.txt", "conten' },
    });
    const result = finish(ctx, 'stop');

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should not override finishReason when usage disproves truncation (fused tool-call arguments)', () => {
    // Issue #12970: the provider fused two intended read_file calls into one
    // argument bag and the streamed JSON is missing the final closing brace,
    // so the parser flags the call incomplete. Usage (185 completion tokens
    // against an 8192 output budget) proves the response was NOT cut by
    // max_tokens, so the brace-depth heuristic must not rewrite the
    // provider's finish_reason to "length" — downstream that misdiagnosis
    // appends the truncation guidance to the schema-validation error and
    // sends the model into futile identical retries.
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'read_file',
          arguments:
            '{"file_path": "/tmp/ad01.yml", "limit": {"file_path": "/tmp/node01.yml", "limit": null}',
          // Fused second call's argument bag; missing the final closing brace.
        },
      ],
      'stop',
      {
        usage: {
          prompt_tokens: 252811,
          completion_tokens: 185,
          total_tokens: 252996,
        },
        maxOutputTokens: 8192,
      },
    );

    // The repaired call is still emitted so downstream schema validation can
    // report the real parameter error...
    const parts = result.candidates?.[0]?.content?.parts ?? [];
    const fnCall = parts.find((p: Part) => p.functionCall);
    expect(fnCall?.functionCall?.name).toBe('read_file');
    expect(fnCall?.functionCall?.args).toEqual({
      file_path: '/tmp/ad01.yml',
      limit: { file_path: '/tmp/node01.yml', limit: null },
    });
    // ...but without the truncation misdiagnosis: turn.ts only flags
    // wasOutputTruncated on MAX_TOKENS, so STOP here is what keeps the
    // scheduler from appending the max_tokens note to the validation error.
    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
    // Withdrawing the diagnosis must not withdraw the data-loss guard: the
    // arguments really did arrive unterminated, so the call is still marked
    // and the scheduler still refuses to let a repaired partial file write
    // through (it just words the refusal by the real cause).
    expect(toolCallArgumentsWereIncomplete(fnCall!.functionCall!)).toBe(true);
  });

  it('should still override finishReason to MAX_TOKENS when usage corroborates truncation', () => {
    // Genuine truncation (#4964 must not regress): completion_tokens reached
    // the output budget, so the incomplete JSON really was cut by the limit
    // even though the provider reported "stop".
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
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 8192,
          total_tokens: 8292,
        },
        maxOutputTokens: 8192,
      },
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should keep the legacy override when the output ceiling is unknown', () => {
    // Without a known output budget the usage check is inconclusive; keep
    // inferring truncation from brace depth as before.
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
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 185,
          total_tokens: 285,
        },
      },
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should trust a provider-reported "length" even when usage is below the ceiling', () => {
    // The usage guard only restrains the client-side inference; an explicit
    // finish_reason from the provider is taken at face value.
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
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 185,
          total_tokens: 285,
        },
        maxOutputTokens: 8192,
      },
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should treat zero-filled usage on the finish chunk as inconclusive, not as a disproof', () => {
    // ModelScope zero-fills usage on the finish chunk and sends the real
    // totals on a trailing `choices: []` chunk (see pipeline.test.ts "should
    // handle providers that send zero usage in finish chunk (like
    // modelscope)"). Reading completion_tokens: 0 as proof against truncation
    // would suppress the #4964 override and, with it, the scheduler's
    // reject-file-writes-while-truncated guard — on a response whose tool-call
    // JSON really was cut. Zero means "not counted", not "nothing generated":
    // this branch is only reached when the parser found incomplete JSON.
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
      {
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        maxOutputTokens: 8192,
      },
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should treat an explicit null completion_tokens as inconclusive, not as a disproof', () => {
    // `null >= 8192 * 0.5` coerces null to 0 and reads as a disproof, which is
    // the same failure mode as the zero-filled case above. Some OpenAI-compatible
    // gateways type this field as `number | null` (see omni usage-log.ts).
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
      {
        usage: {
          prompt_tokens: 0,
          completion_tokens: null,
          total_tokens: 0,
        } as unknown as OpenAI.Chat.ChatCompletionChunk['usage'],
        maxOutputTokens: 8192,
      },
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should attribute consumption exactly at the 50% threshold to truncation', () => {
    // Boundary pin for TRUNCATION_COMPLETION_TOKEN_RATIO_THRESHOLD: the
    // comparison is `>=`, so exactly half the budget is still consistent with
    // a real cut. Goes red if the ratio is raised (0.95) or `>=` becomes `>`.
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
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 4096,
          total_tokens: 4196,
        },
        maxOutputTokens: 8192,
      },
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
  });

  it('should clear truncation for consumption just under the 50% threshold', () => {
    // Other side of the same boundary: one token below half the budget is
    // decisively not a token-limit cut. Goes red if the ratio is lowered
    // (0.25), which would silently re-admit the #12970 misdiagnosis for
    // responses that ended well below the ceiling.
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'read_file',
          arguments:
            '{"file_path": "/tmp/ad01.yml", "limit": {"file_path": "/tmp/node01.yml", "limit": null}',
        },
      ],
      'stop',
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 4095,
          total_tokens: 4195,
        },
        maxOutputTokens: 8192,
      },
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.STOP);
  });

  it('should park the override for the pipeline to settle when the finish chunk carries no usage', () => {
    // The shape the pipeline actually produces: it requests
    // stream_options.include_usage, under which the finish_reason chunk
    // reports no usage and the totals arrive on a later `choices: []` chunk
    // that handleChunkMerging folds into the parked finish response. The
    // converter must keep the conservative override *and* hand over the
    // provider's own reason, or the delayed evidence has nothing to undo.
    let ctx: RequestContext | undefined;
    const result = feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'read_file',
          arguments:
            '{"file_path": "/tmp/ad01.yml", "limit": {"file_path": "/tmp/node01.yml", "limit": null}',
        },
      ],
      'stop',
      {
        maxOutputTokens: 8192,
        captureContext: (c) => {
          ctx = c;
        },
      },
    );

    expect(result.candidates?.[0]?.finishReason).toBe(FinishReason.MAX_TOKENS);
    expect(ctx?.pendingTruncationOverride).toEqual({
      finishReason: FinishReason.STOP,
    });
  });

  it('should not park an override that this chunk already decided', () => {
    // Conclusive evidence — in either direction — settles the rewrite here, so
    // nothing may be left for the pipeline to second-guess on a later chunk.
    const corroborating: RequestContext[] = [];
    feedToolCallChunks(
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
      {
        usage: {
          prompt_tokens: 100,
          completion_tokens: 8192,
          total_tokens: 8292,
        },
        maxOutputTokens: 8192,
        captureContext: (c) => corroborating.push(c),
      },
    );
    expect(corroborating[0]?.pendingTruncationOverride).toBeUndefined();

    const disproving: RequestContext[] = [];
    feedToolCallChunks(
      converter,
      [
        {
          index: 0,
          id: 'call_1',
          name: 'read_file',
          arguments:
            '{"file_path": "/tmp/ad01.yml", "limit": {"file_path": "/tmp/node01.yml", "limit": null}',
        },
      ],
      'stop',
      {
        usage: {
          prompt_tokens: 252811,
          completion_tokens: 185,
          total_tokens: 252996,
        },
        maxOutputTokens: 8192,
        captureContext: (c) => disproving.push(c),
      },
    );
    expect(disproving[0]?.pendingTruncationOverride).toBeUndefined();
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
      baseRequestContext(),
    );
    expect(response.choices[0].finish_reason).toBe(expected);
  });
});

describe('modality filtering', () => {
  /** Converts one user turn holding `parts` and returns its content parts. */
  function userContentParts(
    model: string,
    modalities: RequestContext['modalities'],
    ...parts: Part[]
  ): WirePart[] {
    const userMsg = findRole(
      OpenAIContentConverter.convertLlmRequestToOpenAI(
        { model: 'test-model', contents: [content('user', ...parts)] },
        { model, modalities, startTime: 0 },
      ),
      'user',
    );
    return Array.isArray(userMsg?.content) ? wireParts(userMsg) : [];
  }

  it.each<[string, string, RequestContext['modalities'], Part, string[]]>([
    [
      'replaces image with placeholder when image modality is disabled',
      'deepseek-chat',
      {},
      {
        inlineData: { mimeType: 'image/png', data: 'abc123' },
        displayName: 'screenshot.png',
      } as unknown as Part,
      ['image file', 'does not support image input'],
    ],
    [
      'replaces PDF with placeholder when pdf modality is disabled',
      'test-model',
      { image: true },
      inline('application/pdf', 'pdf-data', 'doc.pdf'),
      ['pdf file', 'does not support PDF input'],
    ],
    [
      'replaces video with placeholder when video modality is disabled',
      'test-model',
      {},
      inline('video/mp4', 'vid-data'),
      ['video file'],
    ],
    [
      'replaces audio with placeholder when audio modality is disabled',
      'test-model',
      {},
      inline('audio/wav', 'audio-data'),
      ['audio file'],
    ],
    [
      'defaults to text-only when no modalities are specified',
      'unknown-model',
      {},
      inline('image/png', 'img-data'),
      ['image file'],
    ],
  ])('%s', (_title, model, modalities, part, fragments) => {
    const parts = userContentParts(model, modalities, part);

    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('text');
    for (const fragment of fragments) {
      expect(parts[0].text).toContain(fragment);
    }
  });

  it('keeps BMP image data when image modality is enabled', () => {
    const parts = userContentParts(
      'gpt-4o',
      { image: true },
      inline('image/bmp', 'abc123'),
    );

    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('image_url');
    expect(parts[0].image_url?.url).toBe('data:image/bmp;base64,abc123');
  });

  it('keeps PDF when pdf modality is enabled', () => {
    const parts = userContentParts(
      'claude-sonnet',
      { image: true, pdf: true },
      inline('application/pdf', 'pdf-data', 'doc.pdf'),
    );

    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe('file');
  });

  it('handles mixed content: keeps text + supported media, replaces unsupported', () => {
    const parts = userContentParts(
      'gpt-4o',
      { image: true },
      { text: 'Analyze these files' },
      inline('image/png', 'img-data'),
      inline('video/mp4', 'vid-data'),
    );

    expect(parts).toHaveLength(3);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toBe('Analyze these files');
    expect(parts[1].type).toBe('image_url');
    expect(parts[2].type).toBe('text');
    expect(parts[2].text).toContain('video file');
  });
});

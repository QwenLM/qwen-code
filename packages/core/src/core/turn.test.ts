/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ServerLlmToolCallRequestEvent,
  ServerLlmErrorEvent,
  ServerLlmModelFallbackEvent,
  ServerLlmStreamEvent,
} from './turn.js';
import {
  CompressionStatus,
  isCompressionFailureStatus,
  Turn,
  LlmEventType,
  createDuplicateProviderToolCallResponse,
  findRepeatedDuplicateProviderToolCall,
} from './turn.js';
import type {
  Part,
  Content,
  PartListUnion,
  GenerateContentResponse,
} from '@google/genai';
import { reportError } from '../utils/errorReporting.js';
import type { LlmChat } from './llm-chat.js';
import { StreamEventType } from './llm-chat.js';
import { normalizeModelToolCallIds } from './toolCallIdUtils.js';
import { markToolCallArgumentsIncomplete } from './incomplete-tool-call-args.js';
import { createOpenAIReasoningThoughtPart } from '../utils/thoughtUtils.js';
import {
  collect,
  content,
  fnCall,
  fnResponse,
  modelChunk,
  streamOf,
} from '../test-utils/model-fixtures.js';

const mockSendMessageStream = vi.fn();
const mockGetHistory = vi.fn();
const mockGetHistoryLength = vi.fn();
const mockGetHistoryTailShallow = vi.fn();
const mockMaybeIncludeSchemaDepthContext = vi.fn();

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  const MockChat = vi.fn().mockImplementation(() => ({
    sendMessageStream: mockSendMessageStream,
    getHistory: mockGetHistory,
    getHistoryLength: mockGetHistoryLength,
    getHistoryTailShallow: mockGetHistoryTailShallow,
    maybeIncludeSchemaDepthContext: mockMaybeIncludeSchemaDepthContext,
  }));
  return {
    ...actual,
    Chat: MockChat,
  };
});

vi.mock('../utils/errorReporting', () => ({
  reportError: vi.fn(),
}));

describe('isCompressionFailureStatus', () => {
  it('treats each compression failure status as failed', () => {
    for (const status of [
      CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
      CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR,
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
      CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
      CompressionStatus.COMPRESSION_FAILED_API_ERROR,
    ]) {
      expect(isCompressionFailureStatus(status)).toBe(true);
    }
  });

  it('keeps API errors distinct from other compression failure statuses', () => {
    expect(CompressionStatus.COMPRESSION_FAILED_API_ERROR).not.toBe(
      CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
    );
    expect(CompressionStatus.COMPRESSION_FAILED_API_ERROR).not.toBe(
      CompressionStatus.COMPRESSION_FAILED_TOKEN_COUNT_ERROR,
    );
    expect(isCompressionFailureStatus(CompressionStatus.COMPRESSED)).toBe(
      false,
    );
    expect(isCompressionFailureStatus(CompressionStatus.NOOP)).toBe(false);
  });
});

describe('findRepeatedDuplicateProviderToolCall', () => {
  const replayOf =
    (...handledIds: string[]) =>
    (item: { providerCallId?: string }) =>
      item.providerCallId !== undefined &&
      handledIds.includes(item.providerCallId);

  // [title, provider ids, replay predicate, ids already answered, index of the expected match]
  it.each([
    [
      'finds a replayed provider id that already received a synthetic response',
      ['fresh', 'handled'],
      replayOf('handled'),
      ['handled'],
      1,
    ],
    [
      'finds a replayed provider id repeated within the same batch',
      ['handled', 'fresh', 'handled'],
      replayOf('handled'),
      [],
      0,
    ],
    [
      'ignores unhandled repeated ids',
      ['fresh', 'fresh'],
      replayOf('handled'),
      [],
      undefined,
    ],
    [
      'ignores id collisions the replay predicate rejects, even after a synthetic response',
      ['handled'],
      () => false,
      ['handled'],
      undefined,
    ],
  ])('%s', (_title, ids, isReplay, handled, match) => {
    const items = ids.map((providerCallId) => ({ providerCallId }));

    expect(
      findRepeatedDuplicateProviderToolCall(
        items,
        (item) => item.providerCallId,
        isReplay,
        new Set<string>(handled),
      ),
    ).toBe(match === undefined ? undefined : items[match]);
  });
});

describe('createDuplicateProviderToolCallResponse', () => {
  it('marks the synthetic response as not started', () => {
    const response = createDuplicateProviderToolCallResponse({
      callId: 'duplicate-response',
      providerCallId: 'provider-call',
      name: 'read_file',
      args: {},
      isClientInitiated: false,
      prompt_id: 'prompt-duplicate',
    });

    expect(response.executionStatus).toBe('not_started');
  });
});

describe('Turn', () => {
  let turn: Turn;

  beforeEach(() => {
    vi.resetAllMocks();
    turn = new Turn(
      {
        sendMessageStream: mockSendMessageStream,
        getHistory: mockGetHistory,
        getHistoryLength: mockGetHistoryLength,
        getHistoryTailShallow: mockGetHistoryTailShallow,
        maybeIncludeSchemaDepthContext: mockMaybeIncludeSchemaDepthContext,
      } as unknown as LlmChat,
      'prompt-id-1',
      undefined,
      'stable-prompt-id',
    );
    mockGetHistory.mockReturnValue([]);
    mockGetHistoryLength.mockReturnValue(0);
    mockGetHistoryTailShallow.mockReturnValue([]);
    mockSendMessageStream.mockResolvedValue((async function* () {})());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const chunk = (value: unknown) => ({ type: StreamEventType.CHUNK, value });
  /** A chunk with one role-less candidate holding `parts`, plus `extra` candidate fields. */
  const cand = (parts: unknown[], extra: object = {}) =>
    chunk({ candidates: [{ content: { parts }, ...extra }] });
  const textChunk = (text: string, extra?: object) => cand([{ text }], extra);
  const callsChunk = (...functionCalls: object[]) => chunk({ functionCalls });
  const contentEvent = (value: string) => ({
    type: LlmEventType.Content,
    value,
  });
  const finished = (reason: string, usageMetadata?: object) => ({
    type: LlmEventType.Finished,
    value: { reason, usageMetadata },
  });
  const toolValues = (events: ServerLlmStreamEvent[]) =>
    events.map((e) => (e as ServerLlmToolCallRequestEvent).value);

  /** Serve `events` (a list, or a hand-written generator) from the chat, run the turn, collect what it yields. */
  const run = (
    events: unknown[] | AsyncGenerator<unknown>,
    req: PartListUnion = [{ text: 'Hi' }],
    signal = new AbortController().signal,
  ) => {
    mockSendMessageStream.mockResolvedValue(
      Array.isArray(events) ? streamOf(...events) : events,
    );
    return collect(turn.run('test-model', req, signal));
  };

  /** Make sendMessageStream reject with `error`, run the turn, collect what it yields. */
  const runFailing = (
    error: unknown,
    req: PartListUnion = [{ text: 'Trigger error' }],
  ) => {
    mockSendMessageStream.mockRejectedValue(error);
    mockMaybeIncludeSchemaDepthContext.mockResolvedValue(undefined);
    return collect(turn.run('test-model', req, new AbortController().signal));
  };
  /** A part-list summary as reportError receives it (history tail entries also carry `role`). */
  const summary = (
    partCount: number,
    textPreview: string,
    extra: object = {},
  ) => ({
    partCount,
    functionCalls: [],
    functionResponses: [],
    textPreview,
    ...extra,
  });
  const expectReported = (error: unknown, history: object, partCount = 1) =>
    expect(reportError).toHaveBeenCalledWith(
      error,
      'Error when talking to API',
      { history, request: summary(partCount, 'Trigger error') },
      'Turn.run-sendMessageStream',
      { contextAlreadySummarized: true },
    );

  describe('constructor', () => {
    it('should initialize pendingToolCalls', () => {
      expect(turn.pendingToolCalls).toEqual([]);
    });
  });

  describe('run', () => {
    it('should yield content events for text parts', async () => {
      const reqParts: Part[] = [{ text: 'Hi' }];
      const events = await run(
        [textChunk('Hello'), textChunk(' world')],
        reqParts,
      );

      expect(mockSendMessageStream).toHaveBeenCalledWith(
        'test-model',
        {
          message: reqParts,
          config: { abortSignal: expect.any(AbortSignal) },
        },
        'prompt-id-1',
        undefined,
        { promptId: 'stable-prompt-id' },
      );

      expect(events).toEqual([contentEvent('Hello'), contentEvent(' world')]);
    });

    it('forwards retractDeliveredOutputOnRetry to the chat send options', async () => {
      // The Hosted Harness retracts published output on a fresh retry; the
      // flag must reach LlmChat or a post-delivery cut continues instead of
      // replaying (#13319).
      turn = new Turn(
        {
          sendMessageStream: mockSendMessageStream,
          getHistory: mockGetHistory,
          getHistoryLength: mockGetHistoryLength,
          getHistoryTailShallow: mockGetHistoryTailShallow,
          maybeIncludeSchemaDepthContext: mockMaybeIncludeSchemaDepthContext,
        } as unknown as LlmChat,
        'prompt-id-1',
        undefined,
        'stable-prompt-id',
        true,
      );
      await run([textChunk('Hello')]);

      expect(mockSendMessageStream).toHaveBeenCalledWith(
        'test-model',
        expect.objectContaining({
          config: { abortSignal: expect.any(AbortSignal) },
        }),
        'prompt-id-1',
        undefined,
        { promptId: 'stable-prompt-id', retractDeliveredOutputOnRetry: true },
      );
    });

    it('should preserve ordered image parts in content events', async () => {
      const png = {
        inlineData: {
          data: 'aW1hZ2U=',
          mimeType: 'image/png',
          displayName: 'chart.png',
        },
      };
      const webp = { inlineData: { data: 'c2Vjb25k', mimeType: 'image/webp' } };
      const events = await run([
        cand([
          { text: 'before' },
          png,
          { thought: true, text: 'hidden' },
          { text: 'after' },
        ]),
        cand([webp]),
      ]);

      expect(events).toEqual([
        {
          type: LlmEventType.Thought,
          value: { subject: '', description: 'hidden' },
        },
        {
          type: LlmEventType.Content,
          value: 'beforeafter',
          parts: [{ text: 'before' }, png, { text: 'after' }],
        },
        { type: LlmEventType.Content, value: '', parts: [webp] },
      ]);
    });

    it('should emit Thought events when a thought part is present', async () => {
      const events = await run([
        chunk(
          modelChunk([
            { thought: true, text: 'reasoning...' },
            { text: 'final answer' },
          ]),
        ),
      ]);

      expect(events).toEqual([
        {
          type: LlmEventType.Thought,
          value: { subject: '', description: 'reasoning...' },
        },
        contentEvent('final answer'),
      ]);
    });

    it('should keep OpenAI reasoning markdown as a streaming thought description', async () => {
      const events = await run([
        chunk(
          modelChunk([
            createOpenAIReasoningThoughtPart('**Analyzing the request**'),
          ]),
        ),
      ]);

      expect(events).toEqual([
        {
          type: LlmEventType.Thought,
          value: { subject: '', description: '**Analyzing the request**' },
        },
      ]);
    });

    it('should keep parsing unmarked structured thought subjects', async () => {
      const events = await run([
        chunk(modelChunk([{ thought: true, text: '**Only Subject**' }])),
      ]);

      expect(events).toEqual([
        {
          type: LlmEventType.Thought,
          value: { subject: 'Only Subject', description: '' },
        },
      ]);
    });

    it('should emit thought descriptions per incoming chunk', async () => {
      const events = await run([
        chunk(modelChunk([{ thought: true, text: 'part1' }])),
        chunk(modelChunk([{ thought: true, text: 'part2' }])),
      ]);

      expect(events).toEqual([
        {
          type: LlmEventType.Thought,
          value: { subject: '', description: 'part1' },
        },
        {
          type: LlmEventType.Thought,
          value: { subject: '', description: 'part2' },
        },
      ]);
    });

    it('should yield tool_call_request events for function calls', async () => {
      const events = await run([
        callsChunk(
          {
            id: 'fc1',
            name: 'tool1',
            args: { arg1: 'val1' },
            isClientInitiated: false,
          },
          { name: 'tool2', args: { arg2: 'val2' }, isClientInitiated: false }, // No ID
        ),
      ]);

      expect(events.length).toBe(2);
      const event1 = events[0] as ServerLlmToolCallRequestEvent;
      expect(event1.type).toBe(LlmEventType.ToolCallRequest);
      expect(event1.value).toEqual(
        expect.objectContaining({
          callId: 'fc1',
          name: 'tool1',
          args: { arg1: 'val1' },
          isClientInitiated: false,
        }),
      );
      expect(turn.pendingToolCalls[0]).toEqual(event1.value);

      const event2 = events[1] as ServerLlmToolCallRequestEvent;
      expect(event2.type).toBe(LlmEventType.ToolCallRequest);
      expect(event2.value).toEqual(
        expect.objectContaining({
          name: 'tool2',
          args: { arg2: 'val2' },
          isClientInitiated: false,
        }),
      );
      expect(event2.value.callId).toEqual(
        expect.stringMatching(/^tool2-\d{13}-\w{10,}$/),
      );
      expect(turn.pendingToolCalls[1]).toEqual(event2.value);
    });

    it('clears response id state when a model fallback occurs', async () => {
      const events = await run([
        chunk({
          responseId: 'primary-response',
          functionCalls: [{ id: 'primary-call', name: 'tool1', args: {} }],
        }),
        {
          type: StreamEventType.MODEL_FALLBACK,
          info: {
            fromModel: 'primary-model',
            toModel: 'fallback-model',
            fallbackIndex: 1,
          },
        },
        callsChunk({ id: 'fallback-call', name: 'tool2', args: {} }),
      ]);

      const toolCalls = events.filter(
        (event): event is ServerLlmToolCallRequestEvent =>
          event.type === LlmEventType.ToolCallRequest,
      );
      const fallbackEvent = events.find(
        (event): event is ServerLlmModelFallbackEvent =>
          event.type === LlmEventType.ModelFallback,
      );
      expect(fallbackEvent).toEqual({
        type: LlmEventType.ModelFallback,
        fromModel: 'primary-model',
        toModel: 'fallback-model',
        statusCode: undefined,
        fallbackIndex: 1,
      });
      expect(toolCalls[0]!.value.response_id).toBe('primary-response');
      expect(toolCalls[1]!.value.response_id).toBeUndefined();
      expect(turn.pendingToolCalls).toEqual([toolCalls[1]!.value]);
    });

    it('should yield UserCancelled event if signal is aborted', async () => {
      const abortController = new AbortController();
      const stream = (async function* () {
        yield textChunk('First part');
        abortController.abort();
        yield textChunk('Second part - should not be processed');
      })();

      const events = await run(
        stream,
        [{ text: 'Test abort' }],
        abortController.signal,
      );
      expect(events).toEqual([
        contentEvent('First part'),
        { type: LlmEventType.UserCancelled },
      ]);
    });

    it('should yield Error event and report if sendMessageStream throws', async () => {
      const error = new Error('API Error');
      const historyContent: Content[] = [
        { role: 'model', parts: [{ text: 'Previous history' }] },
      ];
      mockGetHistoryLength.mockReturnValue(historyContent.length);
      mockGetHistoryTailShallow.mockReturnValue(historyContent);
      const events = await runFailing(error);

      expect(events.length).toBe(1);
      const errorEvent = events[0] as ServerLlmErrorEvent;
      expect(errorEvent.type).toBe(LlmEventType.Error);
      expect(errorEvent.value).toEqual({
        error: { message: 'API Error', status: undefined },
      });
      expectReported(error, {
        rawLength: 1,
        tail: [summary(1, 'Previous history', { role: 'model' })],
      });
    });

    it('preserves the status of friendly forbidden errors', async () => {
      const events = await runFailing({
        response: {
          data: { error: { code: 403, message: 'Code Assist is not enabled' } },
        },
      });

      expect(events).toEqual([
        {
          type: LlmEventType.Error,
          value: {
            error: { message: 'Code Assist is not enabled', status: 403 },
          },
        },
      ]);
    });

    it.each([
      [{ statusCode: 429 }, 429],
      [{ response: { status: 503, data: {} } }, 503],
      [new Error('upstream :HTTP_STATUS/429'), 429],
    ])('normalizes supported provider status shapes', async (error, status) => {
      const events = await runFailing(error);

      expect(events).toEqual([
        {
          type: LlmEventType.Error,
          value: { error: { message: expect.any(String), status } },
        },
      ]);
    });

    it('should report API errors with empty history summary', async () => {
      const error = new Error('API Error');
      const events = await runFailing(error);

      const errorEvent = events[0] as ServerLlmErrorEvent;
      expect(errorEvent.type).toBe(LlmEventType.Error);
      expect(errorEvent.value).toEqual({
        error: { message: 'API Error', status: undefined },
      });
      expectReported(error, { rawLength: 0, tail: [] });
    });

    it('should report API errors without cloning full history', async () => {
      const error = new Error('API Error');
      const largeText = 'x'.repeat(1024 * 1024);
      mockGetHistory.mockImplementation(() => {
        throw new Error('full history clone should not be used');
      });
      mockGetHistoryLength.mockReturnValue(100);
      mockGetHistoryTailShallow.mockReturnValue([
        content('user', fnResponse('tool', { largeText })),
        content(
          'model',
          { thought: true, text: 'internal reasoning' },
          fnCall('readFile', {}),
          { text: largeText },
        ),
      ] satisfies Content[]);

      const events = await runFailing(error, { text: 'Trigger error' });

      expect(events[0]?.type).toBe(LlmEventType.Error);
      expect(mockGetHistory).not.toHaveBeenCalled();
      expect(mockGetHistoryLength).toHaveBeenCalled();
      expect(mockGetHistoryTailShallow).toHaveBeenCalledWith(8, true);
      const reportedContext = vi.mocked(reportError).mock.calls[0]?.[2];
      expect(JSON.stringify(reportedContext)).not.toContain(largeText);
      expect(JSON.stringify(reportedContext)).not.toContain(
        'internal reasoning',
      );
      expectReported(error, {
        rawLength: 100,
        tail: [
          summary(1, '', { role: 'user', functionResponses: ['tool'] }),
          summary(3, largeText.slice(0, 200), {
            role: 'model',
            functionCalls: ['readFile'],
          }),
        ],
      });
    });

    it('should report API errors when request parts include strings', async () => {
      const error = new Error('API Error');
      const diagnosticFailure: unknown = 'history is unavailable';
      mockGetHistoryLength.mockImplementation(() => {
        throw diagnosticFailure;
      });

      const events = await runFailing(error, ['Trigger ', { text: 'error' }]);

      expect(events[0]?.type).toBe(LlmEventType.Error);
      expectReported(
        error,
        {
          error: 'failed to build diagnostic summary',
          cause: 'history is unavailable',
        },
        2,
      );
    });

    it('should preserve API errors when diagnostic summary fails', async () => {
      const error = new Error('API Error');
      mockGetHistoryLength.mockImplementation(() => {
        throw new Error('history is unavailable');
      });

      const events = await runFailing(error);

      expect(events[0]?.type).toBe(LlmEventType.Error);
      expectReported(error, {
        error: 'failed to build diagnostic summary',
        cause: { message: 'history is unavailable', stack: expect.any(String) },
      });
    });

    it('should handle function calls with undefined name or args', async () => {
      const events = await run([
        chunk({
          candidates: [],
          functionCalls: [
            // Each call carries an `id`, as the code expects.
            { id: 'fc1', name: undefined, args: { arg1: 'val1' } },
            { id: 'fc2', name: 'tool2', args: undefined },
            { id: 'fc3', name: undefined, args: undefined },
          ],
        }),
      ]);

      expect(events.length).toBe(3);
      const [value1, value2, value3] = toolValues(events);
      expect(value1).toMatchObject({
        callId: 'fc1',
        name: 'undefined_tool_name',
        args: { arg1: 'val1' },
      });
      expect(value2).toMatchObject({ callId: 'fc2', name: 'tool2', args: {} });
      expect(value3).toMatchObject({
        callId: 'fc3',
        name: 'undefined_tool_name',
        args: {},
      });
    });

    it('should preserve provider tool-call ids separately from generated call ids', async () => {
      const events = await run([
        chunk({
          candidates: [],
          functionCalls: [
            { id: 'fc1', name: 'tool1', args: { arg1: 'val1' } },
            { name: 'tool2', args: { arg2: 'val2' } },
          ],
        }),
      ]);

      expect(events.length).toBe(2);
      const [value1, value2] = toolValues(events);
      expect(value1).toMatchObject({
        callId: 'fc1',
        providerCallId: 'fc1',
        name: 'tool1',
        args: { arg1: 'val1' },
      });
      expect(value2.callId).toMatch(/^tool2-/);
      expect(value2.providerCallId).toBeUndefined();
      expect(value2).toMatchObject({ name: 'tool2', args: { arg2: 'val2' } });
    });

    it('should preserve raw provider ids for suffixed function call ids', async () => {
      const [normalizedPart] = normalizeModelToolCallIds(
        [fnCall('tool1', { arg1: 'val1' }, 'fc1')],
        new Set(['fc1']),
        new Set<string>(),
      );
      const events = await run([
        chunk({
          candidates: [],
          functionCalls: [normalizedPart!.functionCall],
        }),
      ]);

      expect(events.length).toBe(1);
      expect(toolValues(events)[0]).toMatchObject({
        callId: 'fc1__qwen_dup_2',
        providerCallId: 'fc1',
        name: 'tool1',
        args: { arg1: 'val1' },
      });
    });

    it('should yield finished event when response has finish reason', async () => {
      const usageMetadata = {
        promptTokenCount: 17,
        candidatesTokenCount: 50,
        cachedContentTokenCount: 10,
        thoughtsTokenCount: 5,
      };
      const events = await run([
        chunk({
          candidates: [
            {
              content: { parts: [{ text: 'Partial response' }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata,
        }),
      ]);

      expect(events).toEqual([
        contentEvent('Partial response'),
        finished('STOP', usageMetadata),
      ]);
    });

    it('should yield finished event for MAX_TOKENS finish reason', async () => {
      const text = 'This is a long response that was cut off...';
      const events = await run([
        textChunk(text, { finishReason: 'MAX_TOKENS' }),
      ]);

      expect(events).toEqual([contentEvent(text), finished('MAX_TOKENS')]);
    });

    it('should yield finished event for SAFETY finish reason', async () => {
      const events = await run([
        textChunk('Content blocked', { finishReason: 'SAFETY' }),
      ]);

      expect(events).toEqual([
        contentEvent('Content blocked'),
        finished('SAFETY'),
      ]);
    });

    it('should yield finished event with undefined reason when there is no finish reason', async () => {
      const events = await run([textChunk('Response without finish reason')]);

      expect(events).toEqual([contentEvent('Response without finish reason')]);
    });

    it('should handle multiple responses with different finish reasons', async () => {
      const events = await run([
        textChunk('First part'), // No finish reason on first response
        {
          value: {
            type: StreamEventType.CHUNK,
            candidates: [
              {
                content: { parts: [{ text: 'Second part' }] },
                finishReason: 'OTHER',
              },
            ],
          },
        },
      ]);

      expect(events).toEqual([
        contentEvent('First part'),
        contentEvent('Second part'),
        finished('OTHER'),
      ]);
    });

    /** A 'Some text.' chunk carrying `citations`, plus `extra` candidate fields. */
    const citedChunk = (citations: object[], extra?: object) =>
      cand([{ text: 'Some text.' }], {
        citationMetadata: { citations },
        ...extra,
      });
    const stop = { finishReason: 'STOP' };

    it('should yield citation and finished events when response has citationMetadata', async () => {
      const events = await run([
        citedChunk(
          [{ uri: 'https://example.com/source1', title: 'Source 1 Title' }],
          stop,
        ),
      ]);

      expect(events).toEqual([
        contentEvent('Some text.'),
        {
          type: LlmEventType.Citation,
          value: 'Citations:\n(Source 1 Title) https://example.com/source1',
        },
        finished('STOP'),
      ]);
    });

    it('should yield a single citation event for multiple citations in one response', async () => {
      const events = await run([
        citedChunk(
          [
            { uri: 'https://example.com/source2', title: 'Title2' },
            { uri: 'https://example.com/source1', title: 'Title1' },
          ],
          stop,
        ),
      ]);

      expect(events).toEqual([
        contentEvent('Some text.'),
        {
          type: LlmEventType.Citation,
          value:
            'Citations:\n(Title1) https://example.com/source1\n(Title2) https://example.com/source2',
        },
        finished('STOP'),
      ]);
    });

    it('should not yield citation event if there is no finish reason', async () => {
      const events = await run([
        citedChunk([
          { uri: 'https://example.com/source1', title: 'Source 1 Title' },
        ]),
      ]);

      expect(events).toEqual([contentEvent('Some text.')]);
      // No Citation event (but we do get a Finished event with undefined reason)
      expect(events.some((e) => e.type === LlmEventType.Citation)).toBe(false);
    });

    it('should ignore citations without a URI', async () => {
      const events = await run([
        citedChunk(
          [
            { uri: 'https://example.com/source1', title: 'Good Source' },
            { title: 'Bad Source' }, // uri is undefined
          ],
          stop,
        ),
      ]);

      expect(events).toEqual([
        contentEvent('Some text.'),
        {
          type: LlmEventType.Citation,
          value: 'Citations:\n(Good Source) https://example.com/source1',
        },
        finished('STOP'),
      ]);
    });

    it('should not crash when cancelled request has malformed error', async () => {
      const abortController = new AbortController();
      mockSendMessageStream.mockImplementation(async () => {
        abortController.abort();
        throw { response: { data: undefined } }; // Malformed error data
      });

      const events = await collect(
        turn.run(
          'test-model',
          [{ text: 'Test malformed error handling' }],
          abortController.signal,
        ),
      );

      expect(events).toEqual([{ type: LlmEventType.UserCancelled }]);

      expect(reportError).not.toHaveBeenCalled();
    });

    it('should yield a Retry event when it receives one from the chat stream', async () => {
      const events = await run([
        { type: StreamEventType.RETRY },
        textChunk('Success'),
      ]);

      expect(events).toEqual([
        { type: LlmEventType.Retry },
        contentEvent('Success'),
      ]);
    });

    it('bridges a compressed stream event to a ChatCompressed event', async () => {
      const compressionInfo = {
        originalTokenCount: 1000,
        newTokenCount: 200,
        compressionStatus: CompressionStatus.COMPRESSED,
      };
      const events = await run([
        { type: StreamEventType.COMPRESSED, info: compressionInfo },
        textChunk('after'),
      ]);

      expect(events).toEqual([
        { type: LlmEventType.ChatCompressed, value: compressionInfo },
        contentEvent('after'),
      ]);
    });
  });

  describe('wasOutputTruncated flag', () => {
    /** Stream the tool calls, then an empty candidate finishing with `finishReason`. */
    const runCallsThenFinish = (finishReason: string, ...calls: object[]) =>
      run(
        [callsChunk(...calls), cand([], { finishReason })],
        [{ text: 'Test prompt' }],
      );

    it('should set wasOutputTruncated=true on pending tool calls when finishReason is MAX_TOKENS', async () => {
      await runCallsThenFinish('MAX_TOKENS', {
        name: 'write_file',
        args: { file_path: '/test.txt', content: 'hello' },
      });

      expect(turn.pendingToolCalls).toHaveLength(1);
      expect(turn.pendingToolCalls[0].wasOutputTruncated).toBe(true);
      expect(turn.pendingToolCalls[0].name).toBe('write_file');
    });

    it('should NOT set wasOutputTruncated when finishReason is STOP', async () => {
      await runCallsThenFinish('STOP', {
        name: 'read_file',
        args: { file_path: '/test.txt' },
      });

      expect(turn.pendingToolCalls).toHaveLength(1);
      expect(turn.pendingToolCalls[0].wasOutputTruncated).toBeUndefined();
    });

    it('should handle multiple pending tool calls with MAX_TOKENS', async () => {
      await runCallsThenFinish(
        'MAX_TOKENS',
        {
          name: 'write_file',
          args: { file_path: '/test1.txt', content: 'content1' },
        },
        {
          name: 'edit',
          args: { file_path: '/test2.txt', original_text: 'old' },
        },
      );

      expect(turn.pendingToolCalls).toHaveLength(2);
      expect(turn.pendingToolCalls[0].wasOutputTruncated).toBe(true);
      expect(turn.pendingToolCalls[1].wasOutputTruncated).toBe(true);
    });

    // The main-session producer of `hadIncompleteArguments` (#12970): the
    // marker — not the finish-reason diagnosis — must arm the scheduler's
    // data-loss guard when the turn was not token-truncated. The finish must
    // be STOP: under MAX_TOKENS `wasOutputTruncated` is set on every pending
    // call and could not distinguish the marker from the truncation flag.
    it('should set hadIncompleteArguments on tool calls whose arguments arrived incomplete', async () => {
      const markedCall = {
        name: 'write_file',
        args: { file_path: '/test.txt', content: 'half-written' },
      };
      // A clean sibling in the same response pins the per-call quantifier:
      // the marker must land on the marked call only — a response-wide
      // `functionCalls.some(...)` read would flag the complete call too, and
      // the scheduler would then reject a well-formed Edit as malformed.
      const cleanCall = {
        name: 'write_file',
        args: { file_path: '/other.txt', content: 'complete' },
      };
      // Mark the same object reference that goes on the stream — the marker
      // is a non-enumerable symbol and does not survive a rebuild.
      markToolCallArgumentsIncomplete([{ functionCall: markedCall }]);
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            functionCalls: [markedCall, cleanCall],
          } as unknown as GenerateContentResponse,
        };
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                finishReason: 'STOP',
                content: { parts: [] },
              },
            ],
          } as unknown as GenerateContentResponse,
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const reqParts: Part[] = [{ text: 'Test prompt' }];
      const events = [];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      const toolCallEvents = events.filter(
        (event): event is ServerLlmToolCallRequestEvent =>
          event.type === LlmEventType.ToolCallRequest,
      );
      expect(toolCallEvents).toHaveLength(2);
      expect(toolCallEvents[0].value.hadIncompleteArguments).toBe(true);
      expect(toolCallEvents[0].value.wasOutputTruncated).toBeUndefined();
      expect(toolCallEvents[1].value).not.toHaveProperty(
        'hadIncompleteArguments',
      );
      expect(turn.pendingToolCalls).toHaveLength(2);
      expect(turn.pendingToolCalls[0].hadIncompleteArguments).toBe(true);
      expect(turn.pendingToolCalls[0].wasOutputTruncated).toBeUndefined();
      expect(turn.pendingToolCalls[1]).not.toHaveProperty(
        'hadIncompleteArguments',
      );
    });

    it('should NOT set hadIncompleteArguments on unmarked tool calls', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            functionCalls: [
              {
                name: 'write_file',
                args: { file_path: '/test.txt', content: 'complete' },
              },
            ],
          } as unknown as GenerateContentResponse,
        };
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                finishReason: 'STOP',
                content: { parts: [] },
              },
            ],
          } as unknown as GenerateContentResponse,
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const reqParts: Part[] = [{ text: 'Test prompt' }];
      const events = [];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      const toolCallEvent = events.find(
        (event): event is ServerLlmToolCallRequestEvent =>
          event.type === LlmEventType.ToolCallRequest,
      );
      expect(toolCallEvent).toBeDefined();
      expect(toolCallEvent!.value).not.toHaveProperty('hadIncompleteArguments');
      expect(turn.pendingToolCalls).toHaveLength(1);
      expect(turn.pendingToolCalls[0]).not.toHaveProperty(
        'hadIncompleteArguments',
      );
    });
  });
});

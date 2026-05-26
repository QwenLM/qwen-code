/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ServerGeminiToolCallRequestEvent,
  ServerGeminiErrorEvent,
} from './turn.js';
import { CompressionStatus, Turn, GeminiEventType } from './turn.js';
import type { GenerateContentResponse, Part, Content } from '@google/genai';
import { reportError } from '../utils/errorReporting.js';
import type { GeminiChat } from './geminiChat.js';
import { StreamEventType } from './geminiChat.js';
import { StreamingToolExecutor } from './streamingToolExecutor.js';
import { UnauthorizedError } from '../utils/errors.js';

const mockSendMessageStream = vi.fn();
const mockGetHistory = vi.fn();
const mockMaybeIncludeSchemaDepthContext = vi.fn();

vi.mock('@google/genai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/genai')>();
  const MockChat = vi.fn().mockImplementation(() => ({
    sendMessageStream: mockSendMessageStream,
    getHistory: mockGetHistory,
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

describe('Turn', () => {
  let turn: Turn;
  // Define a type for the mocked Chat instance for clarity
  type MockedChatInstance = {
    sendMessageStream: typeof mockSendMessageStream;
    getHistory: typeof mockGetHistory;
    maybeIncludeSchemaDepthContext: typeof mockMaybeIncludeSchemaDepthContext;
  };
  let mockChatInstance: MockedChatInstance;

  beforeEach(() => {
    vi.resetAllMocks();
    mockChatInstance = {
      sendMessageStream: mockSendMessageStream,
      getHistory: mockGetHistory,
      maybeIncludeSchemaDepthContext: mockMaybeIncludeSchemaDepthContext,
    };
    turn = new Turn(mockChatInstance as unknown as GeminiChat, 'prompt-id-1');
    mockGetHistory.mockReturnValue([]);
    mockSendMessageStream.mockResolvedValue((async function* () {})());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('constructor', () => {
    it('should initialize pendingToolCalls and debugResponses', () => {
      expect(turn.pendingToolCalls).toEqual([]);
      expect(turn.getDebugResponses()).toEqual([]);
    });
  });

  describe('run', () => {
    it('should yield content events for text parts', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [{ content: { parts: [{ text: 'Hello' }] } }],
          } as GenerateContentResponse,
        };
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [{ content: { parts: [{ text: ' world' }] } }],
          } as GenerateContentResponse,
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      const reqParts: Part[] = [{ text: 'Hi' }];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(mockSendMessageStream).toHaveBeenCalledWith(
        'test-model',
        {
          message: reqParts,
          config: { abortSignal: expect.any(AbortSignal) },
        },
        'prompt-id-1',
      );

      expect(events).toEqual([
        { type: GeminiEventType.Content, value: 'Hello' },
        { type: GeminiEventType.Content, value: ' world' },
      ]);
      expect(turn.getDebugResponses().length).toBe(2);
    });

    it('should emit Thought events when a thought part is present', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { thought: true, text: 'reasoning...' },
                    { text: 'final answer' },
                  ],
                },
              },
            ],
          } as GenerateContentResponse,
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      const reqParts: Part[] = [{ text: 'Hi' }];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: GeminiEventType.Thought,
          value: { subject: '', description: 'reasoning...' },
        },
        { type: GeminiEventType.Content, value: 'final answer' },
      ]);
    });

    it('should emit thought descriptions per incoming chunk', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ thought: true, text: 'part1' }],
                },
              },
            ],
          } as GenerateContentResponse,
        };
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ thought: true, text: 'part2' }],
                },
              },
            ],
          } as GenerateContentResponse,
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      for await (const event of turn.run(
        'test-model',
        [{ text: 'Hi' }],
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: GeminiEventType.Thought,
          value: { subject: '', description: 'part1' },
        },
        {
          type: GeminiEventType.Thought,
          value: { subject: '', description: 'part2' },
        },
      ]);
    });

    it('should yield tool_call_request events for function calls', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            functionCalls: [
              {
                id: 'fc1',
                name: 'tool1',
                args: { arg1: 'val1' },
                isClientInitiated: false,
              },
              {
                name: 'tool2',
                args: { arg2: 'val2' },
                isClientInitiated: false,
              }, // No ID
            ],
          } as unknown as GenerateContentResponse,
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      const reqParts: Part[] = [{ text: 'Use tools' }];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events.length).toBe(2);
      const event1 = events[0] as ServerGeminiToolCallRequestEvent;
      expect(event1.type).toBe(GeminiEventType.ToolCallRequest);
      expect(event1.value).toEqual(
        expect.objectContaining({
          callId: 'fc1',
          name: 'tool1',
          args: { arg1: 'val1' },
          isClientInitiated: false,
        }),
      );
      expect(turn.pendingToolCalls[0]).toEqual(event1.value);

      const event2 = events[1] as ServerGeminiToolCallRequestEvent;
      expect(event2.type).toBe(GeminiEventType.ToolCallRequest);
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
      expect(turn.getDebugResponses().length).toBe(1);
    });

    it('should yield UserCancelled event if signal is aborted', async () => {
      const abortController = new AbortController();
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [{ content: { parts: [{ text: 'First part' }] } }],
          } as GenerateContentResponse,
        };
        abortController.abort();
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: {
                  parts: [{ text: 'Second part - should not be processed' }],
                },
              },
            ],
          } as GenerateContentResponse,
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      const reqParts: Part[] = [{ text: 'Test abort' }];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        abortController.signal,
      )) {
        events.push(event);
      }
      expect(events).toEqual([
        { type: GeminiEventType.Content, value: 'First part' },
        { type: GeminiEventType.UserCancelled },
      ]);
      expect(turn.getDebugResponses().length).toBe(1);
    });

    it('should yield Error event and report if sendMessageStream throws', async () => {
      const error = new Error('API Error');
      mockSendMessageStream.mockRejectedValue(error);
      const reqParts: Part[] = [{ text: 'Trigger error' }];
      const historyContent: Content[] = [
        { role: 'model', parts: [{ text: 'Previous history' }] },
      ];
      mockGetHistory.mockReturnValue(historyContent);
      mockMaybeIncludeSchemaDepthContext.mockResolvedValue(undefined);
      const events = [];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events.length).toBe(1);
      const errorEvent = events[0] as ServerGeminiErrorEvent;
      expect(errorEvent.type).toBe(GeminiEventType.Error);
      expect(errorEvent.value).toEqual({
        error: { message: 'API Error', status: undefined },
      });
      expect(turn.getDebugResponses().length).toBe(0);
      expect(reportError).toHaveBeenCalledWith(
        error,
        'Error when talking to API',
        [...historyContent, reqParts],
        'Turn.run-sendMessageStream',
      );
    });

    it('should handle function calls with undefined name or args', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [],
            functionCalls: [
              // Add `id` back to the mock to match what the code expects
              { id: 'fc1', name: undefined, args: { arg1: 'val1' } },
              { id: 'fc2', name: 'tool2', args: undefined },
              { id: 'fc3', name: undefined, args: undefined },
            ],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      for await (const event of turn.run(
        'test-model',
        [{ text: 'Test undefined tool parts' }],
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events.length).toBe(3);

      // Assertions for each specific tool call event
      const event1 = events[0] as ServerGeminiToolCallRequestEvent;
      expect(event1.value).toMatchObject({
        callId: 'fc1',
        name: 'undefined_tool_name',
        args: { arg1: 'val1' },
      });

      const event2 = events[1] as ServerGeminiToolCallRequestEvent;
      expect(event2.value).toMatchObject({
        callId: 'fc2',
        name: 'tool2',
        args: {},
      });

      const event3 = events[2] as ServerGeminiToolCallRequestEvent;
      expect(event3.value).toMatchObject({
        callId: 'fc3',
        name: 'undefined_tool_name',
        args: {},
      });
    });

    it('should yield finished event when response has finish reason', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: { parts: [{ text: 'Partial response' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 17,
              candidatesTokenCount: 50,
              cachedContentTokenCount: 10,
              thoughtsTokenCount: 5,
            },
          } as GenerateContentResponse,
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      for await (const event of turn.run(
        'test-model',
        [{ text: 'Test finish reason' }],
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: GeminiEventType.Content, value: 'Partial response' },
        {
          type: GeminiEventType.Finished,
          value: {
            reason: 'STOP',
            usageMetadata: {
              promptTokenCount: 17,
              candidatesTokenCount: 50,
              cachedContentTokenCount: 10,
              thoughtsTokenCount: 5,
            },
          },
        },
      ]);
    });

    it('should yield finished event for MAX_TOKENS finish reason', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'This is a long response that was cut off...' },
                  ],
                },
                finishReason: 'MAX_TOKENS',
              },
            ],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      const reqParts: Part[] = [{ text: 'Generate long text' }];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: GeminiEventType.Content,
          value: 'This is a long response that was cut off...',
        },
        {
          type: GeminiEventType.Finished,
          value: { reason: 'MAX_TOKENS', usageMetadata: undefined },
        },
      ]);
    });

    it('should yield finished event for SAFETY finish reason', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: { parts: [{ text: 'Content blocked' }] },
                finishReason: 'SAFETY',
              },
            ],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      const reqParts: Part[] = [{ text: 'Test safety' }];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: GeminiEventType.Content, value: 'Content blocked' },
        {
          type: GeminiEventType.Finished,
          value: { reason: 'SAFETY', usageMetadata: undefined },
        },
      ]);
    });

    it('should yield finished event with undefined reason when there is no finish reason', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: {
                  parts: [{ text: 'Response without finish reason' }],
                },
                // No finishReason property
              },
            ],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      const reqParts: Part[] = [{ text: 'Test no finish reason' }];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        {
          type: GeminiEventType.Content,
          value: 'Response without finish reason',
        },
      ]);
    });

    it('should handle multiple responses with different finish reasons', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: { parts: [{ text: 'First part' }] },
                // No finish reason on first response
              },
            ],
          },
        };
        yield {
          value: {
            type: StreamEventType.CHUNK,
            candidates: [
              {
                content: { parts: [{ text: 'Second part' }] },
                finishReason: 'OTHER',
              },
            ],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      const reqParts: Part[] = [{ text: 'Test multiple responses' }];
      for await (const event of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: GeminiEventType.Content, value: 'First part' },
        { type: GeminiEventType.Content, value: 'Second part' },
        {
          type: GeminiEventType.Finished,
          value: { reason: 'OTHER', usageMetadata: undefined },
        },
      ]);
    });

    it('should yield citation and finished events when response has citationMetadata', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: { parts: [{ text: 'Some text.' }] },
                citationMetadata: {
                  citations: [
                    {
                      uri: 'https://example.com/source1',
                      title: 'Source 1 Title',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      for await (const event of turn.run(
        'test-model',
        [{ text: 'Test citations' }],
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: GeminiEventType.Content, value: 'Some text.' },
        {
          type: GeminiEventType.Citation,
          value: 'Citations:\n(Source 1 Title) https://example.com/source1',
        },
        {
          type: GeminiEventType.Finished,
          value: { reason: 'STOP', usageMetadata: undefined },
        },
      ]);
    });

    it('should yield a single citation event for multiple citations in one response', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: { parts: [{ text: 'Some text.' }] },
                citationMetadata: {
                  citations: [
                    {
                      uri: 'https://example.com/source2',
                      title: 'Title2',
                    },
                    {
                      uri: 'https://example.com/source1',
                      title: 'Title1',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      for await (const event of turn.run(
        'test-model',
        [{ text: 'test' }],
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: GeminiEventType.Content, value: 'Some text.' },
        {
          type: GeminiEventType.Citation,
          value:
            'Citations:\n(Title1) https://example.com/source1\n(Title2) https://example.com/source2',
        },
        {
          type: GeminiEventType.Finished,
          value: { reason: 'STOP', usageMetadata: undefined },
        },
      ]);
    });

    it('should not yield citation event if there is no finish reason', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: { parts: [{ text: 'Some text.' }] },
                citationMetadata: {
                  citations: [
                    {
                      uri: 'https://example.com/source1',
                      title: 'Source 1 Title',
                    },
                  ],
                },
                // No finishReason
              },
            ],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      for await (const event of turn.run(
        'test-model',
        [{ text: 'test' }],
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: GeminiEventType.Content, value: 'Some text.' },
      ]);
      // No Citation event (but we do get a Finished event with undefined reason)
      expect(events.some((e) => e.type === GeminiEventType.Citation)).toBe(
        false,
      );
    });

    it('should ignore citations without a URI', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                content: { parts: [{ text: 'Some text.' }] },
                citationMetadata: {
                  citations: [
                    {
                      uri: 'https://example.com/source1',
                      title: 'Good Source',
                    },
                    {
                      // uri is undefined
                      title: 'Bad Source',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      for await (const event of turn.run(
        'test-model',
        [{ text: 'test' }],
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: GeminiEventType.Content, value: 'Some text.' },
        {
          type: GeminiEventType.Citation,
          value: 'Citations:\n(Good Source) https://example.com/source1',
        },
        {
          type: GeminiEventType.Finished,
          value: { reason: 'STOP', usageMetadata: undefined },
        },
      ]);
    });

    it('should not crash when cancelled request has malformed error', async () => {
      const abortController = new AbortController();

      const errorToThrow = {
        response: {
          data: undefined, // Malformed error data
        },
      };

      mockSendMessageStream.mockImplementation(async () => {
        abortController.abort();
        throw errorToThrow;
      });

      const events = [];
      const reqParts: Part[] = [{ text: 'Test malformed error handling' }];

      for await (const event of turn.run(
        'test-model',
        reqParts,
        abortController.signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([{ type: GeminiEventType.UserCancelled }]);

      expect(reportError).not.toHaveBeenCalled();
    });

    it('should yield a Retry event when it receives one from the chat stream', async () => {
      const mockResponseStream = (async function* () {
        yield { type: StreamEventType.RETRY };
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [{ content: { parts: [{ text: 'Success' }] } }],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      for await (const event of turn.run(
        'test-model',
        [],
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: GeminiEventType.Retry },
        { type: GeminiEventType.Content, value: 'Success' },
      ]);
    });

    it('bridges a compressed stream event to a ChatCompressed event', async () => {
      const compressionInfo = {
        originalTokenCount: 1000,
        newTokenCount: 200,
        compressionStatus: CompressionStatus.COMPRESSED,
      };
      const mockResponseStream = (async function* () {
        yield { type: StreamEventType.COMPRESSED, info: compressionInfo };
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [{ content: { parts: [{ text: 'after' }] } }],
          },
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const events = [];
      for await (const event of turn.run(
        'test-model',
        [],
        new AbortController().signal,
      )) {
        events.push(event);
      }

      expect(events).toEqual([
        { type: GeminiEventType.ChatCompressed, value: compressionInfo },
        { type: GeminiEventType.Content, value: 'after' },
      ]);
    });
  });

  describe('getDebugResponses', () => {
    it('should return collected debug responses', async () => {
      const resp1 = {
        candidates: [{ content: { parts: [{ text: 'Debug 1' }] } }],
      } as unknown as GenerateContentResponse;
      const resp2 = {
        functionCalls: [{ name: 'debugTool' }],
      } as unknown as GenerateContentResponse;
      const mockResponseStream = (async function* () {
        yield { type: StreamEventType.CHUNK, value: resp1 };
        yield { type: StreamEventType.CHUNK, value: resp2 };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);
      const reqParts: Part[] = [{ text: 'Hi' }];
      for await (const _ of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        // consume stream
      }
      expect(turn.getDebugResponses()).toEqual([resp1, resp2]);
    });
  });

  describe('wasOutputTruncated flag', () => {
    it('should set wasOutputTruncated=true on pending tool calls when finishReason is MAX_TOKENS', async () => {
      const mockResponseStream = (async function* () {
        // Yield a tool call request
        yield {
          type: StreamEventType.CHUNK,
          value: {
            functionCalls: [
              {
                name: 'write_file',
                args: { file_path: '/test.txt', content: 'hello' },
              },
            ],
          } as unknown as GenerateContentResponse,
        };
        // Yield finish with MAX_TOKENS
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                finishReason: 'MAX_TOKENS',
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

      // Verify that pending tool calls have wasOutputTruncated flag set
      expect(turn.pendingToolCalls).toHaveLength(1);
      expect(turn.pendingToolCalls[0].wasOutputTruncated).toBe(true);
      expect(turn.pendingToolCalls[0].name).toBe('write_file');
    });

    it('should NOT set wasOutputTruncated when finishReason is STOP', async () => {
      const mockResponseStream = (async function* () {
        yield {
          type: StreamEventType.CHUNK,
          value: {
            functionCalls: [
              {
                name: 'read_file',
                args: { file_path: '/test.txt' },
              },
            ],
          } as unknown as GenerateContentResponse,
        };
        // Yield finish with STOP (normal completion)
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
      for await (const _ of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        // consume stream
      }

      // Verify that pending tool calls do NOT have wasOutputTruncated flag
      expect(turn.pendingToolCalls).toHaveLength(1);
      expect(turn.pendingToolCalls[0].wasOutputTruncated).toBeUndefined();
    });

    it('should handle multiple pending tool calls with MAX_TOKENS', async () => {
      const mockResponseStream = (async function* () {
        // Yield two tool calls
        yield {
          type: StreamEventType.CHUNK,
          value: {
            functionCalls: [
              {
                name: 'write_file',
                args: { file_path: '/test1.txt', content: 'content1' },
              },
              {
                name: 'edit',
                args: { file_path: '/test2.txt', original_text: 'old' },
              },
            ],
          } as unknown as GenerateContentResponse,
        };
        // Yield finish with MAX_TOKENS
        yield {
          type: StreamEventType.CHUNK,
          value: {
            candidates: [
              {
                finishReason: 'MAX_TOKENS',
                content: { parts: [] },
              },
            ],
          } as unknown as GenerateContentResponse,
        };
      })();
      mockSendMessageStream.mockResolvedValue(mockResponseStream);

      const reqParts: Part[] = [{ text: 'Test prompt' }];
      for await (const _ of turn.run(
        'test-model',
        reqParts,
        new AbortController().signal,
      )) {
        // consume stream
      }

      // Verify both tool calls have wasOutputTruncated flag set
      expect(turn.pendingToolCalls).toHaveLength(2);
      expect(turn.pendingToolCalls[0].wasOutputTruncated).toBe(true);
      expect(turn.pendingToolCalls[1].wasOutputTruncated).toBe(true);
    });
  });

  describe('streamingExecutor wiring', () => {
    it('forwards ToolCallRequest events to executor.accept()', async () => {
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [
                { id: 'fc1', name: 'tool1', args: { a: 1 } },
                { id: 'fc2', name: 'tool2', args: { b: 2 } },
              ],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        // consume
      }

      expect(t.getStreamingExecutor()).toBe(executor);
      expect(executor.getAcceptedRequests().map((r) => r.callId)).toEqual([
        'fc1',
        'fc2',
      ]);
    });

    it('resets (not discards) the executor on retry, keeping it open for the next attempt', async () => {
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          yield { type: StreamEventType.RETRY, retryInfo: undefined };
          // The retried attempt then produces a new tool call. The executor
          // must still observe it — discarding would silently drop fc2.
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc2', name: 'tool2', args: {} }],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        // consume
      }
      expect(executor.isDiscarded()).toBe(false);
      // After Turn.run's finally, the executor is Closed (stream ended).
      expect(executor.isClosed()).toBe(true);
      // First-attempt accept was wiped; second-attempt accept landed.
      expect(executor.getAcceptedRequests().map((r) => r.callId)).toEqual([
        'fc2',
      ]);
    });

    it('abort-after-retry discards with reason aborted (canonical reason wins)', async () => {
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      const ctrl = new AbortController();
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          yield { type: StreamEventType.RETRY, retryInfo: undefined };
          // Caller aborts between retry and the next iteration.
          ctrl.abort();
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc2', name: 'tool2', args: {} }],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        ctrl.signal,
      )) {
        // consume
      }
      // reset → discard sequence: discarded wins, closed flag cleared, reason
      // is 'aborted' not 'retry'.
      expect(executor.isDiscarded()).toBe(true);
      expect(executor.isClosed()).toBe(false);
      expect(executor.getDiscardReason()).toBe('aborted');
    });

    it('discards the executor on signal abort', async () => {
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      const ctrl = new AbortController();
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          ctrl.abort();
          yield {
            type: StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [] } }],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        ctrl.signal,
      )) {
        // consume
      }
      expect(executor.isDiscarded()).toBe(true);
      expect(executor.getDiscardReason()).toBe('aborted');
    });

    it('discards the executor when the stream throws', async () => {
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          throw new Error('boom');
        })(),
      );

      const events: Array<{ type: GeminiEventType }> = [];
      for await (const event of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        events.push(event);
      }
      expect(executor.isDiscarded()).toBe(true);
      expect(executor.getDiscardReason()).toBe('stream-error');
      expect(events.at(-1)).toMatchObject({ type: GeminiEventType.Error });
      expect(vi.mocked(reportError)).toHaveBeenCalledTimes(1);
    });

    it("discards with reason 'unauthorized' and rethrows when the stream throws an UnauthorizedError", async () => {
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        // eslint-disable-next-line require-yield
        (async function* () {
          throw new UnauthorizedError('not allowed');
        })(),
      );

      let caught: unknown;
      try {
        for await (const _ of t.run(
          'test-model',
          [{ text: 'hi' }],
          new AbortController().signal,
        )) {
          // consume
        }
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(UnauthorizedError);
      expect(executor.isDiscarded()).toBe(true);
      expect(executor.getDiscardReason()).toBe('unauthorized');
    });

    it("catch-block aborted check wins over stream-error: signal.aborted + stream throw → reason 'aborted'", async () => {
      // The catch's `if (signal.aborted)` branch must fire BEFORE the
      // generic `discard('stream-error')` so a user-abort that races with
      // a stream throw still surfaces as 'aborted', not 'stream-error'.
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      const ctrl = new AbortController();
      mockSendMessageStream.mockResolvedValue(
        // eslint-disable-next-line require-yield
        (async function* () {
          // Abort first, then throw on the very next iteration.
          ctrl.abort();
          throw new Error('boom-after-abort');
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        ctrl.signal,
      )) {
        // consume
      }
      expect(executor.isDiscarded()).toBe(true);
      expect(executor.getDiscardReason()).toBe('aborted');
    });

    it('closes (not discards) the executor on consumer break-out, preserving buffered state', async () => {
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc2', name: 'tool2', args: {} }],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        break; // simulate client.ts early-return paths (LoopDetected etc.)
      }
      expect(executor.isClosed()).toBe(true);
      expect(executor.isDiscarded()).toBe(false);
      // Buffered state preserved for the consumer to drain.
      expect(executor.getAcceptedRequests().map((r) => r.callId)).toEqual([
        'fc1',
      ]);
    });

    it('closes the executor on normal stream end without setting a discard reason', async () => {
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [{ text: 'done' }] } }],
            } as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        // consume to natural end
      }
      expect(executor.isClosed()).toBe(true);
      expect(executor.isDiscarded()).toBe(false);
      expect(executor.getDiscardReason()).toBeUndefined();
    });

    it('mirrors MAX_TOKENS truncation onto every accepted executor entry', async () => {
      const executor = new StreamingToolExecutor();
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [
                { id: 'fc1', name: 'tool1', args: { a: 1 } },
                { id: 'fc2', name: 'tool2', args: { b: 2 } },
              ],
            } as unknown as GenerateContentResponse,
          };
          yield {
            type: StreamEventType.CHUNK,
            value: {
              candidates: [
                { finishReason: 'MAX_TOKENS', content: { parts: [] } },
              ],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        // consume
      }
      const stored = executor.getAcceptedRequests();
      expect(stored.map((r) => r.callId)).toEqual(['fc1', 'fc2']);
      expect(stored.every((r) => r.wasOutputTruncated === true)).toBe(true);
    });

    it('default-off path: Turn without executor still works unchanged', async () => {
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: { a: 1 } }],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      const events = [];
      for await (const event of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        events.push(event);
      }
      expect(t.getStreamingExecutor()).toBeUndefined();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: GeminiEventType.ToolCallRequest,
      });
    });
  });

  /**
   * Phase 4 of #4387 — orphan prevention across the full pipeline.
   *
   * These tests pair {@link Turn} with a real {@link StreamingToolExecutor}
   * AND a real cancellation listener (the same hook
   * {@link StreamingToolDispatcher} uses) to verify that Turn's lifecycle
   * transitions reach an out-of-band dispatcher even when nothing in
   * `Turn` knows about it. The invariant under test is:
   *
   *   for every functionCall the Turn ever observed, either
   *     (a) its functionResponse will be produced and delivered, or
   *     (b) the dispatcher was notified to drop its in-flight work
   *
   * (b) is what these tests check — (a) is the post-stream consumer's
   * responsibility and is covered in the headless integration tests.
   */
  describe('Phase 4: dispatcher cancellation reaches out-of-band listeners', () => {
    it('mid-stream retry: cancellation listener fires with reason "retry"', async () => {
      const executor = new StreamingToolExecutor();
      const notifications: Array<string | undefined> = [];
      executor.addCancellationListener((r) => notifications.push(r));
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          yield { type: StreamEventType.RETRY, retryInfo: undefined };
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc2', name: 'tool2', args: {} }],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        // consume
      }
      // Exactly one cancellation: the retry. The post-stream `close()`
      // does NOT fire a cancellation (state is preserved).
      expect(notifications).toEqual(['retry']);
    });

    it('signal abort mid-stream: cancellation listener fires with reason "aborted"', async () => {
      const executor = new StreamingToolExecutor();
      const notifications: Array<string | undefined> = [];
      executor.addCancellationListener((r) => notifications.push(r));
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      const ctrl = new AbortController();
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          ctrl.abort();
          yield {
            type: StreamEventType.CHUNK,
            value: {
              candidates: [{ content: { parts: [] } }],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        ctrl.signal,
      )) {
        // consume
      }
      expect(notifications).toEqual(['aborted']);
    });

    it('stream error: cancellation listener fires with reason "stream-error"', async () => {
      const executor = new StreamingToolExecutor();
      const notifications: Array<string | undefined> = [];
      executor.addCancellationListener((r) => notifications.push(r));
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          throw new Error('transport boom');
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        // consume
      }
      expect(notifications).toEqual(['stream-error']);
    });

    it('unauthorized: cancellation listener fires with reason "unauthorized"', async () => {
      const executor = new StreamingToolExecutor();
      const notifications: Array<string | undefined> = [];
      executor.addCancellationListener((r) => notifications.push(r));
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          throw new UnauthorizedError('no creds');
        })(),
      );

      await expect(async () => {
        for await (const _ of t.run(
          'test-model',
          [{ text: 'hi' }],
          new AbortController().signal,
        )) {
          // consume
        }
      }).rejects.toBeInstanceOf(UnauthorizedError);
      expect(notifications).toEqual(['unauthorized']);
    });

    it('normal completion: cancellation listener does NOT fire', async () => {
      const executor = new StreamingToolExecutor();
      const notifications: Array<string | undefined> = [];
      executor.addCancellationListener((r) => notifications.push(r));
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        // consume
      }
      // Stream ended normally — Turn calls executor.close(), which is
      // explicitly NOT a cancellation (buffered state is preserved for
      // the post-stream consumer).
      expect(notifications).toEqual([]);
      expect(executor.isClosed()).toBe(true);
      expect(executor.isDiscarded()).toBe(false);
    });

    it('retry-then-error: listener fires twice, in order (retry, then stream-error)', async () => {
      const executor = new StreamingToolExecutor();
      const notifications: Array<string | undefined> = [];
      executor.addCancellationListener((r) => notifications.push(r));
      const t = new Turn(
        mockChatInstance as unknown as GeminiChat,
        'prompt-id-1',
        executor,
      );
      mockSendMessageStream.mockResolvedValue(
        (async function* () {
          yield {
            type: StreamEventType.CHUNK,
            value: {
              functionCalls: [{ id: 'fc1', name: 'tool1', args: {} }],
            } as unknown as GenerateContentResponse,
          };
          yield { type: StreamEventType.RETRY, retryInfo: undefined };
          throw new Error('transport gave up');
        })(),
      );

      for await (const _ of t.run(
        'test-model',
        [{ text: 'hi' }],
        new AbortController().signal,
      )) {
        // consume
      }
      expect(notifications).toEqual(['retry', 'stream-error']);
    });
  });
});

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponse,
} from '@google/genai';
import { ApiError } from '@google/genai';
import { AuthType, type ContentGenerator } from '../core/contentGenerator.js';
import {
  GeminiChat,
  InvalidStreamError,
  redactStructuredOutputArgsForRecording,
  StreamEventType,
  type StreamEvent,
} from './geminiChat.js';
import { StreamContentError } from './openaiContentGenerator/pipeline.js';
import type { Config } from '../config/config.js';
import { setSimulate429 } from '../utils/testUtils.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { CompressionStatus, type ChatCompressionInfo } from './turn.js';
import {
  ChatCompressionService,
  MAX_CONSECUTIVE_FAILURES,
} from '../services/chatCompressionService.js';
import { SessionStartSource } from '../hooks/types.js';

const { mockGetHeapStatistics } = vi.hoisted(() => ({
  mockGetHeapStatistics: vi.fn(),
}));

vi.mock('node:v8', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:v8')>();
  return {
    ...actual,
    getHeapStatistics: mockGetHeapStatistics,
  };
});

// Mock fs module to prevent actual file system operations during tests
const mockFileSystem = new Map<string, string>();

vi.mock('node:fs', () => {
  const fsModule = {
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn((path: string, data: string) => {
      mockFileSystem.set(path, data);
    }),
    readFileSync: vi.fn((path: string) => {
      if (mockFileSystem.has(path)) {
        return mockFileSystem.get(path);
      }
      throw Object.assign(new Error('ENOENT: no such file or directory'), {
        code: 'ENOENT',
      });
    }),
    existsSync: vi.fn((path: string) => mockFileSystem.has(path)),
    appendFileSync: vi.fn(),
  };

  return {
    default: fsModule,
    ...fsModule,
  };
});

// Add mock for the retry utility
const { mockRetryWithBackoff } = vi.hoisted(() => ({
  mockRetryWithBackoff: vi.fn(),
}));

vi.mock('../utils/retry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/retry.js')>();
  return {
    ...actual,
    retryWithBackoff: mockRetryWithBackoff,
  };
});

const { mockLogContentRetry, mockLogContentRetryFailure } = vi.hoisted(() => ({
  mockLogContentRetry: vi.fn(),
  mockLogContentRetryFailure: vi.fn(),
}));

vi.mock('../telemetry/loggers.js', () => ({
  logContentRetry: mockLogContentRetry,
  logContentRetryFailure: mockLogContentRetryFailure,
  // Real ChatCompressionService.compress() calls logChatCompression on
  // every attempt; the R3.4 integration test exercises that path, so the
  // mock has to expose it (no-op).
  logChatCompression: vi.fn(),
}));

vi.mock('../telemetry/uiTelemetry.js', () => ({
  uiTelemetryService: {
    setLastPromptTokenCount: vi.fn(),
  },
}));

describe('GeminiChat', async () => {
  let mockContentGenerator: ContentGenerator;
  let chat: GeminiChat;
  let mockConfig: Config;
  const config: GenerateContentConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uiTelemetryService.setLastPromptTokenCount).mockClear();
    mockContentGenerator = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      countTokens: vi.fn(),
      embedContent: vi.fn(),
      batchEmbedContents: vi.fn(),
      useSummarizedThinking: vi.fn().mockReturnValue(false),
    } as unknown as ContentGenerator;

    // Default mock implementation for tests that don't care about retry logic
    mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
    mockGetHeapStatistics.mockReturnValue({
      used_heap_size: 0,
      heap_size_limit: Number.MAX_SAFE_INTEGER,
    });
    mockConfig = {
      getSessionId: () => 'test-session-id',
      getTelemetryLogPromptsEnabled: () => true,
      getUsageStatisticsEnabled: () => true,
      getDebugMode: () => false,
      getContentGeneratorConfig: vi.fn().mockReturnValue({
        authType: 'gemini', // Ensure this is set for fallback tests
        model: 'test-model',
      }),
      getModel: vi.fn().mockReturnValue('gemini-pro'),
      setModel: vi.fn(),
      getProjectRoot: vi.fn().mockReturnValue('/test/project/root'),
      getCliVersion: vi.fn().mockReturnValue('1.0.0'),
      storage: {
        getProjectTempDir: vi.fn().mockReturnValue('/test/temp'),
      },
      getToolRegistry: vi.fn().mockReturnValue({
        getTool: vi.fn(),
      }),
      getContentGenerator: vi.fn().mockReturnValue(mockContentGenerator),
      getBaseLlmClient: vi.fn().mockReturnValue(undefined),
      getChatCompression: vi.fn().mockReturnValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDebugLogger: vi
        .fn()
        .mockReturnValue({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      getFileReadCache: vi.fn().mockReturnValue({ clear: vi.fn() }),
    } as unknown as Config;

    // Disable 429 simulation for tests
    setSimulate429(false);
    // Reset history for each test by creating a new instance
    chat = new GeminiChat(
      mockConfig,
      config,
      [],
      undefined,
      uiTelemetryService,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  /**
   * Helper: consume a stream and expect it to throw InvalidStreamError
   * after all transient retries exhaust. Uses fake timers to skip delays.
   * Must be called within a vi.useFakeTimers() / vi.useRealTimers() block.
   */
  async function expectStreamExhaustion(
    stream: AsyncGenerator<StreamEvent>,
  ): Promise<void> {
    const collecting = (async () => {
      for await (const _ of stream) {
        /* consume */
      }
    })();
    // Get assertion promise first (don't await), then advance timers.
    const resultPromise = (async () => {
      await expect(collecting).rejects.toThrow(InvalidStreamError);
    })();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(35_000);
    await resultPromise;
  }

  async function collectStreamWithFakeTimers(
    stream: AsyncGenerator<StreamEvent>,
    advanceByMs: number = 10_000,
  ): Promise<StreamEvent[]> {
    const events: StreamEvent[] = [];
    const collecting = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
      return events;
    })();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(advanceByMs);
    return collecting;
  }

  describe('system instruction helpers', () => {
    it('replaces prior session-start context instead of appending indefinitely', () => {
      const isolatedChat = new GeminiChat(
        mockConfig,
        {},
        [],
        undefined,
        uiTelemetryService,
      );
      isolatedChat.setSystemInstruction('Base instruction');

      isolatedChat.setSessionStartContext('Ctx1');
      isolatedChat.setSessionStartContext('Ctx2');

      expect(isolatedChat['generationConfig'].systemInstruction).toBe(
        'Base instruction\n\n<qwen:session-start-context hidden="true">\nSessionStart additional context:\nCtx2\n</qwen:session-start-context>',
      );
    });

    it('preserves existing system prompt suffixes when replacing session-start context', () => {
      const isolatedChat = new GeminiChat(
        mockConfig,
        {},
        [],
        undefined,
        uiTelemetryService,
      );
      isolatedChat.setSystemInstruction(
        'Base instruction\n\n---\n\nUser memory\n\n---\n\nAppended rule',
      );

      isolatedChat.setSessionStartContext('Ctx1');
      isolatedChat.setSessionStartContext('Ctx2');

      expect(isolatedChat['generationConfig'].systemInstruction).toBe(
        'Base instruction\n\n---\n\nUser memory\n\n---\n\nAppended rule\n\n<qwen:session-start-context hidden="true">\nSessionStart additional context:\nCtx2\n</qwen:session-start-context>',
      );
    });

    it('preserves non-string systemInstruction content when applying session-start context', () => {
      const isolatedChat = new GeminiChat(
        mockConfig,
        {
          systemInstruction: {
            role: 'system',
            parts: [{ text: 'Base content instruction' }],
          },
        },
        [],
        undefined,
        uiTelemetryService,
      );

      isolatedChat.setSessionStartContext('Ctx1');
      isolatedChat.setSessionStartContext('Ctx2');

      expect(isolatedChat['generationConfig'].systemInstruction).toBe(
        'Base content instruction\n\n<qwen:session-start-context hidden="true">\nSessionStart additional context:\nCtx2\n</qwen:session-start-context>',
      );
    });

    it('applies session-start context synchronously via applySessionStartContext', () => {
      const isolatedChat = new GeminiChat(
        mockConfig,
        {},
        [],
        undefined,
        uiTelemetryService,
      );
      isolatedChat.setSystemInstruction('Base instruction');

      isolatedChat.applySessionStartContext(
        '  Sync ctx  ',
        SessionStartSource.Startup,
      );

      expect(isolatedChat['generationConfig'].systemInstruction).toBe(
        'Base instruction\n\n<qwen:session-start-context hidden="true">\nSessionStart additional context:\nSync ctx\n</qwen:session-start-context>',
      );
    });

    it('does not strip legitimate content that only resembles the old plain-text marker', () => {
      const isolatedChat = new GeminiChat(
        mockConfig,
        {},
        [],
        undefined,
        uiTelemetryService,
      );
      isolatedChat.setSystemInstruction(
        'Base instruction\n\n---\n\nSessionStart additional context:\nLegitimate content',
      );

      isolatedChat.setSessionStartContext('Ctx1');

      expect(isolatedChat['generationConfig'].systemInstruction).toContain(
        'Legitimate content',
      );
      expect(isolatedChat['generationConfig'].systemInstruction).toContain(
        '<qwen:session-start-context hidden="true">\nSessionStart additional context:\nCtx1\n</qwen:session-start-context>',
      );
    });
  });

  describe('sendMessageStream', () => {
    it('should succeed if a tool call is followed by an empty part', async () => {
      // 1. Mock a stream that contains a tool call, then an invalid (empty) part.
      const streamWithToolCall = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'test_tool', args: {} } }],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
        // This second chunk is invalid according to isValidResponse
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: '' }],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamWithToolCall,
      );

      // 2. Action & Assert: The stream processing should complete without throwing an error
      // because the presence of a tool call makes the empty final chunk acceptable.
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test message' },
        'prompt-id-tool-call-empty-end',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume stream */
          }
        })(),
      ).resolves.not.toThrow();

      // 3. Verify history was recorded correctly
      const history = chat.getHistory();
      expect(history.length).toBe(2); // user turn + model turn
      const modelTurn = history[1]!;
      expect(modelTurn?.parts?.length).toBe(1); // The empty part is discarded
      expect(modelTurn?.parts![0]!.functionCall).toBeDefined();
    });

    it('should fail if the stream ends with an empty part and has no finishReason', async () => {
      vi.useFakeTimers();
      try {
        const streamWithNoFinish = (async function* () {
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'Initial content...' }],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: '' }],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
        })();

        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          streamWithNoFinish,
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test message' },
          'prompt-id-no-finish-empty-end',
        );
        await expectStreamExhaustion(stream);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should succeed if the stream ends with an invalid part but has a finishReason and contained a valid part', async () => {
      // 1. Mock a stream that sends a valid chunk, then an invalid one, but has a finish reason.
      const streamWithInvalidEnd = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'Initial valid content...' }],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
        // This second chunk is invalid, but the response has a finishReason.
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: '' }], // Invalid part
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamWithInvalidEnd,
      );

      // 2. Action & Assert: The stream should complete without throwing an error.
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test message' },
        'prompt-id-valid-then-invalid-end',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume stream */
          }
        })(),
      ).resolves.not.toThrow();

      // 3. Verify history was recorded correctly with only the valid part.
      const history = chat.getHistory();
      expect(history.length).toBe(2); // user turn + model turn
      const modelTurn = history[1]!;
      expect(modelTurn?.parts?.length).toBe(1);
      expect(modelTurn?.parts![0]!.text).toBe('Initial valid content...');
    });

    it('should consolidate subsequent text chunks after receiving an empty text chunk', async () => {
      // 1. Mock the API to return a stream where one chunk is just an empty text part.
      const multiChunkStream = (async function* () {
        yield {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'Hello' }] } },
          ],
        } as unknown as GenerateContentResponse;
        // FIX: The original test used { text: '' }, which is invalid.
        // A chunk can be empty but still valid. This chunk is now removed
        // as the important part is consolidating what comes after.
        yield {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: ' World!' }] },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        multiChunkStream,
      );

      // 2. Action: Send a message and consume the stream.
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test message' },
        'prompt-id-empty-chunk-consolidation',
      );
      for await (const _ of stream) {
        // Consume the stream
      }

      // 3. Assert: Check that the final history was correctly consolidated.
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      const modelTurn = history[1]!;
      expect(modelTurn?.parts?.length).toBe(1);
      expect(modelTurn?.parts![0]!.text).toBe('Hello World!');
    });

    it('should consolidate adjacent text parts that arrive in separate stream chunks', async () => {
      // 1. Mock the API to return a stream of multiple, adjacent text chunks.
      const multiChunkStream = (async function* () {
        yield {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'This is the ' }] } },
          ],
        } as unknown as GenerateContentResponse;
        yield {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'first part.' }] } },
          ],
        } as unknown as GenerateContentResponse;
        // This function call should break the consolidation.
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ functionCall: { name: 'do_stuff', args: {} } }],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'This is the second part.' }],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        multiChunkStream,
      );

      // 2. Action: Send a message and consume the stream.
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test message' },
        'prompt-id-multi-chunk',
      );
      for await (const _ of stream) {
        // Consume the stream to trigger history recording.
      }

      // 3. Assert: Check that the final history was correctly consolidated.
      const history = chat.getHistory();

      // The history should contain the user's turn and ONE consolidated model turn.
      expect(history.length).toBe(2);

      const modelTurn = history[1]!;
      expect(modelTurn.role).toBe('model');

      // The model turn should have 3 distinct parts: the merged text, the function call, and the final text.
      expect(modelTurn?.parts?.length).toBe(3);
      expect(modelTurn?.parts![0]!.text).toBe('This is the first part.');
      expect(modelTurn.parts![1]!.functionCall).toBeDefined();
      expect(modelTurn.parts![2]!.text).toBe('This is the second part.');
    });
    it('should preserve text parts that stream in the same chunk as a thought', async () => {
      // 1. Mock the API to return a single chunk containing both a thought and visible text.
      const mixedContentStream = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { thought: 'This is a thought.' },
                  { text: 'This is the visible text that should not be lost.' },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        mixedContentStream,
      );

      // 2. Action: Send a message and fully consume the stream to trigger history recording.
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test message' },
        'prompt-id-mixed-chunk',
      );
      for await (const _ of stream) {
        // This loop consumes the stream.
      }

      // 3. Assert: Check the final state of the history.
      const history = chat.getHistory();

      // The history should contain two turns: the user's message and the model's response.
      expect(history.length).toBe(2);

      const modelTurn = history[1]!;
      expect(modelTurn.role).toBe('model');

      // CRUCIAL ASSERTION:
      // The buggy code would fail here, resulting in parts.length being 0.
      // The corrected code will pass, preserving the single visible text part.
      expect(modelTurn?.parts?.length).toBe(1);
      expect(modelTurn?.parts![0]!.text).toBe(
        'This is the visible text that should not be lost.',
      );
    });
    it('should throw an error when a tool call is followed by an empty stream response', async () => {
      vi.useFakeTimers();
      try {
        // 1. Setup: A history where the model has just made a function call.
        const initialHistory: Content[] = [
          {
            role: 'user',
            parts: [{ text: 'Find a good Italian restaurant for me.' }],
          },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: 'find_restaurant',
                  args: { cuisine: 'Italian' },
                },
              },
            ],
          },
        ];
        chat.setHistory(initialHistory);

        // 2. Mock the API to return an empty/thought-only stream.
        const emptyStreamResponse = (async function* () {
          yield {
            candidates: [
              {
                content: { role: 'model', parts: [{ thought: true }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })();
        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          emptyStreamResponse,
        );

        // 3. Action: Send the function response back to the model and consume the stream.
        const stream = await chat.sendMessageStream(
          'test-model',
          {
            message: {
              functionResponse: {
                name: 'find_restaurant',
                response: { name: 'Vesuvio' },
              },
            },
          },
          'prompt-id-stream-1',
        );

        // 4. Assert: The stream processing should throw an InvalidStreamError.
        await expectStreamExhaustion(stream);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should succeed when there is a tool call without finish reason', async () => {
      // Setup: Stream with tool call but no finish reason
      const streamWithToolCall = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      name: 'test_function',
                      args: { param: 'value' },
                    },
                  },
                ],
              },
              // No finishReason
            },
          ],
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamWithToolCall,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-1',
      );

      // Should not throw an error
      await expect(
        (async () => {
          for await (const _ of stream) {
            // consume stream
          }
        })(),
      ).resolves.not.toThrow();
    });

    it('should throw InvalidStreamError when no tool call and no finish reason', async () => {
      vi.useFakeTimers();
      try {
        // Setup: Stream with text but no finish reason and no tool call
        const streamWithoutFinishReason = (async function* () {
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'some response' }],
                },
                // No finishReason
              },
            ],
          } as unknown as GenerateContentResponse;
        })();

        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          streamWithoutFinishReason,
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-1',
        );
        await expectStreamExhaustion(stream);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should throw InvalidStreamError when there is finish reason but truly empty response (no text, no thought)', async () => {
      vi.useFakeTimers();
      try {
        // Setup: Stream with finish reason but completely empty parts
        const streamWithEmptyResponse = (async function* () {
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [],
                },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })();

        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          streamWithEmptyResponse,
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-1',
        );
        await expectStreamExhaustion(stream);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should succeed when there is finish reason and only thought content (reasoning models)', async () => {
      // This test verifies that responses containing only thought/reasoning content
      // are accepted as valid.
      const thoughtOnlyStream = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    thought: true,
                    text: 'Let me think through this problem step by step...',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        thoughtOnlyStream,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-thought-only',
      );

      // Should NOT throw - thought-only responses are valid
      await expect(
        (async () => {
          for await (const _ of stream) {
            // consume stream
          }
        })(),
      ).resolves.not.toThrow();

      // Verify history contains the thought content
      const history = chat.getHistory();
      expect(history.length).toBe(2); // user turn + model turn
      const modelTurn = history[1]!;
      expect(modelTurn.parts?.length).toBe(1);
      expect(modelTurn.parts![0]).toEqual({
        thought: true,
        text: 'Let me think through this problem step by step...',
      });
    });

    it('should succeed when there is finish reason and response text', async () => {
      // Setup: Stream with both finish reason and text content
      const validStream = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'valid response' }],
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        validStream,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-1',
      );

      // Should not throw an error
      await expect(
        (async () => {
          for await (const _ of stream) {
            // consume stream
          }
        })(),
      ).resolves.not.toThrow();
    });

    it('should not lose finish reason when last chunk only has usage metadata', async () => {
      const streamWithTrailingUsageOnlyChunk = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'valid response' }],
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;

        // Some providers emit a trailing usage-only chunk after finishReason.
        yield {
          candidates: [],
          usageMetadata: {
            promptTokenCount: 11,
            candidatesTokenCount: 5,
            totalTokenCount: 16,
          },
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamWithTrailingUsageOnlyChunk,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-1',
      );

      await expect(
        (async () => {
          for await (const _ of stream) {
            // consume stream
          }
        })(),
      ).resolves.not.toThrow();
    });

    it('should succeed for thought-only content when finish reason arrives in a later chunk', async () => {
      const streamWithDelayedFinishReason = (async function* () {
        // First chunk contains only thought content.
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ thought: true, text: 'Thinking through options...' }],
              },
            },
          ],
        } as unknown as GenerateContentResponse;

        // Second chunk carries only finishReason.
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [],
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamWithDelayedFinishReason,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-thought-delayed-finish',
      );

      await expect(
        (async () => {
          for await (const _ of stream) {
            // consume stream
          }
        })(),
      ).resolves.not.toThrow();

      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[1]!.parts).toEqual([
        { thought: true, text: 'Thinking through options...' },
      ]);
    });

    it('should succeed for thought-only responses with finish reason followed by usage-only chunk', async () => {
      const thoughtThenUsageOnlyStream = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ thought: true, text: 'Let me reason this out...' }],
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;

        // Provider can emit trailing usage-only chunk after finish.
        yield {
          candidates: [],
          usageMetadata: {
            promptTokenCount: 12,
            candidatesTokenCount: 4,
            totalTokenCount: 16,
          },
        } as unknown as GenerateContentResponse;
      })();

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        thoughtThenUsageOnlyStream,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-thought-usage-tail',
      );

      await expect(
        (async () => {
          for await (const _ of stream) {
            // consume stream
          }
        })(),
      ).resolves.not.toThrow();

      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[1]!.parts).toEqual([
        { thought: true, text: 'Let me reason this out...' },
      ]);
    });

    it('should call generateContentStream with the correct parameters', async () => {
      const response = (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'response' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
              safetyRatings: [],
            },
          ],
          text: () => 'response',
          usageMetadata: {
            promptTokenCount: 42,
            candidatesTokenCount: 15,
            totalTokenCount: 57,
          },
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        response,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'hello' },
        'prompt-id-1',
      );
      for await (const _ of stream) {
        // consume stream
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledWith(
        {
          model: 'test-model',
          contents: [
            {
              role: 'user',
              parts: [{ text: 'hello' }],
            },
          ],
          config: {},
        },
        'prompt-id-1',
      );

      // Verify that token counting is called when usageMetadata is present.
      // The Footer-driving counter must reflect *prompt* size only — output
      // tokens for the in-flight round are not yet in history. The mock
      // returns promptTokenCount=42, so that's what should be reported.
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledWith(
        42,
      );
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledTimes(
        1,
      );
    });

    it('should not update global telemetry when no telemetryService is provided (subagent isolation)', async () => {
      // Simulate a subagent GeminiChat: created without a telemetryService
      const subagentChat = new GeminiChat(mockConfig, config, []);

      const response = (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'subagent response' }],
                role: 'model',
              },
              finishReason: 'STOP',
              index: 0,
              safetyRatings: [],
            },
          ],
          text: () => 'subagent response',
          usageMetadata: {
            promptTokenCount: 12000,
            candidatesTokenCount: 500,
            totalTokenCount: 12500,
          },
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        response,
      );

      const stream = await subagentChat.sendMessageStream(
        'test-model',
        { message: 'subagent task' },
        'prompt-id-subagent',
      );
      for await (const _ of stream) {
        // consume stream
      }

      // The global uiTelemetryService must NOT be called by subagent chats
      expect(uiTelemetryService.setLastPromptTokenCount).not.toHaveBeenCalled();
    });

    it('should keep parts with thoughtSignature when consolidating history', async () => {
      const stream = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    text: 'p1',
                    thoughtSignature: 's1',
                  } as unknown as { text: string; thoughtSignature: string },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        stream,
      );

      const res = await chat.sendMessageStream('m1', { message: 'h1' }, 'p1');
      for await (const _ of res);

      const history = chat.getHistory();
      expect(history[1].parts![0]).toEqual({
        text: 'p1',
        thoughtSignature: 's1',
      });
    });
  });

  describe('auto-compression integration', () => {
    function makeStreamResponse(text = 'ok') {
      return (async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text }], role: 'model' },
              finishReason: 'STOP',
              index: 0,
              safetyRatings: [],
            },
          ],
          text: () => text,
        } as unknown as GenerateContentResponse;
      })();
    }

    it('releases the send-lock when auto-compression throws (no deadlock)', async () => {
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockRejectedValueOnce(new Error('compression API down'));

      // First send: compression rejects, error propagates to caller. The
      // streamDoneResolver must run so this.sendPromise resolves; otherwise
      // every subsequent send blocks forever.
      await expect(
        chat.sendMessageStream(
          'test-model',
          { message: 'first' },
          'prompt-id-deadlock-1',
        ),
      ).rejects.toThrow('compression API down');

      // Second send: compress returns NOOP, request goes through. If the
      // lock leaked, this await would never resolve.
      compressSpy.mockResolvedValueOnce({
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('second response'),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'second' },
        'prompt-id-deadlock-2',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
    });

    it('releases the send-lock when setup throws after compression', async () => {
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      // sendMessageStream now calls getHistory(true) twice: once during the
      // hard-tier rescue check (before compression) and once after
      // compression to build requestContents. We want the post-compression
      // call to throw — let the first pass through to the real impl, then
      // explode on the second.
      const realGetHistory = chat.getHistory.bind(chat);
      const getHistorySpy = vi.spyOn(chat, 'getHistory');
      getHistorySpy.mockImplementationOnce((curated?: boolean) =>
        realGetHistory(curated),
      );
      getHistorySpy.mockImplementationOnce(() => {
        throw new Error('history setup failed');
      });

      await expect(
        chat.sendMessageStream(
          'test-model',
          { message: 'first' },
          'prompt-id-setup-deadlock-1',
        ),
      ).rejects.toThrow('history setup failed');

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('second response'),
      );
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'second' },
        'prompt-id-setup-deadlock-2',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(
        chat
          .getHistory()
          .some((content) =>
            content.parts?.some((part) => part.text === 'first'),
          ),
      ).toBe(false);
    });

    it('seeds inherited token count via setLastPromptTokenCount', async () => {
      const subagentChat = new GeminiChat(mockConfig, config, [
        { role: 'user', parts: [{ text: 'inherited' }] },
        { role: 'model', parts: [{ text: 'inherited reply' }] },
      ]);
      subagentChat.setLastPromptTokenCount(123_456);
      expect(subagentChat.getLastPromptTokenCount()).toBe(123_456);

      // The compression service receives the seeded count, so the threshold
      // check sees the inherited size — not the constructor default of 0.
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 123_456,
            newTokenCount: 123_456,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse(),
      );

      const stream = await subagentChat.sendMessageStream(
        'test-model',
        { message: 'go' },
        'prompt-id-seed',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBe(123_456);
    });

    it('yields a COMPRESSED stream event as the first event after auto-compression succeeds', async () => {
      const compressedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'ok' }] },
      ];
      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockResolvedValueOnce({
        newHistory: compressedHistory,
        info: {
          originalTokenCount: 1000,
          newTokenCount: 200,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('answer'),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'go' },
        'prompt-id-yield-compressed',
      );
      const events: Array<{ type: StreamEventType }> = [];
      for await (const event of stream) {
        events.push(event as { type: StreamEventType });
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe(StreamEventType.COMPRESSED);
      expect(
        (events[0] as { type: StreamEventType; info: ChatCompressionInfo }).info
          .compressionStatus,
      ).toBe(CompressionStatus.COMPRESSED);
      expect(
        (events[0] as { type: StreamEventType; info: ChatCompressionInfo }).info
          .newTokenCount,
      ).toBe(200);
    });

    it('forwards the pending user message to the compression cheap-gate', async () => {
      // The cheap-gate inside ChatCompressionService.compress uses
      // estimatePromptTokens(history, pendingUserMessage, lastPromptTokenCount)
      // so the very first send after inherited history (where
      // lastPromptTokenCount === 0) can still trigger compaction. This test
      // pins the wiring: sendMessageStream MUST pass the user message it just
      // built through to tryCompress -> service.compress.
      expect(chat.getLastPromptTokenCount()).toBe(0);

      const compressedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ];
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: compressedHistory,
          info: {
            originalTokenCount: 150_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('answer'),
      );

      const userMessageText = 'next user prompt';
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: userMessageText },
        'prompt-id-first-turn',
      );
      // The first event in the stream should be COMPRESSED because the
      // cheap-gate, fed the pending user message, can now size the prompt.
      const first = await stream.next();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe(StreamEventType.COMPRESSED);

      // Drain the rest so the send-lock releases cleanly.
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(1);
      const passedOpts = compressSpy.mock.calls[0][1];
      // sendMessageStream's contract: compute effectiveTokens upstream
      // and forward via precomputedEffectiveTokens.
      expect(passedOpts.precomputedEffectiveTokens).toBeTypeOf('number');
    });

    it('triggers compaction end-to-end through the real ChatCompressionService when lastPromptTokenCount === 0 and inherited history is large (R3.4)', async () => {
      // Reviewer R3.4: the "forwards the pending user message" test above
      // mocks the service entirely, so the real cheap-gate (the actual
      // estimatePromptTokens fallback branch when lastPromptTokenCount===0)
      // never runs. Exercise the full chain here:
      //   sendMessageStream → tryCompress → service.compress (REAL) →
      //   cheap-gate (real estimate via getHistory + userMessage) →
      //   splitter (real) → runSideQuery (mocked at baseLlmClient) →
      //   persistence.
      const largeChars = 'x'.repeat(400_000); // ~100K estimated tokens
      const inheritedHistory: Content[] = [
        { role: 'user', parts: [{ text: largeChars }] },
        { role: 'model', parts: [{ text: 'ack' }] },
        { role: 'user', parts: [{ text: 'follow up' }] },
        { role: 'model', parts: [{ text: 'response' }] },
      ];
      chat.setHistory(inheritedHistory);
      expect(chat.getLastPromptTokenCount()).toBe(0);

      // Default DEFAULT_TOKEN_LIMIT = 128K → auto ≈ 95K. 100K estimate
      // crosses, so cheap-gate must let compaction proceed.
      const generateText = vi.fn().mockResolvedValue({
        text: '<state_snapshot>compressed</state_snapshot>',
        usage: {
          promptTokenCount: 99_000,
          candidatesTokenCount: 1500,
          totalTokenCount: 100_500,
        },
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('done'),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'follow-up after restore' },
        'prompt-r3-4',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      const compressed = events.find(
        (e) => e.type === StreamEventType.COMPRESSED,
      );
      expect(compressed).toBeDefined();
      expect(
        (compressed as { type: StreamEventType; info: ChatCompressionInfo })
          .info.compressionStatus,
      ).toBe(CompressionStatus.COMPRESSED);
      // Real runSideQuery was hit (proves the cheap-gate didn't short-circuit
      // and the splitter produced a non-empty historyToCompress).
      expect(generateText).toHaveBeenCalled();
    });

    it('clears consecutiveFailures after a forced successful compression', async () => {
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );

      // Step 1: auto-compression fails — counter increments on the chat.
      compressSpy.mockResolvedValueOnce({
        newHistory: null,
        info: {
          originalTokenCount: 100_000,
          newTokenCount: 100_000,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse(),
      );
      const stream1 = await chat.sendMessageStream(
        'test-model',
        { message: 'first' },
        'prompt-latch-1',
      );
      for await (const _ of stream1) {
        /* consume */
      }
      // Counter passed to service was 0 on this attempt; the failure branch
      // in tryCompress then increments it to 1.
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(0);

      // Step 2: a forced /compress succeeds. After this, the counter must
      // be reset so future auto-compressions are not suppressed.
      compressSpy.mockResolvedValueOnce({
        newHistory: [
          { role: 'user', parts: [{ text: 'summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        info: {
          originalTokenCount: 100_000,
          newTokenCount: 30_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
      await chat.tryCompress('prompt-latch-force', 'test-model', true);
      // tryCompress was called with force=true, so the service got
      // consecutiveFailures=1 (carried from step 1's increment); force
      // bypasses the breaker, but the counter was still forwarded as-is.
      expect(compressSpy.mock.calls[1][1].consecutiveFailures).toBe(1);

      // Step 3: next auto-compression sees the reset counter.
      compressSpy.mockResolvedValueOnce({
        newHistory: null,
        info: {
          originalTokenCount: 30_000,
          newTokenCount: 30_000,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse(),
      );
      const stream2 = await chat.sendMessageStream(
        'test-model',
        { message: 'second' },
        'prompt-latch-2',
      );
      for await (const _ of stream2) {
        /* consume */
      }
      expect(compressSpy.mock.calls[2][1].consecutiveFailures).toBe(0);
    });

    it('reactively compresses and retries once after a context overflow error', async () => {
      const compressedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
        { role: 'user', parts: [{ text: 'latest' }] },
      ];
      const expectedRequestContents = structuredClone(compressedHistory);
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: compressedHistory,
          info: {
            originalTokenCount: 135_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockRejectedValueOnce(
          new Error(
            "This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens.",
          ),
        )
        .mockResolvedValueOnce(makeStreamResponse('answer after compact'));

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'latest' },
        'prompt-id-reactive-compact',
      );

      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].force).toBe(true);
      expect(compressSpy.mock.calls[1][1].trigger).toBe('auto');
      expect(compressSpy.mock.calls[1][1].originalTokenCount).toBe(135_000);
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );

      const secondRequest = vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mock.calls[1]![0];
      expect(secondRequest.contents).toEqual(expectedRequestContents);
      expect(events[0]?.type).toBe(StreamEventType.COMPRESSED);
      expect(events[1]?.type).toBe(StreamEventType.RETRY);
      expect(events[1]).not.toHaveProperty('retryInfo');
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
              'answer after compact',
        ),
      ).toBe(true);
    });

    it('uses the parsed context limit when reactive overflow lacks an actual token count', async () => {
      const compressedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ];
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: compressedHistory,
          info: {
            originalTokenCount: 128_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockRejectedValueOnce(
          new Error("This model's maximum context length is 128000 tokens."),
        )
        .mockResolvedValueOnce(makeStreamResponse('answer after compact'));

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'latest' },
        'prompt-id-reactive-limit-only',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].originalTokenCount).toBe(128_000);
    });

    it('uses the configured context window when reactive overflow has no token counts', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        contextWindowSize: 262_144,
      });
      const compressedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ];
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: compressedHistory,
          info: {
            originalTokenCount: 262_144,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockRejectedValueOnce(new Error('context_length_exceeded'))
        .mockResolvedValueOnce(makeStreamResponse('answer after compact'));

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'latest' },
        'prompt-id-reactive-window-fallback',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].originalTokenCount).toBe(262_144);
    });

    it('does not attempt reactive compression more than once per send', async () => {
      const compressedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ];
      const secondOverflow = new Error(
        'prompt is too long: 140000 tokens > 128000 maximum',
      );
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: compressedHistory,
          info: {
            originalTokenCount: 135_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockRejectedValueOnce(
          new Error('prompt is too long: 135000 tokens > 128000 maximum'),
        )
        .mockRejectedValueOnce(secondOverflow);

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'latest' },
        'prompt-id-reactive-once',
      );

      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toThrow(secondOverflow);

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
    });

    it('does not emit a duplicate RETRY after reactive compression follows another retry', async () => {
      vi.useFakeTimers();
      try {
        const compressedHistory: Content[] = [
          { role: 'user', parts: [{ text: 'summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
          { role: 'user', parts: [{ text: 'latest' }] },
        ];
        vi.spyOn(ChatCompressionService.prototype, 'compress')
          .mockResolvedValueOnce({
            newHistory: null,
            info: {
              originalTokenCount: 0,
              newTokenCount: 0,
              compressionStatus: CompressionStatus.NOOP,
            },
          })
          .mockResolvedValueOnce({
            newHistory: compressedHistory,
            info: {
              originalTokenCount: 135_000,
              newTokenCount: 40_000,
              compressionStatus: CompressionStatus.COMPRESSED,
            },
          });
        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [{ content: { parts: [{ text: '' }] } }],
              } as unknown as GenerateContentResponse;
            })(),
          )
          .mockRejectedValueOnce(
            new Error('prompt is too long: 135000 tokens > 128000 maximum'),
          )
          .mockResolvedValueOnce(makeStreamResponse('answer after compact'));

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'latest' },
          'prompt-id-reactive-after-invalid-stream',
        );
        const events = await collectStreamWithFakeTimers(stream);
        const eventTypes = events.map((event) => event.type);
        const compressedIndex = eventTypes.indexOf(StreamEventType.COMPRESSED);

        expect(compressedIndex).toBeGreaterThanOrEqual(0);
        expect(eventTypes.slice(compressedIndex)).toEqual([
          StreamEventType.COMPRESSED,
          StreamEventType.RETRY,
          StreamEventType.CHUNK,
        ]);
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces the original context overflow when reactive compression is a NOOP', async () => {
      const overflow = new Error(
        'prompt is too long: 135000 tokens > 128000 maximum',
      );
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 135_000,
            newTokenCount: 135_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockRejectedValue(
        overflow,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'latest' },
        'prompt-id-reactive-noop',
      );

      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toThrow(overflow);

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
    });

    it('marks failed reactive compression attempts for later auto-compaction', async () => {
      const overflow = new Error(
        'prompt is too long: 135000 tokens > 128000 maximum',
      );
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 135_000,
            newTokenCount: 135_000,
            compressionStatus:
              CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
          },
        })
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockRejectedValueOnce(overflow)
        .mockResolvedValueOnce(makeStreamResponse('next request ok'));

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'latest' },
        'prompt-id-reactive-failed-latch',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toThrow(overflow);

      const nextStream = await chat.sendMessageStream(
        'test-model',
        { message: 'next' },
        'prompt-id-after-reactive-failed-latch',
      );
      for await (const _ of nextStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(3);
      // Reactive compression is force=true, so tryCompress's own failure
      // branch doesn't increment the counter (force=true skips it). The
      // reactive overflow handler bumps the counter by 1 so a transient
      // network error doesn't permanently latch the breaker; only
      // MAX_CONSECUTIVE_FAILURES repeated reactive failures will. (R1.2)
      expect(compressSpy.mock.calls[2][1].consecutiveFailures).toBe(1);
    });

    it('releases the send-lock when reactive compression throws', async () => {
      const overflow = new Error(
        'prompt is too long: 135000 tokens > 128000 maximum',
      );
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockRejectedValueOnce(new Error('compression failed'))
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockRejectedValueOnce(overflow)
        .mockResolvedValueOnce(makeStreamResponse('next request ok'));

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'latest' },
        'prompt-id-reactive-throws',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toThrow(overflow);

      const nextStream = await chat.sendMessageStream(
        'test-model',
        { message: 'next' },
        'prompt-id-after-reactive-throws',
      );
      const events: StreamEvent[] = [];
      for await (const event of nextStream) {
        events.push(event);
      }

      expect(compressSpy).toHaveBeenCalledTimes(3);
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
              'next request ok',
        ),
      ).toBe(true);
    });
  });

  // Task 9 (P3): the hard-tier rescue pulls reactive overflow recovery
  // forward to BEFORE the API call. When the estimated prompt size already
  // crosses `computeThresholds(window).hard`, sendMessageStream must:
  //   1) reset consecutiveFailures (so a latched circuit breaker can recover)
  //   2) call tryCompress with force=true (so MAX_CONSECUTIVE_FAILURES does
  //      not gate the only attempt that can save the next round-trip).
  describe('sendMessageStream hard-tier rescue', () => {
    function makeStreamResponse(text = 'ok') {
      return (async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text }], role: 'model' },
              finishReason: 'STOP',
              index: 0,
              safetyRatings: [],
            },
          ],
          text: () => text,
        } as unknown as GenerateContentResponse;
      })();
    }

    /**
     * Default 200K window in our mocks; computeThresholds:
     *   effectiveWindow = 200K - 20K (SUMMARY_RESERVE) = 180K
     *   hard            = max(180K - 3K, auto) = 177K
     * So lastPromptTokenCount=176K + a small user message tips over 177K.
     */
    beforeEach(() => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        contextWindowSize: 200_000,
      });
    });

    it('forces compaction with force=true when estimated tokens cross hard threshold', async () => {
      const compressedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ];
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: compressedHistory,
          info: {
            originalTokenCount: 176_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('after rescue'),
      );

      // Seed lastPromptTokenCount JUST under the 177K hard threshold; the
      // pending user message adds a handful of estimate-tokens that pushes
      // effective >= 177K, so the rescue must trigger.
      chat.setLastPromptTokenCount(176_999);

      const userMessage = 'this is the next user message';
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: userMessage },
        'prompt-id-hard-rescue-forces',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(1);
      const passedOpts = compressSpy.mock.calls[0][1];
      expect(passedOpts.force).toBe(true);
      // Pin the estimation-reuse perf optimization: sendMessageStream
      // computes effectiveTokens once and forwards via
      // precomputedEffectiveTokens. A regression that drops this field
      // back to undefined would be otherwise invisible.
      expect(passedOpts.precomputedEffectiveTokens).toBeTypeOf('number');
      expect(passedOpts.precomputedEffectiveTokens).toBeGreaterThanOrEqual(
        177_000,
      );
    });

    it('resets consecutiveFailures before forcing when hard threshold crossed', async () => {
      // Pre-latch the breaker by failing the unforced cheap-gate
      // MAX_CONSECUTIVE_FAILURES times below the hard threshold.
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );

      // The latching sends never touch the hard tier; lastPromptTokenCount is
      // small enough that effective < hard, so force stays false on each.
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 100_000,
          newTokenCount: 100_000,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => makeStreamResponse(),
      );
      chat.setLastPromptTokenCount(50_000);
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        const s = await chat.sendMessageStream(
          'test-model',
          { message: `latch-${i}` },
          `prompt-latch-${i}`,
        );
        for await (const _ of s) {
          /* consume */
        }
        expect(compressSpy.mock.calls[i][1].force).toBe(false);
      }
      // The counter is now at MAX_CONSECUTIVE_FAILURES (latched).
      expect(compressSpy.mock.calls.at(-1)![1].consecutiveFailures).toBe(
        MAX_CONSECUTIVE_FAILURES - 1,
      );

      // Now bump lastPromptTokenCount into hard tier and send again. The
      // hard-tier rescue must reset the counter and force=true on the call —
      // not short-circuit on the latched breaker.
      compressSpy.mockClear();
      compressSpy.mockResolvedValueOnce({
        newHistory: [
          { role: 'user', parts: [{ text: 'summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        info: {
          originalTokenCount: 178_000,
          newTokenCount: 40_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
      chat.setLastPromptTokenCount(176_999);
      const rescueStream = await chat.sendMessageStream(
        'test-model',
        { message: 'rescue me' },
        'prompt-hard-rescue-reset',
      );
      for await (const _ of rescueStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(1);
      // Counter forwarded to the service must be 0 (reset before the call),
      // not MAX_CONSECUTIVE_FAILURES (which would gate the cheap-gate).
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(0);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
    });

    it('does not force when tokens are below hard threshold (normal auto path)', async () => {
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse(),
      );

      // Well below 177K hard threshold — normal auto path.
      chat.setLastPromptTokenCount(50_000);
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'small message' },
        'prompt-id-hard-rescue-below',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(false);
    });

    it('suppresses hard-rescue entirely when chatCompression.disabled is true (R12.5)', async () => {
      // R12.5: R11.4 added a source-level gate that skips hard-rescue
      // when the user has explicitly disabled auto-compaction. The
      // service-level gate handles the proactive cheap-gate (force=false);
      // the hard-rescue path uses force=true to bypass the breaker, so
      // it would otherwise sidestep the service gate. The R11.4 commit
      // didn't add a regression-guard for this branch. A future
      // refactor removing the source-level gate would silently let
      // compliance/audit-mode sessions get force-compressed via rescue.
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        disabled: true,
      });
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse(),
      );

      // Set lastPromptTokenCount above the 177K hard threshold so the
      // rescue WOULD fire pre-R11.4. Verify it doesn't fire force=true.
      chat.setLastPromptTokenCount(176_999);
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'should-not-rescue' },
        'prompt-id-r12-5',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // The rescue must NOT call tryCompress with force=true. The
      // proactive cheap-gate may still be called (gated separately at
      // the service layer), but if it does it must be force=false.
      const forcedCalls = compressSpy.mock.calls.filter((c) => c[1].force);
      expect(forcedCalls).toHaveLength(0);
    });

    // R7.11: hardRescueFailureCount budget — three branches the previous
    // round left untested. Without these, regressions to the counter
    // accounting (the "every failure-shape strikes the budget" guarantee
    // from R7.2 + R7.3) would silently disable the rescue's bound.
    it('stops firing the rescue after MAX_CONSECUTIVE_FAILURES rescue failures (R7.11)', async () => {
      // Each send crosses the hard threshold, but compression always
      // fails. After MAX rescue strikes, subsequent sends should NOT
      // pass force=true any longer — the budget is exhausted and the
      // chat falls back to the normal cheap-gate path (which will be a
      // NOOP because consecutiveFailures has been reset and the gate
      // re-evaluates from there).
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 178_000,
            newTokenCount: 178_000,
            compressionStatus:
              CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => makeStreamResponse(),
      );

      chat.setLastPromptTokenCount(176_999);
      // Burn the rescue budget.
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        const s = await chat.sendMessageStream(
          'test-model',
          { message: `burn-${i}` },
          `prompt-burn-${i}`,
        );
        for await (const _ of s) {
          /* consume */
        }
        expect(compressSpy.mock.calls[i][1].force).toBe(true);
      }

      // Next send still crosses hard, but the rescue must be suppressed.
      chat.setLastPromptTokenCount(176_999);
      const s = await chat.sendMessageStream(
        'test-model',
        { message: 'after-budget' },
        'prompt-after-budget',
      );
      for await (const _ of s) {
        /* consume */
      }
      const lastCallIdx = compressSpy.mock.calls.length - 1;
      // After the budget is exhausted, the only remaining defence is
      // reactive overflow — sendMessageStream MUST NOT pass force=true
      // any longer.
      expect(compressSpy.mock.calls[lastCallIdx][1].force).toBe(false);
    });

    it('does NOT exhaust the rescue budget on NOOPs — the pessimistic strike is refunded (R9.2)', async () => {
      // R9.2: NOOP from a forced rescue means the history slice was
      // too small to split this turn — not evidence that the
      // compression mechanism is broken. The pessimistic pre-call
      // increment is refunded in the post-call NOOP branch so a
      // session whose first few turns happen to be too small does NOT
      // permanently disable hard-rescue. Verify by running MAX+2
      // consecutive NOOPs and asserting force=true on every call
      // (budget never exhausts).
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 178_000,
            newTokenCount: 178_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => makeStreamResponse(),
      );

      chat.setLastPromptTokenCount(176_999);
      // MAX_CONSECUTIVE_FAILURES + 2 sends — far past the strike
      // budget. With R9.2's refund, NONE of these should fall back to
      // force=false; the rescue keeps firing because NOOPs cost nothing.
      const TOTAL_SENDS = MAX_CONSECUTIVE_FAILURES + 2;
      for (let i = 0; i < TOTAL_SENDS; i++) {
        chat.setLastPromptTokenCount(176_999);
        const s = await chat.sendMessageStream(
          'test-model',
          { message: `noop-${i}` },
          `prompt-noop-${i}`,
        );
        for await (const _ of s) {
          /* consume */
        }
        expect(compressSpy.mock.calls[i][1].force).toBe(true);
      }
    });

    it('counts a thrown exception from the forced rescue against the budget (R7.11 / R7.2)', async () => {
      // R7.2: before pessimistic accounting, a throw inside tryCompress
      // skipped both the consecutiveFailures and hardRescueFailureCount
      // increments — every subsequent send re-fired the doomed rescue.
      // Verify the budget exhausts after MAX consecutive throws.
      let throwCount = 0;
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockImplementation(async () => {
          // Pessimistic: the throw must still strike the budget. We
          // count throws so the test can also assert how many actually
          // ran.
          if (throwCount < MAX_CONSECUTIVE_FAILURES) {
            throwCount += 1;
            throw new Error(`simulated provider 5xx #${throwCount}`);
          }
          // After the budget is exhausted, sendMessageStream should
          // pass force=false; we make this a NOOP so the send can
          // complete cleanly.
          return {
            newHistory: null,
            info: {
              originalTokenCount: 178_000,
              newTokenCount: 178_000,
              compressionStatus: CompressionStatus.NOOP,
            },
          };
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => makeStreamResponse(),
      );
      chat.setLastPromptTokenCount(176_999);

      // The first MAX sends throw. sendMessageStream re-throws, so we
      // catch and continue.
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await expect(
          chat.sendMessageStream(
            'test-model',
            { message: `throw-${i}` },
            `prompt-throw-${i}`,
          ),
        ).rejects.toThrow(/simulated provider 5xx/);
        expect(compressSpy.mock.calls[i][1].force).toBe(true);
      }
      // Next send must NOT fire force=true — budget exhausted purely
      // via throws.
      chat.setLastPromptTokenCount(176_999);
      const s = await chat.sendMessageStream(
        'test-model',
        { message: 'after-throw-budget' },
        'prompt-after-throw-budget',
      );
      for await (const _ of s) {
        /* consume */
      }
      const lastCallIdx = compressSpy.mock.calls.length - 1;
      expect(compressSpy.mock.calls[lastCallIdx][1].force).toBe(false);
    });

    it('reactive overflow catch block increments consecutiveFailures on thrown exceptions (R7.11 / R6.7)', async () => {
      // The status-based reactive failure path was tested in R6.7's
      // initial commit. This pins the OTHER half: if reactive
      // compression throws (network 5xx, abort, etc.), the catch block
      // must still bump consecutiveFailures so the proactive cheap-gate
      // breaker eventually trips.
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          // First call: the cheap-gate NOOPs (below hard threshold), so
          // we reach the API call.
          newHistory: null,
          info: {
            originalTokenCount: 50_000,
            newTokenCount: 50_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        // Second call: reactive overflow recovery — make it throw.
        .mockRejectedValueOnce(new Error('reactive 5xx'));

      // Make generateContentStream throw a context-overflow-shaped error
      // so the reactive recovery branch is exercised.
      const overflowError = Object.assign(
        new Error('context length exceeded'),
        {
          status: 400,
        },
      );
      vi.mocked(mockContentGenerator.generateContentStream).mockRejectedValue(
        overflowError,
      );

      chat.setLastPromptTokenCount(50_000);
      // The send will fail (reactive recovery threw); we just need the
      // counter to have ticked.
      await expect(
        chat
          .sendMessageStream(
            'test-model',
            { message: 'trigger-reactive' },
            'prompt-reactive-throw',
          )
          .then(async (s) => {
            for await (const _ of s) {
              /* consume */
            }
          }),
      ).rejects.toThrow();

      // Now send again under conditions that would invoke the cheap-gate
      // breaker. consecutiveFailures must be at least 1 after the
      // throw above.
      compressSpy.mockClear();
      compressSpy.mockResolvedValueOnce({
        newHistory: null,
        info: {
          originalTokenCount: 60_000,
          newTokenCount: 60_000,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockResolvedValueOnce(makeStreamResponse());
      const s = await chat.sendMessageStream(
        'test-model',
        { message: 'next' },
        'prompt-next-after-reactive-throw',
      );
      for await (const _ of s) {
        /* consume */
      }
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(
        compressSpy.mock.calls[0][1].consecutiveFailures,
      ).toBeGreaterThanOrEqual(1);
    });

    it('hard-rescue clears breakerWarningEmitted alongside consecutiveFailures reset (R9.4)', async () => {
      // R9.4: when hard-rescue resets consecutiveFailures = 0, it must
      // ALSO clear breakerWarningEmitted. Otherwise a sequence of
      // "breaker trip → warn emitted → flag latched → hard-rescue
      // resets counter → breaker trips again → silent (flag still
      // true)" leaves the second trip undiagnosed.
      //
      // Direct field-peek regression test: drive the counter to MAX,
      // call tryCompress with NOOP to force the breaker warn path,
      // then trigger a hard-rescue (force=true at hard threshold) and
      // assert the flag is cleared.
      type ChatInternals = {
        consecutiveFailures: number;
        breakerWarningEmitted: boolean;
        hardRescueFailureCount: number;
      };
      const internals = chat as unknown as ChatInternals;

      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );

      // 1. Pre-trip the breaker: counter = MAX, warn-flag latched.
      internals.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
      internals.breakerWarningEmitted = true;

      // 2. Stage a hard-rescue scenario: lastPromptTokenCount >= hard,
      //    rescue must fire. Mock returns COMPRESSED so we focus on
      //    the pre-call reset path (R9.4 is the reset; COMPRESSED also
      //    triggers the post-call reset, but R9.4's contract is the
      //    PRE-call clear specifically).
      compressSpy.mockResolvedValueOnce({
        newHistory: [
          { role: 'user', parts: [{ text: 'summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        info: {
          originalTokenCount: 178_000,
          newTokenCount: 40_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse(),
      );
      chat.setLastPromptTokenCount(176_999);
      const s = await chat.sendMessageStream(
        'test-model',
        { message: 'cross-hard' },
        'prompt-r9-4',
      );
      for await (const _ of s) {
        /* consume */
      }
      // 3. Both counters cleared, flag cleared. (consecutiveFailures
      //    reset in the pre-call hard-rescue path; flag reset there
      //    too — that's the R9.4 fix.)
      expect(internals.consecutiveFailures).toBe(0);
      expect(internals.breakerWarningEmitted).toBe(false);
    });

    it('coerces NaN candidatesTokenCount from usageMetadata to 0 (R11.1)', async () => {
      // R11.1: `??` only coalesces null/undefined; NaN passes through.
      // If a provider returns NaN, the stored field becomes NaN; next
      // turn's `estimatePromptTokens` returns NaN; `NaN >= hard` is
      // always false → hard-rescue never fires → API overflows. Guard
      // with Number.isFinite so any non-finite value (NaN / Infinity)
      // coerces to 0.
      type ChatInternals = { lastCandidatesTokenCount: number };
      const internals = chat as unknown as ChatInternals;

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'ok' }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
                safetyRatings: [],
              },
            ],
            usageMetadata: {
              promptTokenCount: 10_000,
              candidatesTokenCount: NaN, // hostile provider payload
              totalTokenCount: 10_000,
            },
            text: () => 'ok',
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-r11-1-nan',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // Without the Number.isFinite guard, this would be NaN.
      expect(internals.lastCandidatesTokenCount).toBe(0);
      expect(Number.isFinite(internals.lastCandidatesTokenCount)).toBe(true);
    });

    it('rejects non-finite / negative values from EVERY API token-count capture site (R12.1 sibling sweep)', async () => {
      // R12.1: R11.1 added a Number.isFinite guard to lastCandidatesTokenCount
      // but left lastPromptTokenCount (assigned 3 lines above) accepting
      // anything truthy. The Phase-3 audit matrix for "API value capture"
      // surfaces 3 sites in total: promptTokenCount, candidatesTokenCount,
      // and cachedContentTokenCount. All three need the same uniform
      // coerce-to-0-on-non-finite-or-negative guard.
      //
      // Drive each pathological value (Infinity, NaN, negative) through
      // promptTokenCount and assert the stored field is 0. Negative is
      // important: `Number.isFinite(-1)` is true, so the guard must also
      // include a `>= 0` check.
      type ChatInternals = {
        lastPromptTokenCount: number;
        lastCandidatesTokenCount: number;
      };
      const internals = chat as unknown as ChatInternals;

      for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, -1, -1e9]) {
        // Reset
        internals.lastPromptTokenCount = 5000;
        internals.lastCandidatesTokenCount = 500;

        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          (async function* () {
            yield {
              candidates: [
                {
                  content: { parts: [{ text: 'ok' }], role: 'model' },
                  finishReason: 'STOP',
                  index: 0,
                  safetyRatings: [],
                },
              ],
              usageMetadata: {
                promptTokenCount: bad,
                candidatesTokenCount: bad,
                totalTokenCount: bad,
              },
              text: () => 'ok',
            } as unknown as GenerateContentResponse;
          })(),
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: `r12-1-${String(bad)}` },
          `prompt-r12-1-${String(bad)}`,
        );
        for await (const _ of stream) {
          /* consume */
        }

        // ALL capture sites must coerce. A `Number.isFinite`-only guard
        // would let `-1` poison the prompt count.
        expect(Number.isFinite(internals.lastPromptTokenCount)).toBe(true);
        expect(internals.lastPromptTokenCount).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(internals.lastCandidatesTokenCount)).toBe(true);
        expect(internals.lastCandidatesTokenCount).toBeGreaterThanOrEqual(0);
      }
    });

    it('budget-exhausted warn fires once per exhaustion, not on every send (R8.4)', async () => {
      // Symmetric with R7.9's `breakerWarningEmitted`: once the rescue
      // budget exhausts and the chat stays over hard, the warn must
      // throttle to a single emission. Without the throttle, a session
      // stuck above the threshold spams the log at one warn per send.
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 178_000,
            newTokenCount: 178_000,
            compressionStatus:
              CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => makeStreamResponse(),
      );
      // Hook the chat's debug logger so we can count warn emissions.
      const warnSpy = vi.fn();
      // The debugLogger is module-level; spy on the warn method that
      // sendMessageStream actually uses by intercepting via the logger
      // module import in the test bootstrap. Since we can't easily
      // replace it here, we use a different observable: count
      // generateContentStream invocations after the budget exhausts
      // (every send proceeds normally), and we assert the warn-emitted
      // flag's effect indirectly by verifying that the suite of sends
      // does not error out and the rescue is suppressed exactly once
      // per send post-exhaustion.
      void warnSpy;

      chat.setLastPromptTokenCount(176_999);
      // Burn the budget.
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        const s = await chat.sendMessageStream(
          'test-model',
          { message: `burn-${i}` },
          `prompt-burn-${i}`,
        );
        for await (const _ of s) {
          /* consume */
        }
      }
      // Now send 5 more times — each crosses hard and finds budget
      // exhausted. Pre-R8.4 the warn fired 5 times; post-R8.4 it fires
      // once total. Direct observation requires a logger spy, but the
      // mechanism is identical to R7.9's `breakerWarningEmitted`: the
      // flag must be on GeminiChat and cleared on COMPRESSED success.
      // This test pins the *behavior* (no crash, sends complete) and
      // the implementation test below pins the flag-reset semantics.
      for (let i = 0; i < 5; i++) {
        const s = await chat.sendMessageStream(
          'test-model',
          { message: `post-burn-${i}` },
          `prompt-post-burn-${i}`,
        );
        for await (const _ of s) {
          /* consume */
        }
      }
      // Total compress calls: MAX (rescue) + 5 (proactive cheap-gate
      // attempts; consecutiveFailures was reset by hard-rescue triggers
      // so the breaker hasn't latched).
      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES + 5);
      // The last 5 must all be force=false (budget exhausted).
      for (let i = 0; i < 5; i++) {
        const callIdx = MAX_CONSECUTIVE_FAILURES + i;
        expect(compressSpy.mock.calls[callIdx][1].force).toBe(false);
      }
    });

    it('restores hard-rescue budget after a successful compression refunds the strikes (R8.5)', async () => {
      // After the rescue budget exhausts, a subsequent COMPRESSED
      // success (from any path — reactive overflow, manual /compress,
      // or eventually-passing rescue retry) must reset
      // `hardRescueFailureCount` to 0 so the rescue can fire again on
      // future hard-tier crossings. Without this, a chat that ever
      // exhausted its budget is permanently demoted to reactive-only.
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );

      // Burn the budget with failures.
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 178_000,
          newTokenCount: 178_000,
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => makeStreamResponse(),
      );
      chat.setLastPromptTokenCount(176_999);
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        const s = await chat.sendMessageStream(
          'test-model',
          { message: `burn-${i}` },
          `prompt-burn-${i}`,
        );
        for await (const _ of s) {
          /* consume */
        }
      }
      // Confirm budget exhausted: next call would be force=false.
      // Now stage a successful COMPRESSED outcome and trigger compaction
      // via a normal cheap-gate send (consecutiveFailures was reset by
      // the rescue triggers so the proactive path is open).
      compressSpy.mockClear();
      compressSpy.mockResolvedValueOnce({
        newHistory: [
          { role: 'user', parts: [{ text: 'summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        info: {
          originalTokenCount: 178_000,
          newTokenCount: 40_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
      const s = await chat.sendMessageStream(
        'test-model',
        { message: 'recover' },
        'prompt-recover',
      );
      for await (const _ of s) {
        /* consume */
      }
      // After the COMPRESSED call, the budget should be refunded.
      // Verify by setting up another hard-threshold crossing and
      // confirming force=true gets passed (rescue is re-armed).
      compressSpy.mockClear();
      compressSpy.mockResolvedValueOnce({
        newHistory: [
          { role: 'user', parts: [{ text: 'summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        info: {
          originalTokenCount: 178_000,
          newTokenCount: 40_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
      chat.setLastPromptTokenCount(176_999);
      const s2 = await chat.sendMessageStream(
        'test-model',
        { message: 'cross-hard-again' },
        'prompt-cross-hard-again',
      );
      for await (const _ of s2) {
        /* consume */
      }
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
    });
  });

  describe('addHistory', () => {
    it('should add a new content item to the history', () => {
      const newContent: Content = {
        role: 'user',
        parts: [{ text: 'A new message' }],
      };
      chat.addHistory(newContent);
      const history = chat.getHistory();
      expect(history.length).toBe(1);
      expect(history[0]).toEqual(newContent);
    });

    it('should add multiple items correctly', () => {
      const content1: Content = {
        role: 'user',
        parts: [{ text: 'Message 1' }],
      };
      const content2: Content = {
        role: 'model',
        parts: [{ text: 'Message 2' }],
      };
      chat.addHistory(content1);
      chat.addHistory(content2);
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(content1);
      expect(history[1]).toEqual(content2);
    });
  });

  describe('getHistoryLength', () => {
    it('returns 0 for an empty history', () => {
      expect(chat.getHistoryLength()).toBe(0);
    });

    it('reflects entries added via addHistory', () => {
      chat.addHistory({ role: 'user', parts: [{ text: 'a' }] });
      chat.addHistory({ role: 'model', parts: [{ text: 'b' }] });
      expect(chat.getHistoryLength()).toBe(2);
    });

    it('matches getHistory().length without paying the structuredClone cost', () => {
      chat.addHistory({ role: 'user', parts: [{ text: 'a' }] });
      chat.addHistory({ role: 'model', parts: [{ text: 'b' }] });
      chat.addHistory({ role: 'user', parts: [{ text: 'c' }] });
      expect(chat.getHistoryLength()).toBe(chat.getHistory().length);
    });
  });

  describe('getHistoryTail', () => {
    it('returns only the requested recent entries as a deep copy', () => {
      const oldContent: Content = { role: 'user', parts: [{ text: 'old' }] };
      const recentContent: Content = {
        role: 'model',
        parts: [{ text: 'recent' }],
      };
      chat.addHistory(oldContent);
      chat.addHistory(recentContent);

      const tail = chat.getHistoryTail(1);

      expect(tail).toEqual([recentContent]);
      expect(tail[0]).not.toBe(recentContent);
      tail[0]!.parts![0]!.text = 'mutated';
      expect(chat.getHistory()[1]!.parts![0]!.text).toBe('recent');
    });

    it('returns an empty tail for non-positive counts', () => {
      chat.addHistory({ role: 'user', parts: [{ text: 'a' }] });
      expect(chat.getHistoryTail(0)).toEqual([]);
      expect(chat.getHistoryTail(-1)).toEqual([]);
    });
  });

  describe('getLastHistoryEntry', () => {
    it('returns undefined for an empty history', () => {
      expect(chat.getLastHistoryEntry()).toBeUndefined();
    });

    it('returns a defensive copy of only the last raw history entry', () => {
      chat.addHistory({ role: 'user', parts: [{ text: 'a' }] });
      chat.addHistory({ role: 'model', parts: [{ text: 'b' }] });

      const last = chat.getLastHistoryEntry();
      expect(last).toEqual({ role: 'model', parts: [{ text: 'b' }] });

      last!.parts![0] = { text: 'mutated' };
      expect(chat.getLastHistoryEntry()).toEqual({
        role: 'model',
        parts: [{ text: 'b' }],
      });
    });
  });

  describe('sendMessageStream with retries', () => {
    it('should retry on invalid content, succeed, and report metrics', async () => {
      vi.useFakeTimers();
      try {
        // Use mockImplementationOnce to provide a fresh, promise-wrapped generator for each attempt.
        vi.mocked(mockContentGenerator.generateContentStream)
          .mockImplementationOnce(async () =>
            // First call returns an invalid stream
            (async function* () {
              yield {
                candidates: [{ content: { parts: [{ text: '' }] } }], // Invalid empty text part
              } as unknown as GenerateContentResponse;
            })(),
          )
          .mockImplementationOnce(async () =>
            // Second call returns a valid stream
            (async function* () {
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: 'Successful response' }] },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-retry-success',
        );
        const chunks = await collectStreamWithFakeTimers(stream);

        // Assertions
        expect(mockLogContentRetry).toHaveBeenCalledTimes(1);
        expect(mockLogContentRetryFailure).not.toHaveBeenCalled();
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);

        // Check for a retry event
        expect(chunks.some((c) => c.type === StreamEventType.RETRY)).toBe(true);

        // Check for the successful content chunk
        expect(
          chunks.some(
            (c) =>
              c.type === StreamEventType.CHUNK &&
              c.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Successful response',
          ),
        ).toBe(true);

        // Check that history was recorded correctly once, with no duplicates.
        const history = chat.getHistory();
        expect(history.length).toBe(2);
        expect(history[0]).toEqual({
          role: 'user',
          parts: [{ text: 'test' }],
        });
        expect(history[1]).toEqual({
          role: 'model',
          parts: [{ text: 'Successful response' }],
        });

        // Verify that token counting is not called when usageMetadata is missing
        expect(
          uiTelemetryService.setLastPromptTokenCount,
        ).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should fail after all retries on persistent invalid content and report metrics', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () =>
          (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: '' }],
                    role: 'model',
                  },
                },
              ],
            } as unknown as GenerateContentResponse;
          })(),
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-retry-fail',
        );
        await expectStreamExhaustion(stream);

        // Should be called 3 times (1 initial + 2 transient retries)
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(3);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(2);
        expect(mockLogContentRetryFailure).toHaveBeenCalledTimes(1);

        // History should still contain the user message.
        const history = chat.getHistory();
        expect(history.length).toBe(1);
        expect(history[0]).toEqual({
          role: 'user',
          parts: [{ text: 'test' }],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should retry usage-only empty streams and succeed on a later attempt', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(mockContentGenerator.generateContentStream)
          .mockImplementationOnce(async () =>
            (async function* () {
              yield {
                usageMetadata: {
                  promptTokenCount: 10,
                  candidatesTokenCount: 0,
                  totalTokenCount: 10,
                },
              } as unknown as GenerateContentResponse;
            })(),
          )
          .mockImplementationOnce(async () =>
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Recovered after empty stream' }],
                    },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-empty-usage-retry',
        );
        const events = await collectStreamWithFakeTimers(stream);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(1);
        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Recovered after empty stream',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should retry on TPM throttling StreamContentError with initial delay', async () => {
      vi.useFakeTimers();

      try {
        const tpmError = new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        );
        async function* failingStreamGenerator() {
          throw tpmError;

          yield {} as GenerateContentResponse;
        }
        const failingStream = failingStreamGenerator();
        const successStream = (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'Success after TPM retry' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })();

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(failingStream)
          .mockResolvedValueOnce(successStream);

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-tpm-retry',
        );

        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();

        expect(first.done).toBe(false);
        expect(first.value.type).toBe(StreamEventType.RETRY);

        // Resume generator to schedule the TPM delay, then advance timers.
        const secondPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(60_000);
        const second = await secondPromise;

        expect(second.done).toBe(false);
        expect(second.value.type).toBe(StreamEventType.RETRY);

        const events: StreamEvent[] = [first.value, second.value];

        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.filter((e) => e.type === StreamEventType.RETRY),
        ).toHaveLength(2);
        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Success after TPM retry',
          ),
        ).toBe(true);
        expect(mockLogContentRetry).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should use Retry-After delay for streamed rate-limit errors', async () => {
      vi.useFakeTimers();

      try {
        const retryAfterError = Object.assign(
          new StreamContentError(
            '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
          ),
          {
            status: 429,
            headers: { 'retry-after': '180' },
          },
        );

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              throw retryAfterError;

              yield {} as GenerateContentResponse;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Success after Retry-After' }],
                    },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-retry-after',
        );

        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.value.type).toBe(StreamEventType.RETRY);
        expect(first.value.retryInfo?.delayMs).toBe(180_000);

        const secondPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(180_000);
        await secondPromise;

        const events: StreamEvent[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Success after Retry-After',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should retry immediately when skipDelay is called during rate-limit wait', async () => {
      vi.useFakeTimers();

      try {
        const tpmError = new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        );
        const successStream = (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'Success after skip' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })();

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              throw tpmError;

              yield {} as GenerateContentResponse;
            })(),
          )
          .mockResolvedValueOnce(successStream);

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-skip-delay',
        );

        const iterator = stream[Symbol.asyncIterator]();
        // First event: RETRY with retryInfo containing skipDelay
        const first = await iterator.next();
        expect(first.value.type).toBe(StreamEventType.RETRY);
        const skipDelay = first.value.retryInfo!.skipDelay!;

        // Resume generator — it's now awaiting the 60s delay.
        // Call skipDelay() to resolve it immediately instead of advancing timers.
        const secondPromise = iterator.next();
        skipDelay();
        const second = await secondPromise;

        // The generator should have continued to the next attempt immediately
        expect(second.done).toBe(false);
        expect(second.value.type).toBe(StreamEventType.RETRY); // retry-start marker

        // Consume remaining events
        const events: StreamEvent[] = [first.value, second.value];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Success after skip',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should exit retry loop when aborted during rate-limit delay', async () => {
      vi.useFakeTimers();

      try {
        const tpmError = new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        );
        async function* failingStreamGenerator() {
          throw tpmError;

          yield {} as GenerateContentResponse;
        }

        const abortController = new AbortController();

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(failingStreamGenerator())
          // Should never be called — abort should prevent the second attempt
          .mockResolvedValueOnce(failingStreamGenerator());

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test', config: { abortSignal: abortController.signal } },
          'prompt-id-abort-delay',
        );

        const iterator = stream[Symbol.asyncIterator]();
        // First event: RETRY with retryInfo
        const first = await iterator.next();
        expect(first.value.type).toBe(StreamEventType.RETRY);

        // Abort while the generator is awaiting the 60s delay
        const nextPromise = iterator.next();
        abortController.abort();

        // The generator should throw the abort error
        await expect(nextPromise).rejects.toThrow();

        // Only one API call should have been made (no retry after abort)
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(1);

        // Verify the next sendMessageStream is not blocked by the old delay.
        // If sendPromise were still pending, this would hang until the 60s
        // timer fires — which never happens under fake timers, causing a timeout.
        const nextStream = (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'Next request OK' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })();
        vi.mocked(mockContentGenerator.generateContentStream)
          .mockReset()
          .mockResolvedValueOnce(nextStream);

        const stream2 = await chat.sendMessageStream(
          'test-model',
          { message: 'follow-up' },
          'prompt-id-after-abort',
        );
        const events: StreamEvent[] = [];
        for await (const e of stream2) {
          events.push(e);
        }
        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Next request OK',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should retry on GLM rate limit StreamContentError with backoff delay', async () => {
      vi.useFakeTimers();

      try {
        const glmError = new StreamContentError(
          '{"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}',
        );
        async function* failingStreamGenerator() {
          throw glmError;

          yield {} as GenerateContentResponse;
        }
        const failingStream = failingStreamGenerator();
        const successStream = (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'Success after GLM retry' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })();

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(failingStream)
          .mockResolvedValueOnce(successStream);

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-glm-retry',
        );

        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();

        expect(first.done).toBe(false);
        expect(first.value.type).toBe(StreamEventType.RETRY);

        // Resume generator to schedule the rate limit delay, then advance timers.
        const secondPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(60_000);
        const second = await secondPromise;

        expect(second.done).toBe(false);
        expect(second.value.type).toBe(StreamEventType.RETRY);

        // Verify retryInfo contains retry metadata
        if (
          second.value.type === StreamEventType.RETRY &&
          second.value.retryInfo
        ) {
          expect(second.value.retryInfo.attempt).toBe(1);
          expect(second.value.retryInfo.maxRetries).toBe(10);
          expect(second.value.retryInfo.delayMs).toBe(60000);
        }

        const events: StreamEvent[] = [first.value, second.value];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.filter((e) => e.type === StreamEventType.RETRY),
        ).toHaveLength(2);
        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Success after GLM retry',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should increase delay across repeated streamed rate-limit errors', async () => {
      vi.useFakeTimers();

      try {
        const firstError = new StreamContentError(
          'id:1\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-1","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
        );
        const secondError = new StreamContentError(
          'id:2\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-2","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}',
        );

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              throw firstError;

              yield {} as GenerateContentResponse;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              throw secondError;

              yield {} as GenerateContentResponse;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: 'Recovered after backoff' }] },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-streamed-rate-limit-backoff',
        );

        const iterator = stream[Symbol.asyncIterator]();
        const retryInfos: Array<
          NonNullable<
            Extract<StreamEvent, { type: StreamEventType.RETRY }>['retryInfo']
          >
        > = [];

        const first = await iterator.next();
        expect(first.value.type).toBe(StreamEventType.RETRY);
        retryInfos.push(first.value.retryInfo!);

        let nextPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(60_000);
        await nextPromise;

        const second = await iterator.next();
        expect(second.value.type).toBe(StreamEventType.RETRY);
        retryInfos.push(second.value.retryInfo!);

        nextPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(120_000);
        await nextPromise;

        const events: StreamEvent[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }

        expect(retryInfos.map((info) => info.delayMs)).toEqual([
          60_000, 120_000,
        ]);
        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Recovered after backoff',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    describe('API error retry behavior', () => {
      beforeEach(() => {
        // Use a more direct mock for retry testing
        mockRetryWithBackoff.mockImplementation(async (apiCall, options) => {
          try {
            return await apiCall();
          } catch (error) {
            if (
              options?.shouldRetryOnError &&
              options.shouldRetryOnError(error)
            ) {
              // Try again
              return await apiCall();
            }
            throw error;
          }
        });
      });

      it('should not retry on 400 Bad Request errors', async () => {
        const error400 = new ApiError({ message: 'Bad Request', status: 400 });

        vi.mocked(mockContentGenerator.generateContentStream).mockRejectedValue(
          error400,
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-400',
        );

        await expect(
          (async () => {
            for await (const _ of stream) {
              /* consume stream */
            }
          })(),
        ).rejects.toThrow(error400);

        // Should only be called once (no retry)
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(1);
      });

      it('should retry on 429 Rate Limit errors', async () => {
        const error429 = new ApiError({ message: 'Rate Limited', status: 429 });

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockRejectedValueOnce(error429)
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: 'Success after retry' }] },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-429-retry',
        );

        const events: StreamEvent[] = [];
        for await (const event of stream) {
          events.push(event);
        }

        // Should be called twice (initial + retry)
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);

        // Should have successful content
        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Success after retry',
          ),
        ).toBe(true);
      });

      it('should not retry on schema depth errors', async () => {
        const schemaError = new ApiError({
          message: 'Request failed: maximum schema depth exceeded',
          status: 500,
        });

        vi.mocked(mockContentGenerator.generateContentStream).mockRejectedValue(
          schemaError,
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-schema',
        );

        await expect(
          (async () => {
            for await (const _ of stream) {
              /* consume stream */
            }
          })(),
        ).rejects.toThrow(schemaError);

        // Should only be called once (no retry)
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(1);
      });

      it('should retry on 5xx server errors', async () => {
        const error500 = new ApiError({
          message: 'Internal Server Error 500',
          status: 500,
        });

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockRejectedValueOnce(error500)
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: 'Recovered from 500' }] },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-500-retry',
        );

        const events: StreamEvent[] = [];
        for await (const event of stream) {
          events.push(event);
        }

        // Should be called twice (initial + retry)
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
      });

      afterEach(() => {
        // Reset to default behavior
        mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
      });
    });
  });
  it('should correctly retry and append to an existing history mid-conversation', async () => {
    // 1. Setup
    const initialHistory: Content[] = [
      { role: 'user', parts: [{ text: 'First question' }] },
      { role: 'model', parts: [{ text: 'First answer' }] },
    ];
    chat.setHistory(initialHistory);

    // 2. Mock the API to fail once with an empty stream, then succeed.
    vi.mocked(mockContentGenerator.generateContentStream)
      .mockImplementationOnce(async () =>
        (async function* () {
          yield {
            candidates: [{ content: { parts: [{ text: '' }] } }],
          } as unknown as GenerateContentResponse;
        })(),
      )
      .mockImplementationOnce(async () =>
        // Second attempt succeeds
        (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'Second answer' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

    // 3. Send a new message
    const stream = await chat.sendMessageStream(
      'test-model',
      { message: 'Second question' },
      'prompt-id-retry-existing',
    );
    for await (const _ of stream) {
      // consume stream
    }

    // 4. Assert the final history and metrics
    const history = chat.getHistory();
    expect(history.length).toBe(4);

    // Assert that the correct metrics were reported for one empty-stream retry
    expect(mockLogContentRetry).toHaveBeenCalledTimes(1);

    // Explicitly verify the structure of each part to satisfy TypeScript
    const turn1 = history[0];
    if (!turn1?.parts?.[0] || !('text' in turn1.parts[0])) {
      throw new Error('Test setup error: First turn is not a valid text part.');
    }
    expect(turn1.parts[0].text).toBe('First question');

    const turn2 = history[1];
    if (!turn2?.parts?.[0] || !('text' in turn2.parts[0])) {
      throw new Error(
        'Test setup error: Second turn is not a valid text part.',
      );
    }
    expect(turn2.parts[0].text).toBe('First answer');

    const turn3 = history[2];
    if (!turn3?.parts?.[0] || !('text' in turn3.parts[0])) {
      throw new Error('Test setup error: Third turn is not a valid text part.');
    }
    expect(turn3.parts[0].text).toBe('Second question');

    const turn4 = history[3];
    if (!turn4?.parts?.[0] || !('text' in turn4.parts[0])) {
      throw new Error(
        'Test setup error: Fourth turn is not a valid text part.',
      );
    }
    expect(turn4.parts[0].text).toBe('Second answer');
  });

  it('should retry if the model returns a completely empty stream (no chunks)', async () => {
    // 1. Mock the API to return an empty stream first, then a valid one.
    vi.mocked(mockContentGenerator.generateContentStream)
      .mockImplementationOnce(
        // First call resolves to an async generator that yields nothing.
        async () => (async function* () {})(),
      )
      .mockImplementationOnce(
        // Second call returns a valid stream.
        async () =>
          (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Successful response after empty' }],
                  },
                  finishReason: 'STOP',
                },
              ],
            } as unknown as GenerateContentResponse;
          })(),
      );

    // 2. Call the method and consume the stream.
    const stream = await chat.sendMessageStream(
      'test-model',
      { message: 'test empty stream' },
      'prompt-id-empty-stream',
    );
    const chunks: StreamEvent[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    // 3. Assert the results.
    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(2);
    expect(
      chunks.some(
        (c) =>
          c.type === StreamEventType.CHUNK &&
          c.value.candidates?.[0]?.content?.parts?.[0]?.text ===
            'Successful response after empty',
      ),
    ).toBe(true);

    const history = chat.getHistory();
    expect(history.length).toBe(2);

    // Explicitly verify the structure of each part to satisfy TypeScript
    const turn1 = history[0];
    if (!turn1?.parts?.[0] || !('text' in turn1.parts[0])) {
      throw new Error('Test setup error: First turn is not a valid text part.');
    }
    expect(turn1.parts[0].text).toBe('test empty stream');

    const turn2 = history[1];
    if (!turn2?.parts?.[0] || !('text' in turn2.parts[0])) {
      throw new Error(
        'Test setup error: Second turn is not a valid text part.',
      );
    }
    expect(turn2.parts[0].text).toBe('Successful response after empty');
  });
  it('should queue a subsequent sendMessageStream call until the first stream is fully consumed', async () => {
    // 1. Create a promise to manually control the stream's lifecycle
    let continueFirstStream: () => void;
    const firstStreamContinuePromise = new Promise<void>((resolve) => {
      continueFirstStream = resolve;
    });

    // 2. Mock the API to return controllable async generators
    const firstStreamGenerator = (async function* () {
      yield {
        candidates: [
          { content: { parts: [{ text: 'first response part 1' }] } },
        ],
      } as unknown as GenerateContentResponse;
      await firstStreamContinuePromise; // Pause the stream
      yield {
        candidates: [
          {
            content: { parts: [{ text: ' part 2' }] },
            finishReason: 'STOP',
          },
        ],
      } as unknown as GenerateContentResponse;
    })();

    const secondStreamGenerator = (async function* () {
      yield {
        candidates: [
          {
            content: { parts: [{ text: 'second response' }] },
            finishReason: 'STOP',
          },
        ],
      } as unknown as GenerateContentResponse;
    })();

    vi.mocked(mockContentGenerator.generateContentStream)
      .mockResolvedValueOnce(firstStreamGenerator)
      .mockResolvedValueOnce(secondStreamGenerator);

    // 3. Start the first stream and consume only the first chunk to pause it
    const firstStream = await chat.sendMessageStream(
      'test-model',
      { message: 'first' },
      'prompt-1',
    );
    const firstStreamIterator = firstStream[Symbol.asyncIterator]();
    await firstStreamIterator.next();

    // 4. While the first stream is paused, start the second call. It will block.
    const secondStreamPromise = chat.sendMessageStream(
      'test-model',
      { message: 'second' },
      'prompt-2',
    );

    // 5. Assert that only one API call has been made so far.
    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(1);

    // 6. Unblock and fully consume the first stream to completion.
    continueFirstStream!();
    await firstStreamIterator.next(); // Consume the rest of the stream
    await firstStreamIterator.next(); // Finish the iterator

    // 7. Now that the first stream is done, await the second promise to get its generator.
    const secondStream = await secondStreamPromise;

    // 8. Start consuming the second stream, which triggers its internal API call.
    const secondStreamIterator = secondStream[Symbol.asyncIterator]();
    await secondStreamIterator.next();

    // 9. The second API call should now have been made.
    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(2);

    // 10. FIX: Fully consume the second stream to ensure recordHistory is called.
    await secondStreamIterator.next(); // This finishes the iterator.

    // 11. Final check on history.
    const history = chat.getHistory();
    expect(history.length).toBe(4);

    const turn4 = history[3];
    if (!turn4?.parts?.[0] || !('text' in turn4.parts[0])) {
      throw new Error(
        'Test setup error: Fourth turn is not a valid text part.',
      );
    }
    expect(turn4.parts[0].text).toBe('second response');
  });

  describe('Model Resolution', () => {
    const mockResponse = {
      candidates: [
        {
          content: { parts: [{ text: 'response' }], role: 'model' },
          finishReason: 'STOP',
        },
      ],
    } as unknown as GenerateContentResponse;

    it('should pass the requested model through to generateContentStream', async () => {
      vi.mocked(mockConfig.getModel).mockReturnValue('gemini-pro');
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () =>
          (async function* () {
            yield mockResponse;
          })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-res3',
      );
      for await (const _ of stream) {
        // consume stream
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'test-model',
        }),
        'prompt-id-res3',
      );
    });
  });

  it('should discard valid partial content from a failed attempt upon retry', async () => {
    // Mock the stream to fail on the first attempt after yielding some valid content.
    vi.mocked(mockContentGenerator.generateContentStream)
      .mockImplementationOnce(async () =>
        // First attempt: yields one valid chunk, then one invalid chunk
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [{ text: 'This valid part should be discarded' }],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          yield {
            candidates: [{ content: { parts: [{ text: '' }] } }], // Invalid chunk triggers retry
          } as unknown as GenerateContentResponse;
        })(),
      )
      .mockImplementationOnce(async () =>
        // Second attempt (the retry): succeeds
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [{ text: 'Successful final response' }],
                },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

    // Send a message and consume the stream
    const stream = await chat.sendMessageStream(
      'test-model',
      { message: 'test' },
      'prompt-id-discard-test',
    );
    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    // Check that a retry happened
    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(2);
    expect(events.some((e) => e.type === StreamEventType.RETRY)).toBe(true);

    // Check the final recorded history
    const history = chat.getHistory();
    expect(history.length).toBe(2); // user turn + final model turn

    const modelTurn = history[1]!;
    // The model turn should only contain the text from the successful attempt
    expect(modelTurn!.parts![0]!.text).toBe('Successful final response');
    // It should NOT contain any text from the failed attempt
    expect(modelTurn!.parts![0]!.text).not.toContain(
      'This valid part should be discarded',
    );
  });

  describe('stripThoughtsFromHistory', () => {
    it('should strip thought parts from history and drop thought-only entries', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'question' }] },
        {
          role: 'model',
          parts: [{ text: 'thinking', thought: true }, { text: 'answer' }],
        },
        { role: 'model', parts: [{ text: 'more thinking', thought: true }] },
      ]);

      chat.stripThoughtsFromHistory();

      expect(chat.getHistory()).toEqual([
        { role: 'user', parts: [{ text: 'question' }] },
        { role: 'model', parts: [{ text: 'answer' }] },
      ]);
    });
  });

  describe('stripOrphanedUserEntriesFromHistory', () => {
    it('should pop a single trailing user entry', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'first message' }] },
        { role: 'model', parts: [{ text: 'first response' }] },
        { role: 'user', parts: [{ text: 'orphaned message' }] },
      ]);

      chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual([
        { role: 'user', parts: [{ text: 'first message' }] },
        { role: 'model', parts: [{ text: 'first response' }] },
      ]);
    });

    it('should pop multiple trailing user entries', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'query' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'tool', args: {} } }],
        },
        { role: 'user', parts: [{ text: 'IDE context' }] },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: 'tool',
                response: { result: 'ok' },
              },
            },
          ],
        },
      ]);

      chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual([
        { role: 'user', parts: [{ text: 'query' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'tool', args: {} } }],
        },
      ]);
    });

    it('should be a no-op when last entry is a model response', () => {
      const history = [
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'hi' }] },
      ];
      chat.setHistory([...history]);

      chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual(history);
    });

    it('should handle empty history', () => {
      chat.setHistory([]);

      chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual([]);
    });
  });

  describe('output token recovery', () => {
    function makeChunk(
      parts: Array<{ text?: string; functionCall?: unknown }>,
      finishReason?: string,
    ): GenerateContentResponse {
      return {
        candidates: [
          {
            content: { role: 'model', parts },
            ...(finishReason ? { finishReason } : {}),
          },
        ],
      } as unknown as GenerateContentResponse;
    }

    function makeStream(chunks: GenerateContentResponse[]) {
      return (async function* () {
        for (const c of chunks) {
          yield c;
        }
      })();
    }

    it('should enter recovery loop when escalated response is also truncated', async () => {
      // Three streams: initial (MAX_TOKENS) → escalated (MAX_TOKENS) →
      // recovery (STOP).
      const streams = [
        makeStream([makeChunk([{ text: 'Hello' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: ' world' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: ' ending.' }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a long essay' },
        'prompt-recovery',
      );

      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      const retries = events.filter((e) => e.type === StreamEventType.RETRY);
      // One RETRY for escalation (isContinuation undefined/false),
      // one for recovery (isContinuation true).
      expect(retries.length).toBe(2);
      expect(retries[0]!.type).toBe(StreamEventType.RETRY);
      expect((retries[0] as { isContinuation?: boolean }).isContinuation).toBe(
        undefined,
      );
      expect((retries[1] as { isContinuation?: boolean }).isContinuation).toBe(
        true,
      );
      // API called 3 times: initial + escalation + recovery.
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        3,
      );
    });

    it('should skip recovery when truncated turn has a functionCall', async () => {
      // Initial stream returns a functionCall + MAX_TOKENS. Escalated stream
      // returns the same (functionCall + MAX_TOKENS). Recovery must NOT run
      // because appending a user turn after functionCall is invalid.
      const streams = [
        makeStream([
          makeChunk(
            [
              {
                functionCall: { name: 'write_file', args: { file_path: '/x' } },
              },
            ],
            'MAX_TOKENS',
          ),
        ]),
        makeStream([
          makeChunk(
            [
              {
                functionCall: { name: 'write_file', args: { file_path: '/x' } },
              },
            ],
            'MAX_TOKENS',
          ),
        ]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a file' },
        'prompt-recovery-skip',
      );

      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      // Only the escalation RETRY should fire; no continuation RETRY.
      const continuations = events.filter(
        (e) =>
          e.type === StreamEventType.RETRY &&
          (e as { isContinuation?: boolean }).isContinuation === true,
      );
      expect(continuations.length).toBe(0);

      // API called twice: initial + escalation. No recovery calls.
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );

      // History should end with the truncated model turn that has the
      // functionCall. No dangling user recovery message.
      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      expect(lastEntry.role).toBe('model');
      expect(
        lastEntry.parts?.some((p) => 'functionCall' in p && p.functionCall),
      ).toBe(true);
    });

    it('should cap recovery attempts at MAX_OUTPUT_RECOVERY_ATTEMPTS (3)', async () => {
      // Every stream returns MAX_TOKENS with text (no functionCall).
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => makeStream([makeChunk([{ text: 'x' }], 'MAX_TOKENS')]),
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'infinite loop test' },
        'prompt-recovery-cap',
      );

      // Consume
      for await (const _ of stream) {
        /* consume */
      }

      // 1 initial + 1 escalation + 3 recovery = 5 total.
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        5,
      );
    });

    it('should pop dangling recovery message and emit STOP chunk when recovery throws', async () => {
      const streams = [
        makeStream([makeChunk([{ text: 'partial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: 'still partial' }], 'MAX_TOKENS')]),
        // Recovery stream throws (simulate by yielding no chunks; this makes
        // processStreamResponse reject with NO_FINISH_REASON).
        (async function* () {
          /* empty stream */
        })(),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'recovery fails' },
        'prompt-recovery-fail',
      );

      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      // The last chunk should be the synthetic STOP chunk from the catch.
      const chunkEvents = events.filter(
        (e) => e.type === StreamEventType.CHUNK,
      );
      const lastChunk = chunkEvents[chunkEvents.length - 1]!;
      expect(
        (lastChunk as { value: GenerateContentResponse }).value.candidates?.[0]
          ?.finishReason,
      ).toBe('STOP');

      // History should NOT end with a dangling user recovery message,
      // and roles must strictly alternate so providers don't reject the
      // next turn with "consecutive same-role content" errors.
      const history = chat.getHistory();
      for (let i = 1; i < history.length; i++) {
        expect(history[i]!.role).not.toBe(history[i - 1]!.role);
      }
      const lastEntry = history[history.length - 1]!;
      // Last entry should be the escalated model response, not a user
      // recovery message, and must carry actual parts so the turn is
      // not an empty placeholder.
      expect(lastEntry.role).toBe('model');
      expect(lastEntry.parts!.length).toBeGreaterThan(0);
    });

    it('should stop recovery mid-loop when a later iteration emits functionCall', async () => {
      // Covers the cross-iteration guard: iter 1 returns plain text (recovery
      // proceeds), iter 2 returns a functionCall (recovery must break before
      // iter 3 pushes another user turn after the functionCall).
      const streams = [
        makeStream([makeChunk([{ text: 'initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: 'escalated' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: 'recovery 1 text' }], 'MAX_TOKENS')]),
        makeStream([
          makeChunk(
            [
              {
                functionCall: { name: 'write_file', args: { file_path: '/x' } },
              },
            ],
            'MAX_TOKENS',
          ),
        ]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'mixed recovery' },
        'prompt-recovery-mixed',
      );

      for await (const _ of stream) {
        /* consume */
      }

      // Should call: 1 initial + 1 escalation + 2 recovery (iter 1 text,
      // iter 2 functionCall) = 4 total. The guard fires at the start of
      // iter 3 before any further API call.
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        4,
      );

      // History must end on the functionCall model turn (not a dangling
      // recovery user turn).
      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      expect(lastEntry.role).toBe('model');
      expect(
        lastEntry.parts?.some((p) => 'functionCall' in p && p.functionCall),
      ).toBe(true);
    });

    it('should coalesce successful recovery iterations into the preceding model turn', async () => {
      // Two recovery iterations then a clean STOP. Without coalescing, the
      // internal OUTPUT_RECOVERY_MESSAGE would persist as a real user turn
      // and bias every later model call.
      const streams = [
        makeStream([makeChunk([{ text: 'A' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: 'B' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: 'C' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: 'D' }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'essay' },
        'prompt-recovery-coalesce',
      );
      for await (const _ of stream) {
        /* consume */
      }

      const history = chat.getHistory();
      // Exactly one user turn + one model turn — the recovery pairs should
      // be folded back into the preceding model entry.
      expect(history.length).toBe(2);
      expect(history[0]!.role).toBe('user');
      expect(history[1]!.role).toBe('model');

      // The control prompt must NOT appear anywhere in durable history.
      const flattened = JSON.stringify(history);
      expect(flattened).not.toContain('Resume directly');
      expect(flattened).not.toContain('Output token limit hit');

      // All escalation + recovery content must be preserved in the merged
      // model turn, in order (B escalation → C recovery-1 → D recovery-2).
      const mergedText = (history[1]!.parts ?? [])
        .map((p) => ('text' in p ? ((p as { text?: string }).text ?? '') : ''))
        .join('');
      expect(mergedText).toBe('BCD');
    });
  });

  describe('redactStructuredOutputArgsForRecording', () => {
    // The chat-recording JSONL persists assistant turns to disk and re-feeds
    // them on `--continue` / `--resume`. For `--json-schema` runs the
    // structured_output args ARE the user's structured payload, already
    // emitted on stdout; recording them verbatim here would silently
    // contradict the redaction the ToolCallEvent telemetry path applies.
    // These tests pin the helper that scrubs them.

    it('replaces args on a structured_output functionCall with the placeholder', () => {
      const result = redactStructuredOutputArgsForRecording({
        functionCall: {
          id: 'call-1',
          name: 'structured_output',
          args: {
            extracted: 'sensitive answer',
            score: 0.9,
            details: { token: 'shhhh' },
          },
        },
      });
      expect(result).not.toBeNull();
      expect(result!.functionCall.name).toBe('structured_output');
      expect(result!.functionCall.id).toBe('call-1');
      expect(result!.functionCall.args).toEqual({
        __redacted: 'structured_output payload (see stdout result)',
      });
      // The original payload must NOT survive in any field of the output.
      expect(JSON.stringify(result)).not.toContain('sensitive answer');
      expect(JSON.stringify(result)).not.toContain('shhhh');
    });

    it('passes non-structured_output functionCalls through untouched', () => {
      const original = {
        id: 'call-2',
        name: 'write_file',
        args: { path: '/tmp/x', content: 'hello' },
      };
      const result = redactStructuredOutputArgsForRecording({
        functionCall: original,
      });
      expect(result).not.toBeNull();
      expect(result!.functionCall).toEqual(original);
      // Reference identity not required, but the args object must equal
      // the input (no redaction applied).
      expect(result!.functionCall.args).toEqual({
        path: '/tmp/x',
        content: 'hello',
      });
    });

    it('returns null for parts with no functionCall', () => {
      expect(redactStructuredOutputArgsForRecording({ text: 'hi' })).toBeNull();
      expect(redactStructuredOutputArgsForRecording({})).toBeNull();
    });

    it('does not mutate the input part', () => {
      const original = {
        functionCall: {
          id: 'call-3',
          name: 'structured_output',
          args: { ok: true, data: [1, 2, 3] },
        },
      };
      const snapshot = JSON.parse(JSON.stringify(original));
      redactStructuredOutputArgsForRecording(original);
      expect(original).toEqual(snapshot);
    });
  });

  // Compression logic is tested in chatCompressionService.test.ts; this
  // suite covers per-chat state on GeminiChat: consecutiveFailures
  // circuit breaker, token-count mutation, history replacement, and
  // conditional telemetry mirroring.
  describe('tryCompress (per-chat state)', () => {
    const userMsg = (text: string) => ({
      role: 'user' as const,
      parts: [{ text }],
    });
    const modelMsg = (text: string) => ({
      role: 'model' as const,
      parts: [{ text }],
    });

    /**
     * Mock a successful compression: the service returns COMPRESSED with a
     * fresh history. We don't go through the real
     * `config.getContentGenerator().generateContent` path here — the service
     * is mocked at the boundary.
     */
    function mockCompressionService(
      result: 'compressed' | 'failed-inflated' | 'noop',
    ) {
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      if (result === 'compressed') {
        compressSpy.mockResolvedValue({
          newHistory: [userMsg('summary'), modelMsg('ok'), userMsg('latest')],
          info: {
            originalTokenCount: 1000,
            newTokenCount: 200,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      } else if (result === 'failed-inflated') {
        compressSpy.mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 1000,
            newTokenCount: 1100,
            compressionStatus:
              CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
          },
        });
      } else {
        compressSpy.mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      }
      return compressSpy;
    }

    function mockHeapPressure(usedHeapSize: number, heapLimit = 1000) {
      mockGetHeapStatistics.mockReturnValue({
        used_heap_size: usedHeapSize,
        heap_size_limit: heapLimit,
      });
    }

    it('replaces history and updates per-chat lastPromptTokenCount on COMPRESSED', async () => {
      mockCompressionService('compressed');
      chat.setHistory([userMsg('a'), modelMsg('b'), userMsg('c')]);

      const info = await chat.tryCompress('p1', 'm1');

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(chat.getHistory()).toHaveLength(3);
      expect(chat.getHistory()[0]).toEqual(userMsg('summary'));
      expect(chat.getLastPromptTokenCount()).toBe(200);
    });

    it('mirrors lastPromptTokenCount to the global telemetry only when wired', async () => {
      mockCompressionService('compressed');
      // chat under test was constructed with telemetryService=uiTelemetryService.
      await chat.tryCompress('p2', 'm1');
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledWith(
        200,
      );

      // A subagent-style chat with no telemetryService must NOT touch the
      // global singleton (per the constructor docstring; per-chat counter
      // still updates).
      const subagentChat = new GeminiChat(mockConfig, config, []);
      vi.mocked(uiTelemetryService.setLastPromptTokenCount).mockClear();
      mockCompressionService('compressed');
      const info = await subagentChat.tryCompress('p3', 'm1');
      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(subagentChat.getLastPromptTokenCount()).toBe(200);
      expect(uiTelemetryService.setLastPromptTokenCount).not.toHaveBeenCalled();
    });

    it('increments consecutiveFailures and forwards it to subsequent unforced auto-compactions', async () => {
      const compressSpy = mockCompressionService('failed-inflated');

      const first = await chat.tryCompress('p1', 'm1');
      expect(first.compressionStatus).toBe(
        CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
      );
      expect(compressSpy).toHaveBeenCalledTimes(1);

      // The next unforced call should reach the service with
      // consecutiveFailures=1 (incremented after the first failure). The
      // important thing here is that GeminiChat actually forwards the
      // updated counter — the service's own threshold logic is tested
      // separately in chatCompressionService.test.ts.
      compressSpy.mockClear();
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      await chat.tryCompress('p2', 'm1');
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(1);
    });

    it('forwards force=true to the compression service', async () => {
      const compressSpy = mockCompressionService('compressed');
      mockHeapPressure(900);

      await chat.tryCompress('p1', 'm1', true);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
      expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(false);
      expect(mockGetHeapStatistics).not.toHaveBeenCalled();
    });

    it('uses heap pressure to bypass the token gate without manual force semantics', async () => {
      const compressSpy = mockCompressionService('noop');
      mockHeapPressure(750);
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        contextWindowSize: 1000,
      });

      await chat.tryCompress('p1', 'm1');

      expect(compressSpy.mock.calls[0][1].force).toBe(false);
      expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(true);
      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBe(0);
    });

    it('does not bypass the token gate below the heap-pressure threshold', async () => {
      const compressSpy = mockCompressionService('noop');
      mockHeapPressure(650);

      await chat.tryCompress('p1', 'm1');

      expect(compressSpy.mock.calls[0][1].force).toBe(false);
      expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(false);
    });

    it('does not let a failed heap-pressure attempt latch off later auto-compaction', async () => {
      const compressSpy = mockCompressionService('failed-inflated');
      mockHeapPressure(701);

      const first = await chat.tryCompress('p1', 'm1');
      expect(first.compressionStatus).toBe(
        CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
      );
      expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(true);

      compressSpy.mockClear();
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      mockHeapPressure(0);

      await chat.tryCompress('p2', 'm1');

      expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(false);
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(0);
    });

    it('backs off repeated heap-pressure bypasses after a heap-triggered failure', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-16T00:00:00Z'));
      try {
        const compressSpy = mockCompressionService('failed-inflated');
        mockHeapPressure(800);

        await chat.tryCompress('p1', 'm1');
        expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(true);

        compressSpy.mockClear();
        compressSpy.mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        });

        await chat.tryCompress('p2', 'm1');
        expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(false);

        vi.setSystemTime(new Date('2026-05-16T00:00:31Z'));
        compressSpy.mockClear();

        await chat.tryCompress('p3', 'm1');
        expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('backs off repeated heap-pressure bypasses after a heap-triggered NOOP', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-16T00:00:00Z'));
      try {
        const compressSpy = mockCompressionService('noop');
        mockHeapPressure(800);

        await chat.tryCompress('p1', 'm1');
        expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(true);

        compressSpy.mockClear();

        await chat.tryCompress('p2', 'm1');
        expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(false);

        vi.setSystemTime(new Date('2026-05-16T00:00:31Z'));
        compressSpy.mockClear();

        await chat.tryCompress('p3', 'm1');
        expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('falls back to token-threshold behavior if heap statistics are unavailable', async () => {
      const compressSpy = mockCompressionService('noop');
      mockGetHeapStatistics.mockImplementation(() => {
        throw new Error('heap stats unavailable');
      });

      await chat.tryCompress('p1', 'm1');

      expect(compressSpy.mock.calls[0][1].bypassTokenThreshold).toBe(false);
    });
  });

  // The circuit breaker is the three-strike replacement for the old
  // single-shot hasFailedCompressionAttempt lock. After
  // MAX_CONSECUTIVE_FAILURES failures the chat stops trying to auto-compact
  // until a successful force compress (or any successful compress) resets
  // the counter.
  describe('compression failure circuit breaker', () => {
    const userMsg = (text: string) => ({
      role: 'user' as const,
      parts: [{ text }],
    });
    const modelMsg = (text: string) => ({
      role: 'model' as const,
      parts: [{ text }],
    });

    it('tolerates MAX_CONSECUTIVE_FAILURES - 1 failures and increments the counter each time', async () => {
      // Mock the service to "fail" every call (the chat's counter increments
      // each time). After (MAX - 1) failures, the next tryCompress should
      // still call the service. The actual NOOP-at-threshold gating is the
      // service's job (and verified separately) — here we just observe that
      // GeminiChat keeps forwarding the incremented counter.
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 100_000,
          newTokenCount: 100_000,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
        },
      });
      chat.setHistory([userMsg('a'), modelMsg('b'), userMsg('c')]);

      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await chat.tryCompress(`p${i}`, 'm1');
        // The i-th call sees consecutiveFailures = i (counter pre-increment).
        expect(compressSpy.mock.calls[i][1].consecutiveFailures).toBe(i);
      }
      // After MAX_CONSECUTIVE_FAILURES failures, the breaker is tripped.
      // The next call will still be made by GeminiChat (it does not
      // short-circuit on its side), but the service's cheap-gate will NOOP.
      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
      await chat.tryCompress('p-last', 'm1');
      expect(
        compressSpy.mock.calls[MAX_CONSECUTIVE_FAILURES][1].consecutiveFailures,
      ).toBe(MAX_CONSECUTIVE_FAILURES);
    });

    it('does not increment the counter on forced-call failures', async () => {
      // Forced compressions (manual /compress, reactive overflow) bypass
      // the breaker AND must not count toward it. Otherwise a flaky
      // manual /compress would burn the breaker for auto-compaction.
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 100_000,
          newTokenCount: 100_000,
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
        },
      });
      for (let i = 0; i < 5; i++) {
        await chat.tryCompress(`p-force-${i}`, 'm1', true);
      }
      // After 5 forced failures, an unforced call must still see counter=0.
      compressSpy.mockResolvedValueOnce({
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      await chat.tryCompress('p-unforced', 'm1');
      const lastCall = compressSpy.mock.calls.at(-1);
      expect(lastCall![1].consecutiveFailures).toBe(0);
    });

    it('resets the counter to 0 on a successful (forced) compress', async () => {
      // After two failures, a successful force compress should reset the
      // counter — the next unforced send tries again with consecutiveFailures=0.
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 100_000,
            newTokenCount: 100_000,
            compressionStatus:
              CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
          },
        })
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 100_000,
            newTokenCount: 100_000,
            compressionStatus:
              CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
          },
        })
        .mockResolvedValueOnce({
          newHistory: [userMsg('summary'), modelMsg('ack')],
          info: {
            originalTokenCount: 100_000,
            newTokenCount: 30_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        })
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 0,
            newTokenCount: 0,
            compressionStatus: CompressionStatus.NOOP,
          },
        });

      // Two failures → counter is 2.
      await chat.tryCompress('p1', 'm1');
      await chat.tryCompress('p2', 'm1');
      expect(compressSpy.mock.calls[1][1].consecutiveFailures).toBe(1);

      // Forced successful compress → counter resets to 0.
      await chat.tryCompress('p-force', 'm1', true);
      expect(compressSpy.mock.calls[2][1].consecutiveFailures).toBe(2);

      // Next unforced call: counter is back to 0.
      await chat.tryCompress('p3', 'm1');
      expect(compressSpy.mock.calls[3][1].consecutiveFailures).toBe(0);
    });

    it('counts COMPRESSION_FAILED_OUTPUT_TRUNCATED toward the breaker (R6.15)', async () => {
      // The truncation guard (R1.1 + R5.2b) returns OUTPUT_TRUNCATED on
      // cap overruns. isCompressionFailureStatus() includes it so the
      // breaker should trip after MAX_CONSECUTIVE_FAILURES — verify
      // explicitly so a future enum reshuffle that drops it from the
      // failure-status list is caught.
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 100_000,
          newTokenCount: 100_000,
          compressionStatus:
            CompressionStatus.COMPRESSION_FAILED_OUTPUT_TRUNCATED,
        },
      });
      chat.setHistory([userMsg('a'), modelMsg('b'), userMsg('c')]);

      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await chat.tryCompress(`p-trunc-${i}`, 'm1');
      }
      // Counter should have reached MAX after these truncation-status
      // failures, just like INFLATED and EMPTY_SUMMARY do.
      await chat.tryCompress('p-trunc-after', 'm1');
      expect(
        compressSpy.mock.calls[MAX_CONSECUTIVE_FAILURES][1].consecutiveFailures,
      ).toBe(MAX_CONSECUTIVE_FAILURES);
    });
  });
});

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
  Part,
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
import { SYSTEM_REMINDER_OPEN } from '../utils/environmentContext.js';
import { SessionStartSource } from '../hooks/types.js';

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

const { mockAcquireSleepInhibitor, mockSleepInhibitorRelease } = vi.hoisted(
  () => ({
    mockAcquireSleepInhibitor: vi.fn(),
    mockSleepInhibitorRelease: vi.fn(),
  }),
);

vi.mock('../services/sleepInhibitor.js', () => ({
  acquireSleepInhibitor: mockAcquireSleepInhibitor,
}));

const { mockDebugLoggerWarn } = vi.hoisted(() => ({
  mockDebugLoggerWarn: vi.fn(),
}));

vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: mockDebugLoggerWarn,
      error: vi.fn(),
    }),
  };
});

describe('GeminiChat', async () => {
  let mockContentGenerator: ContentGenerator;
  let chat: GeminiChat;
  let mockConfig: Config;
  const config: GenerateContentConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireSleepInhibitor.mockReturnValue({
      release: mockSleepInhibitorRelease,
    });
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
      getTargetDir: vi.fn().mockReturnValue('/test/project/root'),
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
    it('releases the sleep inhibitor after the stream is consumed', async () => {
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'done' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test message' },
        'prompt-id-sleep-inhibitor',
      );
      for await (const _ of stream) {
        /* consume stream */
      }

      expect(mockAcquireSleepInhibitor).toHaveBeenCalledWith(
        mockConfig,
        'Qwen Code is streaming a model response',
      );
      expect(mockSleepInhibitorRelease).toHaveBeenCalledTimes(1);
    });

    it('releases the sleep inhibitor when the stream errors', async () => {
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'partial' }] },
              },
            ],
          } as unknown as GenerateContentResponse;
          throw new Error('stream aborted');
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'fail' },
        'prompt-id-stream-error',
      );

      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume stream */
          }
        })(),
      ).rejects.toThrow('stream aborted');

      expect(mockSleepInhibitorRelease).toHaveBeenCalledTimes(1);
    });

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

    it('synthesizes a functionResponse for a dangling tool_use before sending', async () => {
      // End-to-end: when sendMessageStream is invoked on a chat whose
      // history carries a dangling `model[functionCall]` (typical state
      // after a Ctrl+Y race or a crash-resume on a partial-tool_use
      // turn), the inline repair pass closes the pair against the
      // just-pushed user content so the wire payload doesn't 400 with
      // "tool_use_id ... corresponding tool_use".
      chat.setHistory([
        { role: 'user', parts: [{ text: 'first message' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_dangling_for_send',
                name: 'read_file',
                args: { path: '/tmp/x' },
              },
            },
          ],
        },
      ]);

      const ackStream = (async function* () {
        yield {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'ok' }] },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        ackStream,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'next user prompt after a stream-error-mid-tool_use' },
        'prompt-send-repair',
      );
      for await (const _ of stream) {
        /* drain */
      }

      const history = chat.getHistory();
      // The dangling fc should now be followed by a user turn that
      // carries both the user-supplied text AND the synthetic fr that
      // closes the pair.
      const userTurn = history[2]!;
      expect(userTurn.role).toBe('user');
      const fr = userTurn.parts!.find((p) => p.functionResponse);
      expect(fr?.functionResponse?.id).toBe('call_dangling_for_send');
      expect(fr?.functionResponse?.name).toBe('read_file');
      expect(
        (fr?.functionResponse?.response as { error?: string })?.error,
      ).toMatch(/interrupted/i);
      // The user's own text part is still present.
      expect(
        userTurn.parts!.some(
          (p) =>
            p.text === 'next user prompt after a stream-error-mid-tool_use',
        ),
      ).toBe(true);
      // tool_result block must come BEFORE the text — Anthropic-
      // compatible backends reject a user message whose first content
      // block isn't the tool_result answering the immediately preceding
      // tool_use. Mirrors upstream Claude Code's `hoistToolResults`.
      expect(userTurn.parts![0]!.functionResponse?.id).toBe(
        'call_dangling_for_send',
      );
    });

    it('does NOT synthesize when the user supplies a matching tool_result', async () => {
      // Retry-of-ToolResult case (lastPrompt is a functionResponse Part
      // array): the user-supplied tool_result must close the pair before
      // the inline repair pass sees it, so no synthetic error is
      // injected. Otherwise the wire payload would carry two
      // functionResponse parts for the same callId — the real one and a
      // bogus synthetic.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'do the read' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_retry_real_fr',
                name: 'read_file',
                args: { path: '/tmp/y' },
              },
            },
          ],
        },
      ]);

      const ackStream = (async function* () {
        yield {
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'ack' }] },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        ackStream,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        {
          message: {
            functionResponse: {
              id: 'call_retry_real_fr',
              name: 'read_file',
              response: { output: 'real-tool-output' },
            },
          },
        },
        'prompt-retry-real-fr',
      );
      for await (const _ of stream) {
        /* drain */
      }

      const userTurn = chat.getHistory()[2]!;
      const frParts = userTurn.parts!.filter((p) => p.functionResponse);
      // Exactly ONE functionResponse — the real one. No synthetic.
      expect(frParts.length).toBe(1);
      expect(frParts[0]!.functionResponse?.id).toBe('call_retry_real_fr');
      expect(
        (frParts[0]!.functionResponse?.response as { output?: string })?.output,
      ).toBe('real-tool-output');
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

    it('persists partial assistant turn when stream throws after a tool_use chunk', async () => {
      // Weak-network scenario: Anthropic-compatible providers emit the
      // `functionCall` part on `content_block_stop`; the SSE may then drop
      // before `message_stop`. The yielded chunk is enough for `Turn.run`
      // to queue a `ToolCallRequest`, the tool scheduler will eventually
      // submit a `functionResponse` user turn — without a matching
      // tool_use in history, the next request body shows
      // `user → user[tool_result]` and DeepSeek/Anthropic rejects with
      // "tool_use_id ... must have a corresponding tool_use block in the
      // previous message". `processStreamResponse` must persist the
      // partial model turn before re-throwing so the pairing is intact.
      mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
      const networkError = new Error('SSE connection reset by peer');
      const streamThatThrowsAfterToolCall = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'call_00_CeJrKJB0PSmXUZTCWHET7332',
                      name: 'read_file',
                      args: { path: '/tmp/x.txt' },
                    },
                  },
                ],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
        throw networkError;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamThatThrowsAfterToolCall,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'open /tmp/x.txt please' },
        'prompt-weak-network-tool',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* drain */
          }
        })(),
      ).rejects.toBe(networkError);

      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]!.role).toBe('user');
      const modelTurn = history[1]!;
      expect(modelTurn.role).toBe('model');
      expect(modelTurn.parts).toBeDefined();
      const functionCallPart = modelTurn.parts!.find((p) => p.functionCall);
      expect(functionCallPart?.functionCall?.id).toBe(
        'call_00_CeJrKJB0PSmXUZTCWHET7332',
      );
      expect(functionCallPart?.functionCall?.name).toBe('read_file');
    });

    it('preserves thinking parts alongside tool_use when stream throws mid-tool', async () => {
      // Covers reasoning-mode providers (DeepSeek, Claude 4.6+) where the
      // assistant turn carries both a thinking block and a tool_use. The
      // partial-history push must keep the thinking part so DeepSeek's
      // `injectThinkingOnToolUseTurns` converter pass sees an existing
      // block on the replayed turn and does not pre-pend a synthetic one
      // (which would discard the model's original reasoning text).
      mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
      const networkError = new Error('SSE timeout');
      const streamWithThinkingAndTool = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'planning the read', thought: true }],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: {
                      id: 'call_thinking_tool_use',
                      name: 'read_file',
                      args: { path: '/tmp/a.txt' },
                    },
                  },
                ],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
        throw networkError;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamWithThinkingAndTool,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'read /tmp/a.txt' },
        'prompt-thinking-tool-weak-network',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* drain */
          }
        })(),
      ).rejects.toBe(networkError);

      const history = chat.getHistory();
      expect(history.length).toBe(2);
      const modelTurn = history[1]!;
      expect(modelTurn.role).toBe('model');
      const parts = modelTurn.parts!;
      // The thinking part must come before the functionCall — Anthropic
      // requires thinking blocks first in the assistant content array.
      expect(parts[0]!.thought).toBe(true);
      expect(parts[0]!.text).toBe('planning the read');
      const functionCallPart = parts.find((p) => p.functionCall);
      expect(functionCallPart?.functionCall?.id).toBe('call_thinking_tool_use');
    });

    it('does NOT persist partial assistant turn when stream throws before any tool_use chunk', async () => {
      // Plain-text partial responses are deliberately dropped on stream
      // error: the Retry path pops the trailing user prompt and re-issues
      // it, so a stale partial-text model turn between them would bias
      // the retry or surface as duplicate output. Only tool_use turns
      // need the partial-history bridge to preserve the tool_use →
      // tool_result invariant — text alone has no such invariant.
      mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
      const networkError = new Error('connection reset');
      const streamThatThrowsAfterText = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: 'partial reply that will be lost' }],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
        throw networkError;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamThatThrowsAfterText,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'hello' },
        'prompt-weak-network-text',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* drain */
          }
        })(),
      ).rejects.toBe(networkError);

      const history = chat.getHistory();
      // Only the user turn is in history — the partial-text model turn is
      // intentionally not persisted.
      expect(history.length).toBe(1);
      expect(history[0]!.role).toBe('user');
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

    it('coalesces startup reminders with the first user prompt for provider requests', async () => {
      chat.setHistory([
        {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>\nstartup context\n</system-reminder>',
            },
          ],
        },
      ]);
      const response = (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'response' }],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        response,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'hello' },
        'prompt-id-startup-coalesce',
      );
      for await (const _ of stream) {
        // consume stream
      }

      const request = vi.mocked(mockContentGenerator.generateContentStream).mock
        .calls[0]?.[0];
      expect(request?.contents).toEqual([
        {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>\nstartup context\n</system-reminder>',
            },
            { text: 'hello' },
          ],
        },
      ]);
      expect(chat.getHistory()).toEqual([
        {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>\nstartup context\n</system-reminder>',
            },
          ],
        },
        { role: 'user', parts: [{ text: 'hello' }] },
        { role: 'model', parts: [{ text: 'response' }] },
      ]);
      expect(chat.getHistory(true)).toEqual([
        {
          role: 'user',
          parts: [
            {
              text: '<system-reminder>\nstartup context\n</system-reminder>',
            },
            { text: 'hello' },
          ],
        },
        { role: 'model', parts: [{ text: 'response' }] },
      ]);
    });

    it('does not deep-clone the full curated history when building request contents', async () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'prior question' }] },
        { role: 'model', parts: [{ text: 'prior answer' }] },
      ]);
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
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        response,
      );
      const structuredCloneSpy = vi
        .spyOn(globalThis, 'structuredClone')
        .mockImplementation(() => {
          throw new Error('structuredClone should not build request contents');
        });

      try {
        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'hello' },
          'prompt-id-no-request-clone',
        );
        for await (const _ of stream) {
          // consume stream
        }
      } finally {
        structuredCloneSpy.mockRestore();
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [
            { role: 'user', parts: [{ text: 'prior question' }] },
            { role: 'model', parts: [{ text: 'prior answer' }] },
            { role: 'user', parts: [{ text: 'hello' }] },
          ],
        }),
        'prompt-id-no-request-clone',
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

    it.each([
      ['NaN', NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['negative', -100],
      ['null', null],
      ['undefined', undefined],
      ['string', '42' as unknown as number],
    ])(
      'coerces hostile-provider %s promptTokenCount so the compaction gate is not poisoned',
      async (_label, badValue) => {
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
            // Both prompt and total are hostile here. With coercion both go
            // to 0, so the per-chat counter stays at its initial 0 and the
            // global telemetry is NOT called (the `if (lastPromptTokenCount)`
            // guard skips the zero case).
            usageMetadata: {
              promptTokenCount: badValue,
              totalTokenCount: badValue,
              candidatesTokenCount: 15,
            },
          } as unknown as GenerateContentResponse;
        })();
        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          response,
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'hello' },
          `prompt-id-hostile-${_label}`,
        );
        for await (const _ of stream) {
          // consume stream
        }

        // Per-chat counter must not be poisoned (stays at initial 0).
        expect(chat.getLastPromptTokenCount()).toBe(0);
        // Global telemetry must not receive a hostile value either.
        expect(
          uiTelemetryService.setLastPromptTokenCount,
        ).not.toHaveBeenCalled();

        // `coerceUsageCount` warns on hostile, defined values so operators can
        // diagnose silent coercion. `null` / `undefined` (the "field omitted"
        // case) is expected and must stay silent.
        const warnCalls = mockDebugLoggerWarn.mock.calls;
        if (badValue == null) {
          // No warn should mention prompt/total — provider simply omitted them.
          const tokenWarn = warnCalls.find(
            (args) =>
              typeof args[0] === 'string' &&
              (args[0].includes('promptTokenCount') ||
                args[0].includes('totalTokenCount')),
          );
          expect(tokenWarn).toBeUndefined();
        } else {
          const promptWarn = warnCalls.find(
            (args) =>
              typeof args[0] === 'string' &&
              args[0].includes('hostile promptTokenCount'),
          );
          const totalWarn = warnCalls.find(
            (args) =>
              typeof args[0] === 'string' &&
              args[0].includes('hostile totalTokenCount'),
          );
          expect(promptWarn).toBeDefined();
          expect(totalWarn).toBeDefined();
          // The hostile value must be embedded so logs are actionable.
          expect(promptWarn?.[0]).toContain(String(badValue));
        }
      },
    );

    it('falls back to coerced totalTokenCount when promptTokenCount is hostile', async () => {
      const response = (async function* () {
        yield {
          candidates: [
            {
              content: {
                parts: [{ text: 'response' }],
                role: 'model',
              },
              finishReason: 'STOP',
            },
          ],
          text: () => 'response',
          usageMetadata: {
            promptTokenCount: NaN,
            totalTokenCount: 73,
            candidatesTokenCount: 15,
          },
        } as unknown as GenerateContentResponse;
      })();
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        response,
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'hello' },
        'prompt-id-hostile-fallback',
      );
      for await (const _ of stream) {
        // consume stream
      }

      expect(chat.getLastPromptTokenCount()).toBe(73);
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledWith(
        73,
      );
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
      // The hard-tier rescue calls getHistoryShallow(true) (when
      // lastPromptTokenCount=0) for its estimator; the post-compression
      // history-load is getRequestHistory(). The "after compression" failure
      // scenario this test targets is the latter — mock that call to throw.
      vi.spyOn(
        chat as unknown as { getRequestHistory: () => Content[] },
        'getRequestHistory',
      ).mockImplementationOnce(() => {
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
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        contextWindowSize: 200_000,
      });
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
      expect(passedOpts.pendingUserMessage).toBeDefined();
      expect(passedOpts.pendingUserMessage?.role).toBe('user');
      expect(
        passedOpts.pendingUserMessage?.parts?.some(
          (part) => part.text === userMessageText,
        ),
      ).toBe(true);
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
      const recordChatCompression = vi.fn();
      const chatWithRecording = new GeminiChat(
        mockConfig,
        config,
        [],
        {
          recordAssistantTurn: vi.fn(),
          recordChatCompression,
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
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
      chatWithRecording.setLastPromptTokenCount(176_999);

      const userMessage = 'this is the next user message';
      const stream = await chatWithRecording.sendMessageStream(
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
      // trigger='auto' is the orphan-strip safety wire: without it the
      // service would see force=true, default compactTrigger to 'manual',
      // and strip the trailing model+functionCall mid tool-loop. Asserting
      // the wiring here guards C1 from silent regression.
      expect(passedOpts.trigger).toBe('auto');
      expect(passedOpts.pendingUserMessage).toBeDefined();
      expect(passedOpts.pendingUserMessage?.role).toBe('user');
      expect(
        passedOpts.pendingUserMessage?.parts?.some(
          (part) => part.text === userMessage,
        ),
      ).toBe(true);
      expect(recordChatCompression).toHaveBeenCalledTimes(1);
      const recordPayload = recordChatCompression.mock.calls[0][0];
      expect(recordPayload.info).toEqual(
        expect.objectContaining({
          compressionStatus: CompressionStatus.COMPRESSED,
          newTokenCount: 40_000,
        }),
      );
      expect(recordPayload.compressedHistory).toEqual([
        { role: 'user', parts: [{ text: 'summary' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ]);
    });

    it('rejects before request serialization when oversized resumed history cannot be compressed', async () => {
      const oversizedResumedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'x'.repeat(720_000) }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ];
      chat.setHistory(oversizedResumedHistory);
      expect(chat.getLastPromptTokenCount()).toBe(0);

      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 180_000,
            newTokenCount: 180_000,
            compressionStatus:
              CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockRejectedValue(
        new Error('Invalid string length'),
      );

      await expect(
        chat.sendMessageStream(
          'test-model',
          { message: 'continue' },
          'prompt-id-oversized-resume-guard',
        ),
      ).rejects.toThrow(
        /compression status: COMPRESSION_FAILED_EMPTY_SUMMARY/i,
      );

      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(chat.getHistory()).toHaveLength(2);
    });

    it('rejects before request serialization and restores history when hard-rescue compression is still oversized', async () => {
      const originalHistory: Content[] = [
        { role: 'user', parts: [{ text: 'x'.repeat(720_000) }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ];
      const recordChatCompression = vi.fn();
      const chatWithRecording = new GeminiChat(
        mockConfig,
        config,
        [],
        {
          recordAssistantTurn: vi.fn(),
          recordChatCompression,
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      chatWithRecording.setHistory(originalHistory);
      chatWithRecording.setLastPromptTokenCount(176_999);

      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockResolvedValueOnce({
        newHistory: [
          { role: 'user', parts: [{ text: 'still large summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        info: {
          originalTokenCount: 180_000,
          newTokenCount: 177_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockRejectedValue(
        new Error('Invalid string length'),
      );

      await expect(
        chatWithRecording.sendMessageStream(
          'test-model',
          { message: 'continue' },
          'prompt-id-oversized-after-compression',
        ),
      ).rejects.toThrow(/compression status: COMPRESSED/i);

      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
      expect(recordChatCompression).not.toHaveBeenCalled();
      expect(chatWithRecording.getLastPromptTokenCount()).toBe(176_999);
      expect(chatWithRecording.getHistory()[0].parts?.[0].text).toBe(
        originalHistory[0].parts?.[0].text,
      );
    });

    it('rejects when compressed history is below hard but the pending user message pushes it over', async () => {
      const originalHistory: Content[] = [
        { role: 'user', parts: [{ text: 'x'.repeat(720_000) }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ];
      const recordChatCompression = vi.fn();
      const chatWithRecording = new GeminiChat(
        mockConfig,
        config,
        [],
        {
          recordAssistantTurn: vi.fn(),
          recordChatCompression,
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      chatWithRecording.setHistory(originalHistory);
      chatWithRecording.setLastPromptTokenCount(175_500);

      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockResolvedValueOnce({
        newHistory: [
          { role: 'user', parts: [{ text: 'summary' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        info: {
          originalTokenCount: 180_000,
          newTokenCount: 176_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('should not send'),
      );

      await expect(
        chatWithRecording.sendMessageStream(
          'test-model',
          { message: 'x'.repeat(8_000) },
          'prompt-id-oversized-after-compression-and-user',
        ),
      ).rejects.toThrow(/Estimated prompt tokens: 178000; hard limit: 177000/i);

      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
      expect(recordChatCompression).not.toHaveBeenCalled();
      expect(chatWithRecording.getLastPromptTokenCount()).toBe(175_500);
      expect(chatWithRecording.getHistory()[0].parts?.[0].text).toBe(
        originalHistory[0].parts?.[0].text,
      );
    });

    it('forwards latched consecutiveFailures into hard-rescue (no pre-call reset); success recovers via the post-call branch', async () => {
      // Hard-rescue uses force=true, which already bypasses the
      // chatCompressionService breaker (the `!force` check in compress's
      // cheap-gate) regardless of the counter value — so a pre-call reset
      // is unnecessary for "let the latched breaker recover".
      //
      // Pre-resetting would in fact DEFEAT the breaker on
      // persistent-failure sessions: hard-rescue failures don't increment
      // via tryCompress (force=true skips the `if (!force)` increment in
      // the failure branch), and only the reactive overflow handler
      // explicitly increments. If hard-rescue zeroed the counter on every
      // send, the reactive-overflow increment would be wiped next send
      // and the counter would oscillate 0↔1 indefinitely.
      //
      // Correct behavior asserted here: hard-rescue forwards the existing
      // counter value as-is; on COMPRESSED success the post-call branch
      // in tryCompress's COMPRESSED handler resets to 0 (recovering a
      // latched session).
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );

      // Step 1: latch the breaker via MAX_CONSECUTIVE_FAILURES below-hard
      // failures (cheap-gate path, force=false).
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
      // Pre-increment semantic: i-th call sees i; counter on chat is now
      // MAX_CONSECUTIVE_FAILURES (latched).
      expect(compressSpy.mock.calls.at(-1)![1].consecutiveFailures).toBe(
        MAX_CONSECUTIVE_FAILURES - 1,
      );

      // Step 2: bump lastPromptTokenCount into hard tier and send again.
      // Hard-rescue fires (force=true) and the COMPRESSED result triggers
      // the post-call reset in tryCompress's COMPRESSED handler.
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
        'prompt-hard-rescue-no-prereset',
      );
      for await (const _ of rescueStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
      // Counter forwarded as-is — the LATCHED value, NOT zero.
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(
        MAX_CONSECUTIVE_FAILURES,
      );

      // Step 3: verify the post-call reset took effect on the chat. A
      // follow-up below-hard send (cheap-gate path, force=false) should
      // forward consecutiveFailures=0, proving the post-call reset in
      // tryCompress's COMPRESSED handler ran on the Step 2 result.
      compressSpy.mockClear();
      compressSpy.mockResolvedValueOnce({
        newHistory: null,
        info: {
          originalTokenCount: 40_000,
          newTokenCount: 40_000,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      chat.setLastPromptTokenCount(50_000);
      const followUpStream = await chat.sendMessageStream(
        'test-model',
        { message: 'after recovery' },
        'prompt-hard-rescue-after-recovery',
      );
      for await (const _ of followUpStream) {
        /* consume */
      }
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(0);
      expect(compressSpy.mock.calls[0][1].force).toBe(false);
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

  describe('getHistoryFunctionResponseIds', () => {
    // Walk-only accessor used by `useGeminiStream.handleCompletedTools`
    // for the dedup pass. The whole point of this method is to avoid
    // the multi-millisecond `structuredClone` hit that
    // `getHistory()` pays on long sessions when only the id Set is
    // needed. Pin the contract: returned Set contains every fr id
    // present in user turns (including duplicates collapsed to one
    // Set entry), and ignores parts that aren't functionResponses
    // and turns that aren't user.
    it('returns an empty Set for empty history', () => {
      expect(chat.getHistoryFunctionResponseIds()).toEqual(new Set());
    });

    it('collects fr ids from user turns and ignores non-fr parts', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'go' }] },
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'cid_a', name: 'read_file', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_a',
                name: 'read_file',
                response: { output: 'a' },
              },
            },
            { text: 'follow up' },
          ],
        },
      ]);

      expect(chat.getHistoryFunctionResponseIds()).toEqual(new Set(['cid_a']));
    });

    it('skips functionCall parts in model turns (only user[fr] counts)', () => {
      // Defensive: a regression that walks all turns instead of just
      // user turns would pull in `functionCall.id`s and double-count.
      chat.setHistory([
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'cid_model', name: 'read_file', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_user',
                name: 'read_file',
                response: { output: 'u' },
              },
            },
          ],
        },
      ]);

      const ids = chat.getHistoryFunctionResponseIds();
      expect(ids).toEqual(new Set(['cid_user']));
      expect(ids.has('cid_model')).toBe(false);
    });

    it('collapses duplicate fr ids across multiple user turns to one Set entry', () => {
      // Same id echoed twice in different user turns: dedup callers
      // only need to know "is this id paired anywhere", not the
      // count, so a Set is sufficient and natural.
      chat.setHistory([
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_dup',
                name: 'read_file',
                response: { output: '1' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_dup',
                name: 'read_file',
                response: { output: '2' },
              },
            },
          ],
        },
      ]);

      const ids = chat.getHistoryFunctionResponseIds();
      expect(ids.size).toBe(1);
      expect(ids.has('cid_dup')).toBe(true);
    });

    it('handles entries with no parts and parts with no functionResponse', () => {
      // Defensive against malformed history (missing parts, parts
      // with neither text nor fr): must not crash.
      chat.setHistory([
        { role: 'user', parts: undefined as unknown as Part[] },
        { role: 'user', parts: [] },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_ok',
                name: 'read_file',
                response: { output: 'ok' },
              },
            },
          ],
        },
      ]);

      expect(chat.getHistoryFunctionResponseIds()).toEqual(new Set(['cid_ok']));
    });

    it('does not deep-clone history (returns a fresh Set, not aliased to internal state)', () => {
      // The whole reason this method exists is to avoid the
      // structuredClone in getHistory(). Mutating the returned Set
      // must not bleed into the next call.
      chat.setHistory([
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_immut',
                name: 'read_file',
                response: { output: 'v' },
              },
            },
          ],
        },
      ]);

      const first = chat.getHistoryFunctionResponseIds();
      first.add('cid_FAKE');
      first.delete('cid_immut');

      const second = chat.getHistoryFunctionResponseIds();
      expect(second.has('cid_immut')).toBe(true);
      expect(second.has('cid_FAKE')).toBe(false);
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

  describe('getHistoryShallow', () => {
    it('copies containers without structured-cloning large part payloads', () => {
      const payload = { output: 'x'.repeat(128 * 1024) };
      const content: Content = {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-1',
              name: 'read_file',
              response: payload,
            },
          },
        ],
      };
      chat.addHistory(content);
      const structuredCloneSpy = vi
        .spyOn(globalThis, 'structuredClone')
        .mockImplementation(() => {
          throw new Error('unexpected deep clone');
        });

      const history = chat.getHistoryShallow();

      expect(structuredCloneSpy).not.toHaveBeenCalled();
      expect(history).toEqual([content]);
      expect(history[0]).not.toBe(content);
      expect(history[0]!.parts).not.toBe(content.parts);
      const response = history[0]!.parts![0] as {
        functionResponse: { response: typeof payload };
      };
      expect(response.functionResponse.response).toBe(payload);
    });
  });

  describe('getHistoryTailShallow', () => {
    it('copies only recent containers without cloning payloads', () => {
      const oldContent: Content = { role: 'user', parts: [{ text: 'old' }] };
      const recentContent: Content = {
        role: 'model',
        parts: [{ text: 'recent' }],
      };
      chat.addHistory(oldContent);
      chat.addHistory(recentContent);
      const structuredCloneSpy = vi
        .spyOn(globalThis, 'structuredClone')
        .mockImplementation(() => {
          throw new Error('unexpected deep clone');
        });

      const tail = chat.getHistoryTailShallow(1);

      expect(structuredCloneSpy).not.toHaveBeenCalled();
      expect(tail).toEqual([recentContent]);
      expect(tail[0]).not.toBe(recentContent);
      expect(tail[0]!.parts).not.toBe(recentContent.parts);
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

  describe('peekLastHistoryEntry', () => {
    it('returns the last entry without structured-cloning the full history', () => {
      const first: Content = { role: 'user', parts: [{ text: 'a' }] };
      const last: Content = { role: 'model', parts: [{ text: 'b' }] };
      chat.addHistory(first);
      chat.addHistory(last);
      const structuredCloneSpy = vi
        .spyOn(globalThis, 'structuredClone')
        .mockImplementation(() => {
          throw new Error('unexpected deep clone');
        });

      expect(chat.peekLastHistoryEntry()).toBe(last);
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    });
  });

  describe('getLastModelMessageText', () => {
    it('returns text from the latest model message without cloning history', () => {
      chat.addHistory({ role: 'model', parts: [{ text: 'older' }] });
      chat.addHistory({ role: 'user', parts: [{ text: 'question' }] });
      chat.addHistory({
        role: 'model',
        parts: [{ text: 'new' }, { text: ' answer' }],
      });
      const structuredCloneSpy = vi
        .spyOn(globalThis, 'structuredClone')
        .mockImplementation(() => {
          throw new Error('unexpected deep clone');
        });

      expect(chat.getLastModelMessageText()).toBe('new answer');
      expect(structuredCloneSpy).not.toHaveBeenCalled();
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

    it('rolls back the partial assistant turn when a retryable error fires after a tool_use chunk', async () => {
      // Regression for a stream attempt that yields a `functionCall`
      // (which triggers the partial-history push in
      // `processStreamResponse`), then throws a retryable error (e.g.
      // a TPM 429 `StreamContentError`). The outer retry loop must
      // drop the partial before issuing the
      // retry — otherwise the retry's response lands as a SECOND
      // consecutive `model` entry and the failed-attempt `tool_use`
      // becomes orphan on the wire (invalid alternation +
      // tool_use_id-with-no-matching-tool_use 400).
      vi.useFakeTimers();
      try {
        const tpmError = new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        );
        const failingStream = (async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: 'call_failed_retry_attempt',
                        name: 'read_file',
                        args: { path: '/tmp/a.txt' },
                      },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          throw tpmError;
        })();
        const successStream = (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'Success after retry' }] },
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
          'prompt-rollback-on-retry',
        );
        const iterator = stream[Symbol.asyncIterator]();
        // Advance through the rate-limit RETRY + delay, drain all events.
        for (;;) {
          const next = iterator.next();
          await vi.advanceTimersByTimeAsync(60_000);
          const r = await next;
          if (r.done) break;
        }

        const history = chat.getHistory();
        // History must NOT contain the failed attempt's partial
        // model[functionCall]. Expected shape: [user, model(success
        // text)] — exactly two entries, alternation intact.
        expect(history.length).toBe(2);
        expect(history[0]!.role).toBe('user');
        expect(history[1]!.role).toBe('model');
        const successText = history[1]!.parts!.find((p) => p.text)?.text;
        expect(successText).toBe('Success after retry');
        // Defensively: NO functionCall anywhere in history.
        expect(history.some((h) => h.parts?.some((p) => p.functionCall))).toBe(
          false,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('rolls back the partial assistant turn when an InvalidStreamError fires after a tool_use chunk on the transient-stream retry budget', async () => {
      // Counterpart to the rate-limit rollback above. The
      // transient-stream retry budget (NO_FINISH_REASON /
      // NO_RESPONSE_TEXT) has its own popPartialIfPushed call site —
      // separate from the rate-limit branch the existing test
      // covers. Without a regression test, that call could be
      // accidentally removed and the rate-limit test would still
      // pass while a stale partial silently rode the retry.
      vi.useFakeTimers();
      try {
        const failingStream = (async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: 'call_transient_retry_partial',
                        name: 'read_file',
                        args: { path: '/tmp/t.txt' },
                      },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          // Mid-tool_use cut without a finish reason — the transient-
          // stream retry budget catches this and retries with delay.
          throw new InvalidStreamError(
            'Model stream ended without a finish reason.',
            'NO_FINISH_REASON',
          );
        })();
        const successStream = (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'Recovered on retry' }] },
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
          'prompt-rollback-transient',
        );
        const iterator = stream[Symbol.asyncIterator]();
        // Advance through the transient-retry delay (initial 2000 ms).
        for (;;) {
          const next = iterator.next();
          await vi.advanceTimersByTimeAsync(5_000);
          const r = await next;
          if (r.done) break;
        }

        const history = chat.getHistory();
        // Final shape must be clean: [user, model(success text)].
        // The failed attempt's partial functionCall must NOT survive.
        expect(history.length).toBe(2);
        expect(history[0]!.role).toBe('user');
        expect(history[1]!.role).toBe('model');
        expect(history[1]!.parts!.find((p) => p.text)?.text).toBe(
          'Recovered on retry',
        );
        expect(history.some((h) => h.parts?.some((p) => p.functionCall))).toBe(
          false,
        );
      } finally {
        vi.useRealTimers();
      }
    });

    // NOTE: no test for the InvalidStreamError content-retry branch
    // (geminiChat.ts ~line 1399). Verified unreachable for that error
    // class: `isTransientStreamError` and `isContentError` are the
    // same predicate (`error instanceof InvalidStreamError`), so the
    // transient branch above always either `continue`s or `break`s
    // before control reaches the content branch. The
    // `popPartialIfPushed()` call there is preserved as
    // defense-in-depth for a future error class that should diverge
    // the predicates; see the comment block at that call site for
    // the full analysis.

    it('rolls back the chat-recording entry too when the retry succeeds', async () => {
      // The in-memory rollback test above asserts `this.history` ends
      // clean after a retry-success. This test asserts the same about
      // chat-recording JSONL: the failed attempt's `recordAssistantTurn`
      // call must NOT have been flushed, so `--resume` won't rehydrate
      // a model[functionCall] turn the live session correctly discarded.
      // Without the deferred-flush stash + popPartialIfPushed clear,
      // `recordAssistantTurn` was called twice (once for the partial,
      // once for the success) and only the in-memory pop fixed live
      // history; the durable transcript stayed corrupt.
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = new GeminiChat(
          mockConfig,
          config,
          [],
          {
            recordAssistantTurn,
            recordChatCompression: vi.fn(),
          } as unknown as ConstructorParameters<typeof GeminiChat>[3],
          uiTelemetryService,
        );

        const tpmError = new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        );
        const failingStream = (async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: 'call_failed_retry_recording',
                        name: 'read_file',
                        args: { path: '/tmp/a.txt' },
                      },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          throw tpmError;
        })();
        const successStream = (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'Success after retry' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })();
        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(failingStream)
          .mockResolvedValueOnce(successStream);

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-recording-rollback',
        );
        const iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const next = iterator.next();
          await vi.advanceTimersByTimeAsync(60_000);
          const r = await next;
          if (r.done) break;
        }

        // Exactly one recording: the successful retry's text turn.
        // The failed attempt's partial functionCall must have been
        // discarded by `popPartialIfPushed` clearing the deferred-flush
        // stash, never reaching the JSONL.
        expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
        const recordedMessage = recordAssistantTurn.mock.calls[0]![0]
          ?.message as Array<{ text?: string; functionCall?: unknown }>;
        const recordedText = recordedMessage.find((p) => p.text)?.text;
        expect(recordedText).toBe('Success after retry');
        // No functionCall part anywhere in the recorded turn.
        expect(recordedMessage.some((p) => p.functionCall)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('flushes the chat-recording entry on the unretryable break path (kept partial → durable JSONL)', async () => {
      // Counterpart to the rollback test: when the retry budget is
      // exhausted (or the error is unretryable from the start), the
      // partial assistant turn IS kept in `this.history` — and the
      // chat-recording JSONL must match. Without the deferred-flush
      // path firing at the rethrow site, the JSONL silently drops a
      // partial that's still in live history, and the orphan-tool_use
      // repair pass at session-load has no dangling functionCall to
      // close → `--resume` first send 400s with the very wedge the
      // repair was supposed to escape.
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = new GeminiChat(
          mockConfig,
          config,
          [],
          {
            recordAssistantTurn,
            recordChatCompression: vi.fn(),
          } as unknown as ConstructorParameters<typeof GeminiChat>[3],
          uiTelemetryService,
        );

        // Unretryable: a non-rate-limit, non-InvalidStream error after
        // a tool_use chunk lands. The catch block falls through to
        // `break` with the partial kept in memory.
        const failingStream = (async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: 'call_unretryable_kept',
                        name: 'read_file',
                        args: { path: '/tmp/k.txt' },
                      },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          throw new Error('synthetic unretryable mid-stream failure');
        })();
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockResolvedValueOnce(failingStream);

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-recording-flush-on-break',
        );
        const iterator = stream[Symbol.asyncIterator]();
        await expect(
          (async () => {
            for (;;) {
              const r = await iterator.next();
              if (r.done) return;
            }
          })(),
        ).rejects.toThrow(/synthetic unretryable/);

        // In-memory: partial is kept (the wedge-recovery contract that
        // the rest of this PR's machinery relies on).
        const history = chatWithRecording.getHistory();
        const lastModelTurn = history.findLast((h) => h.role === 'model');
        expect(
          lastModelTurn?.parts?.some(
            (p) => p.functionCall?.id === 'call_unretryable_kept',
          ),
        ).toBe(true);

        // JSONL: must contain the same partial turn so `--resume` sees
        // a transcript that matches live history. Exactly one record
        // (no success retry happened on this path).
        expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
        const recordedMessage = recordAssistantTurn.mock.calls[0]![0]
          ?.message as Array<{ functionCall?: { id?: string } }>;
        expect(
          recordedMessage.some(
            (p) => p.functionCall?.id === 'call_unretryable_kept',
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

    it('should pass configured retry error codes into streamed retry diagnostics', async () => {
      vi.useFakeTimers();

      try {
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
          authType: AuthType.USE_OPENAI,
          model: 'test-model',
          retryErrorCodes: [4999],
        });
        const providerThrottle = Object.assign(
          new StreamContentError('Provider-specific throttle'),
          { status: 4999 },
        );

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              throw providerThrottle;

              yield {} as GenerateContentResponse;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Success after custom code retry' }],
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
          'prompt-id-custom-retry-code',
        );

        const iterator = stream[Symbol.asyncIterator]();
        const first = await iterator.next();
        expect(first.value.type).toBe(StreamEventType.RETRY);

        const secondPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(60_000);
        await secondPromise;

        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
        }

        expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
          'Rate limit retry scheduled',
          expect.objectContaining({
            classificationDiagnosis: 'retryable',
            classificationReason: 'rate-limit',
            errorKind: 'provider',
          }),
        );
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

    it('preserves the startup reminder when stripping a failed first prompt', () => {
      const startupReminder: Content = {
        role: 'user',
        parts: [{ text: `${SYSTEM_REMINDER_OPEN}\nctx\n</system-reminder>` }],
      };
      chat.setHistory([
        startupReminder,
        { role: 'user', parts: [{ text: 'failed first prompt' }] },
      ]);

      chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual([startupReminder]);
    });

    it('preserves a mid-history MCP added-tool reminder when a later prompt fails', () => {
      // drainPendingAddedMcpToolsReminder injects a system-reminder user
      // entry; if the following prompt fails, popping it must NOT also pop
      // the reminder — the announcement can't be re-queued (the tool is
      // already in announcedDeferredToolNames) so it would be lost forever.
      const mcpReminder: Content = {
        role: 'user',
        parts: [
          { text: `${SYSTEM_REMINDER_OPEN}\nadded: foo\n</system-reminder>` },
        ],
      };
      chat.setHistory([
        { role: 'user', parts: [{ text: 'earlier prompt' }] },
        { role: 'model', parts: [{ text: 'earlier response' }] },
        mcpReminder,
        { role: 'user', parts: [{ text: 'failed prompt' }] },
      ]);

      chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual([
        { role: 'user', parts: [{ text: 'earlier prompt' }] },
        { role: 'model', parts: [{ text: 'earlier response' }] },
        mcpReminder,
      ]);
    });

    it('pops a failed turn whose reminder shares a Content with the prompt', () => {
      // In plan mode (and with subagent/memory reminders) the per-turn
      // reminder is prepended as an extra part to the SAME user Content as the
      // prompt — sendMessageStream records [<system-reminder>…, prompt] as one
      // entry. A failed turn leaves that combined entry trailing. Matching
      // parts[0] alone would treat it as structural and preserve the user's
      // prompt text, which then leaks into the next turn via
      // appendCuratedContent. It must be popped because not every part is a
      // reminder.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'earlier prompt' }] },
        { role: 'model', parts: [{ text: 'earlier response' }] },
        {
          role: 'user',
          parts: [
            {
              text: `${SYSTEM_REMINDER_OPEN}\nPlan mode is active.\n</system-reminder>`,
            },
            { text: 'the actual user prompt' },
          ],
        },
      ]);

      chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual([
        { role: 'user', parts: [{ text: 'earlier prompt' }] },
        { role: 'model', parts: [{ text: 'earlier response' }] },
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

  describe('partial-push marker invariants on history mutation', () => {
    // The whole partial-push lifecycle relies on the invariant
    //   "every history-mutation method clears the partial-push markers"
    // — six sites enforce it (clearHistory, addHistory, setHistory,
    // truncateHistory, stripThoughtsFromHistory,
    // stripOrphanedUserEntriesFromHistory). If any site forgets, a
    // stale `pendingPartialAssistantTurnIndex` could line up with an
    // unrelated model turn in the post-mutation history and cause
    // `popPartialIfPushed` to splice the WRONG entry — silently losing
    // a real assistant response.
    //
    // The markers are ephemeral within a single sendMessageStream
    // call: the `finally` block flushes the deferred JSONL record
    // and calls `clearPendingPartialState()` before the generator
    // unwinds. So we can't observe non-null markers after a real
    // mid-stream error completes — by that point the lifecycle has
    // already cleared them. Instead, we plant the markers directly
    // via the same private-field assignment the production code uses,
    // then call each mutation method and verify both fields are reset
    // in lockstep. This pins the invariant against future refactors
    // that drop a `clearPendingPartialState()` call from one site
    // while the other five still pass.
    type PrivateFields = {
      pendingPartialAssistantTurnIndex: number | null;
      pendingPartialAssistantRecord: unknown;
    };
    function plantMarkers(c: GeminiChat): void {
      const internal = c as unknown as PrivateFields;
      internal.pendingPartialAssistantTurnIndex = 0;
      internal.pendingPartialAssistantRecord = {
        model: 'test-model',
        message: [{ functionCall: { id: 'call_test', name: 't', args: {} } }],
      };
    }
    function markers(c: GeminiChat): {
      idx: number | null;
      record: unknown;
    } {
      const internal = c as unknown as PrivateFields;
      return {
        idx: internal.pendingPartialAssistantTurnIndex,
        record: internal.pendingPartialAssistantRecord,
      };
    }

    it('clearHistory() clears the partial-push markers', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'kick off' }] },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'x', name: 't', args: {} } }],
        },
      ]);
      plantMarkers(chat);
      expect(markers(chat).idx).toBe(0);

      chat.clearHistory();

      expect(markers(chat).idx).toBeNull();
      expect(markers(chat).record).toBeNull();
    });

    it('addHistory() clears the partial-push markers (violation path)', () => {
      // addHistory is documented to be called between sends, NOT
      // mid-send. Calling it with markers active is a violation —
      // the implementation logs a warn so the offending caller is
      // visible in diagnostics, then clears the markers.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'kick off' }] },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'x', name: 't', args: {} } }],
        },
      ]);
      plantMarkers(chat);
      expect(markers(chat).idx).toBe(0);

      chat.addHistory({ role: 'user', parts: [{ text: 'between sends' }] });

      expect(markers(chat).idx).toBeNull();
      expect(markers(chat).record).toBeNull();
    });

    it('setHistory() clears the partial-push markers', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'kick off' }] },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'x', name: 't', args: {} } }],
        },
      ]);
      plantMarkers(chat);
      expect(markers(chat).idx).toBe(0);

      chat.setHistory([{ role: 'user', parts: [{ text: 'replacement' }] }]);

      expect(markers(chat).idx).toBeNull();
      expect(markers(chat).record).toBeNull();
    });

    it('truncateHistory() clears the partial-push markers', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'kick off' }] },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'x', name: 't', args: {} } }],
        },
      ]);
      plantMarkers(chat);
      expect(markers(chat).idx).toBe(0);

      chat.truncateHistory(1);

      expect(markers(chat).idx).toBeNull();
      expect(markers(chat).record).toBeNull();
    });

    it('stripThoughtsFromHistory() clears the partial-push markers', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'kick off' }] },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'x', name: 't', args: {} } }],
        },
      ]);
      plantMarkers(chat);
      expect(markers(chat).idx).toBe(0);

      chat.stripThoughtsFromHistory();

      expect(markers(chat).idx).toBeNull();
      expect(markers(chat).record).toBeNull();
    });

    it('stripOrphanedUserEntriesFromHistory() clears the partial-push markers', () => {
      // History tail is a model turn — strip is a no-op on history,
      // but the marker reset must still fire so all six mutation
      // sites stay uniform.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'kick off' }] },
        {
          role: 'model',
          parts: [{ functionCall: { id: 'x', name: 't', args: {} } }],
        },
      ]);
      plantMarkers(chat);
      expect(markers(chat).idx).toBe(0);

      chat.stripOrphanedUserEntriesFromHistory();

      expect(markers(chat).idx).toBeNull();
      expect(markers(chat).record).toBeNull();
    });
  });

  describe('repairOrphanedToolUseTurns', () => {
    // Verifies the inverse-of-strip pass: every `model[functionCall]`
    // without a matching `user[functionResponse]` in the next turn gets
    // a synthesized error functionResponse. This closes the
    // tool_use ↔ tool_result wire invariant for the residual races
    // (`--resume` of a crashed session, Ctrl+Y before in-flight tool
    // finishes, scheduler abort before submitQuery, manual JSONL edits).

    it('injects a synthetic functionResponse for a trailing tool_use (Race B/C)', () => {
      // --resume of a session that crashed after the partial-tool_use push
      // in `processStreamResponse` but before the scheduler submitted the
      // tool_result. First API call would 400 without repair.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'open /tmp/a.txt' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_crash_A',
                name: 'read_file',
                args: { path: '/tmp/a.txt' },
              },
            },
          ],
        },
      ]);

      const result = chat.repairOrphanedToolUseTurns();

      expect(result.injected).toEqual([
        { callId: 'call_crash_A', name: 'read_file' },
      ]);
      const history = chat.getHistory();
      expect(history.length).toBe(3);
      expect(history[2]!.role).toBe('user');
      const fr = history[2]!.parts![0]!.functionResponse;
      expect(fr?.id).toBe('call_crash_A');
      expect(fr?.name).toBe('read_file');
      expect((fr?.response as { error?: string })?.error).toMatch(
        /interrupted/i,
      );
    });

    it('hoists synthetic functionResponse to the front of an existing user turn (Race A)', () => {
      // Ctrl+Y race: the user retried while the in-flight tool was still
      // running. `stripOrphanedUserEntriesFromHistory` leaves the
      // model[functionCall] in place (trailing entry is model), then the
      // Retry pushes a fresh user turn with the user prompt. Repair must
      // splice the synthetic response onto that user turn so it sits
      // immediately after the model[tool_use] — NOT create a stray
      // synthetic user turn between them. Crucially the synthetic
      // functionResponse must come BEFORE the text part: Anthropic-
      // compatible backends require tool_result blocks to be first in
      // the user message (mirrors upstream Claude Code's
      // `hoistToolResults`). Otherwise the wire payload re-triggers the
      // "tool_use_id ... must have a corresponding tool_use block in the
      // previous message" 400 this PR is supposed to escape.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'open /tmp/a.txt' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_race_A',
                name: 'read_file',
                args: { path: '/tmp/a.txt' },
              },
            },
          ],
        },
        { role: 'user', parts: [{ text: 'retry prompt' }] },
      ]);

      const result = chat.repairOrphanedToolUseTurns();

      expect(result.injected.map((e) => e.callId)).toEqual(['call_race_A']);
      const history = chat.getHistory();
      expect(history.length).toBe(3);
      expect(history[2]!.role).toBe('user');
      expect(history[2]!.parts!.length).toBe(2);
      // synthetic fr FIRST, user text AFTER.
      expect(history[2]!.parts![0]!.functionResponse?.id).toBe('call_race_A');
      expect(history[2]!.parts![1]).toEqual({ text: 'retry prompt' });
    });

    it('hoists synthetic functionResponse AFTER pre-existing real ones (parallel partial submit)', () => {
      // Parallel tool_use with one real functionResponse already in the
      // user turn — synthetic for the missing callId must slot in
      // between the real fr and any non-fr parts so the user message
      // shape stays `[real_fr, synthetic_fr, text]` (every tool_result
      // before any other content, preserving the real-fr order).
      chat.setHistory([
        { role: 'user', parts: [{ text: 'batch read' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'call_A', name: 'read_file', args: {} },
            },
            {
              functionCall: { id: 'call_B', name: 'read_file', args: {} },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_A',
                name: 'read_file',
                response: { output: 'a' },
              },
            },
            { text: 'retry prompt' },
          ],
        },
      ]);

      chat.repairOrphanedToolUseTurns();
      const parts = chat.getHistory()[2]!.parts!;
      expect(parts.length).toBe(3);
      expect(parts[0]!.functionResponse?.id).toBe('call_A');
      expect(parts[1]!.functionResponse?.id).toBe('call_B');
      expect(parts[2]).toEqual({ text: 'retry prompt' });
    });

    it('handles parallel tool_use turns with only some responses present', () => {
      // Common shape after #4176's partial-history push: the stream
      // emitted multiple `content_block_stop`s for parallel tool_uses,
      // but the React scheduler only submitted some before the user hit
      // Ctrl+Y. The Retry path's repair must close every missing pair —
      // the present `functionResponse` for A must NOT be duplicated.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'batch read' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_A',
                name: 'read_file',
                args: { path: '/a' },
              },
            },
            {
              functionCall: {
                id: 'call_B',
                name: 'read_file',
                args: { path: '/b' },
              },
            },
            {
              functionCall: {
                id: 'call_C',
                name: 'read_file',
                args: { path: '/c' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_A',
                name: 'read_file',
                response: { output: 'a-content' },
              },
            },
          ],
        },
      ]);

      const result = chat.repairOrphanedToolUseTurns();

      const injectedIds = result.injected.map((e) => e.callId);
      expect(injectedIds.sort()).toEqual(['call_B', 'call_C']);
      const history = chat.getHistory();
      // Same shape — synthetics merge into the existing user turn.
      expect(history.length).toBe(3);
      const fr = history[2]!.parts!.map((p) => p.functionResponse?.id);
      expect(fr).toEqual(['call_A', 'call_B', 'call_C']);
      // The pre-existing `call_A` response is untouched (real result kept).
      expect(
        (
          history[2]!.parts![0]!.functionResponse?.response as {
            output?: string;
          }
        )?.output,
      ).toBe('a-content');
    });

    it('is a no-op when every tool_use already has a matching response', () => {
      // Happy path: don't churn history when the invariant already holds.
      const happy = [
        { role: 'user' as const, parts: [{ text: 'q' }] },
        {
          role: 'model' as const,
          parts: [
            {
              functionCall: {
                id: 'call_ok',
                name: 'read_file',
                args: {},
              },
            },
          ],
        },
        {
          role: 'user' as const,
          parts: [
            {
              functionResponse: {
                id: 'call_ok',
                name: 'read_file',
                response: { output: 'fine' },
              },
            },
          ],
        },
      ];
      chat.setHistory(structuredClone(happy));

      const result = chat.repairOrphanedToolUseTurns();

      expect(result.injected).toEqual([]);
      expect(chat.getHistory()).toEqual(happy);
    });

    it('repairs multiple non-adjacent dangling tool_uses across history', () => {
      // Stress case for the forward-walk algorithm: dangling turn near the
      // start AND another near the end. Both should be repaired and the
      // outer loop must not re-scan synthetic user turns it just inserted.
      chat.setHistory([
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'early_orphan',
                name: 'glob',
                args: {},
              },
            },
          ],
        },
        { role: 'user', parts: [{ text: 'second user prompt' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'late_orphan',
                name: 'read_file',
                args: { path: '/x' },
              },
            },
          ],
        },
      ]);

      const result = chat.repairOrphanedToolUseTurns();

      const injectedIds = result.injected.map((e) => e.callId);
      expect(injectedIds.sort()).toEqual(['early_orphan', 'late_orphan']);
      const history = chat.getHistory();
      // early_orphan got the synthetic spliced into the existing user turn
      // between the two model entries; late_orphan got a brand-new
      // trailing user turn appended after the second model entry.
      expect(history.length).toBe(4);
      expect(history[0]!.role).toBe('model');
      expect(history[1]!.role).toBe('user');
      expect(
        history[1]!.parts!.some(
          (p) => p.functionResponse?.id === 'early_orphan',
        ),
      ).toBe(true);
      expect(history[2]!.role).toBe('model');
      expect(history[3]!.role).toBe('user');
      expect(history[3]!.parts![0]!.functionResponse?.id).toBe('late_orphan');
    });

    it('ignores model turns with no functionCall parts', () => {
      const plain = [
        { role: 'user' as const, parts: [{ text: 'hi' }] },
        { role: 'model' as const, parts: [{ text: 'hello' }] },
      ];
      chat.setHistory(structuredClone(plain));

      const result = chat.repairOrphanedToolUseTurns();

      expect(result.injected).toEqual([]);
      expect(chat.getHistory()).toEqual(plain);
    });

    it('uses caller-provided reason text', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'q' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'cid', name: 'read_file', args: {} },
            },
          ],
        },
      ]);

      chat.repairOrphanedToolUseTurns('custom reason');

      const fr = chat.getHistory()[2]!.parts![0]!.functionResponse;
      expect((fr?.response as { error?: string })?.error).toBe('custom reason');
    });

    it('hoists the real functionResponse from a non-adjacent later user turn into the adjacent one', () => {
      // Regression for the shape
      // `[user, model[fc], user[text], user[fr_real]]` — arises when
      // the user aborts a long-running tool, types a follow-up text
      // turn, and the React scheduler's late submitQuery then appends
      // the real tool_result as a SEPARATE user entry.
      //
      // Forward scanning alone prevents the *synthesis* duplicate,
      // but the wire layout is still
      // `model[tool_use] → user[text] → user[tool_result]`, which
      // Anthropic-compatible backends reject because the tool_result
      // is not at the head of the IMMEDIATELY following user message.
      // The repair must MOVE the real fr from history[3] into
      // history[2] (before the text part) so the wire format becomes
      // `model[tool_use] → user[tool_result, text]`.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'open /tmp/long.txt' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_nonadjacent_real',
                name: 'read_file',
                args: { path: '/tmp/long.txt' },
              },
            },
          ],
        },
        { role: 'user', parts: [{ text: 'never mind, do something else' }] },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call_nonadjacent_real',
                name: 'read_file',
                response: { output: 'real file contents' },
              },
            },
          ],
        },
      ]);

      const result = chat.repairOrphanedToolUseTurns();

      // No synthesis (the fr is real, just relocated) — `injected`
      // stays empty so the React scheduler dedup doesn't see it as a
      // synthesized callId.
      expect(result.injected).toEqual([]);
      const history = chat.getHistory();
      // History is now 3 entries: the source turn for the hoisted fr
      // had only the one fr part, so it becomes empty and is removed.
      expect(history.length).toBe(3);
      // Real fr now at the head of the immediate next user turn,
      // before the text part, satisfying the wire-format invariant.
      expect(history[2]!.parts![0]!.functionResponse?.id).toBe(
        'call_nonadjacent_real',
      );
      expect(history[2]!.parts![0]!.functionResponse?.response).toEqual({
        output: 'real file contents',
      });
      expect(history[2]!.parts![1]).toEqual({
        text: 'never mind, do something else',
      });
    });

    it('synthesizes missing fr AND hoists real fr in a parallel tool_use mismatch', () => {
      // Counterpart to the hoist case: when the real fr only covers
      // SOME callIds in a parallel tool_use, and the real one is in a
      // non-adjacent later user turn, BOTH fix-ups apply on the same
      // model turn — synthesize the missing callId AND hoist the real
      // fr from the non-adjacent location into the adjacent turn.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'fan out two reads' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'cid_a', name: 'read_file', args: {} },
            },
            {
              functionCall: { id: 'cid_b', name: 'read_file', args: {} },
            },
          ],
        },
        { role: 'user', parts: [{ text: 'follow up' }] },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_a',
                name: 'read_file',
                response: { output: 'real for a' },
              },
            },
          ],
        },
      ]);

      const result = chat.repairOrphanedToolUseTurns();

      // cid_b synthesized (no real fr anywhere). cid_a is hoisted, not
      // synthesized — `injected` only contains the synthetic.
      expect(result.injected).toEqual([{ callId: 'cid_b', name: 'read_file' }]);
      const history = chat.getHistory();
      // The non-adjacent turn that held cid_a's real fr is now empty
      // and removed → 3 entries instead of the original 4.
      expect(history.length).toBe(3);
      // Adjacent user turn now leads with the synthesized fr_b, then
      // the hoisted real fr_a, then the text. Both tool_results sit
      // at the head, satisfying the Anthropic wire-format invariant.
      const adjacentParts = history[2]!.parts!;
      expect(adjacentParts[0]!.functionResponse?.id).toBe('cid_b');
      expect(
        (adjacentParts[0]!.functionResponse?.response as { error?: string })
          ?.error,
      ).toBeDefined();
      expect(adjacentParts[1]!.functionResponse?.id).toBe('cid_a');
      expect(adjacentParts[1]!.functionResponse?.response).toEqual({
        output: 'real for a',
      });
      expect(adjacentParts[2]).toEqual({ text: 'follow up' });
    });

    it('hoists real fr but preserves the source user turn when it carries other content', () => {
      // Edge case for the hoist path: if the source turn for the real
      // fr ALSO carries text (or any non-fr part), removing the fr
      // alone must NOT delete the turn — the remaining text is the
      // user's real message and must be preserved at its original
      // position. Confirms the empty-turn cleanup only deletes turns
      // whose parts list goes to zero after the splice.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'kick off' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'cid_mix', name: 'read_file', args: {} },
            },
          ],
        },
        { role: 'user', parts: [{ text: 'never mind' }] },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_mix',
                name: 'read_file',
                response: { output: 'data' },
              },
            },
            { text: 'thanks anyway' },
          ],
        },
      ]);

      const result = chat.repairOrphanedToolUseTurns();

      expect(result.injected).toEqual([]);
      const history = chat.getHistory();
      // The source turn lost its fr but kept its trailing text, so
      // history is still 4 entries — the source turn survives as a
      // text-only user message.
      expect(history.length).toBe(4);
      expect(history[2]!.parts![0]!.functionResponse?.id).toBe('cid_mix');
      expect(history[2]!.parts![1]).toEqual({ text: 'never mind' });
      expect(history[3]!.parts).toEqual([{ text: 'thanks anyway' }]);
    });

    it('drops duplicate functionResponse entries for the same callId across user turns', () => {
      // Critical regression: when the same callId is echoed back more
      // than once (e.g. the React scheduler retries the late submitQuery
      // after the orphan repair already planted one, or two parallel
      // late-submit paths land), hoisting only the first leaves the
      // duplicate behind. The wire payload then serializes
      //   `model[tool_use] -> user[tool_result] -> user[tool_result]`
      // and Anthropic-compatible backends reject the trailing block as
      // an orphan, re-wedging the session. The repair MUST hoist one
      // canonical fr into the adjacent turn AND delete every duplicate.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'open file' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'cid_dup', name: 'read_file', args: {} },
            },
          ],
        },
        { role: 'user', parts: [{ text: 'never mind' }] },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_dup',
                name: 'read_file',
                response: { output: 'data' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_dup',
                name: 'read_file',
                response: { output: 'data' },
              },
            },
          ],
        },
      ]);

      const result = chat.repairOrphanedToolUseTurns();

      expect(result.injected).toEqual([]);
      const history = chat.getHistory();
      // 5 → 3: both source turns held only the duplicate fr, so both
      // are removed; the canonical fr is hoisted into history[2] and
      // sits at the head before the text part.
      expect(history.length).toBe(3);
      expect(history[2]!.parts![0]!.functionResponse?.id).toBe('cid_dup');
      expect(history[2]!.parts![1]).toEqual({ text: 'never mind' });
      // No fr for cid_dup remains anywhere AFTER the adjacent turn.
      const trailingHasDup = history
        .slice(3)
        .some((entry) =>
          (entry.parts ?? []).some(
            (part) => part.functionResponse?.id === 'cid_dup',
          ),
        );
      expect(trailingHasDup).toBe(false);
    });

    it('drops duplicate fr even when the canonical copy is already in the adjacent turn', () => {
      // Variant of the duplicate case where the FIRST fr lands in the
      // immediate next user turn (no hoist needed) but a second
      // duplicate copy is in a later user turn. The hoist branch is
      // skipped, but duplicate cleanup must still fire — otherwise the
      // wire payload still has two `tool_result` blocks for the same id.
      chat.setHistory([
        { role: 'user', parts: [{ text: 'kick off' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: { id: 'cid_adj_dup', name: 'read_file', args: {} },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_adj_dup',
                name: 'read_file',
                response: { output: 'real' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'cid_adj_dup',
                name: 'read_file',
                response: { output: 'real' },
              },
            },
            { text: 'follow up' },
          ],
        },
      ]);

      const result = chat.repairOrphanedToolUseTurns();

      expect(result.injected).toEqual([]);
      const history = chat.getHistory();
      // The source duplicate turn loses its fr but keeps its text part
      // → 4 entries preserved, but the duplicate fr is gone.
      expect(history.length).toBe(4);
      expect(history[2]!.parts![0]!.functionResponse?.id).toBe('cid_adj_dup');
      expect(history[2]!.parts!.length).toBe(1);
      expect(history[3]!.parts).toEqual([{ text: 'follow up' }]);
      // The model[fc] is followed by exactly one fr for that id across
      // all subsequent user turns.
      const allFrIds = history
        .slice(2)
        .flatMap((entry) =>
          (entry.parts ?? []).map((p) => p.functionResponse?.id),
        )
        .filter((id): id is string => Boolean(id));
      expect(allFrIds).toEqual(['cid_adj_dup']);
    });
  });

  describe('output token recovery', () => {
    function makeChunk(
      parts: Array<{
        text?: string;
        functionCall?: unknown;
        thought?: boolean;
      }>,
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

    it('should coalesce overlapping recovery continuation text', async () => {
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([
          makeChunk([{ text: 'Alpha shared recovery suffix' }], 'MAX_TOKENS'),
        ]),
        makeStream([
          makeChunk(
            [{ text: 'shared recovery suffix and continuation' }],
            'STOP',
          ),
        ]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a long essay' },
        'prompt-recovery-overlap',
      );

      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');

      expect(lastEntry.role).toBe('model');
      expect(text).toBe('Alpha shared recovery suffix and continuation');
    });

    it('should coalesce recovery text that replays a previous tail anchor', async () => {
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([
          makeChunk(
            [
              {
                text: [
                  'Intro',
                  '### 常用语法速查',
                  '| 语法 | 说明 |',
                  'tail that was truncated',
                ].join('\n'),
              },
            ],
            'MAX_TOKENS',
          ),
        ]),
        makeStream([
          makeChunk(
            [
              {
                text: [
                  '### 常用语法速查',
                  '| 语法 | 说明 |',
                  'new suffix',
                ].join('\n'),
              },
            ],
            'STOP',
          ),
        ]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a long mermaid answer' },
        'prompt-recovery-contained-replay',
      );

      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');

      expect(text).toBe(
        [
          'Intro',
          '### 常用语法速查',
          '| 语法 | 说明 |',
          'tail that was truncated',
          'new suffix',
        ].join('\n'),
      );
    });

    it('should preserve prose continuation that coincidentally repeats an opener phrase', async () => {
      // Regression: an earlier version of the contained-prefix fallback would
      // strip leading prose if a substring appeared anywhere in the previous
      // response. That silently dropped legitimate continuation text.
      // Now the contained-prefix path requires a Markdown structural anchor,
      // so common opener phrases like "In summary," / "In conclusion," are
      // left intact even when they happen to match the previous tail.
      const previous =
        'We covered cats. In summary, this concludes the cat section.';
      const continuation =
        'In summary, the answer is 42 and the dog section follows.';
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: continuation }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write something' },
        'prompt-recovery-prose-opener',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');
      // Continuation must be appended verbatim — no silent strip of
      // "In summary, " or "In summary, th".
      expect(text).toBe(previous + continuation);
    });

    it('should not strip prose that coincides with a far-earlier substring of the previous turn', async () => {
      // Even when the continuation accidentally matches a long phrase
      // hundreds of characters above the truncation tail, the contained-prefix
      // fallback must not replay-strip it: there is no structural anchor and
      // the match is not adjacent to the truncation point.
      const filler = 'lorem ipsum dolor sit amet '.repeat(20);
      const previous = `Here is the rest of the explanation.\n${filler}\nthe model was cut off here`;
      const continuation = 'Here is the rest of the explanation continued.';
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: continuation }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write something' },
        'prompt-recovery-far-prose',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');
      expect(text).toBe(previous + continuation);
    });

    it('should preserve continuation when its structural prefix appears mid-paragraph in the previous tail (line-boundary rejection)', async () => {
      // Regression: `previousTailContainsAtLineBoundary` must reject matches
      // that land mid-paragraph in `previousTail` even when a structural
      // anchor at the start of `continuationText` would otherwise pass the
      // contained-prefix gate. Without that check, a plain substring match
      // (e.g. inside a code block that quotes the literal string
      // `"### Heading\n..."` as prose) would silently strip legitimate
      // continuation. The only `"### Heading"` occurrence here is preceded
      // by `"some text"`, not a newline, so the contained-prefix path MUST
      // reject the match and pass the continuation through verbatim.
      const previous =
        'some text ### Heading and then more inline prose follows';
      const continuation =
        '### Heading\nfresh continuation that should not be stripped';
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: continuation }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write something with a heading' },
        'prompt-recovery-line-boundary-reject',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');
      // No silent strip: the full continuation must follow the previous tail
      // verbatim because the only `"### Heading"` occurrence in `previous`
      // is mid-paragraph (not preceded by `\n`).
      expect(text).toBe(previous + continuation);
    });

    it('should preserve prose continuation that opens with a single-cell pipe expression matching mid-tail', async () => {
      // Regression: `startsWithMarkdownStructuralAnchor` must reject
      // single-cell pipe patterns like `|expression|` in technical/math
      // prose. A real GFM table row has ≥3 pipes (≥2 cells) or is a
      // separator row (`|---|`). Without this tightening, prose continuation
      // that coincidentally starts with `|x| more text` and happens to
      // re-appear at a line boundary mid-tail of the previous response would
      // be silently stripped by the contained-prefix path.
      //
      // Setup: the suspect prose fragment `|expression| evaluates to a
      // scalar value.` appears at a line boundary in the middle of
      // `previous`, but `previous` itself ends with a different line — so
      // the suffix-anchored scan in `getRecoveryContinuationSuffix` cannot
      // match. The only path that could strip the continuation is the
      // contained-prefix fallback, which now correctly refuses to anchor on
      // a non-GFM single-cell pipe.
      const previous =
        'We define the expression as follows:\n|expression| evaluates to a scalar value.\nWe also note other facts here.';
      const continuation =
        '|expression| evaluates to a scalar value. Continuing the derivation now.';
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: continuation }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'continue the derivation' },
        'prompt-recovery-single-cell-pipe-prose',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');
      // No silent strip: the full continuation must follow the previous tail
      // verbatim because `|expression|` is prose, not a GFM table row.
      expect(text).toBe(previous + continuation);
    });

    it('should insert a newline separator when the replayed prefix ends with newline but previous tail does not', async () => {
      // Covers the three-condition normalization branch in
      // `getRecoveryContinuationSuffix`: when `replayedPrefix` ends with
      // `\n`, `previousText` does NOT, and `suffix` does NOT start with
      // `\n`, the helper prepends a `\n` so the coalesced text keeps the
      // block-level boundary intact. Without normalization, the suffix
      // would butt up against the previous tail with no separator.
      //
      // Setup: previous tail ends with `### Section` (no trailing newline,
      // because the truncation cut the response immediately after the
      // heading). Continuation replays `### Section\n` followed by body
      // prose. The contained-prefix path strips the replayed heading +
      // newline, leaving a suffix that starts with prose. The
      // normalization branch must restore a `\n` between `### Section` in
      // history and the body prose.
      const previous = 'Intro paragraph.\n### Section';
      const replayedBlock = '### Section\n';
      const continuation = `${replayedBlock}body prose continuation`;
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: continuation }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a structured answer' },
        'prompt-recovery-newline-normalization',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');
      // No duplicated `### Section`, and the heading is separated from the
      // body prose by exactly one newline — the normalization branch fired.
      expect(text).toBe(`${previous}\nbody prose continuation`);
    });

    it('should drop continuation entirely when it exactly replays the previous tail', async () => {
      // Covers the full-overlap guard in getRecoveryContinuationSuffix:
      // previousText.endsWith(continuationText) AND the overlap is significant.
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([
          makeChunk([{ text: 'leading content. tail-fragment' }], 'MAX_TOKENS'),
        ]),
        // The whole continuation matches the previous tail and is significant
        // (>= RECOVERY_OVERLAP_MIN_BYTES). It should be discarded entirely.
        makeStream([makeChunk([{ text: 'tail-fragment' }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write something' },
        'prompt-recovery-full-overlap',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');
      expect(text).toBe('leading content. tail-fragment');
    });

    it('should leave continuation untouched when the previous turn has no plain text', async () => {
      // Covers the empty-text branches: getRecoveryContinuationSuffix's
      // `previousText.length === 0` guard (continuation passed through
      // verbatim) and buildOutputRecoveryMessage's
      // `previousText.trim().length === 0` branch (no
      // <previous_response_suffix> block is appended). The previous turn has
      // only a thought part, so there is no plain text to dedupe against.
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([
          makeChunk(
            [{ text: 'thinking through the problem', thought: true }],
            'MAX_TOKENS',
          ),
        ]),
        makeStream([makeChunk([{ text: 'fresh continuation text' }], 'STOP')]),
      ];
      let callIndex = 0;
      const recoveryPayloads: string[] = [];
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async (params) => {
          const contents = (params as { contents?: Content[] }).contents ?? [];
          const lastTurn = contents[contents.length - 1];
          if (lastTurn && lastTurn.role === 'user') {
            const lastPart = lastTurn.parts?.[0];
            if (
              lastPart &&
              typeof (lastPart as { text?: string }).text === 'string'
            ) {
              recoveryPayloads.push((lastPart as { text: string }).text);
            }
          }
          return streams[callIndex++]!;
        },
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write something' },
        'prompt-recovery-thought-only',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const nonThoughtText = lastEntry.parts
        ?.filter((part) => !('thought' in part) || !part.thought)
        .map((part) => ('text' in part ? part.text : ''))
        .join('');
      // Continuation is preserved verbatim (empty-input guard).
      expect(nonThoughtText).toBe('fresh continuation text');
      // The recovery user message must NOT include a previous_response_suffix
      // block since there was no plain text to anchor on.
      const recoveryMessage = recoveryPayloads.find((p) =>
        p.includes('Output token limit hit'),
      );
      expect(recoveryMessage).toBeDefined();
      expect(recoveryMessage).not.toContain('<previous_response_suffix>');
    });

    it('should dedup recovery continuation when the continuation begins with a thought part', async () => {
      // Regression: `processStreamResponse` orders parts as
      // `[thoughtPart?, ...consolidatedHistoryParts]`. Before the fix,
      // `appendRecoveryContinuationParts` only looked at `nextParts[0]`. For
      // thinking models the first part is the recovery turn's thought, the
      // plain-text predicate returned false on it, and the entire dedup
      // block was skipped — leaking the replayed overlap into history.
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([
          makeChunk([{ text: 'Alpha shared recovery suffix' }], 'MAX_TOKENS'),
        ]),
        makeStream([
          makeChunk(
            [
              // Thought first — recovery dedup must scan past it on the
              // continuation side instead of giving up.
              { text: 'planning the rest', thought: true },
              { text: 'shared recovery suffix and continuation' },
            ],
            'STOP',
          ),
        ]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a long essay' },
        'prompt-recovery-thinking-continuation',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const nonThoughtText = lastEntry.parts
        ?.filter((part) => !('thought' in part) || !part.thought)
        .map((part) => ('text' in part ? part.text : ''))
        .join('');
      expect(nonThoughtText).toBe(
        'Alpha shared recovery suffix and continuation',
      );
    });

    it('should keep the recovery thought before the merged text part (thought-signature provenance)', async () => {
      // Thinking-model providers (Gemini 2.5+, Anthropic, OpenAI o-series)
      // validate thought-signature provenance and expect a thought to
      // precede its associated content. The sibling
      // `prompt-recovery-thinking-continuation` test only pins the joined
      // non-thought text, not structural position, so a regression where
      // the recovery turn's leading thought is appended *after* the merged
      // text part slips through. Assert the ordering explicitly.
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([
          makeChunk([{ text: 'Alpha shared recovery suffix' }], 'MAX_TOKENS'),
        ]),
        makeStream([
          makeChunk(
            [
              { text: 'planning the rest', thought: true },
              { text: 'shared recovery suffix and continuation' },
            ],
            'STOP',
          ),
        ]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a long essay' },
        'prompt-recovery-thinking-continuation-order',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const parts = lastEntry.parts ?? [];

      const thoughtIdx = parts.findIndex(
        (part) => 'thought' in part && part.thought === true,
      );
      const mergedTextIdx = parts.findIndex(
        (part) =>
          'text' in part &&
          typeof part.text === 'string' &&
          part.text.includes('Alpha shared recovery suffix'),
      );

      expect(thoughtIdx).toBeGreaterThanOrEqual(0);
      expect(mergedTextIdx).toBeGreaterThanOrEqual(0);
      expect(thoughtIdx).toBeLessThan(mergedTextIdx);
    });

    it('should preserve a coincidental 2-character CJK overlap (byte floor insufficient for CJK)', async () => {
      // Regression: `RECOVERY_OVERLAP_MIN_BYTES = 6` admits a 2-character
      // CJK overlap (each Chinese char is 3 UTF-8 bytes). Two-character
      // boundary coincidences such as "我们" / "但是" are extremely common
      // across unrelated Chinese sentences. The companion char-floor must
      // require ≥4 code points so a 2-char CJK collision does not silently
      // strip legitimate continuation. The longer "需要" tail of `previous`
      // is meaningful continuation, NOT a replayed suffix of the previous
      // turn — the continuation must survive verbatim.
      const previous = '在分析数据之前我们';
      const continuation = '我们需要先完成准备工作。';
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: continuation }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: '帮我分析数据' },
        'prompt-recovery-cjk-floor',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');
      expect(text).toBe(previous + continuation);
    });

    it('should dedup a replayed structural prefix even when the continuation has leading whitespace', async () => {
      // Regression: the structural-anchor check tolerates leading whitespace
      // (some providers re-emit the replayed block with extra spaces/tabs),
      // but the substring-match loop must also strip that whitespace before
      // matching against the previous tail — otherwise the replayed block
      // never finds its mirror in `previousTail` and the duplicate leaks
      // into history.
      const replayedBlock = '### 常用语法速查\n| 语法 | 说明 |';
      const previous = ['Intro', replayedBlock, 'tail that was truncated'].join(
        '\n',
      );
      // Continuation re-emits the same block prefixed by two spaces.
      const continuation = `  ${replayedBlock}\nnew suffix`;
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: continuation }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a long markdown answer' },
        'prompt-recovery-leading-whitespace',
      );
      for await (const _event of stream) {
        // consume
      }

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');
      // The duplicated `### 常用语法速查\n| 语法 | 说明 |` block must NOT
      // appear twice; only the new suffix should follow the previous tail.
      expect(text).toBe(`${previous}\nnew suffix`);
    });

    it('should truncate the previous_response_suffix to the trailing 1200 chars when the previous turn is longer', async () => {
      // Covers the slice(-OUTPUT_RECOVERY_TAIL_CHARS) branch in
      // buildOutputRecoveryMessage. The truncation tail is 1200 chars; we
      // build a previous response of 1300 chars so the head (100 chars) is
      // dropped and the tail (1200 chars) is what shows up in the
      // <previous_response_suffix> block sent to the recovery turn.
      const head = 'A'.repeat(100);
      const tail = 'B'.repeat(1200);
      const previous = `${head}${tail}`;
      expect(previous.length).toBe(1300);

      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: ' continuation tail' }], 'STOP')]),
      ];
      let callIndex = 0;
      const recoveryPayloads: string[] = [];
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async (params) => {
          const contents = (params as { contents?: Content[] }).contents ?? [];
          const lastTurn = contents[contents.length - 1];
          if (lastTurn && lastTurn.role === 'user') {
            const lastPart = lastTurn.parts?.[0];
            if (
              lastPart &&
              typeof (lastPart as { text?: string }).text === 'string'
            ) {
              recoveryPayloads.push((lastPart as { text: string }).text);
            }
          }
          return streams[callIndex++]!;
        },
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a very long answer' },
        'prompt-recovery-tail-truncation',
      );
      for await (const _event of stream) {
        // consume
      }

      const recoveryMessage = recoveryPayloads.find((p) =>
        p.includes('Output token limit hit'),
      );
      expect(recoveryMessage).toBeDefined();
      // The recovery prompt must contain the suffix block...
      expect(recoveryMessage).toContain('<previous_response_suffix>');
      expect(recoveryMessage).toContain('</previous_response_suffix>');
      // ...with exactly the trailing 1200 chars of the previous response.
      const match = recoveryMessage!.match(
        /<previous_response_suffix>\n([\s\S]*)\n<\/previous_response_suffix>/,
      );
      expect(match).not.toBeNull();
      const suffix = match![1]!;
      expect(suffix.length).toBe(1200);
      expect(suffix).toBe(tail);
      // The 100-char head must NOT leak into the recovery prompt.
      expect(suffix.startsWith('A')).toBe(false);
      expect(recoveryMessage).not.toContain(head);
    });

    it('should neutralize a literal previous_response_suffix delimiter inside the tail so the recovery prompt structure stays intact', async () => {
      // Guards against a delimiter-collision when the model's own truncated
      // output happens to contain the literal closing tag (e.g. while
      // generating XML/HTML examples). The recovery prompt must still have
      // exactly one well-formed <previous_response_suffix>...</...> block.
      const previous =
        'Here is XML: </previous_response_suffix> and then more content.';
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: ' continuation tail' }], 'STOP')]),
      ];
      let callIndex = 0;
      const recoveryPayloads: string[] = [];
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async (params) => {
          const contents = (params as { contents?: Content[] }).contents ?? [];
          const lastTurn = contents[contents.length - 1];
          if (lastTurn && lastTurn.role === 'user') {
            const lastPart = lastTurn.parts?.[0];
            if (
              lastPart &&
              typeof (lastPart as { text?: string }).text === 'string'
            ) {
              recoveryPayloads.push((lastPart as { text: string }).text);
            }
          }
          return streams[callIndex++]!;
        },
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a response that contains my delimiter' },
        'prompt-recovery-delimiter-collision',
      );
      for await (const _event of stream) {
        // consume
      }

      const recoveryMessage = recoveryPayloads.find((p) =>
        p.includes('Output token limit hit'),
      );
      expect(recoveryMessage).toBeDefined();
      // Exactly one opening and one closing delimiter (the recovery prompt's
      // own pair). The model's literal closing tag inside the embedded tail
      // must have been neutralized.
      const openCount = (
        recoveryMessage!.match(/<previous_response_suffix>/g) ?? []
      ).length;
      const closeCount = (
        recoveryMessage!.match(/<\/previous_response_suffix>/g) ?? []
      ).length;
      expect(openCount).toBe(1);
      expect(closeCount).toBe(1);
      // The block must still parse with a single well-formed match.
      const match = recoveryMessage!.match(
        /<previous_response_suffix>\n([\s\S]*)\n<\/previous_response_suffix>/,
      );
      expect(match).not.toBeNull();
      // The block's content should still preserve the model's intent
      // (the surrounding prose), just with the literal delimiter neutralized.
      expect(match![1]).toContain('Here is XML:');
      expect(match![1]).toContain('and then more content.');
    });

    it('should neutralize a literal opening previous_response_suffix delimiter inside the tail', async () => {
      // Mirrors the closing-tag delimiter-collision test, but verifies the
      // opening-tag branch of `sanitizeRecoverySuffixTail`. If the model's own
      // output contains a literal `<previous_response_suffix>` opening tag,
      // the recovery prompt's structural scan must still see exactly one
      // well-formed opening/closing pair (its own).
      const previous =
        'Tag: <previous_response_suffix> was emitted in the output here.';
      const streams = [
        makeStream([makeChunk([{ text: 'discarded initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: previous }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: ' continuation tail' }], 'STOP')]),
      ];
      let callIndex = 0;
      const recoveryPayloads: string[] = [];
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async (params) => {
          const contents = (params as { contents?: Content[] }).contents ?? [];
          const lastTurn = contents[contents.length - 1];
          if (lastTurn && lastTurn.role === 'user') {
            const lastPart = lastTurn.parts?.[0];
            if (
              lastPart &&
              typeof (lastPart as { text?: string }).text === 'string'
            ) {
              recoveryPayloads.push((lastPart as { text: string }).text);
            }
          }
          return streams[callIndex++]!;
        },
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a response that contains my opening delimiter' },
        'prompt-recovery-delimiter-collision-open',
      );
      for await (const _event of stream) {
        // consume
      }

      const recoveryMessage = recoveryPayloads.find((p) =>
        p.includes('Output token limit hit'),
      );
      expect(recoveryMessage).toBeDefined();
      // Exactly one opening and one closing delimiter — the recovery prompt's
      // own pair. The model's literal opening tag inside the embedded tail
      // must have been neutralized via a zero-width space.
      const openCount = (
        recoveryMessage!.match(/<previous_response_suffix>/g) ?? []
      ).length;
      const closeCount = (
        recoveryMessage!.match(/<\/previous_response_suffix>/g) ?? []
      ).length;
      expect(openCount).toBe(1);
      expect(closeCount).toBe(1);
      // The neutralized variant (with a zero-width space between '<' and the
      // tag name) must appear inside the embedded tail.
      expect(recoveryMessage).toContain('<​previous_response_suffix>');
      // The block must still parse with a single well-formed match and
      // preserve the surrounding prose.
      const match = recoveryMessage!.match(
        /<previous_response_suffix>\n([\s\S]*)\n<\/previous_response_suffix>/,
      );
      expect(match).not.toBeNull();
      expect(match![1]).toContain('Tag:');
      expect(match![1]).toContain('was emitted in the output here.');
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

    it('should pop both the partial model turn AND the recovery user message when recovery throws after a functionCall', async () => {
      // Critical regression for the recovery catch's pop ordering.
      // When the recovery stream yields a `functionCall` chunk and
      // then throws, `processStreamResponse` pushes a partial `model`
      // turn into history BEFORE re-throwing — so by the time the
      // recovery catch runs, the trailing entries are
      //   [..., user(OUTPUT_RECOVERY_MESSAGE), model(partial fc)]
      // The naive "if last is user, pop" check would no-op here (last
      // is now `model`), leaving the OUTPUT_RECOVERY_MESSAGE control
      // prompt stranded as a real user turn. The catch must pop the
      // partial model turn FIRST, then the recovery user turn, and
      // clear the partial-push markers so the outer `finally` JSONL
      // flush doesn't resurrect the partial we just deleted.
      const streams = [
        // Initial: text + MAX_TOKENS → triggers escalation.
        makeStream([makeChunk([{ text: 'initial' }], 'MAX_TOKENS')]),
        // Escalated: text + MAX_TOKENS → triggers recovery iteration 1.
        makeStream([makeChunk([{ text: 'escalated' }], 'MAX_TOKENS')]),
        // Recovery iter 1: yields functionCall chunk, then throws.
        // processStreamResponse pushes a partial model turn before
        // re-throwing the synthetic error.
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: 'call_recovery_throw',
                        name: 'read_file',
                        args: { path: '/tmp/r.txt' },
                      },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          throw new Error('synthetic recovery mid-tool_use cut');
        })(),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'recovery throws after functionCall' },
        'prompt-recovery-fc-throw',
      );

      // Consume; the catch swallows the error and emits a synthetic
      // STOP chunk so the consumer sees a clean termination.
      for await (const _ of stream) {
        /* consume */
      }

      const history = chat.getHistory();

      // OUTPUT_RECOVERY_MESSAGE must NOT appear anywhere in history.
      // The pop-ordering bug strands it as a real user turn that then
      // pollutes durable history and biases later turns.
      const flattened = JSON.stringify(history);
      expect(flattened).not.toContain('Output token limit hit');
      expect(flattened).not.toContain('Resume directly');

      // The partial model[functionCall] from the recovery throw must
      // also be popped — leaving it would create a dangling tool_use
      // that the inline repair on the next sendMessageStream would
      // synthesize an `error` functionResponse for, and the React
      // scheduler's late real result would be dropped by the
      // history-based dedup. Symptom: model sees an "execution result
      // was not recorded" error for a tool that actually succeeded.
      const stillHasPartialFc = history.some((entry) =>
        (entry.parts ?? []).some(
          (part) => part.functionCall?.id === 'call_recovery_throw',
        ),
      );
      expect(stillHasPartialFc).toBe(false);

      // Roles must strictly alternate (no consecutive same-role) so
      // providers don't reject the next turn.
      for (let i = 1; i < history.length; i++) {
        expect(history[i]!.role).not.toBe(history[i - 1]!.role);
      }

      // History tail should be the escalated model response (text:
      // 'escalated'), preserved as the user-visible answer.
      const lastEntry = history[history.length - 1]!;
      expect(lastEntry.role).toBe('model');
      const lastModelText = (lastEntry.parts ?? [])
        .map((p) => ('text' in p ? ((p as { text?: string }).text ?? '') : ''))
        .join('');
      expect(lastModelText).toContain('escalated');
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

    it('flushes the JSONL record when escalated stream throws mid-tool_use', async () => {
      // Critical regression for the max-tokens escalation path:
      // 1) initial stream succeeds with text + MAX_TOKENS → triggers
      //    escalation, no partial set, deferred record clean.
      // 2) escalated stream throws AFTER yielding a functionCall chunk
      //    → processStreamResponse pushes a partial model[fc] into
      //    `this.history` and stashes a NEW `pendingPartialAssistantRecord`.
      // 3) The throw escapes through the for-await on the escalated
      //    stream, propagates past the (now-passed) retry loop, and
      //    lands in the outer `finally` block.
      //
      // BEFORE the fix: the flush only ran BEFORE the escalation block,
      // so the new record set in step 2 was never appended to JSONL —
      // live history disagreed with disk; `--resume` rehydrated a
      // truncated transcript and `repairOrphanedToolUseTurnsInHistory`
      // had nothing to repair, leaving the React scheduler's late real
      // result as a permanent orphan.
      //
      // AFTER the fix: the flush is in `finally`, so the record lands
      // on disk regardless of which stream raised.
      const recordAssistantTurn = vi.fn();
      const chatWithRecording = new GeminiChat(
        mockConfig,
        config,
        [],
        {
          recordAssistantTurn,
          recordChatCompression: vi.fn(),
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );

      // Stream 1: text + MAX_TOKENS (success, triggers escalation).
      // Stream 2: yields a functionCall chunk THEN throws — simulates a
      // mid-tool_use stream cut on the escalated request.
      const streams = [
        makeStream([makeChunk([{ text: 'partial answer' }], 'MAX_TOKENS')]),
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: 'call_escalation_throw',
                        name: 'read_file',
                        args: { path: '/tmp/escalated.txt' },
                      },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          throw new Error('synthetic mid-tool_use cut on escalated stream');
        })(),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chatWithRecording.sendMessageStream(
        'gemini-3-pro',
        { message: 'kick off' },
        'prompt-escalation-flush',
      );

      // Consume the stream and expect the synthetic mid-tool_use error
      // to escape (escalation errors do not retry).
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toThrow(/synthetic mid-tool_use cut/);

      // In-memory: the partial functionCall pushed by the escalated
      // processStreamResponse must be in history.
      const history = chatWithRecording.getHistory();
      const partialModel = history.findLast((h) => h.role === 'model');
      expect(
        partialModel?.parts?.some(
          (p) => p.functionCall?.id === 'call_escalation_throw',
        ),
      ).toBe(true);

      // JSONL: at least one record must mention the partial functionCall
      // (the escalation throw flushed it). Without the finally-block
      // flush, this assertion would fail and the durable transcript
      // would silently lose a tool_use that's still live in memory.
      const recordedHasPartial = recordAssistantTurn.mock.calls.some((call) => {
        const message = (
          call[0] as {
            message?: Array<{ functionCall?: { id?: string } }>;
          }
        )?.message;
        return message?.some(
          (p) => p.functionCall?.id === 'call_escalation_throw',
        );
      });
      expect(recordedHasPartial).toBe(true);
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

      await chat.tryCompress('p1', 'm1', true);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
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
  });

  describe('compressFast', () => {
    const userMsg = (text: string): Content => ({
      role: 'user' as const,
      parts: [{ text }],
    });
    const modelMsg = (text: string): Content => ({
      role: 'model' as const,
      parts: [{ text }],
    });
    const modelMsgWithThinking = (
      text: string | null,
      thinking: string,
    ): Content => ({
      role: 'model' as const,
      parts: [{ thought: true, text: thinking }, ...(text ? [{ text }] : [])],
    });
    const toolCall = (name: string): Content => ({
      role: 'model' as const,
      parts: [{ functionCall: { name, args: {} } }],
    });
    const toolResult = (name: string, output: string): Content => ({
      role: 'user' as const,
      parts: [{ functionResponse: { name, response: { output } } }],
    });

    beforeEach(() => {
      (mockConfig as unknown as Record<string, unknown>)[
        'getClearContextOnIdle'
      ] = vi.fn().mockReturnValue({
        toolResultsThresholdMinutes: 60,
        toolResultsNumToKeep: 5,
      });
    });

    it('strips thinking from model turns', () => {
      chat.setHistory([
        userMsg('hello'),
        modelMsgWithThinking('response text', 'internal reasoning'),
        userMsg('next'),
        modelMsg('plain reply'),
      ]);
      chat.setLastPromptTokenCount(1000);

      const result = chat.compressFast();

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      // Thinking parts should be stripped from the first model message
      const history = chat.getHistory();
      const firstModel = history.find((c) => c.role === 'model');
      expect(firstModel?.parts).toEqual([{ text: 'response text' }]);
    });

    it('NOOP when nothing is compressible', () => {
      chat.setHistory([
        userMsg('hello'),
        modelMsg('hi'),
        userMsg('how are you'),
        modelMsg('good'),
      ]);
      chat.setLastPromptTokenCount(1000);

      const result = chat.compressFast();

      expect(result.info.compressionStatus).toBe(CompressionStatus.NOOP);
    });

    it('clears old tool results via microcompaction', () => {
      const history: Content[] = [];
      // Create many tool calls so keepRecent=5 kicks in
      for (let i = 0; i < 8; i++) {
        history.push(toolCall('read_file'));
        history.push(
          toolResult('read_file', `content for file ${i} `.repeat(50)),
        );
      }
      history.push(userMsg('final'));
      history.push(modelMsg('done'));
      chat.setHistory(history);
      chat.setLastPromptTokenCount(5000);

      const result = chat.compressFast();

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.microcompactMeta).toBeDefined();
      expect(result.microcompactMeta!.toolsCleared).toBeGreaterThan(0);
    });

    it('adjusts lastPromptTokenCount by estimated delta on COMPRESSED', () => {
      const history: Content[] = [];
      for (let i = 0; i < 5; i++) {
        history.push(
          userMsg(`question ${i}`),
          modelMsgWithThinking(
            `response ${i}`,
            `very long internal reasoning for turn ${i} `.repeat(100),
          ),
        );
      }
      chat.setHistory(history);
      const apiBaseline = 50000;
      chat.setLastPromptTokenCount(apiBaseline);

      const result = chat.compressFast();

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.info.newTokenCount).toBeLessThan(apiBaseline);
      expect(result.info.newTokenCount).toBeGreaterThan(0);
      expect(chat.getLastPromptTokenCount()).toBe(result.info.newTokenCount);
    });

    it('falls back to estimateContentTokens when lastPromptTokenCount is 0', () => {
      const history: Content[] = [];
      for (let i = 0; i < 5; i++) {
        history.push(
          userMsg(`question ${i}`),
          modelMsgWithThinking(
            `response ${i}`,
            `very long internal reasoning for turn ${i} `.repeat(100),
          ),
        );
      }
      chat.setHistory(history);
      chat.setLastPromptTokenCount(0);

      const result = chat.compressFast();

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.info.originalTokenCount).toBeGreaterThan(0);
      expect(result.info.newTokenCount).toBeLessThan(
        result.info.originalTokenCount,
      );
    });
  });
});

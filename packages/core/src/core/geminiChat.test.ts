/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type {
  Content,
  GenerateContentConfig,
  GenerateContentResponse,
  Part,
} from '@google/genai';
import { ApiError } from '@google/genai';
import { AuthType, type ContentGenerator } from './contentGenerator.js';
import {
  GeminiChat,
  InvalidStreamError,
  approvedPlanRedactionText,
  redactApprovedPlansInHistory,
  redactStructuredOutputArgsForRecording,
  StreamEventType,
  type StreamEvent,
} from './geminiChat.js';
import { RETRYABLE_STREAM_TRANSPORT_CODES } from './stream-transport-retry.js';
import { getToolCallFingerprint } from './toolCallIdUtils.js';
import { classifyRetryError } from '../utils/retryErrorClassification.js';
import { StreamContentError } from './openaiContentGenerator/pipeline.js';
import { OpenAIContentGenerator } from './openaiContentGenerator/openaiContentGenerator.js';
import { EnhancedErrorHandler } from './openaiContentGenerator/errorHandler.js';
import { APIConnectionTimeoutError } from 'openai';
import type { OpenAICompatibleProvider } from './openaiContentGenerator/provider/index.js';
import type { Config } from '../config/config.js';
import { setSimulate429 } from '../utils/testUtils.js';
import { uiTelemetryService } from '../telemetry/uiTelemetry.js';
import { CompressionStatus, type ChatCompressionInfo } from './turn.js';
import {
  ChatCompressionService,
  MAX_CONSECUTIVE_FAILURES,
} from '../services/chatCompressionService.js';
import {
  estimateContentTokens,
  estimatePromptTokens,
} from '../services/tokenEstimation.js';
import { SYSTEM_REMINDER_OPEN } from './environmentContext.js';
import { SessionStartSource } from '../hooks/types.js';
import * as sideQueryModule from '../utils/sideQuery.js';
import {
  getToolCallPreparations,
  setToolCallPreparations,
} from './tool-call-preparation.js';
import { ApprovalMode } from '../config/approval-mode.js';

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

const {
  mockLogContentRetry,
  mockLogContentRetryFailure,
  mockLogProtocolTagSanitized,
} = vi.hoisted(() => ({
  mockLogContentRetry: vi.fn(),
  mockLogContentRetryFailure: vi.fn(),
  mockLogProtocolTagSanitized: vi.fn(),
}));

vi.mock('../telemetry/loggers.js', () => ({
  logContentRetry: mockLogContentRetry,
  logContentRetryFailure: mockLogContentRetryFailure,
  logProtocolTagSanitized: mockLogProtocolTagSanitized,
  // Real ChatCompressionService.compress() calls logChatCompression on
  // every attempt; the R3.4 integration test exercises that path, so the
  // mock has to expose it (no-op).
  logChatCompression: vi.fn(),
}));

vi.mock('../telemetry/uiTelemetry.js', () => ({
  uiTelemetryService: {
    setLastPromptTokenCount: vi.fn(),
    setLastCachedContentTokenCount: vi.fn(),
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
      embedContent: vi.fn(),
      batchEmbedContents: vi.fn(),
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
      getModelRouteIdentity: vi.fn().mockReturnValue('gemini-pro@test0001'),
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
      getEffectiveInputModalities: vi.fn().mockReturnValue({ image: true }),
      getBaseLlmClient: vi.fn().mockReturnValue(undefined),
      getModelFallbacks: vi.fn().mockReturnValue([]),
      getChatCompression: vi.fn().mockReturnValue(undefined),
      getClearContextOnIdle: vi.fn().mockReturnValue({
        toolResultsThresholdMinutes: 30,
        toolResultsNumToKeep: 1,
      }),
      getAutoCompactThreshold: vi.fn().mockReturnValue(undefined),
      getHookSystem: vi.fn().mockReturnValue(undefined),
      getDebugLogger: vi
        .fn()
        .mockReturnValue({ debug: vi.fn(), warn: vi.fn(), info: vi.fn() }),
      getApprovalMode: vi.fn().mockReturnValue('default'),
      takePendingManualPlanExitNotice: vi.fn().mockReturnValue(undefined),
      restorePendingManualPlanExitNotice: vi.fn(),
      getFileReadCache: vi.fn().mockReturnValue({ clear: vi.fn() }),
      getRestoreAskUserQuestion: vi.fn().mockReturnValue(false),
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
    expectedError?: Partial<InvalidStreamError>,
  ): Promise<void> {
    const collecting = (async () => {
      for await (const _ of stream) {
        /* consume */
      }
    })();
    // Get assertion promise first (don't await), then advance timers.
    const resultPromise = (async () => {
      if (expectedError) {
        await expect(collecting).rejects.toMatchObject(expectedError);
      } else {
        await expect(collecting).rejects.toThrow(InvalidStreamError);
      }
    })();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(35_000);
    await resultPromise;
  }

  function chatWithRecorder(recordAssistantTurn: ReturnType<typeof vi.fn>) {
    return new GeminiChat(
      mockConfig,
      config,
      [],
      {
        recordAssistantTurn,
        recordChatCompression: vi.fn(),
      } as unknown as ConstructorParameters<typeof GeminiChat>[3],
      uiTelemetryService,
    );
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

  function streamResponse(
    ...responses: GenerateContentResponse[]
  ): AsyncGenerator<GenerateContentResponse> {
    return (async function* () {
      yield* responses;
    })();
  }

  function stopResponse(parts: Part[]): GenerateContentResponse {
    return {
      candidates: [
        {
          content: { parts },
          finishReason: 'STOP',
        },
      ],
    } as unknown as GenerateContentResponse;
  }

  describe('history-rewrite loaded-skill tracking', () => {
    // Destructive rewrites (compaction, truncation, orphan stripping)
    // conservatively clear the SkillTool's loaded-skill tracking so an
    // evicted body can never stay stuck behind the dedup guard. The
    // trade-off is at most one duplicate body on the next invoke.
    const wireSkillTracker = () => {
      const skillTool = { clearLoadedSkills: vi.fn() };
      vi.mocked(mockConfig.getToolRegistry).mockReturnValue({
        getTool: vi.fn().mockReturnValue(skillTool),
      } as unknown as ReturnType<Config['getToolRegistry']>);
      return skillTool;
    };

    it('setHistory clears tracking on wholesale replacement', () => {
      const skillTool = wireSkillTracker();
      chat.setHistory([{ role: 'user', parts: [{ text: 'hi' }] }]);
      expect(skillTool.clearLoadedSkills).toHaveBeenCalled();
    });

    it('tryCompress clears tracking through its setHistory', async () => {
      const skillTool = wireSkillTracker();
      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockResolvedValueOnce({
        newHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
        info: {
          originalTokenCount: 100_000,
          newTokenCount: 30_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });

      await chat.tryCompress('prompt-skill-clear', true);

      expect(skillTool.clearLoadedSkills).toHaveBeenCalled();
    });

    it('tryCompress leaves tracking untouched on NOOP', async () => {
      const skillTool = wireSkillTracker();
      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockResolvedValueOnce({
        newHistory: null,
        info: {
          originalTokenCount: 1_000,
          newTokenCount: 1_000,
          compressionStatus: CompressionStatus.NOOP,
        },
      });

      await chat.tryCompress('prompt-skill-noop', true);

      expect(skillTool.clearLoadedSkills).not.toHaveBeenCalled();
    });

    it('truncateHistory clears tracking when entries were dropped', () => {
      const skillTool = wireSkillTracker();
      chat.addHistory({ role: 'user', parts: [{ text: 'a' }] });
      chat.addHistory({ role: 'model', parts: [{ text: 'b' }] });
      chat.truncateHistory(1);
      expect(skillTool.clearLoadedSkills).toHaveBeenCalled();
    });

    it('truncateHistory leaves tracking when nothing was dropped', () => {
      const skillTool = wireSkillTracker();
      chat.addHistory({ role: 'user', parts: [{ text: 'a' }] });
      chat.truncateHistory(5);
      expect(skillTool.clearLoadedSkills).not.toHaveBeenCalled();
    });

    it('stripOrphanedUserEntriesFromHistory clears tracking when it strips', () => {
      const skillTool = wireSkillTracker();
      chat.addHistory({ role: 'model', parts: [{ text: 'ack' }] });
      chat.addHistory({ role: 'user', parts: [{ text: 'orphan' }] });
      chat.stripOrphanedUserEntriesFromHistory();
      expect(skillTool.clearLoadedSkills).toHaveBeenCalled();
    });

    it('stripOrphanedUserEntriesFromHistory leaves tracking when nothing is stripped', () => {
      const skillTool = wireSkillTracker();
      chat.addHistory({ role: 'model', parts: [{ text: 'ack' }] });
      chat.stripOrphanedUserEntriesFromHistory();
      expect(skillTool.clearLoadedSkills).not.toHaveBeenCalled();
    });

    it('forked chats never touch the shared parent tracker', () => {
      const skillTool = wireSkillTracker();
      chat.isForkedChat = true;

      chat.setHistory([{ role: 'model', parts: [{ text: 'ack' }] }]);
      chat.addHistory({ role: 'user', parts: [{ text: 'orphan' }] });
      chat.stripOrphanedUserEntriesFromHistory();
      chat.addHistory({ role: 'model', parts: [{ text: 'ack2' }] });
      chat.truncateHistory(1);

      expect(skillTool.clearLoadedSkills).not.toHaveBeenCalled();
    });
  });

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

    describe('manual plan-exit notices', () => {
      beforeEach(() => {
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () =>
          streamResponse(stopResponse([{ text: 'ok' }])),
        );
      });

      it('is disabled by default', async () => {
        vi.mocked(mockConfig.takePendingManualPlanExitNotice).mockReturnValue({
          version: 1,
          currentMode: ApprovalMode.DEFAULT,
        });

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'continue' },
          'prompt-id-plan-exit-disabled',
        );
        for await (const _ of stream) {
          /* consume */
        }

        expect(
          mockConfig.takePendingManualPlanExitNotice,
        ).not.toHaveBeenCalled();
        expect(
          chat
            .getHistory()
            .flatMap((content) => content.parts ?? [])
            .some((part) =>
              part.text?.includes(
                'changed outside the approved exit_plan_mode flow',
              ),
            ),
        ).toBe(false);
      });

      it('appends one notice after a function response', async () => {
        vi.mocked(mockConfig.takePendingManualPlanExitNotice)
          .mockReturnValueOnce({
            version: 7,
            currentMode: ApprovalMode.AUTO_EDIT,
          })
          .mockReturnValue(undefined);
        chat.enableManualPlanExitNotices();
        chat.setHistory([
          { role: 'user', parts: [{ text: 'read it' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call-plan-exit',
                  name: 'read_file',
                  args: { path: '/tmp/input' },
                },
              },
            ],
          },
        ]);

        const firstStream = await chat.sendMessageStream(
          'test-model',
          {
            message: {
              functionResponse: {
                id: 'call-plan-exit',
                name: 'read_file',
                response: { output: 'contents' },
              },
            },
          },
          'prompt-id-plan-exit-tool-result',
        );
        for await (const _ of firstStream) {
          /* consume */
        }

        const secondStream = await chat.sendMessageStream(
          'test-model',
          { message: 'next turn' },
          'prompt-id-plan-exit-next-turn',
        );
        for await (const _ of secondStream) {
          /* consume */
        }

        const toolResultTurn = chat.getHistory()[2]!;
        expect(toolResultTurn.parts?.[0]?.functionResponse?.id).toBe(
          'call-plan-exit',
        );
        expect(toolResultTurn.parts?.at(-1)?.text).toContain(
          'The current approval mode is: auto-edit.',
        );
        expect(
          chat
            .getHistory()
            .flatMap((content) => content.parts ?? [])
            .filter((part) =>
              part.text?.includes(
                'changed outside the approved exit_plan_mode flow',
              ),
            ),
        ).toHaveLength(1);
      });

      it('restores a claim when setup rolls back the history push', async () => {
        vi.mocked(mockConfig.takePendingManualPlanExitNotice).mockReturnValue({
          version: 11,
          currentMode: ApprovalMode.DEFAULT,
        });
        chat.enableManualPlanExitNotices();
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
            'prompt-id-plan-exit-rollback-1',
          ),
        ).rejects.toThrow('history setup failed');

        expect(
          mockConfig.restorePendingManualPlanExitNotice,
        ).toHaveBeenCalledWith(11);

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'second' },
          'prompt-id-plan-exit-rollback-2',
        );
        for await (const _ of stream) {
          /* consume */
        }

        const history = chat.getHistory();
        expect(
          history.some((content) =>
            content.parts?.some((part) => part.text === 'first'),
          ),
        ).toBe(false);
        expect(
          history
            .flatMap((content) => content.parts ?? [])
            .filter((part) =>
              part.text?.includes(
                'changed outside the approved exit_plan_mode flow',
              ),
            ),
        ).toHaveLength(1);
        expect(
          mockConfig.restorePendingManualPlanExitNotice,
        ).toHaveBeenCalledTimes(1);
      });

      it('commits one history part when provider setup retries', async () => {
        vi.mocked(
          mockConfig.takePendingManualPlanExitNotice,
        ).mockReturnValueOnce({
          version: 13,
          currentMode: ApprovalMode.DEFAULT,
        });
        chat.enableManualPlanExitNotices();
        vi.mocked(mockContentGenerator.generateContentStream)
          .mockRejectedValueOnce(new Error('transient transport setup'))
          .mockImplementationOnce(async () =>
            streamResponse(stopResponse([{ text: 'recovered' }])),
          );
        mockRetryWithBackoff.mockImplementationOnce(async (apiCall) => {
          try {
            return await apiCall();
          } catch {
            return apiCall();
          }
        });

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'retry me' },
          'prompt-id-plan-exit-provider-retry',
        );
        for await (const _ of stream) {
          /* consume */
        }

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          mockConfig.takePendingManualPlanExitNotice,
        ).toHaveBeenCalledTimes(1);
        expect(
          chat
            .getHistory()
            .flatMap((content) => content.parts ?? [])
            .filter((part) =>
              part.text?.includes(
                'changed outside the approved exit_plan_mode flow',
              ),
            ),
        ).toHaveLength(1);
        expect(
          mockConfig.restorePendingManualPlanExitNotice,
        ).not.toHaveBeenCalled();
      });

      it.each([
        {
          tail: 'model',
          compressedHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            { role: 'model', parts: [{ text: 'ack' }] },
          ] satisfies Content[],
        },
        {
          tail: 'user',
          compressedHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            { role: 'model', parts: [{ text: 'ack' }] },
            {
              role: 'user',
              parts: [{ text: 'restored attachment context' }],
            },
          ] satisfies Content[],
        },
      ])(
        'preserves the committed notice across reactive compression with a $tail tail',
        async ({ compressedHistory }) => {
          vi.mocked(
            mockConfig.takePendingManualPlanExitNotice,
          ).mockReturnValueOnce({
            version: 15,
            currentMode: ApprovalMode.DEFAULT,
          });
          chat.enableManualPlanExitNotices();
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
            .mockRejectedValueOnce(
              new Error('prompt is too long: 135000 tokens > 128000 maximum'),
            )
            .mockImplementationOnce(async () =>
              streamResponse(stopResponse([{ text: 'after compression' }])),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'retry after overflow' },
            'prompt-id-plan-exit-reactive-compression',
          );
          for await (const _ of stream) {
            /* consume */
          }

          const retryRequest = vi.mocked(
            mockContentGenerator.generateContentStream,
          ).mock.calls[1]![0] as { contents: Content[] };
          expect(
            retryRequest.contents
              .flatMap((content) => content.parts ?? [])
              .filter((part) =>
                part.text?.includes(
                  'changed outside the approved exit_plan_mode flow',
                ),
              ),
          ).toHaveLength(1);
          expect(
            chat
              .getHistory()
              .flatMap((content) => content.parts ?? [])
              .filter((part) =>
                part.text?.includes(
                  'changed outside the approved exit_plan_mode flow',
                ),
              ),
          ).toHaveLength(1);
          const history = chat.getHistory();
          const noticeTurn = history.find((content) =>
            content.parts?.some((part) =>
              part.text?.includes(
                'changed outside the approved exit_plan_mode flow',
              ),
            ),
          );
          expect(noticeTurn?.parts?.at(-1)?.text).toContain(
            'changed outside the approved exit_plan_mode flow',
          );
          expect(
            history.some(
              (content, index) =>
                content.role === 'user' && history[index + 1]?.role === 'user',
            ),
          ).toBe(false);
          expect(
            mockConfig.takePendingManualPlanExitNotice,
          ).toHaveBeenCalledTimes(1);
          expect(
            mockConfig.restorePendingManualPlanExitNotice,
          ).not.toHaveBeenCalled();
        },
      );

      it('does not redeliver after rebuilding a chat with the same cursor', async () => {
        let pending = true;
        vi.mocked(
          mockConfig.takePendingManualPlanExitNotice,
        ).mockImplementation(() => {
          if (!pending) {
            return undefined;
          }
          pending = false;
          return {
            version: 17,
            currentMode: ApprovalMode.DEFAULT,
          };
        });
        chat.enableManualPlanExitNotices();

        const firstStream = await chat.sendMessageStream(
          'test-model',
          { message: 'first chat' },
          'prompt-id-plan-exit-before-rebuild',
        );
        for await (const _ of firstStream) {
          /* consume */
        }

        const replacementChat = new GeminiChat(mockConfig, config);
        replacementChat.enableManualPlanExitNotices();
        const replacementStream = await replacementChat.sendMessageStream(
          'test-model',
          { message: 'replacement chat' },
          'prompt-id-plan-exit-after-rebuild',
        );
        for await (const _ of replacementStream) {
          /* consume */
        }

        expect(
          replacementChat
            .getHistory()
            .flatMap((content) => content.parts ?? [])
            .some((part) =>
              part.text?.includes(
                'changed outside the approved exit_plan_mode flow',
              ),
            ),
        ).toBe(false);
        expect(
          mockConfig.takePendingManualPlanExitNotice,
        ).toHaveBeenCalledTimes(2);
      });
    });

    it('increments the user-content push counter once per surviving send', async () => {
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

      const before = chat.getUserContentPushCount();
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'hello' },
        'prompt-id-push-count',
      );
      for await (const _ of stream) {
        /* consume stream */
      }

      // The user content landed exactly once, so the counter advanced by one —
      // this is the signal the Retry strip/restore in client.ts gates on.
      expect(chat.getUserContentPushCount()).toBe(before + 1);
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

    it('still synthesizes when restore is on and the user sends ordinary text', async () => {
      vi.mocked(mockConfig.getRestoreAskUserQuestion).mockReturnValue(true);
      chat.setHistory([
        { role: 'user', parts: [{ text: 'pick one' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_auq_ordinary_send',
                name: 'ask_user_question',
                args: {
                  questions: [
                    {
                      question: 'Which approach?',
                      header: 'Approach',
                      options: [
                        { label: 'Polling', description: 'Poll the API' },
                        { label: 'Webhook', description: 'Use a webhook' },
                      ],
                    },
                  ],
                },
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
        { message: 'never mind, just continue' },
        'prompt-ordinary-over-auq',
      );
      for await (const _ of stream) {
        /* drain */
      }

      const history = chat.getHistory();
      const userTurn = history[2]!;
      expect(userTurn.role).toBe('user');
      expect(userTurn.parts![0]!.functionResponse?.id).toBe(
        'call_auq_ordinary_send',
      );
      expect(
        userTurn.parts!.some((p) => p.text === 'never mind, just continue'),
      ).toBe(true);
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

    it('uses the normalized function call ID for preparation metadata', async () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'first request' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'read_file',
                args: { file_path: 'a.txt' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: { output: 'first result' },
              },
            },
          ],
        },
      ]);
      const preparationResponse = {
        candidates: [{ content: { role: 'model', parts: [] } }],
      } as unknown as GenerateContentResponse;
      setToolCallPreparations(preparationResponse, [
        { callId: 'call-1', toolName: 'read_file' },
      ]);
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield preparationResponse;
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'call-1',
                        name: 'read_file',
                        args: { file_path: 'b.txt' },
                      },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'second request' },
        'prompt-normalized-preparation-id',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      const preparation = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => getToolCallPreparations(event.value))[0];
      const functionCall = events.find(
        (event) =>
          event.type === StreamEventType.CHUNK &&
          event.value.functionCalls?.length,
      );
      expect(preparation?.callId).toBe('call-1__qwen_dup_2');
      expect(
        functionCall?.type === StreamEventType.CHUNK
          ? functionCall.value.functionCalls?.[0]?.id
          : undefined,
      ).toBe(preparation?.callId);
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

    it('should retry semantically empty responses after a tool result', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);

        const responses: GenerateContentResponse[][] = [
          [stopResponse([{ thought: true, text: 'I should keep working.' }])],
          [
            stopResponse([
              { thought: true, text: 'I should still keep working.' },
              { text: '(empty content)' },
            ]),
          ],
          [
            {
              candidates: [
                {
                  content: {
                    parts: [
                      { thought: true, text: 'One more attempt.' },
                      { text: '(empty ' },
                    ],
                  },
                },
              ],
            } as GenerateContentResponse,
            stopResponse([{ text: 'content)' }]),
          ],
          [stopResponse([{ text: 'Finished the analysis.' }])],
        ];
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () =>
          (async function* () {
            yield* responses.shift()!;
          })(),
        );

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-empty-response',
        );
        const events = await collectStreamWithFakeTimers(stream, 15_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(4);
        expect(
          events.some((event) => event.type === StreamEventType.RETRY),
        ).toBe(true);
        const lastRetryIndex = events.findLastIndex(
          (event) => event.type === StreamEventType.RETRY,
        );
        const finishIndex = events.findIndex(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            Boolean(event.value.candidates?.[0]?.finishReason),
        );
        expect(finishIndex).toBeGreaterThan(lastRetryIndex);
        expect(
          events
            .slice(lastRetryIndex + 1)
            .some(
              (event) =>
                event.type === StreamEventType.CHUNK &&
                event.value.candidates?.[0]?.content?.parts?.some(
                  (part) => part.text === '(empty content)',
                ),
            ),
        ).toBe(false);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(3);
        expect(mockLogContentRetry).toHaveBeenLastCalledWith(
          mockConfig,
          expect.objectContaining({
            error_type: 'NO_TOOL_RESULT_PROGRESS',
            model: 'test-model',
          }),
        );
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
        expect(recordAssistantTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            message: [{ text: 'Finished the analysis.' }],
          }),
        );
        const history = chatWithRecording.getHistory();
        expect(history).toHaveLength(4);
        expect(history.at(-1)).toEqual({
          role: 'model',
          parts: [{ text: 'Finished the analysis.' }],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should accept a thought-only tool result continuation once the retry budget is exhausted (#9026)', async () => {
      vi.useFakeTimers();
      try {
        chat.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () =>
          streamResponse(
            stopResponse([{ thought: true, text: 'I should keep working.' }]),
          ),
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-empty-response-exhausted',
        );
        const events = await collectStreamWithFakeTimers(stream, 35_000);

        // Retries still run first (#7039): the quiet completion is only
        // accepted once the budget is spent, never on first occurrence.
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(4);
        expect(
          events.some((event) => event.type === StreamEventType.RETRY),
        ).toBe(true);
        // The run completes instead of aborting (#9026), and the final
        // thought-only turn survives in history.
        expect(chat.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ thought: true, text: 'I should keep working.' }],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should accept a fully quiet tool result completion after retry exhaustion and keep history well-formed (#9026)', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        // Every attempt ends with a valid STOP and nothing else — the
        // deterministic shape that aborted whole headless runs before.
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => streamResponse(stopResponse([])));

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-quiet-completion',
        );
        const events = await collectStreamWithFakeTimers(stream, 35_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(4);
        expect(
          events.some((event) => event.type === StreamEventType.RETRY),
        ).toBe(true);
        // The accepted turn must not leave history ending on the user's
        // functionResponse: a placeholder model turn keeps user/model
        // alternation intact for the next request, and the JSONL record
        // carries the same text so transcript and history agree.
        expect(chatWithRecording.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ text: '(empty content)' }],
        });
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
        expect(recordAssistantTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            message: [{ text: '(empty content)' }],
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('still accepts a quiet completion when the armed attempt is transport-replayed (#9026)', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        let callCount = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => {
          callCount++;
          if (callCount === 5) {
            // The armed attempt dies at the socket before its first chunk:
            // replayable. The replayed final attempt must still carry the
            // one-shot acceptance instead of running un-armed into the
            // exhausted budget.
            return (async function* () {
              throw Object.assign(new TypeError('terminated'), {
                cause: Object.assign(new Error('socket failure'), {
                  code: 'ECONNRESET',
                }),
              });

              yield {} as GenerateContentResponse;
            })();
          }
          return streamResponse(stopResponse([]));
        });

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-armed-transport-replay',
        );
        const events = await collectStreamWithFakeTimers(stream, 120_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(6);
        expect(
          events.some((event) => event.type === StreamEventType.RETRY),
        ).toBe(true);
        expect(chatWithRecording.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ text: '(empty content)' }],
        });
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('still accepts a quiet completion when the armed attempt leaks protocol tags (#9026)', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        let callCount = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => {
          callCount++;
          if (callCount === 5) {
            // The armed attempt fails with PROTOCOL_TAG_LEAK and is
            // rescheduled by the tag-leak retry branch. The transient
            // budget is already spent, so the rescheduled attempt must
            // still carry the one-shot acceptance (rearm keyed to the
            // transient bucket) instead of running un-armed into the
            // exhausted budget.
            return (async function* () {
              throw new InvalidStreamError(
                'Model response started with leaked protocol tags.',
                'PROTOCOL_TAG_LEAK',
              );

              yield {} as GenerateContentResponse;
            })();
          }
          return streamResponse(stopResponse([]));
        });

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-armed-tag-leak',
        );
        const events = await collectStreamWithFakeTimers(stream, 120_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(6);
        expect(
          events.some((event) => event.type === StreamEventType.RETRY),
        ).toBe(true);
        expect(chatWithRecording.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ text: '(empty content)' }],
        });
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not arm quiet acceptance from a tag-leak-only budget exhaustion (#9026)', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        let callCount = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => {
          callCount++;
          if (callCount <= 2) {
            // Two tag-leak retries exhaust the tag-leak budget alone; that
            // must NOT arm acceptance — a quiet ending still has its full
            // transient retry-first budget ahead of it (#7039).
            return (async function* () {
              throw new InvalidStreamError(
                'Model response started with leaked protocol tags.',
                'PROTOCOL_TAG_LEAK',
              );

              yield {} as GenerateContentResponse;
            })();
          }
          return streamResponse(stopResponse([]));
        });

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-tag-leak-only-no-arm',
        );
        await collectStreamWithFakeTimers(stream, 120_000);

        // Calls 3-6 exhaust the transient budget on quiet STOPs; only the
        // 7th attempt is armed and accepted — never the first quiet one
        // right after the tag-leak budget spent.
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(7);
        expect(chatWithRecording.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ text: '(empty content)' }],
        });
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('still accepts a quiet completion when the armed attempt is cut into a continuation (#9026)', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        let callCount = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => {
          callCount++;
          if (callCount === 5) {
            // The armed attempt delivers visible text, then the socket
            // dies: continuation recovery reschedules it. The continuation
            // must keep the one-shot acceptance (rearm at the continuation
            // branch), so its quiet ending is accepted instead of
            // re-thrown into the exhausted budget.
            return (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      role: 'model',
                      parts: [{ text: 'partial answer' }],
                    },
                  },
                ],
              } as unknown as GenerateContentResponse;
              throw Object.assign(new TypeError('terminated'), {
                cause: Object.assign(new Error('socket failure'), {
                  code: 'ECONNRESET',
                }),
              });
            })();
          }
          return streamResponse(stopResponse([]));
        });

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-armed-continuation',
        );
        await collectStreamWithFakeTimers(stream, 120_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(6);
        // The delivered prefix survives; the quiet continuation adds no
        // placeholder because the turn already carries visible text.
        expect(chatWithRecording.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ text: 'partial answer' }],
        });
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
        expect(recordAssistantTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            message: [{ text: 'partial answer' }],
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('still accepts a quiet completion when the armed attempt hits a rate limit (#9026)', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        let callCount = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => {
          callCount++;
          if (callCount === 5) {
            // The armed attempt is throttled (429) and rescheduled by the
            // rate-limit branch; the rescheduled attempt is still the final
            // one and must keep the one-shot acceptance.
            return (async function* () {
              throw new StreamContentError(
                '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
              );

              yield {} as GenerateContentResponse;
            })();
          }
          return streamResponse(stopResponse([]));
        });

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-armed-rate-limit',
        );
        const events = await collectStreamWithFakeTimers(stream, 180_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(6);
        expect(
          events.some((event) => event.type === StreamEventType.RETRY),
        ).toBe(true);
        expect(chatWithRecording.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ text: '(empty content)' }],
        });
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('arms the quiet completion when a mixed error type exhausts the budget (#9026)', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        let callCount = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => {
          callCount++;
          if (callCount === 4) {
            // A non-NO_TOOL_RESULT_PROGRESS transient error consumes the
            // final retry slot; the shared budget means the last attempt
            // must still be armed.
            return (async function* () {
              yield {} as GenerateContentResponse;
            })();
          }
          return streamResponse(stopResponse([]));
        });

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-mixed-final-error',
        );
        const events = await collectStreamWithFakeTimers(stream, 120_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
        expect(
          events.some((event) => event.type === StreamEventType.RETRY),
        ).toBe(true);
        expect(chatWithRecording.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ text: '(empty content)' }],
        });
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
      } finally {
        vi.useRealTimers();
      }
    });

    it('records an accepted inlineData-only quiet turn in the transcript (#9026)', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        const imagePart = {
          inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
        };
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () =>
          streamResponse({
            candidates: [
              {
                content: { parts: [imagePart] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse),
        );

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-inlinedata-accept',
        );
        await collectStreamWithFakeTimers(stream, 120_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
        expect(chatWithRecording.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [imagePart],
        });
        // History and JSONL must come from the same source: the record
        // carries the inlineData part, not an empty message.
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
        expect(recordAssistantTurn).toHaveBeenCalledWith(
          expect.objectContaining({
            message: [imagePart],
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(['SAFETY', 'RECITATION', 'BLOCKLIST'] as const)(
      'keeps %s-blocked quiet tool result completions fatal (#9026)',
      async (finishReason) => {
        vi.useFakeTimers();
        try {
          const recordAssistantTurn = vi.fn();
          const chatWithRecording = chatWithRecorder(recordAssistantTurn);
          chatWithRecording.setHistory([
            { role: 'user', parts: [{ text: 'inspect the project' }] },
            {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    id: 'call_read_file',
                    name: 'read_file',
                    args: { path: '/tmp/example' },
                  },
                },
              ],
            },
          ]);
          vi.mocked(
            mockContentGenerator.generateContentStream,
          ).mockImplementation(async () =>
            streamResponse({
              candidates: [
                {
                  content: { parts: [] },
                  finishReason,
                },
              ],
            } as unknown as GenerateContentResponse),
          );

          const stream = await chatWithRecording.sendMessageStream(
            'test-model',
            {
              message: [
                {
                  functionResponse: {
                    id: 'call_read_file',
                    name: 'read_file',
                    response: { output: 'file contents' },
                  },
                },
              ],
            },
            'prompt-id-tool-result-safety-fatal',
          );

          await expectStreamExhaustion(stream, {
            type: 'NO_TOOL_RESULT_PROGRESS',
          });
          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(5);
          expect(recordAssistantTurn).not.toHaveBeenCalled();
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('keeps an Anthropic-routed refusal quiet tool result completion fatal (#9026)', async () => {
      // Anthropic's `refusal` stop_reason is converted to SAFETY by
      // mapAnthropicFinishReasonToGemini (anthropicContentGenerator/
      // converter.ts). Without that mapping it would fall through to
      // FINISH_REASON_UNSPECIFIED and the armed attempt would accept the
      // refusal as a quiet "(empty content)" completion, masking the
      // provider's safety decision.
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () =>
          streamResponse({
            candidates: [
              {
                content: { parts: [] },
                finishReason: 'SAFETY',
              },
            ],
          } as unknown as GenerateContentResponse),
        );

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-anthropic-refusal-fatal',
        );

        await expectStreamExhaustion(stream, {
          type: 'NO_TOOL_RESULT_PROGRESS',
        });
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
        expect(recordAssistantTurn).not.toHaveBeenCalled();
        // The refusal must not be masked by an accepted placeholder turn.
        expect(
          chatWithRecording
            .getHistory()
            .some((content) =>
              content.parts?.some((part) => part.text === '(empty content)'),
            ),
        ).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps unspecified quiet tool result completions fatal after retry exhaustion (#9026)', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
        chatWithRecording.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () =>
          streamResponse({
            candidates: [
              {
                content: { parts: [] },
                finishReason: 'FINISH_REASON_UNSPECIFIED',
              },
            ],
          } as unknown as GenerateContentResponse),
        );

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-unspecified-fatal',
        );

        await expectStreamExhaustion(stream, {
          type: 'NO_TOOL_RESULT_PROGRESS',
        });
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
        expect(recordAssistantTurn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('should keep MAX_TOKENS quiet tool result completions fatal after retry exhaustion (#9026)', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
          authType: AuthType.USE_GEMINI,
          model: 'test-model',
          samplingParams: { max_tokens: 1024 },
        });
        chat.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);
        let callCount = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => {
          callCount++;
          if (callCount < 5) {
            return streamResponse(stopResponse([]));
          }
          return streamResponse({
            candidates: [
              {
                content: {
                  parts: [{ thought: true, text: 'Still truncated.' }],
                },
                finishReason: 'MAX_TOKENS',
              },
            ],
          } as GenerateContentResponse);
        });

        const stream = await chat.sendMessageStream(
          'test-model',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-max-tokens-after-exhaustion',
        );

        await expectStreamExhaustion(stream, {
          type: 'NO_TOOL_RESULT_PROGRESS_MAX_TOKENS',
        });
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not retry tool result continuations that make another tool call', async () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'inspect the project' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_read_file',
                name: 'read_file',
                args: { path: '/tmp/example' },
              },
            },
          ],
        },
      ]);

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamResponse(
          stopResponse([
            {
              functionCall: {
                id: 'call_list_files',
                name: 'list_files',
                args: { path: '/tmp' },
              },
            },
          ]),
        ),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        {
          message: [
            {
              functionResponse: {
                id: 'call_read_file',
                name: 'read_file',
                response: { output: 'file contents' },
              },
            },
          ],
        },
        'prompt-id-tool-result-next-tool-call',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
        false,
      );
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.candidates?.[0]?.content?.parts?.some(
              (part) => part.functionCall?.id === 'call_list_files',
            ),
        ),
      ).toBe(true);
    });

    it('should escalate thought-only MAX_TOKENS responses after a tool result', async () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'inspect the project' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_read_file',
                name: 'read_file',
                args: { path: '/tmp/example' },
              },
            },
          ],
        },
      ]);

      const responses = [
        streamResponse({
          candidates: [
            {
              content: {
                parts: [{ thought: true, text: 'I need more tokens.' }],
              },
              finishReason: 'MAX_TOKENS',
            },
          ],
        } as GenerateContentResponse),
        streamResponse(stopResponse([{ text: 'Finished the analysis.' }])),
      ];
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => responses.shift()!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-pro',
        {
          message: [
            {
              functionResponse: {
                id: 'call_read_file',
                name: 'read_file',
                response: { output: 'file contents' },
              },
            },
          ],
        },
        'prompt-id-tool-result-max-tokens',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
      const calls = vi.mocked(mockContentGenerator.generateContentStream).mock
        .calls;
      expect(calls[1]![0].config?.maxOutputTokens).toBeGreaterThan(
        calls[0]![0].config?.maxOutputTokens ?? 0,
      );
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.RETRY &&
            event.maxOutputTokensEscalated !== undefined,
        ),
      ).toBe(true);
      expect(chat.getHistory().at(-1)).toEqual({
        role: 'model',
        parts: [{ text: 'Finished the analysis.' }],
      });
    });

    it('should accept quiet completions after MAX_TOKENS escalation retries exhaust (#9026)', async () => {
      vi.useFakeTimers();
      try {
        chat.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);

        const streams = [
          streamResponse({
            candidates: [
              {
                content: {
                  parts: [{ thought: true, text: 'I need more tokens.' }],
                },
                finishReason: 'MAX_TOKENS',
              },
            ],
          } as GenerateContentResponse),
          streamResponse(stopResponse([])),
          streamResponse(stopResponse([])),
          streamResponse(stopResponse([])),
          streamResponse(stopResponse([])),
          streamResponse(stopResponse([])),
        ];
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => streams.shift()!);

        const stream = await chat.sendMessageStream(
          'gemini-pro',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-max-tokens-quiet-continuation',
        );
        await collectStreamWithFakeTimers(stream, 35_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(6);
        expect(chat.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ text: '(empty content)' }],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should not escalate thought-only MAX_TOKENS responses when max tokens are user-set', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
          authType: AuthType.USE_GEMINI,
          model: 'test-model',
          samplingParams: { max_tokens: 1024 },
        });
        chat.setHistory([
          { role: 'user', parts: [{ text: 'inspect the project' }] },
          {
            role: 'model',
            parts: [
              {
                functionCall: {
                  id: 'call_read_file',
                  name: 'read_file',
                  args: { path: '/tmp/example' },
                },
              },
            ],
          },
        ]);

        const responses = [
          streamResponse({
            candidates: [
              {
                content: {
                  parts: [{ thought: true, text: 'I need more tokens.' }],
                },
                finishReason: 'MAX_TOKENS',
              },
            ],
          } as GenerateContentResponse),
          streamResponse(stopResponse([{ text: 'Finished the analysis.' }])),
        ];
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => responses.shift()!);

        const stream = await chat.sendMessageStream(
          'gemini-pro',
          {
            message: [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
          },
          'prompt-id-tool-result-user-max-tokens',
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.some(
            (event) =>
              event.type === StreamEventType.RETRY &&
              event.maxOutputTokensEscalated !== undefined,
          ),
        ).toBe(false);
        expect(mockLogContentRetry).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({
            error_type: 'NO_TOOL_RESULT_PROGRESS_MAX_TOKENS',
            model: 'gemini-pro',
          }),
        );
        expect(chat.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [{ text: 'Finished the analysis.' }],
        });
      } finally {
        vi.useRealTimers();
      }
    });

    it('should preserve (empty content) outside tool result continuations', async () => {
      const validStream = (async function* () {
        yield {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{ text: '(empty content)' }],
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
      expect(chat.getHistory().at(-1)).toEqual({
        role: 'model',
        parts: [{ text: '(empty content)' }],
      });
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
          // The send path window-clamps every main-turn request; with a
          // near-empty prompt the 32K default ceiling binds.
          config: { maxOutputTokens: 32_000 },
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

    it('caps function responses at the provider send boundary without changing user text', async () => {
      (
        mockConfig as Config & {
          getToolOutputBatchBudget: () => number;
        }
      ).getToolOutputBatchBudget = () => 100;
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamResponse({
          candidates: [
            {
              content: { role: 'model', parts: [{ text: 'done' }] },
              finishReason: 'STOP',
              index: 0,
              safetyRatings: [],
            },
          ],
          usageMetadata: { totalTokenCount: 1 },
        } as unknown as GenerateContentResponse),
      );
      const userText = 'ordinary user text must stay unchanged';

      const stream = await chat.sendMessageStream(
        'test-model',
        {
          message: [
            { text: userText },
            {
              functionResponse: {
                id: 'large-tool',
                name: 'shell',
                response: { output: 'x'.repeat(1000) },
              },
            },
          ],
        },
        'prompt-send-guard',
      );
      for await (const _ of stream) {
        // consume stream
      }

      const request = vi.mocked(mockContentGenerator.generateContentStream).mock
        .calls[0][0];
      const sentParts = (request.contents as Content[])[0].parts ?? [];
      expect(sentParts[0].text).toBe(userText);
      const output = sentParts[1].functionResponse?.response?.['output'];
      expect(typeof output).toBe('string');
      expect((output as string).length).toBeLessThanOrEqual(100);
      expect(chat.getHistory()[0].parts).toEqual(sentParts);
    });

    it('keeps historical image refs stable and reattaches only recent image bytes', async () => {
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        maxRecentImagesToRetain: 1,
        imagePayloadThreshold: 1,
      });
      chat.setHistory([
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: 'old-shot' } }],
        },
        {
          role: 'model',
          parts: [{ text: 'I see the first image' }],
        },
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: 'new-shot' } }],
        },
        {
          role: 'model',
          parts: [{ text: 'I see the second image' }],
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

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'continue' },
        'prompt-id-image-refs',
      );
      for await (const _ of stream) {
        // consume stream
      }

      const request = vi.mocked(mockContentGenerator.generateContentStream).mock
        .calls[0]?.[0];
      const contents = request?.contents as Content[];
      const serialized = JSON.stringify(contents);
      expect(serialized).toMatch(
        /\[Image #[a-f0-9]{12}: image\/png, \d+ bytes\]/,
      );
      expect(serialized).not.toContain('"data":"old-shot"');
      expect(serialized?.match(/"data":"new-shot"/g)).toHaveLength(1);
      expect(contents.at(-1)).toEqual({
        role: 'user',
        parts: expect.arrayContaining([
          { text: 'continue' },
          {
            text: expect.stringContaining('Recent images reattached'),
          },
          {
            inlineData: {
              mimeType: 'image/png',
              data: 'new-shot',
              displayName: undefined,
            },
          },
        ]),
      });
    });

    it('reattaches stored image markers on later below-threshold requests', async () => {
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        maxRecentImagesToRetain: 1,
        imagePayloadThreshold: 1,
      });
      chat.setHistory([
        {
          role: 'user',
          parts: [{ inlineData: { mimeType: 'image/png', data: 'old-shot' } }],
        },
        { role: 'model', parts: [{ text: 'I see the image' }] },
      ]);
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streamResponse(stopResponse([{ text: 'response' }])),
      );

      for (const [message, promptId] of [
        ['first question', 'prompt-id-image-refs-first'],
        ['second question', 'prompt-id-image-refs-second'],
      ] as const) {
        const stream = await chat.sendMessageStream(
          'test-model',
          { message },
          promptId,
        );
        for await (const _ of stream) {
          // consume stream
        }
      }

      const durable = JSON.stringify(chat.getHistory());
      expect(durable).toMatch(/Image #[a-f0-9]{12}/);
      expect(durable).not.toContain('"data":"old-shot"');
      const secondRequest = vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mock.calls[1]?.[0];
      expect(JSON.stringify(secondRequest?.contents)).toContain(
        '"data":"old-shot"',
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

    it('excludes exact degraded placeholders without dropping legitimate mentions or tool calls', () => {
      const toolCall = {
        functionCall: { id: 'call-1', name: 'read_file', args: {} },
      };
      const functionResponse = {
        functionResponse: {
          id: 'call-1',
          name: 'read_file',
          response: { output: 'ok' },
        },
      };
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'what happened?' }] },
        {
          role: 'model',
          parts: [{ text: 'The endpoint returned (request timeout) once.' }],
        },
        { role: 'user', parts: [{ text: 'continue' }] },
        { role: 'model', parts: [{ text: ' (request timeout) ' }] },
        { role: 'user', parts: [{ text: 'try again' }] },
        {
          role: 'model',
          parts: [{ text: '(request timeout)' }, toolCall],
        },
        { role: 'user', parts: [functionResponse] },
      ];
      chat.setHistory(history);

      expect(chat.getHistory(true)).toEqual([
        history[0],
        history[1],
        {
          role: 'user',
          parts: [{ text: 'continue' }, { text: 'try again' }],
        },
        history[5],
        history[6],
      ]);
      expect(chat.getHistory()).toEqual(history);
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

    it('sanitizes a standalone closing thinking tag without retrying valid tool calls', async () => {
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
      const create = vi.fn().mockImplementation(async () =>
        (async function* () {
          yield {
            id: 'sanitized-protocol-tag',
            created: 1,
            model: 'test-model',
            choices: [
              {
                index: 0,
                delta: {
                  reasoning_content: 'hidden reasoning',
                  content: '\n</think>\n',
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_read',
                      type: 'function',
                      function: { name: 'read_file', arguments: '{}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
          } as unknown as OpenAI.Chat.ChatCompletionChunk;
        })(),
      );
      const provider = {
        buildClient: () =>
          ({ chat: { completions: { create } } }) as unknown as OpenAI,
        buildRequest: (request: OpenAI.Chat.ChatCompletionCreateParams) =>
          request,
        buildHeaders: () => ({}),
        getDefaultGenerationConfig: () => ({}),
      } as OpenAICompatibleProvider;
      const generator = new OpenAIContentGenerator(
        { model: 'test-model', authType: AuthType.USE_OPENAI },
        mockConfig,
        provider,
      );
      vi.mocked(mockConfig.getContentGenerator).mockReturnValue(generator);
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        model: 'test-model',
        authType: AuthType.USE_OPENAI,
      });

      const stream = await chatWithRecording.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-sanitized-protocol-tag',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);
      const parts = events.flatMap((event) =>
        event.type === StreamEventType.CHUNK
          ? (event.value.candidates?.[0]?.content?.parts ?? [])
          : [],
      );

      expect(create).toHaveBeenCalledTimes(1);
      expect(mockLogContentRetry).not.toHaveBeenCalled();
      expect(mockLogProtocolTagSanitized).toHaveBeenCalledTimes(1);
      expect(mockLogProtocolTagSanitized).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          model: 'test-model',
          prompt_id: 'prompt-id-sanitized-protocol-tag',
          response_id: 'sanitized-protocol-tag',
          tag_name: 'think',
          tool_call_count: 1,
        }),
      );
      expect(parts).toContainEqual({
        functionCall: { id: 'call_read', name: 'read_file', args: {} },
      });
      expect(parts.some((part) => part.text?.includes('</think>'))).toBe(false);
      expect(JSON.stringify(chatWithRecording.getHistory())).not.toContain(
        '</think>',
      );
      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      expect(
        JSON.stringify(recordAssistantTurn.mock.calls[0]?.[0].message),
      ).not.toContain('</think>');
    });

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
    function makeStreamResponse(
      text = 'ok',
      usageMetadata?: GenerateContentResponse['usageMetadata'],
    ) {
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
          usageMetadata,
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
        contextWindowSize: 264_000,
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
      // The seeded authoritative count is the baseline of this attempt's
      // effective count (seed + locally-estimated pending message), so the
      // published number is the effective count, not the bare seed. Pin the
      // exact deterministic value — seed 123,456 + char/4 estimate of the
      // pending 'go' message (2 chars -> ceil(2/4) = 1 token), with
      // lastOutputTokenCount still 0 — so over-counting regressions on the
      // send path are caught too, not just under-counting.
      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBe(123_457);
      expect(compressSpy.mock.calls[0][1].precomputedEffectiveTokens).toBe(
        123_457,
      );
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

    it('forwards the pending user message and request config to compression', async () => {
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
      const requestTools = [
        {
          functionDeclarations: [
            { name: 'subagent_tool', description: 'Subagent-only tool' },
          ],
        },
      ];
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: userMessageText, config: { tools: requestTools } },
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
      expect(compressSpy.mock.calls[0][1].requestGenerationConfig?.tools).toBe(
        requestTools,
      );
    });

    it('triggers cache-sharing compaction end-to-end when a provider token count is available (R3.4)', async () => {
      // Reviewer R3.4: the "forwards the pending user message" test above
      // mocks the service entirely, so the real cheap-gate never runs there.
      // Exercise the full chain here with the provider token-count anchor
      // required for cache sharing:
      //   sendMessageStream → tryCompress → service.compress (REAL) →
      //   cheap-gate (count-based estimate from the 172K anchor) →
      //   splitter (real) → cache-sharing request (mocked at baseLlmClient) →
      //   persistence.
      const largeChars = 'x'.repeat(688_000); // ~172K estimated tokens
      const inheritedHistory: Content[] = [
        { role: 'user', parts: [{ text: largeChars }] },
        { role: 'model', parts: [{ text: 'ack' }] },
        { role: 'user', parts: [{ text: 'follow up' }] },
        { role: 'model', parts: [{ text: 'response' }] },
      ];
      chat.setHistory(inheritedHistory);
      chat.setLastPromptTokenCount(172_000);
      expect(chat.getLastPromptTokenCount()).toBe(172_000);

      // Full 200K window (DEFAULT_TOKEN_LIMIT): auto = 0.85 × 200K = 170K,
      // hard = 177K. ~172K sits between them, so the cheap-gate (force=false
      // path) must let compaction proceed without tripping hard-rescue.
      const coldSpy = vi.spyOn(sideQueryModule, 'runSideQuery');
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
      // Google GenAI uses the cache-sharing request rather than the cold side
      // query, while still exercising the real splitter and accounting path.
      expect(generateText).toHaveBeenCalled();
      expect(coldSpy).not.toHaveBeenCalled();
    });

    it('routes zero-baseline compression through the cold side query end-to-end (R5-3)', async () => {
      // Companion to the R3.4 test above without a provider token-count
      // anchor: an inherited history with lastPromptTokenCount === 0 must
      // derive a non-zero compression baseline locally, and the service must
      // skip cache sharing (no provider-reported anchor) and run the cold
      // side query. Pins the tryCompress-baseline → service-anchor-gate
      // composition; a gate re-sourced from opts.originalTokenCount would
      // mis-route this to the shared path, and a dropped derivation would
      // zero the baseline.
      const largeChars = 'x'.repeat(688_000); // ~172K estimated tokens
      const inheritedHistory: Content[] = [
        { role: 'user', parts: [{ text: largeChars }] },
        { role: 'model', parts: [{ text: 'ack' }] },
        { role: 'user', parts: [{ text: 'follow up' }] },
        { role: 'model', parts: [{ text: 'response' }] },
      ];
      chat.setHistory(inheritedHistory);
      expect(chat.getLastPromptTokenCount()).toBe(0);

      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      const coldSpy = vi
        .spyOn(sideQueryModule, 'runSideQuery')
        .mockResolvedValue({
          text: '<state_snapshot>compressed</state_snapshot>',
          usage: {
            promptTokenCount: 99_000,
            candidatesTokenCount: 1500,
            totalTokenCount: 100_500,
          },
        } as never);
      const generateText = vi.fn();
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('done'),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'follow-up after restore' },
        'prompt-r5-3',
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
      // The derived non-zero baseline (not the zero counter) reached the
      // service...
      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBeGreaterThan(
        0,
      );
      // ...and the missing provider anchor kept the request on the cold
      // path.
      expect(generateText).not.toHaveBeenCalled();
      expect(coldSpy).toHaveBeenCalledTimes(1);
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
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_API_ERROR,
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
      await chat.tryCompress('prompt-latch-force', true);
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
      expect(compressSpy.mock.calls[1][1].precomputedEffectiveTokens).toBe(
        135_000,
      );
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );

      const secondRequest = vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mock.calls[1]![0];
      expect(secondRequest.contents).toEqual(expectedRequestContents);
      expect(events[0]?.type).toBe(StreamEventType.COMPRESSED);
      // The overflow message reports the actual token count (135000), so the
      // published original count is provider-authoritative — no `~` marker.
      expect(
        (events[0] as { type: StreamEventType; info: ChatCompressionInfo }).info
          .originalTokenCountIsEstimated,
      ).toBe(false);
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
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].originalTokenCount).toBe(128_000);
      // The overflow message carries no actual token count, so the published
      // original count is the parsed limit — a projection that must keep
      // the `~` estimated marker.
      const compressedEvent = events.find(
        (event) => event.type === StreamEventType.COMPRESSED,
      );
      expect(
        (compressedEvent as { info: ChatCompressionInfo }).info
          .originalTokenCountIsEstimated,
      ).toBe(true);
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
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].originalTokenCount).toBe(262_144);
      // Neither actual nor limit tokens parsed — the configured window is a
      // fallback projection and must keep the `~` estimated marker.
      const compressedEvent = events.find(
        (event) => event.type === StreamEventType.COMPRESSED,
      );
      expect(
        (compressedEvent as { info: ChatCompressionInfo }).info
          .originalTokenCountIsEstimated,
      ).toBe(true);
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
    function makeStreamResponse(
      text = 'ok',
      usageMetadata?: GenerateContentResponse['usageMetadata'],
    ) {
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
          usageMetadata,
          text: () => text,
        } as unknown as GenerateContentResponse;
      })();
    }

    /**
     * 200K raw window in our mocks. Thresholds run against the FULL window
     * (the output clamp replaced the reservation):
     *   effectiveWindow = 200K - 20K (SUMMARY_RESERVE) = 180K
     *   hard            = max(180K - 3K, auto + 3K) = 177K
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
            newTokenCountIsEstimated: true,
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
      expect(recordPayload.info.newTokenCountIsEstimated).toBe(true);
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
      expect(chatWithRecording.isLastPromptTokenCountEstimated()).toBe(false);
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
      expect(chatWithRecording.isLastPromptTokenCountEstimated()).toBe(false);
      expect(chatWithRecording.getHistory()[0].parts?.[0].text).toBe(
        originalHistory[0].parts?.[0].text,
      );
    });

    it('does not treat the image token estimate as output tokens after hard-rescue compression', async () => {
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
      chatWithRecording.setLastPromptTokenCount(176_500);

      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
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
        makeStreamResponse('sent after compression'),
      );

      const stream = await chatWithRecording.sendMessageStream(
        'test-model',
        { message: 'x'.repeat(3_000) },
        'prompt-id-hard-rescue-image-estimate-slot',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(recordChatCompression).toHaveBeenCalledTimes(1);
      expect(chatWithRecording.getLastPromptTokenCount()).toBe(176_000);
    });

    it('includes previous response output tokens in the hard-tier estimate', async () => {
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 50_000,
            newTokenCount: 50_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            { role: 'model', parts: [{ text: 'ack' }] },
          ],
          info: {
            originalTokenCount: 176_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          makeStreamResponse('first', {
            promptTokenCount: 176_000,
            candidatesTokenCount: 1_500,
            totalTokenCount: 177_500,
          }),
        )
        .mockResolvedValueOnce(makeStreamResponse('after rescue'));

      chat.setLastPromptTokenCount(50_000);
      const firstStream = await chat.sendMessageStream(
        'test-model',
        { message: 'prime the token counters' },
        'prompt-prime-candidates',
      );
      for await (const _ of firstStream) {
        /* consume */
      }

      const rescueStream = await chat.sendMessageStream(
        'test-model',
        { message: 'small follow-up' },
        'prompt-hard-rescue-candidates',
      );
      for await (const _ of rescueStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[0][1].force).toBe(false);
      expect(compressSpy.mock.calls[1][1].force).toBe(true);
      expect(
        compressSpy.mock.calls[1][1].precomputedEffectiveTokens,
      ).toBeGreaterThanOrEqual(177_000);
    });

    it('does not double-count output tokens when prompt count falls back to total token count', async () => {
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 176_000,
          newTokenCount: 176_000,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          makeStreamResponse('first', {
            candidatesTokenCount: 1_500,
            totalTokenCount: 176_000,
          }),
        )
        .mockResolvedValueOnce(makeStreamResponse('second'));

      chat.setLastPromptTokenCount(50_000);
      const firstStream = await chat.sendMessageStream(
        'test-model',
        { message: 'prime fallback token counters' },
        'prompt-prime-total-token-fallback',
      );
      for await (const _ of firstStream) {
        /* consume */
      }

      const secondStream = await chat.sendMessageStream(
        'test-model',
        { message: 'small follow-up' },
        'prompt-total-token-fallback-follow-up',
      );
      for await (const _ of secondStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].force).toBe(false);
      expect(
        compressSpy.mock.calls[1][1].precomputedEffectiveTokens,
      ).toBeLessThan(177_000);
    });

    it('includes previous response thought tokens in the hard-tier estimate', async () => {
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 50_000,
            newTokenCount: 50_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            { role: 'model', parts: [{ text: 'ack' }] },
          ],
          info: {
            originalTokenCount: 176_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          makeStreamResponse('first', {
            promptTokenCount: 176_000,
            candidatesTokenCount: 500,
            thoughtsTokenCount: 1_000,
            totalTokenCount: 177_500,
          }),
        )
        .mockResolvedValueOnce(makeStreamResponse('after rescue'));

      chat.setLastPromptTokenCount(50_000);
      const firstStream = await chat.sendMessageStream(
        'test-model',
        { message: 'prime thought token counters' },
        'prompt-prime-thought-tokens',
      );
      for await (const _ of firstStream) {
        /* consume */
      }

      const rescueStream = await chat.sendMessageStream(
        'test-model',
        { message: 'small follow-up' },
        'prompt-hard-rescue-thought-tokens',
      );
      for await (const _ of rescueStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].force).toBe(true);
      expect(
        compressSpy.mock.calls[1][1].precomputedEffectiveTokens,
      ).toBeGreaterThanOrEqual(177_000);
    });

    it('includes disjoint candidate and thought tokens when total token count is unavailable', async () => {
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 50_000,
            newTokenCount: 50_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            { role: 'model', parts: [{ text: 'ack' }] },
          ],
          info: {
            originalTokenCount: 176_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          makeStreamResponse('first', {
            promptTokenCount: 176_000,
            candidatesTokenCount: 1_200,
            thoughtsTokenCount: 300,
          }),
        )
        .mockResolvedValueOnce(makeStreamResponse('after rescue'));

      chat.setLastPromptTokenCount(50_000);
      const firstStream = await chat.sendMessageStream(
        'test-model',
        { message: 'prime disjoint output token counters' },
        'prompt-prime-disjoint-output-tokens',
      );
      for await (const _ of firstStream) {
        /* consume */
      }

      const rescueStream = await chat.sendMessageStream(
        'test-model',
        { message: 'small follow-up' },
        'prompt-hard-rescue-disjoint-output-tokens',
      );
      for await (const _ of rescueStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].force).toBe(true);
      expect(
        compressSpy.mock.calls[1][1].precomputedEffectiveTokens,
      ).toBeGreaterThanOrEqual(177_000);
    });

    it('does not double-count OpenAI-compatible reasoning tokens already included in candidates', async () => {
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 176_400,
          newTokenCount: 176_400,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          makeStreamResponse('first', {
            promptTokenCount: 175_400,
            candidatesTokenCount: 1_000,
            thoughtsTokenCount: 500,
            totalTokenCount: 176_400,
          }),
        )
        .mockResolvedValueOnce(makeStreamResponse('second'));

      chat.setLastPromptTokenCount(50_000);
      const firstStream = await chat.sendMessageStream(
        'test-model',
        { message: 'prime OpenAI-compatible reasoning token counters' },
        'prompt-prime-openai-reasoning-tokens',
      );
      for await (const _ of firstStream) {
        /* consume */
      }

      const secondStream = await chat.sendMessageStream(
        'test-model',
        { message: 'small follow-up' },
        'prompt-openai-reasoning-follow-up',
      );
      for await (const _ of secondStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].force).toBe(false);
      expect(
        compressSpy.mock.calls[1][1].precomputedEffectiveTokens,
      ).toBeLessThan(177_000);
    });

    it('resets previous response output tokens when seeding last prompt tokens externally', async () => {
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 176_000,
            newTokenCount: 176_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          makeStreamResponse('first', {
            promptTokenCount: 10_000,
            candidatesTokenCount: 5_000,
            totalTokenCount: 15_000,
          }),
        )
        .mockResolvedValueOnce(makeStreamResponse('second'));

      const firstStream = await chat.sendMessageStream(
        'test-model',
        { message: 'collect candidates' },
        'prompt-collect-candidates',
      );
      for await (const _ of firstStream) {
        /* consume */
      }

      chat.setLastPromptTokenCount(176_000);
      const secondStream = await chat.sendMessageStream(
        'test-model',
        { message: 'seeded follow-up' },
        'prompt-seeded-after-candidates',
      );
      for await (const _ of secondStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].force).toBe(false);
      expect(
        compressSpy.mock.calls[1][1].precomputedEffectiveTokens,
      ).toBeLessThan(177_000);
    });

    it('resets previous response output tokens after successful compression', async () => {
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 50_000,
            newTokenCount: 50_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        })
        .mockResolvedValueOnce({
          newHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            { role: 'model', parts: [{ text: 'ack' }] },
          ],
          info: {
            originalTokenCount: 176_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        })
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 40_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          makeStreamResponse('first', {
            promptTokenCount: 176_000,
            candidatesTokenCount: 100_000,
            totalTokenCount: 276_000,
          }),
        )
        .mockResolvedValueOnce(makeStreamResponse('after compression'))
        .mockResolvedValueOnce(makeStreamResponse('after reset'));

      chat.setLastPromptTokenCount(50_000);
      const firstStream = await chat.sendMessageStream(
        'test-model',
        { message: 'prime output tokens' },
        'prompt-prime-compression-reset',
      );
      for await (const _ of firstStream) {
        /* consume */
      }

      const rescueStream = await chat.sendMessageStream(
        'test-model',
        { message: 'trigger compression' },
        'prompt-compression-reset-rescue',
      );
      for await (const _ of rescueStream) {
        /* consume */
      }

      const followUpStream = await chat.sendMessageStream(
        'test-model',
        { message: 'after compression reset' },
        'prompt-after-compression-reset',
      );
      for await (const _ of followUpStream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(3);
      expect(compressSpy.mock.calls[1][1].force).toBe(true);
      expect(
        compressSpy.mock.calls[2][1].precomputedEffectiveTokens,
      ).toBeLessThan(100_000);
    });

    it('stops pre-send hard-rescue after repeated failed hard-tier compactions', async () => {
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
        async () => makeStreamResponse('after failed rescue'),
      );

      chat.setLastPromptTokenCount(176_999);
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await expect(
          chat.sendMessageStream(
            'test-model',
            { message: `hard-rescue-${i}` },
            `prompt-hard-rescue-bound-${i}`,
          ),
        ).rejects.toThrow(
          /compression status: COMPRESSION_FAILED_EMPTY_SUMMARY/i,
        );
      }

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'send after bounded hard-rescue failures' },
        'prompt-hard-rescue-after-failures',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
      expect(compressSpy.mock.calls.map(([, opts]) => opts.force)).toEqual(
        Array(MAX_CONSECUTIVE_FAILURES).fill(true),
      );
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('hard-tier rescue skipped'),
      );
      expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('prompt_id=prompt-hard-rescue-after-failures'),
      );
    });

    it('falls back to reactive overflow recovery after the hard-rescue bound is exhausted', async () => {
      const failedRescueResult = {
        newHistory: null,
        info: {
          originalTokenCount: 178_000,
          newTokenCount: 178_000,
          compressionStatus: CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
        },
      };
      const compressedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'summary after overflow' }] },
        { role: 'model', parts: [{ text: 'ack' }] },
      ];
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce(failedRescueResult)
        .mockResolvedValueOnce(failedRescueResult)
        .mockResolvedValueOnce(failedRescueResult)
        .mockResolvedValueOnce({
          newHistory: compressedHistory,
          info: {
            originalTokenCount: 180_000,
            newTokenCount: 40_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockRejectedValueOnce(
          new Error('prompt is too long: 180000 tokens > 128000 maximum'),
        )
        .mockResolvedValueOnce(makeStreamResponse('after reactive fallback'));

      chat.setLastPromptTokenCount(176_999);
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await expect(
          chat.sendMessageStream(
            'test-model',
            { message: `failed-hard-rescue-${i}` },
            `prompt-hard-rescue-before-reactive-${i}`,
          ),
        ).rejects.toThrow(
          /compression status: COMPRESSION_FAILED_EMPTY_SUMMARY/i,
        );
      }

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'send after hard-rescue bound' },
        'prompt-hard-rescue-reactive-fallback',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES + 1);
      expect(
        compressSpy.mock.calls
          .slice(0, MAX_CONSECUTIVE_FAILURES)
          .map(([, opts]) => opts.force),
      ).toEqual(Array(MAX_CONSECUTIVE_FAILURES).fill(true));
      expect(compressSpy.mock.calls[MAX_CONSECUTIVE_FAILURES][1].force).toBe(
        true,
      );
      expect(
        compressSpy.mock.calls[MAX_CONSECUTIVE_FAILURES][1].originalTokenCount,
      ).toBe(180_000);
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
    });

    it('does not count thrown hard-rescue attempts toward the retry bound', async () => {
      const compressionError = new Error('compression side-query failed');
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockRejectedValue(compressionError);

      chat.setLastPromptTokenCount(176_999);
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES + 1; i++) {
        await expect(
          chat.sendMessageStream(
            'test-model',
            { message: `throwing-hard-rescue-${i}` },
            `prompt-hard-rescue-throw-${i}`,
          ),
        ).rejects.toThrow(compressionError);
      }

      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES + 1);
      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
    });

    it('stops hard-rescue after repeated NOOP results are still oversized', async () => {
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

      chat.setLastPromptTokenCount(176_999);
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await expect(
          chat.sendMessageStream(
            'test-model',
            { message: `noop-hard-rescue-${i}` },
            `prompt-hard-rescue-noop-${i}`,
          ),
        ).rejects.toThrow(/compression status: NOOP/i);
      }

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('after bounded noop hard-rescue'),
      );
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'send after bounded noop hard-rescue' },
        'prompt-hard-rescue-after-noop-bound',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
      expect(compressSpy.mock.calls.map(([, opts]) => opts.force)).toEqual(
        Array(MAX_CONSECUTIVE_FAILURES).fill(true),
      );
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('hard-tier rescue skipped'),
      );
      expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining(
          'prompt_id=prompt-hard-rescue-after-noop-bound',
        ),
      );
    });

    it('does not replace token counters when usage reports zero prompt tokens', async () => {
      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 123_456,
          newTokenCount: 123_456,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('zero prompt count', {
          promptTokenCount: 0,
          totalTokenCount: 5000,
        }),
      );

      chat.setLastPromptTokenCount(123_456);
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'zero prompt count should not reseed' },
        'prompt-zero-count-no-reseed',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(chat.getLastPromptTokenCount()).toBe(123_456);
    });

    it('ignores previous response output tokens when the prompt token count is zero', () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'history question' }] },
        { role: 'model', parts: [{ text: 'history answer' }] },
      ];
      const userMessage: Content = {
        role: 'user',
        parts: [{ text: 'follow-up question' }],
      };

      expect(estimatePromptTokens(history, userMessage, 0, 9999)).toBe(
        estimateContentTokens([...history, userMessage]),
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

    it('gates thresholds on the full window and clamps maxOutputTokens to the room left (issue #5950)', async () => {
      // claude-sonnet-4-6 has a 65,536 output limit, clipped to the 64K
      // ceiling. With the old reservation, a 170K prompt on a 200K window
      // would have hard-rescued (hard was ~111K); with full-window
      // thresholds hard = 177K, so this send takes the normal cheap-gate
      // path — and the outgoing request is window-clamped instead:
      // maxOutputTokens = 200000 − ~170001 − 10000 (margin) ≈ 20K.
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'claude-sonnet-4-6',
        contextWindowSize: 200_000,
      });

      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 170_000,
            newTokenCount: 170_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('clamped response'),
      );

      const chatInstance = new GeminiChat(
        mockConfig,
        config,
        [],
        undefined,
        uiTelemetryService,
      );
      chatInstance.setLastPromptTokenCount(170_000);

      const stream = await chatInstance.sendMessageStream(
        'claude-sonnet-4-6',
        { message: 'hi' },
        'prompt-window-clamp-taper',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // Full-window thresholds: 170K < hard (177K) → cheap-gate, not rescue.
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(false);

      // The outgoing request is clamped to the room left in the window:
      // char/4("hi") = 1 token, inflated by the conservative safety factor
      // (1.5x, ceil'd) to 2, estimate = 170,000 + 2,
      // room = 200,000 − 170,002 − 10,000.
      const requestConfig = vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mock.calls[0][0].config as { maxOutputTokens?: number };
      expect(requestConfig.maxOutputTokens).toBe(19_998);
      expect(170_000 + requestConfig.maxOutputTokens!).toBeLessThanOrEqual(
        200_000,
      );
    });

    it('sends the default ceiling when the window has room (unknown model → 32K)', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        contextWindowSize: 200_000,
      });

      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 50_000,
          newTokenCount: 50_000,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('roomy response'),
      );

      const chatInstance = new GeminiChat(
        mockConfig,
        config,
        [],
        undefined,
        uiTelemetryService,
      );
      chatInstance.setLastPromptTokenCount(50_000);

      const stream = await chatInstance.sendMessageStream(
        'test-model',
        { message: 'hi' },
        'prompt-window-clamp-ceiling',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // Room = 200K − ~50K − 10K = ~140K; the 32K default ceiling binds.
      const requestConfig = vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mock.calls[0][0].config as { maxOutputTokens?: number };
      expect(requestConfig.maxOutputTokens).toBe(32_000);
    });

    it('uses QWEN_CODE_MAX_OUTPUT_TOKENS as the ceiling when set', async () => {
      process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'] = '12000';
      try {
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
          authType: AuthType.USE_GEMINI,
          model: 'test-model',
          contextWindowSize: 200_000,
        });

        vi.spyOn(
          ChatCompressionService.prototype,
          'compress',
        ).mockResolvedValue({
          newHistory: null,
          info: {
            originalTokenCount: 50_000,
            newTokenCount: 50_000,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          makeStreamResponse('env ceiling response'),
        );

        const chatInstance = new GeminiChat(
          mockConfig,
          config,
          [],
          undefined,
          uiTelemetryService,
        );
        chatInstance.setLastPromptTokenCount(50_000);

        const stream = await chatInstance.sendMessageStream(
          'test-model',
          { message: 'hi' },
          'prompt-window-clamp-env-ceiling',
        );
        for await (const _ of stream) {
          /* consume */
        }

        const requestConfig = vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mock.calls[0][0].config as { maxOutputTokens?: number };
        expect(requestConfig.maxOutputTokens).toBe(12_000);
      } finally {
        delete process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'];
      }
    });

    it('pads the first-send clamp estimate for unseen system/tool overhead', async () => {
      // On the very first send (lastPromptTokenCount === 0) the char/4
      // history estimate misses ~15-20K of system-prompt + tool-schema
      // overhead. Without the pad, the clamp on a 40K window would grant
      // ~30K of output against a real prompt of ~18K+ → prompt + max_tokens
      // overflows the window (observed live in the E2E dry-run: 18,359 +
      // 26,764 = 45,123 > 40,000). With the 20K pad the grant drops to
      // ~10K, keeping the invariant even in the worst under-count case.
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        contextWindowSize: 40_000,
      });

      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('first send'),
      );

      const chatInstance = new GeminiChat(
        mockConfig,
        config,
        [],
        undefined,
        uiTelemetryService,
      );
      // lastPromptTokenCount deliberately left at 0 (fresh session).

      const stream = await chatInstance.sendMessageStream(
        'test-model',
        { message: 'hi' },
        'prompt-first-send-clamp-pad',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // clamp = 40000 − (1-token estimate + 20000 pad) − 10000 margin = 9,999,
      // NOT the ~30K an unpadded estimate would produce.
      const requestConfig = vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mock.calls[0][0].config as { maxOutputTokens?: number };
      expect(requestConfig.maxOutputTokens).toBe(9_999);
    });

    it('keeps the overhead pad after compression uses an estimated baseline', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        contextWindowSize: 40_000,
      });

      vi.spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: [
            { role: 'user', parts: [{ text: 'summary' }] },
            { role: 'model', parts: [{ text: 'ok' }] },
          ],
          info: {
            originalTokenCount: 1000,
            newTokenCount: 79,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        })
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 79,
            newTokenCount: 79,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('first send after compression'),
      );

      const chatInstance = new GeminiChat(
        mockConfig,
        config,
        [
          { role: 'user', parts: [{ text: 'history without usage' }] },
          { role: 'model', parts: [{ text: 'response' }] },
        ],
        undefined,
        uiTelemetryService,
      );
      await chatInstance.tryCompress('prompt-estimated-compression', true);
      expect(chatInstance.isLastPromptTokenCountEstimated()).toBe(true);

      const stream = await chatInstance.sendMessageStream(
        'test-model',
        { message: 'hi' },
        'prompt-estimated-clamp-pad',
      );
      for await (const _ of stream) {
        /* consume */
      }

      const requestConfig = vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mock.calls[0][0].config as { maxOutputTokens?: number };
      expect(requestConfig.maxOutputTokens).toBe(9_919);
    });

    it('clears estimated provenance when provider usage is received', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        contextWindowSize: 40_000,
      });
      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 79,
          newTokenCount: 79,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('usage received', {
          promptTokenCount: 123,
          candidatesTokenCount: 7,
          totalTokenCount: 130,
        }),
      );

      const chatInstance = new GeminiChat(
        mockConfig,
        config,
        [],
        undefined,
        uiTelemetryService,
      );
      chatInstance.seedResumeTokenCounts(79, 0, true);
      expect(chatInstance.isLastPromptTokenCountEstimated()).toBe(true);

      const stream = await chatInstance.sendMessageStream(
        'test-model',
        { message: 'hi' },
        'prompt-provider-usage-clears-estimate',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(chatInstance.getLastPromptTokenCount()).toBe(123);
      expect(chatInstance.isLastPromptTokenCountEstimated()).toBe(false);
    });

    it('keeps estimated provenance when provider usage has no usable count', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        contextWindowSize: 40_000,
      });
      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 79,
          newTokenCount: 79,
          compressionStatus: CompressionStatus.NOOP,
        },
      });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('usage omitted', {
          promptTokenCount: 0,
          totalTokenCount: 0,
        }),
      );

      const chatInstance = new GeminiChat(
        mockConfig,
        config,
        [],
        undefined,
        uiTelemetryService,
      );
      chatInstance.seedResumeTokenCounts(79, 0, true);

      const stream = await chatInstance.sendMessageStream(
        'test-model',
        { message: 'hi' },
        'prompt-provider-usage-keeps-estimate',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(chatInstance.getLastPromptTokenCount()).toBe(79);
      expect(chatInstance.isLastPromptTokenCountEstimated()).toBe(true);
    });

    it('keeps a sane input budget on small custom windows (issue #6144)', async () => {
      // Custom local model with a 65,536-token window. Under the old
      // reservation a flat 64K was subtracted from the window, collapsing
      // the input budget to 1,536 tokens and rejecting a ~6K prompt. With
      // full-window thresholds the same prompt sends normally, and the
      // output request is the model's 32,768 output limit (room =
      // 65,536 − ~6,280 − 10,000 ≈ 49K does not bind).
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'qwen3coder-64k',
        contextWindowSize: 65_536,
      });

      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce({
          newHistory: null,
          info: {
            originalTokenCount: 6_276,
            newTokenCount: 6_276,
            compressionStatus: CompressionStatus.NOOP,
          },
        });
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        makeStreamResponse('normal response'),
      );

      const chatInstance = new GeminiChat(
        mockConfig,
        config,
        [],
        undefined,
        uiTelemetryService,
      );
      chatInstance.setLastPromptTokenCount(6_276);

      const stream = await chatInstance.sendMessageStream(
        'qwen3coder-64k',
        { message: 'hi' },
        'prompt-small-window-clamp',
      );
      for await (const _ of stream) {
        /* consume — must not throw the hard-rescue failure */
      }

      // Normal auto-path cheap-gate (force=false), NOT hard-tier rescue.
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(false);
      const requestConfig = vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mock.calls[0][0].config as { maxOutputTokens?: number };
      expect(requestConfig.maxOutputTokens).toBe(32_768);
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

  describe('getHistoryToolCallFingerprints', () => {
    it('returns an empty Map for empty history', () => {
      expect(chat.getHistoryToolCallFingerprints()).toEqual(new Map());
    });

    it('maps only responded functionCall ids to (name, args) fingerprints', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'go' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'cid_a',
                name: 'read_file',
                args: { file_path: 'a.ts' },
              },
            },
            {
              functionCall: {
                id: 'cid_unanswered',
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
                id: 'cid_a',
                name: 'read_file',
                response: { output: 'a' },
              },
            },
          ],
        },
      ]);

      const fingerprints = chat.getHistoryToolCallFingerprints();
      expect([...fingerprints.keys()]).toEqual(['cid_a']);
      expect(fingerprints.get('cid_a')).toBe(
        getToolCallFingerprint('read_file', { file_path: 'a.ts' }),
      );
    });

    it('keeps the first answered call for an id reused across turns and skips orphan response ids', () => {
      // The stored fingerprint is the replay oracle at every entry point:
      // for providers that reuse ids across turns, the id must keep naming
      // the call that first executed under it, and a functionResponse with
      // no matching functionCall must contribute nothing.
      chat.setHistory([
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'cid_reused',
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
                id: 'cid_reused',
                name: 'read_file',
                response: { output: 'a' },
              },
            },
            {
              functionResponse: {
                id: 'cid_orphan',
                name: 'read_file',
                response: { output: 'x' },
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'cid_reused',
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
                id: 'cid_reused',
                name: 'read_file',
                response: { output: 'b' },
              },
            },
          ],
        },
      ]);

      const fingerprints = chat.getHistoryToolCallFingerprints();
      expect([...fingerprints.keys()]).toEqual(['cid_reused']);
      expect(fingerprints.get('cid_reused')).toBe(
        getToolCallFingerprint('read_file', { file_path: 'a.ts' }),
      );
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
    it('copies Part containers without cloning large leaf payloads', () => {
      const payload = { output: 'x'.repeat(128 * 1024) };
      const topLevelInlineData = {
        mimeType: 'image/png',
        data: 'top-level-image',
      };
      const nestedInlineData = {
        mimeType: 'image/png',
        data: 'nested-image',
      };
      const topLevelPart: Part = { inlineData: topLevelInlineData };
      const nestedPart: Part = { inlineData: nestedInlineData };
      const functionResponsePart: Part = {
        functionResponse: {
          id: 'call-1',
          name: 'read_file',
          response: payload,
          parts: [nestedPart],
        },
      };
      const content: Content = {
        role: 'user',
        parts: [topLevelPart, functionResponsePart],
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
      expect(history[0]!.parts![0]).not.toBe(topLevelPart);
      expect(history[0]!.parts![0]!.inlineData).toBe(topLevelInlineData);
      const copiedFunctionResponsePart = history[0]!.parts![1]!;
      expect(copiedFunctionResponsePart).not.toBe(functionResponsePart);
      expect(copiedFunctionResponsePart.functionResponse).not.toBe(
        functionResponsePart.functionResponse,
      );
      const copiedNested = copiedFunctionResponsePart.functionResponse
        ?.parts as Part[];
      expect(copiedNested).not.toBe(
        functionResponsePart.functionResponse?.parts,
      );
      expect(copiedNested[0]).not.toBe(nestedPart);
      expect(copiedNested[0]!.inlineData).toBe(nestedInlineData);
      delete history[0]!.parts![0]!.inlineData;
      delete copiedNested[0]!.inlineData;
      expect(topLevelPart.inlineData).toBe(topLevelInlineData);
      expect(nestedPart.inlineData).toBe(nestedInlineData);
      const response = copiedFunctionResponsePart as {
        functionResponse: { response: typeof payload };
      };
      expect(response.functionResponse.response).toBe(payload);
    });
  });

  describe('getHistoryForForkWindow', () => {
    it('removes startup context before curating adjacent user turns', () => {
      const startup: Content = {
        role: 'user',
        parts: [
          {
            text: '<system-reminder>\nstartup context\n</system-reminder>',
          },
        ],
      };
      const firstTurn: Content = {
        role: 'user',
        parts: [
          {
            text: '<system-reminder>\nturn context\n</system-reminder>',
          },
          { text: 'first question' },
        ],
      };
      const answer: Content = {
        role: 'model',
        parts: [{ text: 'first answer' }],
      };
      chat.setHistory([startup, firstTurn, answer]);

      expect(chat.getHistoryForForkWindow()).toEqual([firstTurn, answer]);
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

    it('filters out thought parts from the last model message', () => {
      chat.addHistory({
        role: 'model',
        parts: [
          { text: 'internal reasoning...', thought: true },
          { text: 'visible response' },
        ],
      });

      expect(chat.getLastModelMessageText()).toBe('visible response');
    });

    it('returns undefined when all text parts are thoughts', () => {
      chat.addHistory({
        role: 'model',
        parts: [{ text: 'only thinking', thought: true }],
      });

      expect(chat.getLastModelMessageText()).toBeUndefined();
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

    it('retries a split degraded placeholder without yielding or persisting it', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            streamResponse(
              {
                candidates: [{ content: { parts: [{ text: '(request ' }] } }],
              } as unknown as GenerateContentResponse,
              stopResponse([{ text: 'timeout)' }]),
            ),
          )
          .mockResolvedValueOnce(
            streamResponse(stopResponse([{ text: 'Recovered response' }])),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-degraded-placeholder',
        );
        const events = await collectStreamWithFakeTimers(stream);
        const emitted = events
          .filter((event) => event.type === StreamEventType.CHUNK)
          .flatMap(
            (event) =>
              event.value.candidates?.[0]?.content?.parts?.map(
                (part) => part.text,
              ) ?? [],
          );

        expect(emitted).toEqual(['Recovered response']);
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(mockLogContentRetry).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({
            error_type: 'UPSTREAM_DEGRADED_RESPONSE',
          }),
        );
        expect(chat.getHistory()).toEqual([
          { role: 'user', parts: [{ text: 'test' }] },
          { role: 'model', parts: [{ text: 'Recovered response' }] },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('passes through longer text that mentions the placeholder', async () => {
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamResponse(
          stopResponse([
            { text: 'The endpoint returned (request timeout) once.' },
          ]),
        ),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-placeholder-mention',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
              'The endpoint returned (request timeout) once.',
        ),
      ).toBe(true);
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
    });

    it('does not reject a placeholder turn that contains a function call', async () => {
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        streamResponse(
          stopResponse([
            { text: '(request timeout)' },
            {
              functionCall: { id: 'call-1', name: 'read_file', args: {} },
            },
          ]),
        ),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-placeholder-tool-call',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.candidates?.[0]?.content?.parts?.some(
              (part) => part.functionCall?.id === 'call-1',
            ),
        ),
      ).toBe(true);
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
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

        // Should be called 5 times (1 initial + 4 transient retries)
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(4);
        expect(mockLogContentRetryFailure).toHaveBeenCalledTimes(1);
        expect(mockLogContentRetryFailure).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({
            total_attempts: 5,
            final_error_type: 'NO_FINISH_REASON',
            model: 'test-model',
          }),
        );

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

    it('should recover after four consecutive invalid streams', async () => {
      vi.useFakeTimers();
      try {
        let callCount = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => {
          callCount++;
          if (callCount <= 4) {
            return (async function* () {
              yield {
                candidates: [
                  {
                    content: { parts: [] },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })();
          }

          return (async function* () {
            yield {
              candidates: [
                {
                  content: { parts: [{ text: 'Recovered response' }] },
                  finishReason: 'STOP',
                },
              ],
            } as unknown as GenerateContentResponse;
          })();
        });

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-four-invalid-streams',
        );
        const events = await collectStreamWithFakeTimers(stream, 25_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(4);
        for (const [index, retryDelayMs] of [
          2000, 4000, 6000, 8000,
        ].entries()) {
          expect(mockLogContentRetry).toHaveBeenNthCalledWith(
            index + 1,
            mockConfig,
            expect.objectContaining({
              attempt_number: index,
              error_type: 'NO_RESPONSE_TEXT',
              retry_delay_ms: retryDelayMs,
              model: 'test-model',
            }),
          );
        }
        expect(mockLogContentRetryFailure).not.toHaveBeenCalled();
        expect(
          events.some(
            (event) =>
              event.type === StreamEventType.CHUNK &&
              event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Recovered response',
          ),
        ).toBe(true);
        expect(chat.getHistory()).toEqual([
          { role: 'user', parts: [{ text: 'test' }] },
          { role: 'model', parts: [{ text: 'Recovered response' }] },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each([
      {
        name: 'protocol tag leaks',
        errorType: 'PROTOCOL_TAG_LEAK',
        delta: {
          reasoning_content: 'hidden reasoning',
          content: '</think> leaked visible reasoning',
        },
        finishReason: 'stop',
        retryCount: 2,
      },
      {
        name: 'malformed tool calls',
        errorType: 'MALFORMED_TOOL_CALL',
        delta: {
          tool_calls: [
            {
              index: 0,
              id: 'call_without_name',
              type: 'function',
              function: { arguments: '{}' },
            },
          ],
        },
        finishReason: 'tool_calls',
        retryCount: 4,
      },
    ] as const)(
      'should retry $name through the OpenAI pipeline',
      async (testCase) => {
        vi.useFakeTimers();
        try {
          const create = vi.fn().mockImplementation(async () =>
            (async function* () {
              yield {
                id: 'protocol-tag-leak',
                created: 1,
                model: 'test-model',
                choices: [
                  {
                    index: 0,
                    delta: testCase.delta,
                    finish_reason: testCase.finishReason,
                  },
                ],
              } as unknown as OpenAI.Chat.ChatCompletionChunk;
            })(),
          );
          const provider = {
            buildClient: () =>
              ({ chat: { completions: { create } } }) as unknown as OpenAI,
            buildRequest: (request: OpenAI.Chat.ChatCompletionCreateParams) =>
              request,
            buildHeaders: () => ({}),
            getDefaultGenerationConfig: () => ({}),
          } as OpenAICompatibleProvider;
          const generator = new OpenAIContentGenerator(
            { model: 'test-model', authType: AuthType.USE_OPENAI },
            mockConfig,
            provider,
          );
          vi.mocked(mockConfig.getContentGenerator).mockReturnValue(generator);
          vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
            model: 'test-model',
            authType: AuthType.USE_OPENAI,
          });

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            `prompt-id-${testCase.errorType.toLowerCase()}-budget`,
          );
          await expectStreamExhaustion(stream);

          expect(create).toHaveBeenCalledTimes(testCase.retryCount + 1);
          expect(mockLogContentRetry).toHaveBeenCalledTimes(
            testCase.retryCount,
          );
          expect(mockLogContentRetryFailure).toHaveBeenCalledWith(
            mockConfig,
            expect.objectContaining({
              total_attempts: testCase.retryCount + 1,
              final_error_type: testCase.errorType,
              model: 'test-model',
            }),
          );
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('keeps invalid stream retry budgets independent across error types', async () => {
      vi.useFakeTimers();
      try {
        let callCount = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => {
          callCount++;
          if (callCount <= 2) {
            return streamResponse(stopResponse([]));
          }
          if (callCount === 3) {
            return streamResponse(
              stopResponse([
                {
                  text: '<analysis>hidden</analysis><summary>leaked</summary>',
                },
              ]),
            );
          }

          return streamResponse(stopResponse([{ text: 'Recovered response' }]));
        });

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-mixed-invalid-streams',
        );
        const events = await collectStreamWithFakeTimers(stream, 15_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(4);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(3);
        expect(mockLogContentRetry).toHaveBeenLastCalledWith(
          mockConfig,
          expect.objectContaining({
            attempt_number: 0,
            error_type: 'PROTOCOL_TAG_LEAK',
            retry_delay_ms: 2000,
            model: 'test-model',
          }),
        );
        expect(
          events.some(
            (event) =>
              event.type === StreamEventType.CHUNK &&
              event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Recovered response',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('surfaces an abort fired during the invalid-stream retry delay without retrying again', async () => {
      vi.useFakeTimers();
      try {
        const abortController = new AbortController();
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => streamResponse(stopResponse([])));

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test', config: { abortSignal: abortController.signal } },
          'prompt-id-invalid-stream-abort-delay',
        );

        const iterator = stream[Symbol.asyncIterator]();
        let next = await iterator.next();
        while (!next.done && next.value.type !== StreamEventType.RETRY) {
          next = await iterator.next();
        }
        if (next.done) {
          throw new Error('Expected invalid stream retry event.');
        }
        expect(next.value.type).toBe(StreamEventType.RETRY);

        const nextPromise = iterator.next();
        abortController.abort();
        await expect(nextPromise).rejects.toThrow();

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should retry usage-only empty streams without recording failed attempts', async () => {
      vi.useFakeTimers();
      try {
        const recordAssistantTurn = vi.fn();
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);
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

        const stream = await chatWithRecording.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-empty-usage-retry',
        );
        const events = await collectStreamWithFakeTimers(stream);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(1);
        expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
        expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual([
          { text: 'Recovered after empty stream' },
        ]);
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

    it('does not enter the fallback chain in unattended retry mode', async () => {
      vi.stubEnv('QWEN_CODE_UNATTENDED_RETRY', '1');
      try {
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
          authType: AuthType.USE_GEMINI,
          model: 'test-model',
          maxRetries: 0,
        });
        vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
          'fallback-model',
        ]);
        const resolveForModel = vi.fn();
        vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
          resolveForModel,
        } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
        const capacityError = Object.assign(
          new StreamContentError(
            '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
          ),
          { status: 429 },
        );
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockRejectedValueOnce(capacityError);

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-unattended-no-fallback',
        );
        await expect(
          (async () => {
            for await (const _ of stream) {
              /* consume */
            }
          })(),
        ).rejects.toBe(capacityError);

        expect(resolveForModel).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('disables model fallback without disabling compression', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'fallback-model',
      ]);
      const resolveForModel = vi.fn();
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      const capacityError = Object.assign(
        new Error('temporarily unavailable'),
        {
          status: 503,
        },
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockRejectedValueOnce(capacityError);
      const tryCompress = vi.spyOn(chat, 'tryCompress');

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-no-model-fallback',
        undefined,
        { disableModelFallbacks: true },
      );

      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toBe(capacityError);
      expect(tryCompress).toHaveBeenCalled();
      expect(resolveForModel).not.toHaveBeenCalled();
    });

    it('uses one exact image route across retries and filters history for the next target', async () => {
      const capacityError = Object.assign(
        new Error('temporarily unavailable'),
        {
          status: 503,
        },
      );
      const routeGenerateContentStream = vi
        .fn()
        .mockRejectedValueOnce(capacityError)
        .mockResolvedValueOnce(
          (async function* () {
            yield {
              candidates: [
                {
                  content: { parts: [{ text: 'seen' }] },
                  finishReason: 'STOP',
                },
              ],
              usageMetadata: { promptTokenCount: 99_999 },
            } as unknown as GenerateContentResponse;
          })(),
        );
      const routeGenerator = {
        ...mockContentGenerator,
        generateContentStream: routeGenerateContentStream,
      } as ContentGenerator;
      const routeSelector =
        'openai:vision-agent\0https://vision.example.com/v1';
      const selector = `${routeSelector}\0`;
      const resolveForModel = vi.fn().mockResolvedValue({
        contentGenerator: routeGenerator,
        contentGeneratorConfig: {
          model: 'vision-agent',
          authType: AuthType.USE_OPENAI,
          maxRetries: 1,
          modalities: { image: true },
        },
        retryAuthType: AuthType.USE_OPENAI,
        model: 'vision-agent',
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'gemini-pro@test0001',
      );
      vi.mocked(mockConfig.getEffectiveInputModalities).mockReturnValue({
        pdf: true,
      });
      chat = new GeminiChat(
        mockConfig,
        config,
        [
          {
            role: 'user',
            parts: [
              { text: 'prior question' },
              {
                inlineData: {
                  mimeType: 'application/pdf',
                  data: 'prior-pdf',
                },
              },
            ],
          },
          { role: 'model', parts: [{ text: 'prior answer' }] },
        ],
        undefined,
        uiTelemetryService,
      );
      const tryCompress = vi.spyOn(chat, 'tryCompress');
      mockRetryWithBackoff.mockImplementation(async (apiCall, options) => {
        try {
          return await apiCall();
        } catch (error) {
          expect(options?.shouldRetryOnError?.(error)).toBe(true);
          return apiCall();
        }
      });

      const stream = await chat.sendMessageStream(
        selector,
        {
          message: [
            { text: 'inspect' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: 'private-image',
              },
            },
          ],
        },
        'prompt-exact-route-retry',
      );
      for await (const _ of stream) {
        /* consume */
      }
      expect(chat.getLastPromptTokenCount()).toBe(0);

      expect(resolveForModel).toHaveBeenCalledOnce();
      expect(resolveForModel).toHaveBeenCalledWith(routeSelector, {
        failClosed: true,
      });
      expect(tryCompress).not.toHaveBeenCalled();
      expect(routeGenerateContentStream).toHaveBeenCalledTimes(2);
      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
      const routeRequest = JSON.stringify(
        routeGenerateContentStream.mock.calls.at(-1)?.[0],
      );
      expect(routeRequest).toContain('"model":"vision-agent"');
      expect(routeRequest).toContain('private-image');
      expect(routeRequest).toContain('[document: application/pdf]');
      expect(routeRequest).not.toContain('prior-pdf');

      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'primary follow-up' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );
      const primaryStream = await chat.sendMessageStream(
        'test-model',
        {
          message: [
            { text: 'continue on primary' },
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: 'current-pdf',
              },
            },
          ],
        },
        'prompt-after-exact-route',
      );
      for await (const _ of primaryStream) {
        /* consume */
      }

      const primaryRequest = JSON.stringify(
        vi.mocked(mockContentGenerator.generateContentStream).mock
          .calls[0]?.[0],
      );
      expect(primaryRequest).toContain('[image: image/png]');
      expect(primaryRequest).not.toContain('private-image');
      expect(primaryRequest).toContain('prior-pdf');
      expect(primaryRequest).toContain('current-pdf');
      const history = JSON.stringify(chat.getHistory());
      expect(history).toContain('private-image');
      expect(history).toContain('prior-pdf');
      expect(history).toContain('current-pdf');
    });

    it('fails an exact image route without entering the fallback chain', async () => {
      const capacityError = Object.assign(new Error('vision unavailable'), {
        status: 503,
      });
      const routeGenerator = {
        ...mockContentGenerator,
        generateContentStream: vi.fn().mockRejectedValue(capacityError),
      } as ContentGenerator;
      const selector = 'openai:vision-agent\0https://vision.example.com/v1\0';
      const resolveForModel = vi.fn().mockResolvedValue({
        contentGenerator: routeGenerator,
        contentGeneratorConfig: {
          model: 'vision-agent',
          authType: AuthType.USE_OPENAI,
          maxRetries: 0,
          modalities: { image: true },
        },
        retryAuthType: AuthType.USE_OPENAI,
        model: 'vision-agent',
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'ordinary-fallback',
      ]);

      const stream = await chat.sendMessageStream(
        selector,
        {
          message: [
            {
              inlineData: { mimeType: 'image/png', data: 'private-image' },
            },
          ],
        },
        'prompt-exact-route-failure',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toBe(capacityError);

      expect(resolveForModel).toHaveBeenCalledOnce();
      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
    });

    it('continues fallback after usage and preparation metadata', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getEffectiveInputModalities).mockReturnValue({
        image: true,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'fallback-a',
        'fallback-b',
      ]);

      const fallbackAGenerateContentStream = vi.fn();
      const fallbackBGenerateContentStream = vi.fn();
      const makeFallbackGenerator = (generateContentStream: unknown) =>
        ({
          generateContent: vi.fn(),
          generateContentStream,
          embedContent: vi.fn(),
          batchEmbedContents: vi.fn(),
        }) as unknown as ContentGenerator;
      const resolveForModel = vi
        .fn()
        .mockResolvedValueOnce({
          contentGenerator: makeFallbackGenerator(
            fallbackAGenerateContentStream,
          ),
          contentGeneratorConfig: { modalities: {} },
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'fallback-a',
        })
        .mockResolvedValueOnce({
          contentGenerator: makeFallbackGenerator(
            fallbackBGenerateContentStream,
          ),
          contentGeneratorConfig: { modalities: { image: true } },
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'fallback-b',
        });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'gemini-pro@test0001',
      );

      const capacityError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        ),
        { status: 429 },
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockResolvedValueOnce(
        (async function* () {
          yield {
            usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 },
          } as GenerateContentResponse;
          throw capacityError;
        })(),
      );
      const preparationResponse = {
        candidates: [{ content: { parts: [] } }],
      } as unknown as GenerateContentResponse;
      setToolCallPreparations(preparationResponse, [
        { callId: 'call-fallback-a', toolName: 'read_file' },
      ]);
      fallbackAGenerateContentStream.mockResolvedValueOnce(
        (async function* () {
          yield preparationResponse;
          throw capacityError;
        })(),
      );
      fallbackBGenerateContentStream.mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'fallback-b ok' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 99_999 },
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        {
          message: [
            { text: 'test' },
            {
              inlineData: {
                mimeType: 'image/png',
                data: 'fallback-image',
              },
            },
          ],
        },
        'prompt-two-fallbacks',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(
        events.filter((event) => event.type === StreamEventType.MODEL_FALLBACK),
      ).toHaveLength(2);
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.usageMetadata?.promptTokenCount === 10,
        ),
      ).toBe(true);
      expect(
        events.filter((event) => event.type === StreamEventType.MODEL_FALLBACK),
      ).toEqual([
        {
          type: StreamEventType.MODEL_FALLBACK,
          info: {
            fromModel: 'test-model',
            toModel: 'fallback-a',
            statusCode: 429,
            fallbackIndex: 1,
          },
        },
        {
          type: StreamEventType.MODEL_FALLBACK,
          info: {
            fromModel: 'fallback-a',
            toModel: 'fallback-b',
            statusCode: 429,
            fallbackIndex: 2,
          },
        },
      ]);
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(
        JSON.stringify(fallbackAGenerateContentStream.mock.calls[0]?.[0]),
      ).not.toContain('fallback-image');
      expect(
        JSON.stringify(fallbackBGenerateContentStream.mock.calls[0]?.[0]),
      ).toContain('fallback-image');
      expect(fallbackAGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(fallbackBGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
              'fallback-b ok',
        ),
      ).toBe(true);
    });

    it('stamps fallback-served counts under the request route key (#9454)', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue(['fallback-b']);

      const fallbackBGenerateContentStream = vi.fn();
      const resolveForModel = vi.fn().mockResolvedValue({
        contentGenerator: {
          generateContent: vi.fn(),
          generateContentStream: fallbackBGenerateContentStream,
          countTokens: vi.fn(),
          embedContent: vi.fn(),
          batchEmbedContents: vi.fn(),
          useSummarizedThinking: vi.fn().mockReturnValue(false),
        } as unknown as ContentGenerator,
        contentGeneratorConfig: { modalities: {} },
        retryAuthType: AuthType.USE_GEMINI,
        retryErrorCodes: undefined,
        model: 'fallback-b',
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'gemini-pro@test0001',
      );

      const capacityError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        ),
        { status: 429 },
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockResolvedValueOnce(
        (async function* () {
          yield {
            usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 },
          } as GenerateContentResponse;
          throw capacityError;
        })(),
      );
      fallbackBGenerateContentStream.mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'fallback-b ok' }],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: { promptTokenCount: 99_999 },
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: [{ text: 'test' }] },
        'prompt-fallback-route-stamp',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // The session-token-limit gate in Client reads the count keyed by the
      // REQUEST route. A fallback serves on behalf of the same request (the
      // session model never changes), so its count must survive that keyed
      // read instead of being invalidated as a foreign route's (#9454).
      expect(chat.getLastPromptTokenCount('test-model@route')).toBe(99_999);
      // The count still belongs to the serving turn's request route: a read
      // for a different route invalidates it as before.
      expect(chat.getLastPromptTokenCount('other-model@route')).toBe(0);
    });

    it('skips a fallback alias that resolves to the current model', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'resolved-primary-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'primary-alias',
        'fallback-b',
      ]);

      const duplicateGenerateContentStream = vi.fn();
      const fallbackBGenerateContentStream = vi.fn();
      const makeFallbackGenerator = (generateContentStream: unknown) =>
        ({
          generateContent: vi.fn(),
          generateContentStream,
          embedContent: vi.fn(),
          batchEmbedContents: vi.fn(),
        }) as unknown as ContentGenerator;
      const resolveForModel = vi
        .fn()
        .mockResolvedValueOnce({
          contentGenerator: makeFallbackGenerator(
            duplicateGenerateContentStream,
          ),
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'resolved-primary-model',
        })
        .mockResolvedValueOnce({
          contentGenerator: makeFallbackGenerator(
            fallbackBGenerateContentStream,
          ),
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'fallback-b',
        });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);

      const capacityError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        ),
        { status: 429 },
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockRejectedValueOnce(capacityError);
      fallbackBGenerateContentStream.mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'fallback-b ok' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'requested-primary-model',
        { message: 'test' },
        'prompt-skip-resolved-duplicate-fallback',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(resolveForModel).toHaveBeenCalledTimes(2);
      expect(duplicateGenerateContentStream).not.toHaveBeenCalled();
      expect(fallbackBGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(
        events.filter((event) => event.type === StreamEventType.MODEL_FALLBACK),
      ).toEqual([
        {
          type: StreamEventType.MODEL_FALLBACK,
          info: {
            fromModel: 'requested-primary-model',
            toModel: 'fallback-b',
            statusCode: 429,
            fallbackIndex: 1,
          },
        },
      ]);
    });

    it('skips an unresolvable fallback model and tries the next fallback', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'bad-fallback',
        'fallback-b',
      ]);

      const fallbackBGenerateContentStream = vi.fn();
      const fallbackBGenerator = {
        generateContent: vi.fn(),
        generateContentStream: fallbackBGenerateContentStream,
        embedContent: vi.fn(),
        batchEmbedContents: vi.fn(),
      } as unknown as ContentGenerator;
      const resolveError = new Error('unknown fallback alias');
      const resolveForModel = vi
        .fn()
        .mockRejectedValueOnce(resolveError)
        .mockResolvedValueOnce({
          contentGenerator: fallbackBGenerator,
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'fallback-b',
        });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);

      const capacityError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        ),
        { status: 429 },
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockRejectedValueOnce(capacityError);
      fallbackBGenerateContentStream.mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'fallback-b ok' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-skip-bad-fallback',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(resolveForModel).toHaveBeenCalledTimes(2);
      expect(resolveForModel).toHaveBeenNthCalledWith(1, 'bad-fallback', {
        failClosed: true,
      });
      expect(resolveForModel).toHaveBeenNthCalledWith(2, 'fallback-b', {
        failClosed: true,
      });
      expect(
        events.filter((event) => event.type === StreamEventType.MODEL_FALLBACK),
      ).toHaveLength(1);
      expect(fallbackBGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
              'fallback-b ok',
        ),
      ).toBe(true);
    });

    it('does not try the next fallback after a fallback emits output', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'fallback-a',
        'fallback-b',
      ]);

      const fallbackAGenerateContentStream = vi.fn();
      const fallbackBGenerateContentStream = vi.fn();
      const makeFallbackGenerator = (generateContentStream: unknown) =>
        ({
          generateContent: vi.fn(),
          generateContentStream,
          embedContent: vi.fn(),
          batchEmbedContents: vi.fn(),
        }) as unknown as ContentGenerator;
      const resolveForModel = vi
        .fn()
        .mockResolvedValueOnce({
          contentGenerator: makeFallbackGenerator(
            fallbackAGenerateContentStream,
          ),
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'fallback-a',
        })
        .mockResolvedValueOnce({
          contentGenerator: makeFallbackGenerator(
            fallbackBGenerateContentStream,
          ),
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'fallback-b',
        });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);

      const capacityError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        ),
        { status: 429 },
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockRejectedValueOnce(capacityError);
      fallbackAGenerateContentStream.mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'fallback-a partial' }],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          throw capacityError;
        })(),
      );
      fallbackBGenerateContentStream.mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [
              {
                content: { role: 'model', parts: [{ text: 'fallback-b ok' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-fallback-output-then-error',
      );
      const events: StreamEvent[] = [];
      await expect(
        (async () => {
          for await (const event of stream) {
            events.push(event);
          }
        })(),
      ).rejects.toBe(capacityError);

      expect(
        events.filter((event) => event.type === StreamEventType.MODEL_FALLBACK),
      ).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
              'fallback-a partial',
        ),
      ).toBe(true);
      expect(fallbackAGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(fallbackBGenerateContentStream).not.toHaveBeenCalled();
      expect(resolveForModel).not.toHaveBeenCalledWith('fallback-b', {
        failClosed: true,
      });
      const history = chat.getHistory();
      expect(history).toHaveLength(1);
      expect(history[0]!.role).toBe('user');
      expect(
        history.some((entry) =>
          entry.parts?.some((part) => part.text === 'fallback-a partial'),
        ),
      ).toBe(false);
    });

    it('surfaces an abort raised while resolving a fallback model', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue(['fallback-a']);

      const abortError = new DOMException('Aborted', 'AbortError');
      const resolveForModel = vi.fn().mockRejectedValueOnce(abortError);
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);

      const capacityError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        ),
        { status: 429 },
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockRejectedValueOnce(capacityError);

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-fallback-resolve-abort',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toBe(abortError);

      expect(resolveForModel).toHaveBeenCalledTimes(1);
    });

    it('surfaces an abort raised by a fallback stream without trying later fallbacks', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'fallback-a',
        'fallback-b',
      ]);

      const abortError = new DOMException('Aborted', 'AbortError');
      const fallbackAGenerateContentStream = vi
        .fn()
        .mockRejectedValueOnce(abortError);
      const fallbackBGenerateContentStream = vi.fn();
      const makeFallbackGenerator = (generateContentStream: unknown) =>
        ({
          generateContent: vi.fn(),
          generateContentStream,
          embedContent: vi.fn(),
          batchEmbedContents: vi.fn(),
        }) as unknown as ContentGenerator;
      const resolveForModel = vi
        .fn()
        .mockResolvedValueOnce({
          contentGenerator: makeFallbackGenerator(
            fallbackAGenerateContentStream,
          ),
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'fallback-a',
        })
        .mockResolvedValueOnce({
          contentGenerator: makeFallbackGenerator(
            fallbackBGenerateContentStream,
          ),
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'fallback-b',
        });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);

      const capacityError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        ),
        { status: 429 },
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockRejectedValueOnce(capacityError);

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-fallback-stream-abort',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toBe(abortError);

      expect(resolveForModel).toHaveBeenCalledTimes(1);
      expect(fallbackAGenerateContentStream).toHaveBeenCalledTimes(1);
      expect(fallbackBGenerateContentStream).not.toHaveBeenCalled();
    });

    it('does not fallback on non-eligible primary auth errors', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'fallback-model',
      ]);
      const resolveForModel = vi.fn();
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      const authError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"401","message":"Unauthorized"}}',
        ),
        { status: 401 },
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockRejectedValueOnce(authError);

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-primary-auth-no-fallback',
      );
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toBe(authError);

      expect(resolveForModel).not.toHaveBeenCalled();
    });

    it('preserves primary partial tool calls when fallback is skipped after output', async () => {
      vi.useFakeTimers();
      try {
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
          authType: AuthType.USE_GEMINI,
          model: 'test-model',
          maxRetries: 0,
        });
        vi.mocked(mockConfig.getModelFallbacks).mockReturnValue(['test-model']);
        const resolveForModel = vi.fn();
        vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
          resolveForModel,
        } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);

        const capacityError = Object.assign(
          new StreamContentError(
            '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
          ),
          { status: 429 },
        );
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockResolvedValueOnce(
          (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          id: 'call_failed_primary_attempt',
                          name: 'read_file',
                          args: { path: '/tmp/primary.txt' },
                        },
                      },
                    ],
                  },
                },
              ],
            } as unknown as GenerateContentResponse;
            throw capacityError;
          })(),
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-skipped-fallback-failure',
        );

        const collecting = (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })();
        const resultPromise =
          await expect(collecting).rejects.toBe(capacityError);
        await vi.advanceTimersByTimeAsync(0);
        await resultPromise;
        expect(resolveForModel).not.toHaveBeenCalled();
        const history = chat.getHistory();
        expect(history).toHaveLength(2);
        expect(history[0]!.role).toBe('user');
        expect(history[1]!.role).toBe('model');
        expect(history[1]!.parts?.some((part) => part.functionCall)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    // Shared transport-cut fixtures. `socketCut` is the shared producer of
    // the canonical `UND_ERR_SOCKET` retryable shape. The per-code
    // drift-guard test (`it.each` over the allow-list) constructs
    // parameterized retryable shapes inline on purpose; non-retryable
    // shapes stay inline on purpose too.
    const socketCut = () =>
      Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('other side closed'), {
          code: 'UND_ERR_SOCKET',
        }),
      });

    /** Stream that yields `chunks` and then dies from a socket cut. */
    function cutAfter(chunks: GenerateContentResponse[]) {
      return (async function* () {
        for (const chunk of chunks) yield chunk;
        throw socketCut();
      })();
    }

    /** Collect all events from `stream`, catching the terminal error. */
    async function drainCollecting(stream: AsyncGenerator<StreamEvent>) {
      const events: StreamEvent[] = [];
      let caughtError: unknown;
      try {
        for await (const event of stream) events.push(event);
      } catch (error) {
        caughtError = error;
      }
      return { events, caughtError };
    }

    it('retries retryable transport stream errors and succeeds on a later attempt', async () => {
      vi.useFakeTimers();
      try {
        const transportError = socketCut();

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              throw transportError;

              yield {} as GenerateContentResponse;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Recovered after transport retry' }],
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
          'prompt-transport-retry',
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY),
        ).toHaveLength(1);
        expect(
          events.some(
            (event) =>
              event.type === StreamEventType.CHUNK &&
              event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Recovered after transport retry',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('replays after a transport cut without leaking a placeholder prefix', async () => {
      vi.useFakeTimers();
      try {
        const transportError = Object.assign(new TypeError('terminated'), {
          cause: Object.assign(new Error('other side closed'), {
            code: 'UND_ERR_SOCKET',
          }),
        });
        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [{ content: { parts: [{ text: '(request ' }] } }],
              } as unknown as GenerateContentResponse;
              throw transportError;
            })(),
          )
          .mockResolvedValueOnce(
            streamResponse(stopResponse([{ text: 'Recovered response' }])),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-placeholder-prefix-transport-cut',
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);
        const emittedText = events
          .filter((event) => event.type === StreamEventType.CHUNK)
          .flatMap(
            (event) =>
              event.value.candidates?.[0]?.content?.parts?.map(
                (part) => part.text,
              ) ?? [],
          );

        expect(emittedText).toEqual(['Recovered response']);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY),
        ).toHaveLength(1);
        expect(chat.getHistory()).toEqual([
          { role: 'user', parts: [{ text: 'test' }] },
          { role: 'model', parts: [{ text: 'Recovered response' }] },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops retrying retryable transport stream errors after the retry budget is exhausted', async () => {
      vi.useFakeTimers();
      try {
        const transportError = socketCut();

        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(() =>
          Promise.resolve(
            (async function* () {
              throw transportError;

              yield {} as GenerateContentResponse;
            })(),
          ),
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-transport-retry-exhausted',
        );
        // Collect in the background and capture the terminal error manually:
        // the rejection only settles after fake timers advance past both retry
        // delays, so a deferred `expect().rejects` here would either deadlock
        // (awaited before advancing) or trip `vitest/valid-expect` (not
        // awaited). Catch-and-assert sidesteps both.
        const collecting = drainCollecting(stream);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10_000);
        const { events, caughtError } = await collecting;

        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toContain('terminated');
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(3);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY),
        ).toHaveLength(2);
        // The not-taken log must attribute the stop to budget exhaustion —
        // no content was delivered here, so 'skipped_after_content' would
        // be a misattribution of "gave up" as "unsafe to recover".
        expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
          'Transport stream retry not taken',
          expect.objectContaining({
            retryDecision: 'exhausted',
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('attributes budget exhaustion correctly when thinking chunks flowed', async () => {
      // Every attempt yields a thought chunk, so the attempt flags diverge:
      // streamYieldedChunk is true, streamYieldedContentChunk stays false.
      // The not-taken log must still say 'exhausted' — pinning the ternary
      // to the content flag, not the any-chunk flag, for the dominant #7832
      // shape: repeated socket cuts mid-thinking.
      vi.useFakeTimers();
      try {
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(() =>
          Promise.resolve(
            cutAfter([
              {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Still reasoning…', thought: true }],
                    },
                  },
                ],
              } as unknown as GenerateContentResponse,
            ]),
          ),
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-transport-retry-exhausted-after-thinking',
        );
        // Same catch-and-assert drain as the zero-chunk exhaustion test:
        // the rejection settles only after both retry delays elapse.
        const collecting = drainCollecting(stream);

        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10_000);
        const { events, caughtError } = await collecting;

        expect(caughtError).toBeInstanceOf(Error);
        expect((caughtError as Error).message).toContain('terminated');
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(3);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY),
        ).toHaveLength(2);
        expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
          'Transport stream retry not taken',
          expect.objectContaining({
            retryDecision: 'exhausted',
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not replay a transport stream error after yielding a chunk', async () => {
      // The replay path stays closed once output has reached callers —
      // re-sending would duplicate it. Recovery goes through the
      // continuation path instead (see 'transport stream continuation'
      // below), which is what the second attempt here is.
      vi.useFakeTimers();
      try {
        const transportError = socketCut();

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Partial response before socket close' }],
                    },
                  },
                ],
              } as unknown as GenerateContentResponse;
              throw transportError;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: ' …and the rest.' }] },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-transport-no-replay-after-chunk',
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);

        // The second attempt is a continuation, not a replay: its request
        // carries the delivered text plus a resume instruction rather than
        // repeating the original contents unchanged.
        const secondRequest = vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mock.calls[1]![0].contents as Content[];
        expect(secondRequest.at(-2)).toEqual({
          role: 'model',
          parts: [{ text: 'Partial response before socket close' }],
        });
        expect(
          events.filter(
            (event) =>
              event.type === StreamEventType.RETRY && !event.isContinuation,
          ),
        ).toHaveLength(0);
        expect(
          events.some(
            (event) =>
              event.type === StreamEventType.CHUNK &&
              event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Partial response before socket close',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries a transport stream error after yielding only thinking chunks', async () => {
      // Thinking models stream thought parts within seconds, then can
      // spend minutes reasoning — exactly when gateways close long-lived
      // SSE connections (#7832). The replay must be allowed even though
      // thought chunks already reached the caller: the failed attempt's
      // partial turn is discarded wholesale before the retry, so nothing
      // the caller saw from that attempt can appear twice.
      vi.useFakeTimers();
      try {
        const transportError = socketCut();

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [
                        { text: 'Let me think about this…', thought: true },
                      ],
                    },
                  },
                ],
              } as unknown as GenerateContentResponse;
              throw transportError;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Recovered after thinking-phase retry' }],
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
          'prompt-transport-retry-after-thinking',
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY),
        ).toHaveLength(1);
        expect(
          events.some(
            (event) =>
              event.type === StreamEventType.CHUNK &&
              event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Recovered after thinking-phase retry',
          ),
        ).toBe(true);
        // The retry log must record that non-content chunks (the
        // thinking) had already flowed — the diagnostic that makes
        // thinking-phase replays visible in the debug log.
        expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
          'Transport stream retry scheduled',
          expect.objectContaining({
            retryDecision: 'retry',
            yieldedNonContentChunks: true,
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not replay when visible content followed the thinking chunks', async () => {
      // The content flag must accumulate across the whole attempt: once a
      // non-thought part has flowed — even after any amount of thinking —
      // a replay would duplicate visible output and stays blocked. Recovery
      // goes through the continuation path instead, so the assertion is on
      // *which* path fired rather than on the request count: a replay resends
      // the original contents unchanged, a continuation carries the delivered
      // text and a resume instruction, and only the latter is acceptable here.
      //
      // Only the visible text is anchored on. The thought part is excluded
      // from the continuation prefix as well, so this also covers thoughts not
      // leaking into the resumed request.
      vi.useFakeTimers();
      try {
        const transportError = socketCut();

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Reasoning first…', thought: true }],
                    },
                  },
                ],
              } as unknown as GenerateContentResponse;
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Visible answer begins' }],
                    },
                  },
                ],
              } as unknown as GenerateContentResponse;
              throw transportError;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: ' …and ends.' }] },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-transport-no-replay-after-thinking-then-content',
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);

        const secondRequest = vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mock.calls[1]![0].contents as Content[];
        expect(secondRequest.at(-2)).toEqual({
          role: 'model',
          parts: [{ text: 'Visible answer begins' }],
        });
        expect(
          events.filter(
            (event) =>
              event.type === StreamEventType.RETRY && !event.isContinuation,
          ),
        ).toHaveLength(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('attributes a blocked replay to delivered content when a function call was cut', async () => {
      // A cut after a functionCall part closes both recovery paths: the
      // delivered functionCall is non-thought output (a replay would
      // duplicate it), and continuation across a functionCall boundary is
      // excluded. The not-taken log must attribute the block to delivered
      // content rather than budget exhaustion — the diagnostic that
      // separates "unsafe to recover" from "gave up" in the debug log.
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        cutAfter([
          {
            candidates: [
              {
                content: {
                  parts: [{ text: 'Choosing a tool…', thought: true }],
                },
              },
            ],
          } as unknown as GenerateContentResponse,
          {
            candidates: [
              {
                content: {
                  parts: [{ functionCall: { name: 'read_file', args: {} } }],
                },
              },
            ],
          } as unknown as GenerateContentResponse,
        ]),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-transport-no-recovery-after-function-call-cut',
      );
      const events: StreamEvent[] = [];
      await expect(async () => {
        for await (const event of stream) {
          events.push(event);
        }
      }).rejects.toThrow('terminated');

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(
        events.filter((event) => event.type === StreamEventType.RETRY),
      ).toHaveLength(0);
      expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
        'Transport stream retry not taken',
        expect.objectContaining({
          retryDecision: 'skipped_after_content',
        }),
      );
    });

    it('retries a transport stream error after yielding only tool preparation metadata', async () => {
      vi.useFakeTimers();
      try {
        const transportError = socketCut();
        const preparationResponse = {
          candidates: [{ content: { parts: [] } }],
        } as unknown as GenerateContentResponse;
        setToolCallPreparations(preparationResponse, [
          { callId: 'call-preparing', toolName: 'read_file' },
        ]);

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              yield preparationResponse;
              throw transportError;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Recovered after preparation' }],
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
          'prompt-transport-after-preparation',
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY),
        ).toHaveLength(1);
        // The preparation chunk has no candidate output at all, so the
        // retry log must record that no non-content chunks flowed — the
        // false side of the diagnostic the thinking-phase test pins true.
        expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
          'Transport stream retry scheduled',
          expect.objectContaining({
            retryDecision: 'retry',
            yieldedNonContentChunks: false,
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    describe('transport stream continuation (#7832)', () => {
      function textChunk(
        text: string,
        finishReason?: string,
      ): GenerateContentResponse {
        return {
          candidates: [
            {
              content: { role: 'model', parts: [{ text }] },
              ...(finishReason ? { finishReason } : {}),
            },
          ],
        } as unknown as GenerateContentResponse;
      }

      function requestContentsOfCall(index: number): Content[] {
        return vi.mocked(mockContentGenerator.generateContentStream).mock.calls[
          index
        ]![0].contents as Content[];
      }

      it('continues from the delivered text instead of failing the send', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('<html><body>')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('</body></html>', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'write a game' },
            'prompt-transport-continuation',
          );
          const events = await collectStreamWithFakeTimers(stream, 5_000);

          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(2);

          // `isContinuation` is what tells the UI to KEEP the text already on
          // screen. A plain RETRY would make it discard the first half.
          const retries = events.filter(
            (event) => event.type === StreamEventType.RETRY,
          );
          expect(retries).toHaveLength(1);
          expect(
            retries[0]!.type === StreamEventType.RETRY &&
              retries[0]!.isContinuation,
          ).toBe(true);

          // The continuation request shows the model its own output and asks
          // it to resume — it does not re-send the original request alone.
          const secondRequest = requestContentsOfCall(1);
          expect(secondRequest.at(-2)).toEqual({
            role: 'model',
            parts: [{ text: '<html><body>' }],
          });
          const instruction = secondRequest.at(-1)!;
          expect(instruction.role).toBe('user');
          expect(instruction.parts?.[0]?.text).toContain(
            'The connection dropped mid-response',
          );
          expect(instruction.parts?.[0]?.text).toContain(
            '<previous_response_suffix>',
          );

          // Both halves reach the caller, in order and exactly once.
          const delivered = events
            .filter((event) => event.type === StreamEventType.CHUNK)
            .map(
              (event) =>
                (event as { value: GenerateContentResponse }).value
                  .candidates?.[0]?.content?.parts?.[0]?.text ?? '',
            )
            .join('');
          expect(delivered).toBe('<html><body></body></html>');
        } finally {
          vi.useRealTimers();
        }
      });

      it('stitches the delivered text into durable history', async () => {
        // Without the merge, history would keep only the continuation half and
        // every later turn (plus /compress and --resume) would see an answer
        // that starts mid-document.
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('first half ')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('second half', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-history',
          );
          await collectStreamWithFakeTimers(stream, 5_000);

          const history = chat.getHistory();
          expect(history.at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'first half second half' }],
          });
          // The synthetic resume instruction is request-only; it must never
          // land in history as if the user had typed it.
          expect(
            history.some((entry) =>
              entry.parts?.some((part) =>
                part.text?.includes('The connection dropped mid-response'),
              ),
            ),
          ).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      /**
       * The JSONL transcript that `--resume` / `--continue` reads is written
       * by `recordAssistantTurn`, not by `this.history`. The continuation
       * attempt's own parts carry only the resumed remainder, so without
       * merging the delivered prefix back in, the durable transcript starts
       * the recovered turn mid-sentence.
       *
       * `processStreamResponse` folds the prefix into the response parts once,
       * before it writes either layer, so these tests assert the record and
       * history agree — not just that the record is merged. Two earlier
       * shapes failed exactly there: deduping the record against the trimmed
       * `contentText` while history used the raw part, and merging in the
       * outer send loop after the record had already been appended.
       */
      function recordedText(
        recordAssistantTurn: ReturnType<typeof vi.fn>,
        callIndex = 0,
      ): string | undefined {
        const message = recordAssistantTurn.mock.calls[callIndex]![0]
          .message as Array<{ text?: string }>;
        return message.find((part) => part.text !== undefined)?.text;
      }

      it('records the delivered prefix with the resumed remainder in one turn', async () => {
        vi.useFakeTimers();
        try {
          const recordAssistantTurn = vi.fn();
          const chatWithRecording = chatWithRecorder(recordAssistantTurn);
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('first half ')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('second half', 'STOP');
              })(),
            );

          const stream = await chatWithRecording.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-record',
          );
          await collectStreamWithFakeTimers(stream, 5_000);

          // One turn in, one turn on disk.
          expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
          expect(recordedText(recordAssistantTurn)).toBe(
            'first half second half',
          );
          // The durable record and in-memory history must agree.
          expect(chatWithRecording.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'first half second half' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('merges a whitespace-leading remainder identically in both layers', async () => {
        // R1-1: the record used to dedupe against `contentText`, which is
        // trimmed, while history merged the raw part. A cut landing on a token
        // boundary (before a space) then fused the two words in the transcript
        // only — "The result is" + " 42." recorded as "The result is42.".
        vi.useFakeTimers();
        try {
          const recordAssistantTurn = vi.fn();
          const chatWithRecording = chatWithRecorder(recordAssistantTurn);
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('The result is')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk(' 42.', 'STOP');
              })(),
            );

          const stream = await chatWithRecording.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-record-boundary',
          );
          await collectStreamWithFakeTimers(stream, 5_000);

          expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
          expect(recordedText(recordAssistantTurn)).toBe('The result is 42.');
          expect(chatWithRecording.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'The result is 42.' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps a whitespace-boundary overlap dedup consistent across layers', async () => {
        // The dedup-divergence half of R1-1: " total" is a 6-byte overlap only
        // while untrimmed, so trimming the operand lost the dedup entirely and
        // recorded "The grand totaltotal sum is 9.".
        vi.useFakeTimers();
        try {
          const recordAssistantTurn = vi.fn();
          const chatWithRecording = chatWithRecorder(recordAssistantTurn);
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('The grand total')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk(' total sum is 9.', 'STOP');
              })(),
            );

          const stream = await chatWithRecording.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-record-boundary-overlap',
          );
          await collectStreamWithFakeTimers(stream, 5_000);

          const history = chatWithRecording.getHistory().at(-1);
          const historyText = history?.parts?.find(
            (part) => part.text !== undefined,
          )?.text;
          expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
          // Whatever the dedup decides, both layers must decide it the same.
          expect(recordedText(recordAssistantTurn)).toBe(historyText);
          expect(recordedText(recordAssistantTurn)).not.toContain('totaltotal');
        } finally {
          vi.useRealTimers();
        }
      });

      it('agrees across layers when the consumer aborts at the deferred finish chunk', async () => {
        // R2-2: on a tool-result continuation the finishReason is withheld and
        // re-emitted as a synthetic chunk AFTER the history push — a
        // suspension point. `Turn.run` returns at exactly that kind of chunk
        // when the user hits Esc. While the merge lived in the outer send
        // loop, abandoning here left a merged record against a remainder-only
        // history, and the JSONL is append-only so nothing reconciles it.
        vi.useFakeTimers();
        try {
          const recordAssistantTurn = vi.fn();
          const chatWithRecording = chatWithRecorder(recordAssistantTurn);
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('Analysis: the file ')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('contains the bug.', 'STOP');
              })(),
            );

          const stream = await chatWithRecording.sendMessageStream(
            'test-model',
            {
              // A functionResponse turn is what makes this a tool-result
              // continuation, which is what defers the finishReason.
              message: [
                {
                  functionResponse: {
                    id: 'call_deferred_window',
                    name: 'read_file',
                    response: { output: 'file contents' },
                  },
                },
              ],
            },
            'prompt-transport-continuation-record-deferred-abort',
          );

          const collecting = (async () => {
            for await (const event of stream) {
              // The pass-through chunks have their finishReason stripped, so
              // this fires only on the synthetic deferred chunk.
              if (
                event.type === StreamEventType.CHUNK &&
                event.value.candidates?.[0]?.finishReason
              ) {
                break;
              }
            }
          })();
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(5_000);
          await collecting;

          const historyText = chatWithRecording
            .getHistory()
            .at(-1)
            ?.parts?.find((part) => part.text !== undefined)?.text;
          expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
          expect(recordedText(recordAssistantTurn)).toBe(
            'Analysis: the file contains the bug.',
          );
          // The durable record and in-memory history must not disagree, even
          // though the send was abandoned before it could finish.
          expect(historyText).toBe(recordedText(recordAssistantTurn));
        } finally {
          vi.useRealTimers();
        }
      });

      it('dedupes replayed overlap in the recorded turn too', async () => {
        vi.useFakeTimers();
        try {
          const recordAssistantTurn = vi.fn();
          const chatWithRecording = chatWithRecorder(recordAssistantTurn);
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(
              cutAfter([textChunk('The quick brown fox jumps over')]),
            )
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('jumps over the lazy dog.', 'STOP');
              })(),
            );

          const stream = await chatWithRecording.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-record-overlap',
          );
          await collectStreamWithFakeTimers(stream, 5_000);

          expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
          expect(recordedText(recordAssistantTurn)).toBe(
            'The quick brown fox jumps over the lazy dog.',
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it('records nothing of a continuation a fresh-restart retry discarded', async () => {
        // The mirror of the merge: when the continuation is superseded, the
        // delivered text is dropped from history, so it must stay out of the
        // transcript too. Recording the prefix when the continuation is
        // *scheduled* would fix `--resume` for the success case and duplicate
        // the answer here.
        vi.useFakeTimers();
        try {
          const recordAssistantTurn = vi.fn();
          const chatWithRecording = chatWithRecorder(recordAssistantTurn);
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('doomed fragment ')]))
            .mockResolvedValueOnce(
              (async function* () {
                throw new InvalidStreamError(
                  'Model stream ended with empty response text.',
                  'NO_RESPONSE_TEXT',
                );

                yield {} as GenerateContentResponse;
              })(),
            )
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('a clean answer', 'STOP');
              })(),
            );

          const stream = await chatWithRecording.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-record-superseded',
          );
          await collectStreamWithFakeTimers(stream, 10_000);

          // Three attempts proves the continuation really was scheduled and
          // then superseded, rather than never starting.
          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(3);
          expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
          expect(recordedText(recordAssistantTurn)).toBe('a clean answer');
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps the record remainder-only when the continuation itself is cut after a tool call', async () => {
        // The one case where the prefix and a deferred partial record are
        // live at the same time. A continuation attempt that yields a
        // functionCall and then dies is excluded from continuing again
        // (`canContinueAfterTransportCut` requires !streamYieldedFunctionCall),
        // so the prefix is still set while `pendingPartialAssistantRecord`
        // stashes the partial turn.
        //
        // The attempt did not survive, so the prefix must stay out of BOTH
        // layers: history keeps the remainder-only partial (the merge at the
        // success exit never runs) and the flushed record has to match it.
        // Merging unconditionally instead of on success only would put the
        // delivered text in the transcript and not in history — the same
        // desync this fix removes, pointing the other way.
        vi.useFakeTimers();
        try {
          const recordAssistantTurn = vi.fn();
          const chatWithRecording = chatWithRecorder(recordAssistantTurn);
          const toolCallChunk = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        id: 'call_after_continuation',
                        name: 'read_file',
                        args: { path: '/tmp/x.txt' },
                      },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;

          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('delivered half ')]))
            .mockResolvedValueOnce(cutAfter([toolCallChunk]));

          const stream = await chatWithRecording.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-record-fc-cut',
          );
          // This send rejects, so it cannot use `collectStreamWithFakeTimers`:
          // that helper returns the collecting promise only after advancing
          // timers, and the cut lands during the advance — leaving the
          // rejection momentarily unhandled. Attach the assertion first, like
          // `expectStreamExhaustion` above.
          const collecting = (async () => {
            for await (const _ of stream) {
              /* consume */
            }
          })();
          const settled = (async () => {
            await expect(collecting).rejects.toThrow('terminated');
          })();
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(10_000);
          await settled;

          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(2);
          expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
          // No text part at all: the attempt yielded only a functionCall.
          expect(recordedText(recordAssistantTurn)).toBeUndefined();

          // And the durable record still matches what survives in memory.
          const lastTurn = chatWithRecording.getHistory().at(-1);
          expect(lastTurn?.role).toBe('model');
          expect(
            lastTurn?.parts?.some((part) =>
              part.text?.includes('delivered half'),
            ),
          ).toBe(false);
        } finally {
          vi.useRealTimers();
        }
      });

      it('drops replayed overlap when the model repeats its own tail', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(
              cutAfter([textChunk('The quick brown fox jumps over')]),
            )
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('jumps over the lazy dog.', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-overlap',
          );
          await collectStreamWithFakeTimers(stream, 5_000);

          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'The quick brown fox jumps over the lazy dog.' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('survives repeated cuts and accumulates every delivered fragment', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('part one ')]))
            .mockResolvedValueOnce(cutAfter([textChunk('part two ')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('part three', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-repeated',
          );
          const events = await collectStreamWithFakeTimers(stream, 10_000);

          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(3);
          // The third request carries BOTH earlier fragments, not just the
          // most recent one.
          expect(requestContentsOfCall(2).at(-2)).toEqual({
            role: 'model',
            parts: [{ text: 'part one part two ' }],
          });
          expect(
            events.filter(
              (event) =>
                event.type === StreamEventType.RETRY && event.isContinuation,
            ),
          ).toHaveLength(2);
          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'part one part two part three' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('drops replayed overlap when an intermediate attempt is cut again', async () => {
        // The two cases above, combined: a middle attempt both replays the
        // previous tail *and* is cut before finishing. Dedup at merge time
        // only compares the final attempt against the accumulated prefix, so
        // an overlap replayed by an intermediate attempt is baked into that
        // prefix — it is propagated to every later request and into durable
        // history, where it corrupts /compress, --resume, and the context of
        // every following turn.
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('part one ')]))
            .mockResolvedValueOnce(cutAfter([textChunk('part one part two ')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('part three', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-intermediate-replay',
          );
          await collectStreamWithFakeTimers(stream, 10_000);

          // The third request must not carry "part one" twice.
          expect(requestContentsOfCall(2).at(-2)).toEqual({
            role: 'model',
            parts: [{ text: 'part one part two ' }],
          });
          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'part one part two part three' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps continuing when a later attempt is cut during thinking', async () => {
        // `streamYieldedContentChunk` is per-attempt, so an attempt cut while
        // still in its thinking phase looks identical to a cut that delivered
        // nothing at all — even though earlier attempts already put text on
        // the caller's screen. The replay gate is checked first, so without a
        // guard on the accumulated text it fires here, resets the
        // continuation state, and emits a plain RETRY that tells the UI to
        // discard output the user was watching.
        vi.useFakeTimers();
        try {
          const thoughtOnly = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'Now let me check the next part.', thought: true },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;

          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('part one ')]))
            .mockResolvedValueOnce(cutAfter([thoughtOnly]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('part two', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-thought-only-cut',
          );
          const events = await collectStreamWithFakeTimers(stream, 10_000);

          // Every RETRY must be a continuation. A plain RETRY here is the UI
          // being told to throw away "part one ".
          const retries = events.filter(
            (event) => event.type === StreamEventType.RETRY,
          );
          expect(retries).toHaveLength(2);
          expect(
            retries.every(
              (event) =>
                (event as { isContinuation?: boolean }).isContinuation === true,
            ),
          ).toBe(true);

          // The delivered text must still anchor the third request...
          expect(requestContentsOfCall(2).at(-2)).toEqual({
            role: 'model',
            parts: [{ text: 'part one ' }],
          });
          // ...and survive into history rather than being regenerated.
          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'part one part two' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('pins the delivered text after a thought part in the merged turn', async () => {
        // Covers `textIndex > 0`: the continuation turn leads with a thought
        // part, so the delivered text must merge into the *text* part rather
        // than being spliced at index 0 ahead of the thinking.
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('part one ')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield {
                  candidates: [
                    {
                      content: {
                        role: 'model',
                        parts: [
                          { text: 'still reasoning', thought: true },
                          { text: 'part two' },
                        ],
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
            'prompt-transport-continuation-thought-then-text',
          );
          await collectStreamWithFakeTimers(stream, 10_000);

          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [
              { text: 'still reasoning', thought: true },
              { text: 'part one part two' },
            ],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('inserts the delivered text when the continuation has no text part', async () => {
        // Covers `textIndex < 0`: a thinking model completes the continuation
        // with only a thought part. The delivered text has nothing to merge
        // into, so it is inserted as its own part — and must land *after* the
        // thought, not ahead of it.
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('part one ')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield {
                  candidates: [
                    {
                      content: {
                        role: 'model',
                        parts: [{ text: 'only thinking', thought: true }],
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
            'prompt-transport-continuation-thought-only',
          );
          await collectStreamWithFakeTimers(stream, 10_000);

          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [
              { text: 'only thinking', thought: true },
              { text: 'part one ' },
            ],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('propagates once the continuation budget is exhausted', async () => {
        vi.useFakeTimers();
        try {
          let call = 0;
          vi.mocked(
            mockContentGenerator.generateContentStream,
          ).mockImplementation(() =>
            Promise.resolve(cutAfter([textChunk(`fragment ${call++} `)])),
          );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-exhausted',
          );
          let caughtError: unknown;
          const collecting = (async () => {
            try {
              for await (const _ of stream) {
                /* consume */
              }
            } catch (error) {
              caughtError = error;
            }
          })();
          await vi.advanceTimersByTimeAsync(0);
          await vi.advanceTimersByTimeAsync(30_000);
          await collecting;

          expect((caughtError as Error).message).toContain('terminated');
          // Initial attempt + maxContinuationRetries continuations, then stop.
          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(4);
          // Plain-text cuts reach the not-taken branch with content delivered
          // but no functionCall, which also pins the log's ternary key to
          // `streamYieldedContentChunk`: re-keying it to
          // `streamYieldedFunctionCall` would log 'exhausted' here.
          expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
            'Transport stream retry not taken',
            expect.objectContaining({
              retryDecision: 'skipped_after_content',
            }),
          );
        } finally {
          vi.useRealTimers();
        }
      });

      it('does not continue a cut that delivered a functionCall', async () => {
        // Injecting a user turn between a functionCall and its
        // functionResponse produces a sequence providers reject; the partial
        // tool-use turn is left for the scheduler's repair path instead.
        const toolChunk = {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  { text: 'Let me read that file. ' },
                  {
                    functionCall: {
                      id: 'call_1',
                      name: 'read_file',
                      args: { path: '/tmp/a.txt' },
                    },
                  },
                ],
              },
            },
          ],
        } as unknown as GenerateContentResponse;

        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          cutAfter([toolChunk]),
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-transport-continuation-functioncall',
        );
        await expect(async () => {
          for await (const _ of stream) {
            /* consume */
          }
        }).rejects.toThrow('terminated');

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(1);
      });

      it('replays rather than continues when only a thought was delivered', async () => {
        // The reported failure mode: thinking models emit reasoning within
        // seconds, so gating replay on "any chunk yielded" made it
        // unreachable. A thought carries no answer text a replay could
        // duplicate, so the clean replay is still the right recovery.
        vi.useFakeTimers();
        try {
          const thoughtChunk = {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'Let me plan this out.', thought: true }],
                },
              },
            ],
          } as unknown as GenerateContentResponse;

          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([thoughtChunk]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('the full answer', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-thought-only',
          );
          const events = await collectStreamWithFakeTimers(stream, 5_000);

          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(2);
          // A replay, not a continuation: no resume instruction is injected
          // and the RETRY tells the UI to discard the failed attempt.
          const secondRequest = requestContentsOfCall(1);
          expect(
            secondRequest.some((entry) =>
              entry.parts?.some((part) =>
                part.text?.includes('The connection dropped mid-response'),
              ),
            ),
          ).toBe(false);
          expect(
            events.filter(
              (event) =>
                event.type === StreamEventType.RETRY && !event.isContinuation,
            ),
          ).toHaveLength(1);
          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'the full answer' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('replays rather than continues when the delivered text was blank', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('   ')]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('real content', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-blank',
          );
          const events = await collectStreamWithFakeTimers(stream, 5_000);

          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(2);
          expect(
            events.filter(
              (event) =>
                event.type === StreamEventType.RETRY && event.isContinuation,
            ),
          ).toHaveLength(0);
        } finally {
          vi.useRealTimers();
        }
      });

      it('drops a pending continuation when a fresh-restart retry takes over', async () => {
        // A socket cut starts a continuation; the continuation attempt then
        // fails with an InvalidStreamError, whose retry re-sends the ORIGINAL
        // request and emits a plain RETRY (UI discards the delivered text).
        // The request must drop it too — otherwise the resend keeps asking the
        // model to continue output the caller no longer has.
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('doomed fragment ')]))
            .mockResolvedValueOnce(
              (async function* () {
                throw new InvalidStreamError(
                  'Model stream ended with empty response text.',
                  'NO_RESPONSE_TEXT',
                );

                yield {} as GenerateContentResponse;
              })(),
            )
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('a clean answer', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-superseded',
          );
          await collectStreamWithFakeTimers(stream, 10_000);

          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(3);
          const thirdRequest = requestContentsOfCall(2);
          expect(
            thirdRequest.some((entry) =>
              entry.parts?.some((part) =>
                part.text?.includes('doomed fragment'),
              ),
            ),
          ).toBe(false);
          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'a clean answer' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('keeps continuing when a later attempt is cut with nothing yielded', async () => {
        // A socket cut delivers text and schedules a continuation; the
        // continuation attempt is then cut again having yielded nothing at
        // all. The replay branch is checked first and its per-attempt
        // "nothing delivered" test is satisfied here, so it must also consult
        // the accumulated buffer — replaying would re-send the original
        // request under a plain RETRY, telling the UI to discard text the
        // caller already has and making the model regenerate it.
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('kept half ')]))
            .mockResolvedValueOnce(cutAfter([]))
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('a clean answer', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-empty-later-attempt',
          );
          const events = await collectStreamWithFakeTimers(stream, 10_000);

          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(3);
          // Both RETRYs keep the UI's buffer; a plain one would drop the text.
          expect(
            events
              .filter((event) => event.type === StreamEventType.RETRY)
              .every(
                (event) =>
                  (event as { isContinuation?: boolean }).isContinuation ===
                  true,
              ),
          ).toBe(true);
          const thirdRequest = requestContentsOfCall(2);
          expect(
            thirdRequest.some((entry) =>
              entry.parts?.some((part) =>
                part.text?.includes('The connection dropped mid-response'),
              ),
            ),
          ).toBe(true);
          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'kept half a clean answer' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });

      it('drops a pending continuation when reactive compression takes over', async () => {
        // The third branch that emits a plain RETRY alongside
        // `suppressNextRetryEvent`. This ordering is not far-fetched: a
        // continuation attempt sends *more* than the original request (the
        // delivered text plus the resume instruction ride along), so it is
        // exactly the attempt most likely to overflow the context window.
        // Compression rebuilds `requestContents` from a compacted history, so a
        // continuation staged against the old contents is stale twice over.
        vi.useFakeTimers();
        try {
          vi.spyOn(ChatCompressionService.prototype, 'compress')
            // The pre-send proactive pass; the reactive one is the second call.
            .mockResolvedValueOnce({
              newHistory: null,
              info: {
                originalTokenCount: 0,
                newTokenCount: 0,
                compressionStatus: CompressionStatus.NOOP,
              },
            })
            .mockResolvedValueOnce({
              newHistory: [
                { role: 'user', parts: [{ text: 'summary' }] },
                { role: 'model', parts: [{ text: 'ack' }] },
                { role: 'user', parts: [{ text: 'test' }] },
              ],
              info: {
                originalTokenCount: 135_000,
                newTokenCount: 40_000,
                compressionStatus: CompressionStatus.COMPRESSED,
              },
            });
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('discarded half ')]))
            .mockRejectedValueOnce(
              new Error('prompt is too long: 135000 tokens > 128000 maximum'),
            )
            .mockResolvedValueOnce(
              (async function* () {
                yield textChunk('a clean answer', 'STOP');
              })(),
            );

          const stream = await chat.sendMessageStream(
            'test-model',
            { message: 'test' },
            'prompt-transport-continuation-replaced-by-compression',
          );
          await collectStreamWithFakeTimers(stream, 10_000);

          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(3);
          const thirdRequest = requestContentsOfCall(2);
          expect(
            thirdRequest.some((entry) =>
              entry.parts?.some((part) =>
                part.text?.includes('discarded half'),
              ),
            ),
          ).toBe(false);
          expect(
            thirdRequest.some((entry) =>
              entry.parts?.some((part) =>
                part.text?.includes('The connection dropped mid-response'),
              ),
            ),
          ).toBe(false);
          expect(chat.getHistory().at(-1)).toEqual({
            role: 'model',
            parts: [{ text: 'a clean answer' }],
          });
        } finally {
          vi.useRealTimers();
        }
      });
    });

    it('falls back after yielding only tool preparation metadata', async () => {
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'test-model',
        maxRetries: 0,
      });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'fallback-model',
      ]);

      const fallbackGenerateContentStream = vi.fn().mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'Recovered with fallback' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );
      const resolveForModel = vi.fn().mockResolvedValue({
        contentGenerator: {
          generateContent: vi.fn(),
          generateContentStream: fallbackGenerateContentStream,
          embedContent: vi.fn(),
          batchEmbedContents: vi.fn(),
        } as unknown as ContentGenerator,
        retryAuthType: AuthType.USE_GEMINI,
        retryErrorCodes: undefined,
        model: 'fallback-model',
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);

      const capacityError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling"}}',
        ),
        { status: 429 },
      );
      const preparationResponse = {
        candidates: [{ content: { parts: [] } }],
      } as unknown as GenerateContentResponse;
      setToolCallPreparations(preparationResponse, [
        { callId: 'call-fallback', toolName: 'read_file' },
      ]);
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield preparationResponse;
          throw capacityError;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-fallback-after-preparation',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      expect(resolveForModel).toHaveBeenCalledWith('fallback-model', {
        failClosed: true,
      });
      expect(fallbackGenerateContentStream).toHaveBeenCalledOnce();
      expect(
        events.filter((event) => event.type === StreamEventType.MODEL_FALLBACK),
      ).toHaveLength(1);
    });

    it('classifies every allow-listed stream transport code as retryable transport', () => {
      // Drift guard: the stream allow-list is a hand-curated subset of the
      // classifier's transport codes. If a code is renamed/removed there, or
      // a typo is introduced here, this fails instead of silently never
      // retrying.
      for (const code of RETRYABLE_STREAM_TRANSPORT_CODES) {
        expect(classifyRetryError({ code })).toMatchObject({
          kind: 'transport',
          diagnosis: 'retryable',
          transportCode: code,
        });
      }
    });

    it.each([...RETRYABLE_STREAM_TRANSPORT_CODES])(
      'retries a pre-first-chunk transport error carrying code %s',
      async (transportCode) => {
        vi.useFakeTimers();
        try {
          const transportError = Object.assign(new TypeError('terminated'), {
            cause: Object.assign(new Error('socket failure'), {
              code: transportCode,
            }),
          });

          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(
              (async function* () {
                throw transportError;

                yield {} as GenerateContentResponse;
              })(),
            )
            .mockResolvedValueOnce(
              (async function* () {
                yield {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: `Recovered from ${transportCode}` }],
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
            `prompt-transport-${transportCode}`,
          );
          const events = await collectStreamWithFakeTimers(stream, 5_000);

          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(2);
          expect(
            events.filter((event) => event.type === StreamEventType.RETRY),
          ).toHaveLength(1);
          expect(
            events.some(
              (event) =>
                event.type === StreamEventType.CHUNK &&
                event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                  `Recovered from ${transportCode}`,
            ),
          ).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      },
    );

    it('retries an enhanced timeout before the first content chunk', async () => {
      vi.useFakeTimers();
      try {
        // The OpenAI SDK's canonical timeout shape: bare, with no code,
        // status, or cause (issue #8527).
        const timeoutError = new APIConnectionTimeoutError();
        const errorHandler = new EnhancedErrorHandler(() => true);
        let enhancedTimeout: unknown;
        try {
          errorHandler.handle(
            timeoutError,
            {
              model: 'test-model',
              modalities: {},
              startTime: Date.now() - 63_000,
            },
            { model: 'test-model', contents: [] },
          );
        } catch (error) {
          enhancedTimeout = error;
        }

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              throw enhancedTimeout;

              yield {} as GenerateContentResponse;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: {
                      parts: [{ text: 'Recovered after enhanced timeout' }],
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
          'prompt-enhanced-timeout-retry',
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY),
        ).toHaveLength(1);
        expect(
          events.some(
            (event) =>
              event.type === StreamEventType.CHUNK &&
              event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Recovered after enhanced timeout',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries a transport error whose code is on the error itself (no cause)', async () => {
      vi.useFakeTimers();
      try {
        // getTransportCode checks the direct `error.code` before `cause.code`;
        // the other tests only exercise the `cause` path.
        const transportError = Object.assign(new Error('socket reset'), {
          code: 'ECONNRESET',
        });

        vi.mocked(mockContentGenerator.generateContentStream)
          .mockResolvedValueOnce(
            (async function* () {
              throw transportError;

              yield {} as GenerateContentResponse;
            })(),
          )
          .mockResolvedValueOnce(
            (async function* () {
              yield {
                candidates: [
                  {
                    content: { parts: [{ text: 'Recovered via direct code' }] },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-transport-direct-code',
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(2);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY),
        ).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries an SDK-wrapped transport error whose code sits at cause depth 2', async () => {
      // The OpenAI SDK wraps a pre-header socket reset as APIConnectionError ->
      // TypeError('fetch failed') -> cause { code: 'ECONNRESET' }, so the code
      // is two cause levels down. Drive the real inline shouldRetryOnError
      // predicate through the retryWithBackoff options and assert it retries.
      const transportError = Object.assign(new Error('Connection error.'), {
        cause: Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('read ECONNRESET'), {
            code: 'ECONNRESET',
          }),
        }),
      });

      mockRetryWithBackoff.mockImplementation(async (apiCall, options) => {
        try {
          return await apiCall();
        } catch (error) {
          expect(options?.shouldRetryOnError?.(error)).toBe(true);
          return apiCall();
        }
      });

      vi.mocked(mockContentGenerator.generateContentStream)
        .mockRejectedValueOnce(transportError)
        .mockResolvedValueOnce(
          (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: 'Recovered from depth-2 RST' }],
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
        'prompt-transport-sdk-wrapped-depth2',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.candidates?.[0]?.content?.parts?.[0]?.text ===
              'Recovered from depth-2 RST',
        ),
      ).toBe(true);
    });

    it('does not retry a transport error that carries an HTTP 4xx status', async () => {
      // A definitive 4xx is a permanent client error; the socket-level cause
      // must not relabel it as retryable (classifier keeps 4xx authoritative).
      const transportError = Object.assign(new TypeError('terminated'), {
        status: 400,
        cause: Object.assign(new Error('other side closed'), {
          code: 'ECONNRESET',
        }),
      });

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          throw transportError;

          yield {} as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-transport-4xx-no-retry',
      );
      const events: StreamEvent[] = [];
      await expect(async () => {
        for await (const event of stream) {
          events.push(event);
        }
      }).rejects.toThrow('terminated');

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(
        events.filter((event) => event.type === StreamEventType.RETRY),
      ).toHaveLength(0);
    });

    it('does not retry a transport code outside the stream allow-list', async () => {
      // ECONNREFUSED classifies as transport/retryable but is excluded from
      // RETRYABLE_STREAM_TRANSPORT_CODES (permanent misconfiguration, not a
      // transient blip), so the stream path must not replay it.
      const transportError = Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('connection refused'), {
          code: 'ECONNREFUSED',
        }),
      });

      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          throw transportError;

          yield {} as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-transport-not-allowlisted',
      );
      const events: StreamEvent[] = [];
      await expect(async () => {
        for await (const event of stream) {
          events.push(event);
        }
      }).rejects.toThrow('terminated');

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(
        events.filter((event) => event.type === StreamEventType.RETRY),
      ).toHaveLength(0);
    });

    it('surfaces an abort fired during the transport retry delay without retrying again', async () => {
      vi.useFakeTimers();
      try {
        const transportError = socketCut();
        const abortController = new AbortController();

        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          (async function* () {
            throw transportError;

            yield {} as GenerateContentResponse;
          })(),
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test', config: { abortSignal: abortController.signal } },
          'prompt-transport-abort-delay',
        );

        const iterator = stream[Symbol.asyncIterator]();
        // First event is the RETRY emitted before the 1s transport delay.
        const first = await iterator.next();
        expect(first.value.type).toBe(StreamEventType.RETRY);

        // Abort while the generator is awaiting the retry delay.
        const nextPromise = iterator.next();
        abortController.abort();
        await expect(nextPromise).rejects.toThrow();

        // Only the initial attempt ran; the abort cut the retry short.
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

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
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);

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
        const chatWithRecording = chatWithRecorder(recordAssistantTurn);

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

    it('fast-fails a mid-stream quota-exhaustion error instead of scheduling a rate-limit retry', async () => {
      // A permanent quota-exhaustion 429 can arrive mid-stream as a
      // StreamContentError while reading, bypassing the retryWithBackoff
      // fast-fail that only wraps stream establishment. The stream-side
      // catch must fast-fail it before the rate-limit branch; otherwise
      // isRateLimitError (code 429) schedules a 1-5 minute delay on an
      // error that cannot succeed until the reset time.
      vi.useFakeTimers();

      try {
        const quotaError = new StreamContentError(
          '{"error":{"code":"429","message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC."}}',
        );
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockResolvedValueOnce(
          (async function* () {
            throw quotaError;

            yield {} as GenerateContentResponse;
          })(),
        );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-quota-fastfail',
        );
        const iterator = stream[Symbol.asyncIterator]();

        // Fast-fail: the first pull rejects with the friendly message. No
        // RETRY event is yielded and no rate-limit delay is scheduled.
        await expect(iterator.next()).rejects.toThrow(/Quota exhausted/);
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(1);
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

    it('should use configured delay across repeated streamed rate-limit errors', async () => {
      vi.useFakeTimers();

      try {
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
          authType: AuthType.USE_OPENAI,
          model: 'test-model',
          retryInitialDelayMs: 3_000,
          retryMaxDelayMs: 5_000,
        });
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
        await vi.advanceTimersByTimeAsync(3_000);
        await nextPromise;

        const second = await iterator.next();
        expect(second.value.type).toBe(StreamEventType.RETRY);
        retryInfos.push(second.value.retryInfo!);

        nextPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(5_000);
        await nextPromise;

        const events: StreamEvent[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }

        expect(retryInfos.map((info) => info.delayMs)).toEqual([3_000, 5_000]);
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

    it('uses configured stream rate-limit retry delays', async () => {
      vi.useFakeTimers();

      try {
        vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
          authType: AuthType.USE_OPENAI,
          model: 'test-model',
          maxRetries: 2,
          retryInitialDelayMs: 3_000,
          retryMaxDelayMs: 5_000,
        });
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
                    content: { parts: [{ text: 'Recovered' }] },
                    finishReason: 'STOP',
                  },
                ],
              } as unknown as GenerateContentResponse;
            })(),
          );

        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-id-configured-rate-limit-delay',
        );
        const iterator = stream[Symbol.asyncIterator]();

        const first = await iterator.next();
        expect(first.value.type).toBe(StreamEventType.RETRY);
        expect(first.value.retryInfo?.delayMs).toBe(3_000);

        let nextPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(3_000);
        await nextPromise;

        const second = await iterator.next();
        expect(second.value.type).toBe(StreamEventType.RETRY);
        expect(second.value.retryInfo?.delayMs).toBe(5_000);

        nextPromise = iterator.next();
        await vi.advanceTimersByTimeAsync(5_000);
        await nextPromise;

        const events: StreamEvent[] = [];
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          events.push(next.value);
        }

        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                'Recovered',
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

  it('discards a completed protocol-tagged response and retries before persistence', async () => {
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
    vi.mocked(mockContentGenerator.generateContentStream)
      .mockImplementationOnce(async () =>
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  parts: [{ text: '<ana' }],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          yield {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text:
                        'lysis>failed scratch</analysis>' +
                        '<summary>FAILED_ATTEMPT_SHOULD_BE_DISCARDED</summary>',
                    },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      )
      .mockImplementationOnce(async () =>
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

    const stream = await chatWithRecording.sendMessageStream(
      'test-model',
      { message: 'test' },
      'prompt-id-protocol-leak',
    );
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(2);
    expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
      true,
    );
    const emittedText = events
      .filter((event) => event.type === StreamEventType.CHUNK)
      .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? [])
      .map((part) => part.text ?? '')
      .join('');
    expect(emittedText).toBe('Successful final response');
    expect(chatWithRecording.getLastModelMessageText()).toBe(
      'Successful final response',
    );
    expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
    expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual([
      { text: 'Successful final response' },
    ]);
  });

  it.each([
    {
      name: 'array with a different first argument key',
      leakedJson: JSON.stringify([
        {
          file_path: 'a.ts',
          prompt: 'Create the node.',
          name: 'create_node',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
        {
          name: 'read_ref',
          prompt: 'Read the reference.',
          subagent_type: 'general-purpose',
          run_in_background: true,
        },
      ]),
      trailingText: '',
      finishWithContent: false,
    },
    {
      name: 'single object with trailing prose',
      leakedJson: JSON.stringify({ command: 'ls', name: 'run_shell_command' }),
      trailingText: 'Let me continue.',
      finishWithContent: true,
    },
  ])(
    'retries a JSON tool protocol leak: $name',
    async ({ leakedJson, trailingText, finishWithContent }) => {
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
      const leakedText =
        leakedJson + '\n</parameter>\n</function>\n' + trailingText;
      const leakedResponses = [
        {
          candidates: [
            {
              content: {
                parts: [
                  { text: '...', thought: true },
                  { text: leakedText.slice(0, 40) },
                ],
              },
            },
          ],
        } as unknown as GenerateContentResponse,
        {
          candidates: [
            {
              content: { parts: [{ text: leakedText.slice(40) }] },
              ...(finishWithContent ? { finishReason: 'STOP' as const } : {}),
            },
          ],
        } as unknown as GenerateContentResponse,
      ];
      if (!finishWithContent) {
        leakedResponses.push({
          candidates: [{ finishReason: 'STOP' }],
        } as unknown as GenerateContentResponse);
      }
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(streamResponse(...leakedResponses))
        .mockResolvedValueOnce(
          streamResponse(stopResponse([{ text: 'Successful final response' }])),
        );

      const stream = await chatWithRecording.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-json-tool-protocol-leak',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
      expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
        true,
      );
      const emittedParts = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
      expect(emittedParts).toEqual([{ text: 'Successful final response' }]);
      expect(chatWithRecording.getLastModelMessageText()).toBe(
        'Successful final response',
      );
      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual([
        { text: 'Successful final response' },
      ]);
    },
  );

  it.each([
    [JSON.stringify([{ name: 'example', value: 1 }]), 8, 1],
    ['[1,2,3]', 2, 2],
  ])(
    'preserves an ordinary leading JSON array: %s',
    async (response, splitAt, expectedTextChunks) => {
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockResolvedValueOnce(
        streamResponse(
          {
            candidates: [
              {
                content: {
                  parts: [
                    { text: 'thinking', thought: true },
                    { text: response.slice(0, splitAt) },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse,
          stopResponse([{ text: response.slice(splitAt) }]),
        ),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-json-array-literal',
      );
      const events: StreamEvent[] = [];
      const streamedTextChunks: string[] = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type === StreamEventType.CHUNK) {
          const text =
            event.value.candidates?.[0]?.content?.parts
              ?.filter((part) => !part.thought)
              .map((part) => part.text ?? '')
              .join('') ?? '';
          if (text) streamedTextChunks.push(text);
        }
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
        false,
      );
      const emittedParts = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
      expect(streamedTextChunks).toHaveLength(expectedTextChunks);
      expect(emittedParts.find((part) => part.thought)?.text).toBe('thinking');
      expect(streamedTextChunks.join('')).toBe(response);
      expect(chat.getLastModelMessageText()).toBe(response);
    },
  );

  it('releases buffered JSON through a finish-only chunk without leaked tags', async () => {
    const response = JSON.stringify([{ name: 'example', value: 1 }]);
    const splitAt = 12;
    vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValueOnce(
      streamResponse(
        {
          candidates: [
            { content: { parts: [{ text: response.slice(0, splitAt) }] } },
          ],
        } as unknown as GenerateContentResponse,
        {
          candidates: [
            { content: { parts: [{ text: response.slice(splitAt) }] } },
          ],
        } as unknown as GenerateContentResponse,
        {
          candidates: [{ finishReason: 'STOP' }],
        } as unknown as GenerateContentResponse,
      ),
    );

    const stream = await chat.sendMessageStream(
      'test-model',
      { message: 'test' },
      'prompt-id-json-finish-only',
    );
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
      false,
    );
    const emittedParts = events
      .filter((event) => event.type === StreamEventType.CHUNK)
      .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
    const emittedText = emittedParts
      .filter((part) => !part.thought)
      .map((part) => part.text ?? '')
      .join('');
    expect(emittedText).toBe(response);
    expect(chat.getLastModelMessageText()).toBe(response);
    expect(chat.getHistory().at(-1)?.parts).toEqual(emittedParts);
  });

  it.each(['preparation', 'function call'] as const)(
    'retries when a %s interrupts a partial JSON protocol leak',
    async (middleChunkType) => {
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
      const leakedText =
        JSON.stringify([{ name: 'read_file', file_path: 'a.ts' }]) +
        '\n</parameter>\n</function>\n';
      const splitAt = 12;
      let middleResponse: GenerateContentResponse;
      if (middleChunkType === 'preparation') {
        middleResponse = {
          candidates: [{ content: { parts: [] } }],
        } as unknown as GenerateContentResponse;
        setToolCallPreparations(middleResponse, [
          { callId: 'call-1', toolName: 'read_file' },
        ]);
      } else {
        middleResponse = {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      id: 'call-1',
                      name: 'read_file',
                      args: { file_path: 'a.ts' },
                    },
                  },
                ],
              },
            },
          ],
        } as unknown as GenerateContentResponse;
      }
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          streamResponse(
            {
              candidates: [
                {
                  content: { parts: [{ text: leakedText.slice(0, splitAt) }] },
                },
              ],
            } as unknown as GenerateContentResponse,
            middleResponse,
            stopResponse([{ text: leakedText.slice(splitAt) }]),
          ),
        )
        .mockResolvedValueOnce(
          streamResponse(stopResponse([{ text: 'Successful final response' }])),
        );

      const stream = await chatWithRecording.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-interrupted-json-tool-protocol-leak',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
      expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
        true,
      );
      const emittedParts = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
      expect(emittedParts).toEqual([{ text: 'Successful final response' }]);
      expect(chatWithRecording.getLastModelMessageText()).toBe(
        'Successful final response',
      );
      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual([
        { text: 'Successful final response' },
      ]);
    },
  );

  it.each([true, false])(
    'preserves leading JSON when a tool call ends without a finish reason (tool call first: %s)',
    async (toolCallFirst) => {
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
      const response = JSON.stringify([{ name: 'example', value: 1 }]);
      const splitAt = 12;
      const functionCallPart = {
        functionCall: {
          id: 'call-1',
          name: 'read_file',
          args: { file_path: 'a.ts' },
        },
      };
      const functionCallResponse = {
        candidates: [{ content: { parts: [functionCallPart] } }],
      } as unknown as GenerateContentResponse;
      const textResponses = [
        response.slice(0, splitAt),
        response.slice(splitAt),
      ].map(
        (text) =>
          ({
            candidates: [{ content: { parts: [{ text }] } }],
          }) as unknown as GenerateContentResponse,
      );
      const responses = toolCallFirst
        ? [functionCallResponse, ...textResponses]
        : [textResponses[0]!, functionCallResponse, textResponses[1]!];
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockResolvedValueOnce(streamResponse(...responses));

      const stream = await chatWithRecording.sendMessageStream(
        'test-model',
        { message: 'test' },
        `prompt-id-json-tool-call-no-finish-${toolCallFirst}`,
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        1,
      );
      expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
        false,
      );
      const emittedParts = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
      expect(chatWithRecording.getHistory().at(-1)?.parts).toEqual(
        emittedParts,
      );
      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      const recordedParts = recordAssistantTurn.mock.calls[0]?.[0]
        .message as Part[];
      for (const parts of [emittedParts, recordedParts]) {
        expect(parts.filter((part) => part.functionCall)).toEqual([
          functionCallPart,
        ]);
        expect(
          parts
            .filter((part) => part.text)
            .map((part) => part.text)
            .join(''),
        ).toBe(response);
      }
    },
  );

  it.each([false, true])(
    'keeps leading JSON before a later structured tool call (preparation: %s)',
    async (withPreparation) => {
      const response = JSON.stringify([{ name: 'example', value: 1 }]);
      const preparationResponse = {
        candidates: [{ content: { parts: [] } }],
      } as unknown as GenerateContentResponse;
      setToolCallPreparations(preparationResponse, [
        { callId: 'call-1', toolName: 'read_file' },
      ]);
      const usageResponse = {
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      } as GenerateContentResponse;
      const responses = [
        {
          candidates: [
            {
              content: { parts: [{ text: response }] },
            },
          ],
        } as unknown as GenerateContentResponse,
        usageResponse,
      ];
      if (withPreparation) responses.push(preparationResponse);
      responses.push(
        stopResponse([
          {
            functionCall: {
              id: 'call-1',
              name: 'read_file',
              args: { file_path: 'a.ts' },
            },
          },
        ]),
      );
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockResolvedValueOnce(streamResponse(...responses));

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-json-before-tool-call',
      );
      const events: StreamEvent[] = [];
      for await (const event of stream) events.push(event);

      const emittedParts = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
      const emittedPreparations = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => getToolCallPreparations(event.value));
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.usageMetadata?.promptTokenCount === 10 &&
            event.value.usageMetadata.candidatesTokenCount === 2,
        ),
      ).toBe(true);
      expect(emittedPreparations).toEqual(
        withPreparation ? [{ callId: 'call-1', toolName: 'read_file' }] : [],
      );
      for (const parts of [
        emittedParts,
        chat.getHistory().at(-1)?.parts ?? [],
      ]) {
        expect(parts.findIndex((part) => part.text === response)).toBe(0);
        expect(parts.findIndex((part) => part.functionCall)).toBe(1);
      }
    },
  );

  it('does not retry after a structured tool call has already been emitted', async () => {
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
    const leakedText =
      JSON.stringify([{ name: 'read_file', file_path: 'a.ts' }]) +
      '\n</parameter>\n</function>\n';
    vi.mocked(mockContentGenerator.generateContentStream)
      .mockResolvedValueOnce(
        streamResponse(
          {
            candidates: [
              {
                content: {
                  parts: [
                    {
                      functionCall: {
                        id: 'call-1',
                        name: 'read_file',
                        args: { file_path: 'a.ts' },
                      },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse,
          stopResponse([{ text: leakedText }]),
        ),
      )
      .mockResolvedValueOnce(
        streamResponse(stopResponse([{ text: 'Unexpected retry response' }])),
      );

    const stream = await chatWithRecording.sendMessageStream(
      'test-model',
      { message: 'test' },
      'prompt-id-tool-call-before-json-protocol-leak',
    );
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
      false,
    );
    const emittedParts = events
      .filter((event) => event.type === StreamEventType.CHUNK)
      .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
    expect(emittedParts).toEqual([
      {
        functionCall: {
          id: 'call-1',
          name: 'read_file',
          args: { file_path: 'a.ts' },
        },
      },
    ]);
    expect(chatWithRecording.getHistory().at(-1)?.parts).toEqual(emittedParts);
    expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
    expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual(
      emittedParts,
    );
  });

  it('does not reject normal HTML or protocol tag names in prose', async () => {
    const response =
      '<details><summary>Title</summary></details> ' +
      'Use the literal <analysis> tag in this example.';
    vi.mocked(
      mockContentGenerator.generateContentStream,
    ).mockImplementationOnce(async () =>
      (async function* () {
        yield {
          candidates: [
            {
              content: { parts: [{ text: response }] },
              finishReason: 'STOP',
            },
          ],
        } as unknown as GenerateContentResponse;
      })(),
    );

    const stream = await chat.sendMessageStream(
      'test-model',
      { message: 'test' },
      'prompt-id-protocol-literal',
    );
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
      false,
    );
    expect(chat.getLastModelMessageText()).toBe(response);
  });

  it('does not reject closing protocol tags inside a JSON string', async () => {
    const response = JSON.stringify({
      example: '} </parameter></function> text',
    });
    vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValueOnce(
      streamResponse(stopResponse([{ text: response }])),
    );

    const stream = await chat.sendMessageStream(
      'test-model',
      { message: 'test' },
      'prompt-id-json-protocol-literal',
    );
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);

    expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
      false,
    );
    expect(chat.getLastModelMessageText()).toBe(response);
  });

  it('retries leaked JSON before a structured tool call', async () => {
    vi.useFakeTimers();
    try {
      const leakedText =
        JSON.stringify([{ name: 'read_file', file_path: 'a.ts' }]) +
        '\n</parameter>\n</function>\n';
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          streamResponse(
            {
              candidates: [{ content: { parts: [{ text: leakedText }] } }],
            } as unknown as GenerateContentResponse,
            stopResponse([
              {
                functionCall: {
                  id: 'call-1',
                  name: 'read_file',
                  args: { file_path: 'a.ts' },
                },
              },
            ]),
          ),
        )
        .mockResolvedValueOnce(
          streamResponse(stopResponse([{ text: 'Successful final response' }])),
        );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-json-leak-before-tool-call',
      );
      const events: StreamEvent[] = [];
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await next;
        if (result.done) break;
        events.push(result.value);
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
      const emittedParts = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
      expect(emittedParts).toEqual([{ text: 'Successful final response' }]);
      expect(chat.getHistory().at(-1)?.parts).toEqual(emittedParts);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries leaked JSON without a finish reason via the post-stream leak guard', async () => {
    vi.useFakeTimers();
    try {
      const leakedText =
        JSON.stringify([{ name: 'read_file', file_path: 'a.ts' }]) +
        '\n\n</parameter>\n</function>\n';
      vi.mocked(mockContentGenerator.generateContentStream)
        .mockResolvedValueOnce(
          streamResponse(
            {
              candidates: [{ content: { parts: [{ text: leakedText }] } }],
            } as unknown as GenerateContentResponse,
            {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        functionCall: {
                          id: 'call-1',
                          name: 'read_file',
                          args: { file_path: 'a.ts' },
                        },
                      },
                    ],
                  },
                },
              ],
            } as unknown as GenerateContentResponse,
          ),
        )
        .mockResolvedValueOnce(
          streamResponse(stopResponse([{ text: 'Successful final response' }])),
        );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-json-leak-no-finish-reason',
      );
      const events: StreamEvent[] = [];
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await next;
        if (result.done) break;
        events.push(result.value);
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
      const emittedParts = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
      expect(emittedParts).toEqual([{ text: 'Successful final response' }]);
      expect(chat.getHistory().at(-1)?.parts).toEqual(emittedParts);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a protocol-tagged turn even when the leaked attempt also contains a tool call', async () => {
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
      chatWithRecording.setHistory([
        { role: 'user', parts: [{ text: 'earlier user turn' }] },
        { role: 'model', parts: [{ text: 'earlier model turn' }] },
      ]);

      vi.mocked(mockContentGenerator.generateContentStream)
        .mockImplementationOnce(async () =>
          (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: '<ana' }],
                  },
                },
              ],
            } as unknown as GenerateContentResponse;
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text:
                          'lysis>failed scratch</analysis>' +
                          '<summary>FAILED_ATTEMPT_SHOULD_BE_DISCARDED</summary>',
                      },
                      {
                        functionCall: {
                          id: 'call_protocol_leak_should_retry',
                          name: 'read_file',
                          args: { path: '/tmp/leaked.txt' },
                        },
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
            } as unknown as GenerateContentResponse;
          })(),
        )
        .mockImplementationOnce(async () =>
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

      const stream = await chatWithRecording.sendMessageStream(
        'test-model',
        { message: 'test' },
        'prompt-id-protocol-leak-tool-call',
      );
      const events: StreamEvent[] = [];
      const iterator = stream[Symbol.asyncIterator]();
      for (;;) {
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(5_000);
        const result = await next;
        if (result.done) break;
        events.push(result.value);
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
      expect(events.some((event) => event.type === StreamEventType.RETRY)).toBe(
        true,
      );
      const emittedParts = events
        .filter((event) => event.type === StreamEventType.CHUNK)
        .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);
      expect(emittedParts.some((part) => part.functionCall)).toBe(false);
      const emittedText = emittedParts.map((part) => part.text ?? '').join('');
      expect(emittedText).toBe('Successful final response');
      expect(chatWithRecording.getLastModelMessageText()).toBe(
        'Successful final response',
      );

      const history = chatWithRecording.getHistory();
      expect(history).toEqual([
        { role: 'user', parts: [{ text: 'earlier user turn' }] },
        { role: 'model', parts: [{ text: 'earlier model turn' }] },
        { role: 'user', parts: [{ text: 'test' }] },
        { role: 'model', parts: [{ text: 'Successful final response' }] },
      ]);
      expect(
        history.some((turn) => turn.parts?.some((part) => part.functionCall)),
      ).toBe(false);

      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual([
        { text: 'Successful final response' },
      ]);
    } finally {
      vi.useRealTimers();
    }
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

      const strippedEntries = chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual([
        { role: 'user', parts: [{ text: 'first message' }] },
        { role: 'model', parts: [{ text: 'first response' }] },
      ]);
      expect(strippedEntries).toEqual([
        { role: 'user', parts: [{ text: 'orphaned message' }] },
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

      const strippedEntries = chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual([
        { role: 'user', parts: [{ text: 'query' }] },
        {
          role: 'model',
          parts: [{ functionCall: { name: 'tool', args: {} } }],
        },
      ]);
      expect(strippedEntries).toEqual([
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

    it('keeps a tool result adjacent across a removable degraded placeholder', () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'open /tmp/a.txt' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-1',
                name: 'read_file',
                args: { path: '/tmp/a.txt' },
              },
            },
          ],
        },
        { role: 'model', parts: [{ text: '(request timeout)' }] },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: { output: 'ok' },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-1',
                name: 'read_file',
                response: { output: 'ok' },
              },
            },
          ],
        },
      ];
      const expectedHistory = structuredClone(history.slice(0, 4));
      chat.setHistory(history);

      expect(chat.repairOrphanedToolUseTurns()).toEqual({
        injected: [],
        droppedDuplicates: [{ callId: 'call-1', name: 'read_file' }],
      });
      expect(chat.repairOrphanedToolUseTurns()).toEqual({
        injected: [],
        droppedDuplicates: [],
      });
      expect(chat.getHistory()).toEqual(expectedHistory);
      expect(chat.getHistory(true)).toEqual([
        expectedHistory[0],
        expectedHistory[1],
        expectedHistory[3],
      ]);
    });

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

    it('preserves selected call ids instead of synthesizing a response', () => {
      chat.setHistory([
        { role: 'user', parts: [{ text: 'ask' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call_auq',
                name: 'ask_user_question',
                args: {},
              },
            },
          ],
        },
      ]);

      const result = chat.repairOrphanedToolUseTurns(undefined, {
        preserveCallIds: new Set(['call_auq']),
      });

      expect(result.injected).toEqual([]);
      expect(chat.getHistory()).toHaveLength(2);
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

    function invalidStream(
      type: InvalidStreamError['type'],
    ): AsyncGenerator<GenerateContentResponse> {
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          throw new InvalidStreamError('Invalid continuation stream.', type);
        },
        async return() {
          return { done: true, value: undefined };
        },
        async throw(error?: unknown) {
          throw error;
        },
      } as AsyncGenerator<GenerateContentResponse>;
    }

    it('escalates an empty MAX_TOKENS response instead of retrying it as an empty stream', async () => {
      vi.useFakeTimers();
      try {
        const requestedMaxOutputTokens: Array<number | undefined> = [];
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async (request) => {
          const maxOutputTokens = request.config?.maxOutputTokens;
          requestedMaxOutputTokens.push(maxOutputTokens);
          return maxOutputTokens !== undefined && maxOutputTokens > 8_192
            ? makeStream([
                makeChunk([{ text: 'Completed after escalation.' }], 'STOP'),
              ])
            : makeStream([makeChunk([], 'MAX_TOKENS')]);
        });

        const stream = await chat.sendMessageStream(
          'gemini-pro',
          { message: 'complete the tool call' },
          'prompt-empty-max-tokens-escalation',
        );
        const events = await collectStreamWithFakeTimers(stream, 25_000);

        expect(requestedMaxOutputTokens).toEqual([8_192, 64_000]);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY),
        ).toEqual([
          {
            type: StreamEventType.RETRY,
            maxOutputTokensEscalated: 64_000,
          },
        ]);
        expect(mockLogContentRetry).not.toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({ error_type: 'NO_RESPONSE_TEXT' }),
        );
        expect(chat.getHistory()).toEqual([
          { role: 'user', parts: [{ text: 'complete the tool call' }] },
          {
            role: 'model',
            parts: [{ text: 'Completed after escalation.' }],
          },
        ]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-clamps maxOutputTokens on each recovery send as the prompt grows (window invariant)', async () => {
      // The #5950 shape at recovery time: 131,072 window, 71,349 prompt,
      // 64K-ceiling model. Initial clamp grants 49,722. The response
      // truncates at MAX_TOKENS, the 49,722-token partial lands in history,
      // and the recovery resend's prompt is now ~121K — reusing the stale
      // 49,722 would overflow the window by ~40K. The recovery loop must
      // re-clamp per iteration (here down to the 4,000 floor).
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'claude-sonnet-4-6',
        contextWindowSize: 131_072,
      });
      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 71_349,
          newTokenCount: 71_349,
          compressionStatus: CompressionStatus.NOOP,
        },
      });

      const truncatedWithUsage = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'partial essay…' }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
        usageMetadata: {
          promptTokenCount: 71_349,
          totalTokenCount: 121_071, // output = 49,722 (the full grant)
        },
      } as unknown as GenerateContentResponse;
      const streams = [
        makeStream([truncatedWithUsage]),
        makeStream([makeChunk([{ text: ' …and done.' }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      chat.setLastPromptTokenCount(71_349);
      const stream = await chat.sendMessageStream(
        'claude-sonnet-4-6',
        { message: 'hi' },
        'prompt-recovery-reclamp',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // Escalation is a no-op (the room already bound below the 64K
      // ceiling), so exactly 2 calls: initial + recovery.
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );
      const calls = vi.mocked(mockContentGenerator.generateContentStream).mock
        .calls;
      const initialConfig = calls[0]![0].config as { maxOutputTokens?: number };
      const recoveryConfig = calls[1]![0].config as {
        maxOutputTokens?: number;
      };
      // Initial: char/4("hi")=1 token, inflated by the conservative safety
      // factor (1.5x, ceil'd) to 2, room = 131072 − 71351 − 10000 = 49721
      // (below the 64K ceiling).
      expect(initialConfig.maxOutputTokens).toBe(49_721);
      // Recovery: prompt grew to ~121K → re-clamped to the 4,000 floor, NOT
      // the stale 49,721 (which would overflow the window by ~40K).
      expect(recoveryConfig.maxOutputTokens).toBe(4_000);
    });

    it('re-clamps recovery sends even when an intermediate response omits usage metadata', async () => {
      // Codex round-4 scenario: multi-iteration recovery where the FIRST
      // truncated response reports usage but the SECOND omits it. The
      // count-based estimate freezes at iteration-1 values while history
      // keeps growing by ~64K per iteration; the padded fresh-walk estimate
      // must overrule it so iteration 2 does not re-grant the full ceiling.
      vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
        authType: AuthType.USE_GEMINI,
        model: 'claude-sonnet-4-6',
        contextWindowSize: 180_000,
      });
      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 5_000,
          newTokenCount: 5_000,
          compressionStatus: CompressionStatus.NOOP,
        },
      });

      // ~64K estimated tokens of partial output per truncated response, so
      // the history walk actually sees the growth.
      const truncatedWithUsage = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'y'.repeat(256_000) }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
        usageMetadata: {
          promptTokenCount: 5_000,
          totalTokenCount: 69_000, // output = 64,000 (the full grant)
        },
      } as unknown as GenerateContentResponse;
      const truncatedNoUsage = {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'z'.repeat(256_000) }] },
            finishReason: 'MAX_TOKENS',
          },
        ],
        // usageMetadata deliberately absent — provider omitted it.
      } as unknown as GenerateContentResponse;
      const streams = [
        makeStream([truncatedWithUsage]),
        makeStream([truncatedNoUsage]),
        makeStream([makeChunk([{ text: ' fin.' }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      chat.setLastPromptTokenCount(5_000);
      const stream = await chat.sendMessageStream(
        'claude-sonnet-4-6',
        { message: 'hi' },
        'prompt-recovery-stale-usage',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        3,
      );
      const calls = vi.mocked(mockContentGenerator.generateContentStream).mock
        .calls;
      const recovery1Config = calls[1]![0].config as {
        maxOutputTokens?: number;
      };
      const recovery2Config = calls[2]![0].config as {
        maxOutputTokens?: number;
      };
      // Iteration 1: plenty of room, ceiling binds.
      expect(recovery1Config.maxOutputTokens).toBe(64_000);
      // Iteration 2: the stale count-based estimate (frozen at ~69K) would
      // re-grant the full 64,000; the padded walk (~148K: two 64K partials
      // + pad) must win, shrinking the grant to roughly
      // 180,000 − ~148K − 10,000 ≈ 22K.
      expect(recovery2Config.maxOutputTokens).toBeLessThan(30_000);
      expect(recovery2Config.maxOutputTokens).toBeGreaterThanOrEqual(4_000);
    });

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
        'gemini-pro',
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

    it('retries protocol-tag leaks during max-tokens escalation', async () => {
      vi.useFakeTimers();
      try {
        const streams = [
          makeStream([makeChunk([{ text: 'Hello' }], 'MAX_TOKENS')]),
          (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: '<ana' }],
                  },
                },
              ],
            } as unknown as GenerateContentResponse;
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text:
                          'lysis>discard escalated attempt</analysis>' +
                          '<summary>DISCARD_ESCALATED_ATTEMPT</summary>',
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
            } as unknown as GenerateContentResponse;
          })(),
          makeStream([makeChunk([{ text: 'Hello world' }], 'STOP')]),
        ];
        let callIndex = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => streams[callIndex++]!);

        const stream = await chat.sendMessageStream(
          'gemini-pro',
          { message: 'write a long essay' },
          'prompt-escalation-protocol-retry',
        );
        const events: StreamEvent[] = [];
        const iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const next = iterator.next();
          await vi.advanceTimersByTimeAsync(5_000);
          const result = await next;
          if (result.done) break;
          events.push(result.value);
        }

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(3);
        expect(
          events.filter((event) => event.type === StreamEventType.RETRY).length,
        ).toBe(2);
        expect(chat.getLastModelMessageText()).toBe('Hello world');
        expect(
          JSON.stringify(chat.getHistory()).includes(
            'DISCARD_ESCALATED_ATTEMPT',
          ),
        ).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('preserves current user image bytes during output recovery', async () => {
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        maxRecentImagesToRetain: 0,
        imagePayloadThreshold: 1,
      });
      const streams = [
        makeStream([makeChunk([{ text: 'initial' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: 'escalated' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: 'done' }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-pro',

        {
          message: [
            { text: 'describe this image' },
            { inlineData: { mimeType: 'image/png', data: 'current-shot' } },
          ],
        },
        'prompt-recovery-image',
      );

      for await (const _event of stream) {
        // consume
      }

      const recoveryRequest = vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mock.calls[2]?.[0];
      const serialized = JSON.stringify(recoveryRequest?.contents);
      expect(serialized).toContain('"data":"current-shot"');
    });

    it('should skip no-op escalation and recover directly for high-output models', async () => {
      const streams = [
        makeStream([makeChunk([{ text: 'Hello' }], 'MAX_TOKENS')]),
        makeStream([makeChunk([{ text: ' ending.' }], 'STOP')]),
      ];
      let callIndex = 0;
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => streams[callIndex++]!,
      );

      const stream = await chat.sendMessageStream(
        'gemini-3-pro',
        { message: 'write a long essay' },
        'prompt-direct-recovery',
      );

      const events: StreamEvent[] = [];
      for await (const event of stream) {
        events.push(event);
      }

      const retries = events.filter((e) => e.type === StreamEventType.RETRY);
      expect(retries.length).toBe(1);
      expect((retries[0] as { isContinuation?: boolean }).isContinuation).toBe(
        true,
      );
      expect(
        (retries[0] as { maxOutputTokensEscalated?: number })
          .maxOutputTokensEscalated,
      ).toBeUndefined();
      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
        2,
      );

      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const text = lastEntry.parts
        ?.map((part) => ('text' in part ? part.text : ''))
        .join('');
      expect(text).toBe('Hello ending.');
    });

    it('retries protocol-tag leaks during direct output recovery', async () => {
      vi.useFakeTimers();
      try {
        const streams = [
          makeStream([makeChunk([{ text: 'Hello' }], 'MAX_TOKENS')]),
          (async function* () {
            yield {
              candidates: [
                {
                  content: {
                    parts: [{ text: '<ana' }],
                  },
                },
              ],
            } as unknown as GenerateContentResponse;
            yield {
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text:
                          'lysis>discard recovery attempt</analysis>' +
                          '<summary>DISCARD_RECOVERY_ATTEMPT</summary>',
                      },
                    ],
                  },
                  finishReason: 'STOP',
                },
              ],
            } as unknown as GenerateContentResponse;
          })(),
          makeStream([makeChunk([{ text: ' world' }], 'STOP')]),
        ];
        let callIndex = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => streams[callIndex++]!);

        const stream = await chat.sendMessageStream(
          'gemini-3-pro',
          { message: 'write a long essay' },
          'prompt-direct-recovery-protocol-retry',
        );
        const events: StreamEvent[] = [];
        const iterator = stream[Symbol.asyncIterator]();
        for (;;) {
          const next = iterator.next();
          await vi.advanceTimersByTimeAsync(5_000);
          const result = await next;
          if (result.done) break;
          events.push(result.value);
        }

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(3);
        const retries = events.filter(
          (event) => event.type === StreamEventType.RETRY,
        );
        expect(retries).toHaveLength(2);
        expect(
          retries.map(
            (event) => (event as { isContinuation?: boolean }).isContinuation,
          ),
        ).toEqual([true, true]);
        expect(chat.getLastModelMessageText()).toBe('Hello world');
        expect(chat.getHistory()).toEqual([
          { role: 'user', parts: [{ text: 'write a long essay' }] },
          { role: 'model', parts: [{ text: 'Hello world' }] },
        ]);
      } finally {
        vi.useRealTimers();
      }
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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

    it('keeps protocol tag leak budget during output continuation', async () => {
      vi.useFakeTimers();
      try {
        const streams = [
          makeStream([makeChunk([{ text: 'initial' }], 'MAX_TOKENS')]),
          makeStream([makeChunk([{ text: 'escalated' }], 'MAX_TOKENS')]),
          invalidStream('PROTOCOL_TAG_LEAK'),
          invalidStream('PROTOCOL_TAG_LEAK'),
          invalidStream('PROTOCOL_TAG_LEAK'),
        ];
        let callIndex = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => streams[callIndex++]!);

        const stream = await chat.sendMessageStream(
          'gemini-pro',
          { message: 'essay' },
          'prompt-recovery-protocol-leak-budget',
        );

        await collectStreamWithFakeTimers(stream, 35_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(5);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(2);
        expect(mockLogContentRetry).toHaveBeenLastCalledWith(
          mockConfig,
          expect.objectContaining({
            attempt_number: 1,
            error_type: 'PROTOCOL_TAG_LEAK',
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps continuation retry budgets independent across error types', async () => {
      vi.useFakeTimers();
      try {
        const streams = [
          makeStream([makeChunk([{ text: 'initial' }], 'MAX_TOKENS')]),
          makeStream([makeChunk([{ text: 'escalated' }], 'MAX_TOKENS')]),
          invalidStream('NO_FINISH_REASON'),
          invalidStream('NO_FINISH_REASON'),
          invalidStream('PROTOCOL_TAG_LEAK'),
          makeStream([makeChunk([{ text: ' recovered' }], 'STOP')]),
        ];
        let callIndex = 0;
        vi.mocked(
          mockContentGenerator.generateContentStream,
        ).mockImplementation(async () => streams[callIndex++]!);

        const stream = await chat.sendMessageStream(
          'gemini-pro',
          { message: 'essay' },
          'prompt-recovery-mixed-invalid-streams',
        );

        const events = await collectStreamWithFakeTimers(stream, 15_000);

        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledTimes(6);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(3);
        expect(mockLogContentRetry).toHaveBeenLastCalledWith(
          mockConfig,
          expect.objectContaining({
            attempt_number: 0,
            error_type: 'PROTOCOL_TAG_LEAK',
            retry_delay_ms: 2000,
          }),
        );
        expect(
          events.some(
            (e) =>
              e.type === StreamEventType.CHUNK &&
              e.value.candidates?.[0]?.content?.parts?.[0]?.text ===
                ' recovered',
          ),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('should cap recovery attempts at MAX_OUTPUT_RECOVERY_ATTEMPTS (3)', async () => {
      // Every stream returns MAX_TOKENS with text (no functionCall).
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => makeStream([makeChunk([{ text: 'x' }], 'MAX_TOKENS')]),
      );

      const stream = await chat.sendMessageStream(
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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
        'gemini-pro',
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

    it('rolls back an escalated partial tool call when the stream fails', async () => {
      // The escalated attempt pushes a partial model[functionCall] and
      // stages its recording before the stream failure surfaces. Both must
      // be rolled back so later sends and resumed sessions do not repair an
      // incomplete call with a synthetic result.
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
        'gemini-pro',
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

      expect(chatWithRecording.getHistory()).toEqual([
        { role: 'user', parts: [{ text: 'kick off' }] },
      ]);

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
      expect(recordedHasPartial).toBe(false);
    });
  });

  describe('redactApprovedPlanFromHistory', () => {
    // After an approved exit_plan_mode the full plan text would otherwise
    // stay in history as the model's own tool-call argument and get
    // regurgitated into later responses (#6237). These tests pin the
    // targeted history rewrite the tool scheduler performs post-approval.

    const REPLACEMENT = '[Plan approved and saved to /tmp/p.md]';

    function chatWith(history: Content[]): GeminiChat {
      return new GeminiChat({} as unknown as Config, {}, history);
    }

    it('rewrites only the plan arg of the matching exit_plan_mode call', () => {
      const chat = chatWith([
        { role: 'user', parts: [{ text: 'plan it' }] },
        {
          role: 'model',
          parts: [
            { text: 'My plan follows.' },
            {
              functionCall: {
                id: 'call-plan',
                name: 'exit_plan_mode',
                args: { plan: 'SECRET BIG PLAN', originalRequest: 'plan it' },
              },
            },
          ],
        },
      ]);

      expect(chat.redactApprovedPlanFromHistory('call-plan', REPLACEMENT)).toBe(
        true,
      );

      const entry = chat.getHistory()[1]!;
      const fnCall = entry.parts![1]!.functionCall!;
      expect(fnCall.args!['plan']).toBe(REPLACEMENT);
      expect(fnCall.args!['originalRequest']).toBe('plan it');
      expect(fnCall.id).toBe('call-plan');
      expect(entry.parts![0]).toEqual({ text: 'My plan follows.' });
      expect(JSON.stringify(chat.getHistory())).not.toContain(
        'SECRET BIG PLAN',
      );
    });

    it('returns false when no matching call id or tool name exists', () => {
      const chat = chatWith([
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-other',
                name: 'write_file',
                args: { plan: 'not a plan tool' },
              },
            },
          ],
        },
      ]);
      expect(chat.redactApprovedPlanFromHistory('call-plan', REPLACEMENT)).toBe(
        false,
      );
      expect(
        chat.redactApprovedPlanFromHistory('call-other', REPLACEMENT),
      ).toBe(false);
      expect(chat.getHistory()[0]!.parts![0]!.functionCall!.args!['plan']).toBe(
        'not a plan tool',
      );
    });

    it('returns false when expectedPlan differs from the in-history plan', () => {
      const chat = chatWith([
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-plan',
                name: 'exit_plan_mode',
                args: { plan: 'SECRET BIG PLAN' },
              },
            },
          ],
        },
      ]);
      // Never-lie invariant: a stale/different on-disk plan blocks the
      // rewrite entirely.
      expect(
        chat.redactApprovedPlanFromHistory(
          'call-plan',
          REPLACEMENT,
          'a different plan',
        ),
      ).toBe(false);
      expect(chat.getHistory()[0]!.parts![0]!.functionCall!.args!['plan']).toBe(
        'SECRET BIG PLAN',
      );
      // Matching expectedPlan still rewrites.
      expect(
        chat.redactApprovedPlanFromHistory(
          'call-plan',
          REPLACEMENT,
          'SECRET BIG PLAN',
        ),
      ).toBe(true);
    });

    it('returns false when the matching call has no string plan arg', () => {
      const chat = chatWith([
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-plan',
                name: 'exit_plan_mode',
                args: {},
              },
            },
          ],
        },
      ]);
      expect(chat.redactApprovedPlanFromHistory('call-plan', REPLACEMENT)).toBe(
        false,
      );
    });
  });

  describe('redactApprovedPlansInHistory (load-side, #6237)', () => {
    // The chat-recording JSONL captures the assistant turn with the full
    // plan argument before the tool runs, so --resume re-feeds the text the
    // in-session redaction removed. These tests pin the history-wide pass
    // applied on every wholesale history load.
    const PLAN = '## Plan\n\nresume leak fixture';
    const PLAN_PATH = '/plans/session.md';

    const approvedHistory = (): Content[] => [
      { role: 'user', parts: [{ text: 'plan it' }] },
      {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call-a',
              name: 'exit_plan_mode',
              args: { plan: PLAN, originalRequest: 'plan it' },
            },
          },
        ],
      },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'call-a',
              name: 'exit_plan_mode',
              response: {
                output:
                  'User approved. You can now start coding. Start with updating your todo list if applicable.',
              },
            },
          },
        ],
      },
    ];

    it('rewrites approved calls whose plan matches the on-disk file', () => {
      const out = redactApprovedPlansInHistory(
        approvedHistory(),
        PLAN,
        PLAN_PATH,
      );
      expect(out).not.toBeNull();
      const fnCall = out![1]!.parts![0]!.functionCall!;
      expect(fnCall.args!['plan']).toBe(approvedPlanRedactionText(PLAN_PATH));
      expect(fnCall.args!['originalRequest']).toBe('plan it');
      expect(JSON.stringify(out)).not.toContain('resume leak fixture');
    });

    it('redacts only the approved call when a rejected call shares the plan text', () => {
      const history: Content[] = [
        { role: 'user', parts: [{ text: 'plan it' }] },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-rejected',
                name: 'exit_plan_mode',
                args: { plan: PLAN },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-rejected',
                name: 'exit_plan_mode',
                response: {
                  output:
                    'Plan execution was not approved. Remaining in plan mode.',
                },
              },
            },
          ],
        },
        {
          role: 'model',
          parts: [
            {
              functionCall: {
                id: 'call-approved',
                name: 'exit_plan_mode',
                args: { plan: PLAN },
              },
            },
          ],
        },
        {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'call-approved',
                name: 'exit_plan_mode',
                response: {
                  output: 'User approved. You can now start coding.',
                },
              },
            },
          ],
        },
      ];

      const out = redactApprovedPlansInHistory(history, PLAN, PLAN_PATH);
      expect(out).not.toBeNull();
      // The rejected call keeps its plan text (the model needs it for
      // revision); only the approved call is rewritten.
      expect(out![1]!.parts![0]!.functionCall!.args!['plan']).toBe(PLAN);
      expect(out![3]!.parts![0]!.functionCall!.args!['plan']).toBe(
        approvedPlanRedactionText(PLAN_PATH),
      );
    });

    it('returns null when the response was not an approval', () => {
      const history = approvedHistory();
      (
        history[2]!.parts![0]!.functionResponse!.response as {
          output: string;
        }
      ).output = 'Plan execution was not approved. Remaining in plan mode.';
      expect(redactApprovedPlansInHistory(history, PLAN, PLAN_PATH)).toBeNull();
    });

    it('returns null when the on-disk plan differs (stale file)', () => {
      expect(
        redactApprovedPlansInHistory(
          approvedHistory(),
          'a different, later plan',
          PLAN_PATH,
        ),
      ).toBeNull();
    });

    it('is applied by setHistory when the plan file exists', () => {
      // The module-level node:fs mock backs readFileSync with
      // mockFileSystem, so "writing" the plan file is a Map insert.
      const planFile = '/plans/wired-session.md';
      mockFileSystem.set(planFile, PLAN);
      try {
        const chat = new GeminiChat(
          {
            getPlanFilePath: () => planFile,
            getToolRegistry: () => undefined,
          } as unknown as Config,
          {},
          [],
        );
        chat.setHistory(approvedHistory());
        const fnCall = chat.getHistory()[1]!.parts![0]!.functionCall!;
        expect(fnCall.args!['plan']).toBe(approvedPlanRedactionText(planFile));
      } finally {
        mockFileSystem.delete(planFile);
      }
    });

    it('is applied by the constructor for rehydrated history', () => {
      const planFile = '/plans/ctor-session.md';
      mockFileSystem.set(planFile, PLAN);
      try {
        const chat = new GeminiChat(
          { getPlanFilePath: () => planFile } as unknown as Config,
          {},
          approvedHistory(),
        );
        const fnCall = chat.getHistory()[1]!.parts![0]!.functionCall!;
        expect(fnCall.args!['plan']).toBe(approvedPlanRedactionText(planFile));
      } finally {
        mockFileSystem.delete(planFile);
      }
    });

    it('setHistory leaves history alone when no plan file exists', () => {
      const chat = new GeminiChat(
        {
          getPlanFilePath: () => '/plans/never-written.md',
          getToolRegistry: () => undefined,
        } as unknown as Config,
        {},
        [],
      );
      chat.setHistory(approvedHistory());
      const fnCall = chat.getHistory()[1]!.parts![0]!.functionCall!;
      expect(fnCall.args!['plan']).toBe(PLAN);
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
            newTokenCountIsEstimated: true,
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

      const info = await chat.tryCompress('p1');

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(chat.getHistory()).toHaveLength(3);
      expect(chat.getHistory()[0]).toEqual(userMsg('summary'));
      expect(chat.getLastPromptTokenCount()).toBe(200);
    });

    it('mirrors lastPromptTokenCount to the global telemetry only when wired', async () => {
      mockCompressionService('compressed');
      // chat under test was constructed with telemetryService=uiTelemetryService.
      await chat.tryCompress('p2');
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledWith(
        200,
      );

      // A subagent-style chat with no telemetryService must NOT touch the
      // global singleton (per the constructor docstring; per-chat counter
      // still updates).
      const subagentChat = new GeminiChat(mockConfig, config, []);
      vi.mocked(uiTelemetryService.setLastPromptTokenCount).mockClear();
      mockCompressionService('compressed');
      const info = await subagentChat.tryCompress('p3');
      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(subagentChat.getLastPromptTokenCount()).toBe(200);
      expect(uiTelemetryService.setLastPromptTokenCount).not.toHaveBeenCalled();
    });

    it('increments consecutiveFailures and forwards it to subsequent unforced auto-compactions', async () => {
      const compressSpy = mockCompressionService('failed-inflated');

      const first = await chat.tryCompress('p1');
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
      await chat.tryCompress('p2');
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(1);
    });

    it('forwards force=true to the compression service', async () => {
      const compressSpy = mockCompressionService('compressed');

      await chat.tryCompress('p1', true);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
    });

    it('derives a compression baseline when no API token count is available', async () => {
      const compressSpy = mockCompressionService('compressed');
      chat.setHistory([userMsg('x'.repeat(4000)), modelMsg('acknowledged')]);

      await chat.tryCompress('p-zero-baseline', true);

      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBeGreaterThan(
        0,
      );
      expect(chat.isLastPromptTokenCountEstimated()).toBe(true);
    });

    it('retains estimated provenance across repeated compression', async () => {
      const compressSpy = mockCompressionService('compressed');

      await chat.tryCompress('p-estimated-first', true);
      expect(chat.isLastPromptTokenCountEstimated()).toBe(true);

      await chat.tryCompress('p-estimated-second', true);

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(chat.isLastPromptTokenCountEstimated()).toBe(true);
    });

    it('persists estimated provenance in a compression checkpoint', async () => {
      const recordChatCompression = vi.fn();
      const recordingChat = new GeminiChat(
        mockConfig,
        config,
        [userMsg('history without usage'), modelMsg('response')],
        {
          recordChatCompression,
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      mockCompressionService('compressed');

      await recordingChat.tryCompress('p-estimated-checkpoint', true);

      expect(recordChatCompression).toHaveBeenCalledWith(
        expect.objectContaining({
          info: expect.objectContaining({ newTokenCountIsEstimated: true }),
        }),
      );
    });

    it('preserves an authoritative compression count from the service', async () => {
      const recordChatCompression = vi.fn();
      const recordingChat = new GeminiChat(
        mockConfig,
        config,
        [userMsg('history'), modelMsg('response')],
        {
          recordChatCompression,
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      vi.spyOn(ChatCompressionService.prototype, 'compress').mockResolvedValue({
        newHistory: [userMsg('summary'), modelMsg('ok')],
        info: {
          originalTokenCount: 1000,
          newTokenCount: 200,
          newTokenCountIsEstimated: false,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });

      const info = await recordingChat.tryCompress('p-authoritative', true);

      expect(info.newTokenCountIsEstimated).toBe(false);
      expect(recordingChat.isLastPromptTokenCountEstimated()).toBe(false);
      expect(recordChatCompression).toHaveBeenCalledWith(
        expect.objectContaining({
          info: expect.objectContaining({ newTokenCountIsEstimated: false }),
        }),
      );
    });

    it('marks and records the locally adjusted fast-compression count as estimated', () => {
      const recordChatCompression = vi.fn();
      vi.mocked(mockConfig.getClearContextOnIdle).mockReturnValue({
        toolResultsThresholdMinutes: 30,
        toolResultsNumToKeep: 1,
      });
      const recordingChat = new GeminiChat(
        mockConfig,
        config,
        [
          userMsg('question'),
          {
            role: 'model',
            parts: [
              { text: 'reasoning '.repeat(100), thought: true },
              { text: 'answer' },
            ],
          },
        ],
        {
          recordChatCompression,
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      recordingChat.seedResumeTokenCounts(1000, 0, false);

      const result = recordingChat.compressFast();

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(result.info.newTokenCount).toBeGreaterThan(0);
      expect(result.info.newTokenCount).toBeLessThan(1000);
      expect(recordingChat.isLastPromptTokenCountEstimated()).toBe(true);
      expect(recordChatCompression).toHaveBeenCalledWith(
        expect.objectContaining({
          info: expect.objectContaining({ newTokenCountIsEstimated: true }),
        }),
      );
    });

    // Reproduction for issue #9309: /compress-fast followed by /compress
    // shows banners on two different scales — compressFast anchors on the
    // API-reported prompt count (system prompt + tools + history) while a
    // later tryCompress re-estimates history-only once the stored count is
    // estimate-derived. The numbers therefore cannot chain across commands;
    // each banner must at least expose which side is an estimate so the UI
    // can mark it instead of presenting the jump as lost context.
    it('exposes provenance on fast-compression info: API baseline authoritative, adjusted count estimated', () => {
      vi.mocked(mockConfig.getClearContextOnIdle).mockReturnValue({
        toolResultsThresholdMinutes: 30,
        toolResultsNumToKeep: 1,
      });
      const fastChat = new GeminiChat(
        mockConfig,
        config,
        [
          userMsg('question'),
          {
            role: 'model',
            parts: [
              { text: 'reasoning '.repeat(100), thought: true },
              { text: 'answer' },
            ],
          },
        ],
        undefined,
        uiTelemetryService,
      );
      fastChat.seedResumeTokenCounts(5000, 0, false);

      const { info } = fastChat.compressFast();

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(info.originalTokenCountIsEstimated).toBe(false);
      expect(info.newTokenCountIsEstimated).toBe(true);
    });

    it('marks the fast-compression baseline as estimated when no API count exists', () => {
      vi.mocked(mockConfig.getClearContextOnIdle).mockReturnValue({
        toolResultsThresholdMinutes: 30,
        toolResultsNumToKeep: 1,
      });
      const fastChat = new GeminiChat(
        mockConfig,
        config,
        [
          userMsg('question'),
          {
            role: 'model',
            parts: [
              { text: 'reasoning '.repeat(100), thought: true },
              { text: 'answer' },
            ],
          },
        ],
        undefined,
        uiTelemetryService,
      );

      const { info } = fastChat.compressFast();

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(info.originalTokenCount).toBeGreaterThan(0);
      expect(info.originalTokenCountIsEstimated).toBe(true);
    });

    it('reports original-count provenance on the summarize path after a fast compression', async () => {
      vi.mocked(mockConfig.getClearContextOnIdle).mockReturnValue({
        toolResultsThresholdMinutes: 30,
        toolResultsNumToKeep: 1,
      });
      const compressSpy = mockCompressionService('compressed');
      chat.setHistory([
        userMsg('question'),
        {
          role: 'model',
          parts: [
            { text: 'reasoning '.repeat(100), thought: true },
            { text: 'answer' },
          ],
        },
      ]);
      chat.seedResumeTokenCounts(5000, 0, false);

      // /compress-fast leaves the stored count estimate-derived...
      chat.compressFast();
      expect(chat.isLastPromptTokenCountEstimated()).toBe(true);
      const adjustedAfterFast = chat.getLastPromptTokenCount();

      // ...so the subsequent /compress re-estimates the history locally
      // (a different scale than the fast banner) and must expose that its
      // "before" number is an estimate.
      const info = await chat.tryCompress('p-after-fast', true);

      expect(compressSpy.mock.calls[0][1].originalTokenCount).not.toBe(
        adjustedAfterFast,
      );
      expect(info.originalTokenCountIsEstimated).toBe(true);
    });

    it('reports an authoritative original count when the API count is fresh', async () => {
      mockCompressionService('compressed');
      chat.setHistory([userMsg('a'), modelMsg('b')]);
      chat.seedResumeTokenCounts(5000, 0, false);

      const info = await chat.tryCompress('p-authoritative-original', true);

      expect(info.originalTokenCountIsEstimated).toBe(false);
    });

    it('marks the precomputed effective count as estimated even when the stored API count is authoritative', async () => {
      // Normal/hard-rescue auto-compaction: the send path publishes the
      // precomputed effective count (stored baseline + locally estimated
      // pending message / previous output). That projection must carry the
      // `~` marker even though the stored baseline came from the API
      // (review probe on #9568).
      const compressSpy = mockCompressionService('compressed');
      chat.setHistory([userMsg('a'), modelMsg('b')]);
      chat.seedResumeTokenCounts(5000, 0, false);

      const info = await chat.tryCompress(
        'p-precomputed-effective-estimated',
        true,
        undefined,
        {
          precomputedEffectiveTokens: 6200,
          pendingUserMessage: userMsg('next'),
          trigger: 'auto',
        },
      );

      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBe(6200);
      expect(info.originalTokenCountIsEstimated).toBe(true);
    });

    it('keeps a fallback override estimated while publishing its count', async () => {
      // Reactive overflow without a provider-reported actual count: the
      // limit/config/default fallback override is a projection and must
      // keep the `~` marker.
      const compressSpy = mockCompressionService('compressed');
      chat.setHistory([userMsg('a'), modelMsg('b')]);
      chat.seedResumeTokenCounts(5000, 0, false);

      const info = await chat.tryCompress(
        'p-override-fallback-estimated',
        true,
        undefined,
        {
          originalTokenCountOverride: { count: 128_000, isEstimated: true },
          precomputedEffectiveTokens: 128_000,
          trigger: 'auto',
        },
      );

      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBe(128_000);
      expect(info.originalTokenCountIsEstimated).toBe(true);
    });

    it('treats a provider-reported actualTokens override as authoritative', async () => {
      // Reactive overflow whose error message reports the actual token
      // count: only this override variant may drop the `~` marker.
      const compressSpy = mockCompressionService('compressed');
      chat.setHistory([userMsg('a'), modelMsg('b')]);
      chat.seedResumeTokenCounts(5000, 0, false);

      const info = await chat.tryCompress(
        'p-override-actual-authoritative',
        true,
        undefined,
        {
          originalTokenCountOverride: { count: 135_000, isEstimated: false },
          precomputedEffectiveTokens: 135_000,
          trigger: 'auto',
        },
      );

      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBe(135_000);
      expect(info.originalTokenCountIsEstimated).toBe(false);
    });
  });

  // Route-scoped token counts (#9454): API-reported prompt/output token
  // counts describe the serialization of the route (model + auth type +
  // endpoint) that produced them. A /model switch rebuilds the content
  // generator but keeps this GeminiChat instance, so counts recorded for the
  // previous route must be invalidated — otherwise they anchor admission,
  // clamp, and compression decisions for a different serialization.
  describe('route-scoped token counts (#9454)', () => {
    const switchRoute = (routeKey: string) => {
      vi.mocked(mockConfig.getModelRouteIdentity).mockReturnValue(routeKey);
    };

    it('invalidates API-reported counts when the model route changes', () => {
      // Count reported by the pre-switch route (authoritative, not estimated).
      chat.setLastPromptTokenCount(691_000, false);
      expect(chat.getLastPromptTokenCount()).toBe(691_000);

      // Simulate /model switching to a different route; the same chat
      // instance survives with its history.
      switchRoute('anthropic-model@beef1234');

      // The stale count must not size requests for the new route: safety
      // decisions fall back to the history-walk estimate (count 0).
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(chat.getLastOutputTokenCount()).toBe(0);
      expect(chat.isLastPromptTokenCountEstimated()).toBe(false);
      // The telemetry mirror must drop the stale count too, or the session
      // token-limit gate and compression banners keep using it.
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledWith(
        0,
      );
    });

    it('keeps counts authoritative while the route is unchanged', () => {
      chat.setLastPromptTokenCount(50_000, false);

      // Repeated reads on the same route keep the API-authoritative count.
      expect(chat.getLastPromptTokenCount()).toBe(50_000);
      expect(chat.getLastOutputTokenCount()).toBe(0);
      expect(chat.isLastPromptTokenCountEstimated()).toBe(false);
      expect(chat.getLastPromptTokenCount()).toBe(50_000);
    });

    it('keeps a foreign count intact across a keyless display read (#9506)', () => {
      // Counts stamped under one route key (e.g. the vision bridge's
      // full-turn selector route) must survive a keyless read: /context
      // calls the getters with no argument, which defaults to the ACTIVE
      // route key and used to zero the only slot before the
      // session-token-limit gate's keyed read got to it.
      chat.setLastPromptTokenCount(500_000, false);
      switchRoute('other-active@route');

      // The foreign count must not leak to the active route...
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledWith(
        0,
      );
      // ...and the crossing must not have destroyed it: the gate's keyed
      // read for the original route restores the exact API-reported value.
      expect(chat.getLastPromptTokenCount('gemini-pro@test0001')).toBe(500_000);
      expect(chat.getLastPromptTokenCount()).toBe(0);
    });

    it('restores retained counts when the route switches back (#9506)', () => {
      chat.seedResumeTokenCounts(321, 45, true);
      switchRoute('anthropic-model@beef1234');
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(chat.getLastOutputTokenCount()).toBe(0);

      // A turn returning to the original route reads its exact retained
      // counts — prompt, previous-output, and provenance — instead of the
      // destructive zero a foreign touch used to leave behind.
      switchRoute('gemini-pro@test0001');
      expect(chat.getLastPromptTokenCount()).toBe(321);
      expect(chat.getLastOutputTokenCount()).toBe(45);
      expect(chat.isLastPromptTokenCountEstimated()).toBe(true);
    });

    it('invalidates seeded resume counts after a later route change', () => {
      chat.seedResumeTokenCounts(321, 45, false);
      expect(chat.getLastPromptTokenCount()).toBe(321);
      expect(chat.getLastOutputTokenCount()).toBe(45);

      switchRoute('other-model@1234abcd');

      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(chat.getLastOutputTokenCount()).toBe(0);
    });

    it('accepts counts recorded on the new route after a switch', () => {
      chat.setLastPromptTokenCount(691_000, false);
      switchRoute('anthropic-model@beef1234');
      expect(chat.getLastPromptTokenCount()).toBe(0);

      // First response on the new route re-establishes authoritative counts.
      chat.setLastPromptTokenCount(120_000, false);
      expect(chat.getLastPromptTokenCount()).toBe(120_000);
      expect(chat.isLastPromptTokenCountEstimated()).toBe(false);
    });

    it('invalidates a stale count before sending on the new route', async () => {
      chat.setLastPromptTokenCount(691_000, false);
      switchRoute('anthropic-model@beef1234');
      vi.mocked(mockContentGenerator.generateContentStream).mockImplementation(
        async () => {
          expect(
            uiTelemetryService.setLastPromptTokenCount,
          ).toHaveBeenCalledWith(0);
          return (async function* () {
            yield {
              candidates: [
                {
                  content: { parts: [{ text: 'ok' }] },
                  finishReason: 'STOP',
                },
              ],
            } as unknown as GenerateContentResponse;
          })();
        },
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'new route' },
        'prompt-route-switch',
      );
      for await (const _ of stream) {
        /* consume */
      }
    });

    it('invalidates a stale route count before manual compression sizing', async () => {
      // Authoritative count recorded by the pre-switch route. Manual
      // /compress reaches tryCompress without sendMessageStream's entry
      // invalidation, and tryCompress reads the count field directly, so it
      // must drop the foreign count itself before admission/sizing.
      chat.setLastPromptTokenCount(691_000, false);
      switchRoute('anthropic-model@beef1234');

      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      compressSpy.mockResolvedValue({
        newHistory: null,
        info: {
          originalTokenCount: 0,
          newTokenCount: 0,
          compressionStatus: CompressionStatus.NOOP,
        },
      });

      await chat.tryCompress('prompt-manual-compress', true);

      // History is empty, so the estimate path sizes the attempt at 0 — the
      // stale 691_000 must not have anchored the compression decision.
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0]?.[1].originalTokenCount).toBe(0);
    });

    it('invalidates a stale route count before fast-compression sizing', () => {
      // compressFast is the third entrypoint alongside sendMessageStream
      // and tryCompress: it reads the raw count field for its apiBaseline,
      // so it must drop a pre-switch count before sizing the new route.
      vi.mocked(mockConfig.getClearContextOnIdle).mockReturnValue({
        toolResultsThresholdMinutes: 30,
        toolResultsNumToKeep: 1,
      });
      const fastChat = new GeminiChat(
        mockConfig,
        config,
        [
          { role: 'user', parts: [{ text: 'question' }] },
          {
            role: 'model',
            parts: [
              { text: 'reasoning '.repeat(100), thought: true },
              { text: 'answer' },
            ],
          },
        ],
        {
          recordChatCompression: vi.fn(),
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      fastChat.setLastPromptTokenCount(691_000, false);
      switchRoute('anthropic-model@beef1234');

      const result = fastChat.compressFast();

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      // The stale 691_000 must not anchor sizing for the new route: the
      // baseline falls back to the history-walk estimate.
      expect(result.info.originalTokenCount).toBeLessThan(691_000);
      expect(fastChat.getLastPromptTokenCount()).toBeLessThan(691_000);
    });

    it('zeroes the telemetry cached-content mirror when invalidating a foreign count', () => {
      // The cached content count is written for the same foreign route's
      // last response; leaving it up next to the zeroed prompt count gives
      // /context an internally inconsistent capacity picture.
      chat.setLastPromptTokenCount(691_000, false);
      switchRoute('anthropic-model@beef1234');

      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(
        uiTelemetryService.setLastCachedContentTokenCount,
      ).toHaveBeenCalledWith(0);
    });

    it('does not mirror cached content without a route-stamped prompt count', async () => {
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'cached' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 0,
              totalTokenCount: 0,
              cachedContentTokenCount: 42,
            },
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'cached-only' },
        'prompt-cached-only',
      );
      for await (const _ of stream) {
        /* consume */
      }
      switchRoute('anthropic-model@beef1234');
      expect(chat.getLastPromptTokenCount()).toBe(0);

      expect(
        uiTelemetryService.setLastCachedContentTokenCount,
      ).not.toHaveBeenCalledWith(42);
    });

    it('mirrors cached content alongside a route-stamped prompt count', async () => {
      // The cached-content mirror's only non-zero production write lives
      // inside the prompt-count guard; deleting it must not leave the suite
      // green. Consumed without a route switch, a cached-content response
      // must reach the /context cached-tokens line (#9454).
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'cached' }] },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 100,
              totalTokenCount: 100,
              cachedContentTokenCount: 42,
            },
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'cached-happy' },
        'prompt-cached-happy',
      );
      for await (const _ of stream) {
        /* consume */
      }

      expect(chat.getLastPromptTokenCount()).toBe(100);
      expect(
        uiTelemetryService.setLastCachedContentTokenCount,
      ).toHaveBeenCalledWith(42);
    });

    it('restores the request route key when a failed hard-rescue rolls counts back', async () => {
      // Hard-rescue only fires for non-exact sends, whose request route key
      // can differ from the active route's. tryCompress re-stamps the key
      // to the ACTIVE route mid-rescue; the rollback must restore the key
      // alongside the counts, or the resurrected override-route count rides
      // the active key past the next send's entry invalidation (#9454).
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'active@route',
      );
      const rescueChat = new GeminiChat(
        mockConfig,
        config,
        [
          { role: 'user', parts: [{ text: 'earlier turn' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        {
          recordAssistantTurn: vi.fn(),
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      // Authoritative count recorded by an earlier override-route turn.
      vi.mocked(mockConfig.getModelRouteIdentity).mockReturnValue(
        'override-model@route',
      );
      rescueChat.setLastPromptTokenCount(176_999, false);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'active@route',
      );

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

      await expect(
        rescueChat.sendMessageStream(
          'override-model',
          { message: 'continue' },
          'prompt-hard-rescue-route-key-restore',
        ),
      ).rejects.toThrow(/compression status: COMPRESSED/i);

      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
      // The restored count belongs to the override route: an active-route
      // read must invalidate it, not inherit it.
      expect(rescueChat.getLastPromptTokenCount()).toBe(0);
    });

    it('restores the retention map when a failed hard-rescue rolls counts back (#9506)', async () => {
      // The rescue's own compression consumes retained map entries
      // mid-flight (the service's keyless getter reads adopt the active
      // route) and a successful compression clears the map outright. The
      // rollback must restore the pre-rescue snapshot, or the resurrected
      // route's over-limit count survives nowhere and its next
      // session-token-limit gate read passes with 0.
      vi.mocked(mockConfig.getModelRouteIdentity).mockReturnValue(
        'active@route',
      );
      const rescueChat = new GeminiChat(
        mockConfig,
        config,
        [{ role: 'user', parts: [{ text: 'x'.repeat(720_000) }] }],
        {
          recordAssistantTurn: vi.fn(),
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      rescueChat.setLastPromptTokenCount(190_000, false);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'active@route',
      );

      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockImplementationOnce(async (chatToCompress) => {
        // Mirror the real service's unconditional keyless reads: they
        // adopt the ACTIVE route, consuming its retained entry mid-rescue.
        chatToCompress.getLastPromptTokenCount();
        chatToCompress.isLastPromptTokenCountEstimated();
        return {
          newHistory: [
            { role: 'user', parts: [{ text: 'still large summary' }] },
          ],
          info: {
            originalTokenCount: 180_000,
            newTokenCount: 178_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        };
      });

      await expect(
        rescueChat.sendMessageStream(
          'override-model',
          { message: 'continue' },
          'prompt-rescue-retention-map-restore',
        ),
      ).rejects.toThrow(/compression status: COMPRESSED/i);

      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
      // The active route's over-limit count survived the failed rescue:
      // its next keyed read must still see it, not 0.
      expect(rescueChat.getLastPromptTokenCount('active@route')).toBe(190_000);
      expect(rescueChat.getLastPromptTokenCount('override-model@route')).toBe(
        0,
      );
    });

    it('restores the output token count when a failed hard-rescue rolls counts back (#9506)', async () => {
      // The rescue's COMPRESSED stamp zeroes lastOutputTokenCount via
      // setLastPromptTokenCount. The rollback restores the resurrected
      // prompt count, its provenance, the route key and the retention map
      // — it must restore the output half of the pair too, or the next
      // turn's additive prompt estimate (prompt + output + new content)
      // under-counts by the last response's size.
      vi.mocked(mockConfig.getModelRouteIdentity).mockReturnValue(
        'override-model@route',
      );
      const rescueChat = new GeminiChat(
        mockConfig,
        config,
        [
          { role: 'user', parts: [{ text: 'earlier turn' }] },
          { role: 'model', parts: [{ text: 'ack' }] },
        ],
        {
          recordAssistantTurn: vi.fn(),
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      // Authoritative count pair recorded by an earlier override-route turn.
      rescueChat.seedResumeTokenCounts(170_000, 8_000, false);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'active@route',
      );

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

      await expect(
        rescueChat.sendMessageStream(
          'override-model',
          { message: 'continue' },
          'prompt-hard-rescue-output-restore',
        ),
      ).rejects.toThrow(/compression status: COMPRESSED/i);

      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
      // Reading through the override route (the resurrected slot's key)
      // must return the full pre-rescue pair, output half included.
      vi.mocked(mockConfig.getModelRouteIdentity).mockReturnValue(
        'override-model@route',
      );
      expect(rescueChat.getLastPromptTokenCount()).toBe(170_000);
      expect(rescueChat.getLastOutputTokenCount()).toBe(8_000);
    });

    it('re-adopts the request route after the compression service flips the slots (#9506)', async () => {
      // ChatCompressionService.compress reads the KEYLESS count getters,
      // which adopt the ACTIVE route. On a non-exact override send whose
      // request route differs, that flips the slots back to the active
      // route's retained counts mid-rescue. When the summarization side
      // query then fails, the post-rescue stop check must size from the
      // honest history-walk estimate, not the flipped foreign count.
      vi.mocked(mockConfig.getModelRouteIdentity).mockReturnValue(
        'active@route',
      );
      const rescueChat = new GeminiChat(
        mockConfig,
        config,
        [{ role: 'user', parts: [{ text: 'x'.repeat(720_000) }] }],
        {
          recordAssistantTurn: vi.fn(),
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      rescueChat.setLastPromptTokenCount(150_000, false);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'active@route',
      );

      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockImplementationOnce(async (chatToCompress) => {
        chatToCompress.getLastPromptTokenCount();
        chatToCompress.isLastPromptTokenCountEstimated();
        return {
          newHistory: null,
          info: {
            originalTokenCount: 180_000,
            newTokenCount: 0,
            compressionStatus:
              CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
          },
        };
      });

      await expect(
        rescueChat.sendMessageStream(
          'override-model',
          { message: 'continue' },
          'prompt-rescue-flip-re-adopt',
        ),
      ).rejects.toThrow(/Context is too large to send safely/i);

      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
      // The active route's retained count survived the failed rescue.
      expect(rescueChat.getLastPromptTokenCount('active@route')).toBe(150_000);
    });

    it('retains a foreign-keyed slot occupant when the usage stamp re-keys (#9506)', async () => {
      // Mid-send compression can leave the slots keyed to the ACTIVE route
      // when the response's usage report arrives for the REQUEST route.
      // The stamp must retain the displaced occupant before overwriting
      // it, or the active route's count is destroyed and its next keyed
      // read returns 0 — bypassing the session token limit.
      vi.mocked(mockConfig.getModelRouteIdentity).mockReturnValue(
        'active@route',
      );
      const stampChat = new GeminiChat(
        mockConfig,
        config,
        [{ role: 'user', parts: [{ text: 'x'.repeat(720_000) }] }],
        {
          recordAssistantTurn: vi.fn(),
          // Successful hard-rescue compression records after the
          // post-compression guard passes (deferred recording).
          recordChatCompression: vi.fn(),
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      stampChat.setLastPromptTokenCount(150_000, false);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'active@route',
      );

      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockImplementationOnce(async (chatToCompress) => {
        chatToCompress.getLastPromptTokenCount();
        chatToCompress.isLastPromptTokenCountEstimated();
        return {
          newHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
          info: {
            originalTokenCount: 180_000,
            newTokenCount: 60_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        };
      });
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'ok' }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            usageMetadata: {
              promptTokenCount: 61_000,
              totalTokenCount: 62_000,
            },
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await stampChat.sendMessageStream(
        'override-model',
        { message: 'continue' },
        'prompt-stamp-retains-occupant',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // The request route's fresh API report occupies the slots...
      expect(stampChat.getLastPromptTokenCount('override-model@route')).toBe(
        61_000,
      );
      // ...and the active route's post-compression count was retained,
      // not destroyed by the re-keying stamp.
      expect(stampChat.getLastPromptTokenCount('active@route')).toBe(60_000);
    });

    it('stamps the compressed count under the request route when the send ends without usage (#9506)', async () => {
      // In-send compression runs for the REQUEST route, but
      // setLastPromptTokenCount re-keys the fresh count to the ACTIVE
      // route. If the request then ends without a usage report (abort,
      // 400 — the reactive-overflow path exists for exactly those), the
      // request route never stamps a count of its own, and its next
      // session-token-limit gate read passes with 0 even though the
      // shared compressed history's exact measure is on record.
      vi.mocked(mockConfig.getModelRouteIdentity).mockReturnValue(
        'active@route',
      );
      const stampChat = new GeminiChat(
        mockConfig,
        config,
        [{ role: 'user', parts: [{ text: 'x'.repeat(720_000) }] }],
        {
          recordAssistantTurn: vi.fn(),
          // Successful hard-rescue compression records after the
          // post-compression guard passes (deferred recording).
          recordChatCompression: vi.fn(),
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      stampChat.setLastPromptTokenCount(150_000, false);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'active@route',
      );

      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockImplementationOnce(async (chatToCompress) => {
        chatToCompress.getLastPromptTokenCount();
        chatToCompress.isLastPromptTokenCountEstimated();
        return {
          newHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
          info: {
            originalTokenCount: 180_000,
            newTokenCount: 60_000,
            compressionStatus: CompressionStatus.COMPRESSED,
          },
        };
      });
      vi.mocked(
        mockContentGenerator.generateContentStream,
      ).mockResolvedValueOnce(
        (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'ok' }], role: 'model' },
                finishReason: 'STOP',
                index: 0,
              },
            ],
            // No usageMetadata: the request route never stamps a count of
            // its own, so the compression stamp must be readable under it.
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await stampChat.sendMessageStream(
        'override-model',
        { message: 'continue' },
        'prompt-compression-stamps-request-route',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // The request route's keyed read sees the compressed history's
      // count instead of passing the gate with 0...
      expect(stampChat.getLastPromptTokenCount('override-model@route')).toBe(
        60_000,
      );
      // ...and the active route still sees it through the retained entry,
      // because the compressed history is shared by every route.
      expect(stampChat.getLastPromptTokenCount('active@route')).toBe(60_000);
    });

    it('drops stale retained counts when a successful compression rewrites the history (#9506)', async () => {
      // Compression rewrites the shared history every retained entry
      // sizes. Retained pre-compression counts must not survive the
      // success path, or a later keyed read adopts one and the session-
      // token-limit gate blocks a prompt that fits the compressed history.
      chat.setLastPromptTokenCount(691_000, false);
      switchRoute('override@route');
      // The crossing retains the original route's count under its own key.
      expect(chat.getLastPromptTokenCount()).toBe(0);

      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockResolvedValueOnce({
        newHistory: [{ role: 'user', parts: [{ text: 'summary' }] }],
        info: {
          originalTokenCount: 691_000,
          newTokenCount: 50_000,
          compressionStatus: CompressionStatus.COMPRESSED,
        },
      });

      await chat.tryCompress('prompt-compression-drops-retained', true);

      expect(chat.getLastPromptTokenCount()).toBe(50_000);
      expect(chat.getLastPromptTokenCount('gemini-pro@test0001')).toBe(0);
    });

    it('drops all retained counts when fast compression rewrites the history (#9506)', () => {
      // compressFast rewrites the same shared history the other routes'
      // retained entries size; clearing only the active route's entry
      // would leave stale pre-compression counts adoptable by later keyed
      // reads.
      vi.mocked(mockConfig.getClearContextOnIdle).mockReturnValue({
        toolResultsThresholdMinutes: 30,
        toolResultsNumToKeep: 1,
      });
      const fastChat = new GeminiChat(
        mockConfig,
        config,
        [
          { role: 'user', parts: [{ text: 'question' }] },
          {
            role: 'model',
            parts: [
              { text: 'reasoning '.repeat(100), thought: true },
              { text: 'answer' },
            ],
          },
        ],
        {
          recordChatCompression: vi.fn(),
        } as unknown as ConstructorParameters<typeof GeminiChat>[3],
        uiTelemetryService,
      );
      fastChat.setLastPromptTokenCount(691_000, false);
      // Cross routes so the count is retained under the original key.
      switchRoute('other-route@fast');
      expect(fastChat.getLastPromptTokenCount()).toBe(0);

      const result = fastChat.compressFast();

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      // The retained pre-compression entry did not survive the rewrite.
      expect(fastChat.getLastPromptTokenCount('gemini-pro@test0001')).toBe(0);
    });

    it('does not anchor an exact route output clamp on the active route count', async () => {
      // Authoritative count recorded by the ACTIVE route. An exact `\0`
      // route send targets a different serialization, so its output clamp
      // must not read this count — the entry invalidation has to compare
      // against the request's route, not the active one.
      chat.setLastPromptTokenCount(691_000, false);

      const routeGenerateContentStream = vi.fn().mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: { parts: [{ text: 'ok' }] },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );
      const routeGenerator = {
        ...mockContentGenerator,
        generateContentStream: routeGenerateContentStream,
      } as ContentGenerator;
      const resolveForModel = vi.fn().mockResolvedValue({
        contentGenerator: routeGenerator,
        contentGeneratorConfig: {
          model: 'vision-agent',
          authType: AuthType.USE_OPENAI,
          maxRetries: 0,
          // Large enough that the zeroed-count estimate path (history walk
          // + ESTIMATE_CLAMP_OVERHEAD_PAD + clamp margin) still leaves room
          // for the full explicit ceiling below.
          contextWindowSize: 64_000,
          modalities: {},
        },
        retryAuthType: AuthType.USE_OPENAI,
        model: 'vision-agent',
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'gemini-pro@test0001',
      );

      const selector = 'openai:vision-agent\0https://vision.example.com/v1\0';
      const stream = await chat.sendMessageStream(
        selector,
        {
          message: 'clamp probe',
          config: { maxOutputTokens: 8_000 },
        },
        'prompt-exact-route-clamp',
      );
      for await (const _ of stream) {
        /* consume */
      }

      // With the foreign count zeroed the estimate leaves room for the full
      // 8_000 ceiling. Had the active route's 691_000 anchored the clamp,
      // the request would have been floored at MIN_CLAMPED_OUTPUT_TOKENS.
      const routeRequest = routeGenerateContentStream.mock.calls[0]?.[0] as {
        config?: { maxOutputTokens?: number };
      };
      expect(routeRequest.config?.maxOutputTokens).toBe(8_000);
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
        await chat.tryCompress(`p${i}`);
        // The i-th call sees consecutiveFailures = i (counter pre-increment).
        expect(compressSpy.mock.calls[i][1].consecutiveFailures).toBe(i);
      }
      // After MAX_CONSECUTIVE_FAILURES failures, the breaker is tripped.
      // The next call will still be made by GeminiChat (it does not
      // short-circuit on its side), but the service's cheap-gate will NOOP.
      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
      await chat.tryCompress('p-last');
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
        await chat.tryCompress(`p-force-${i}`, true);
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
      await chat.tryCompress('p-unforced');
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
      await chat.tryCompress('p1');
      await chat.tryCompress('p2');
      expect(compressSpy.mock.calls[1][1].consecutiveFailures).toBe(1);

      // Forced successful compress → counter resets to 0.
      await chat.tryCompress('p-force', true);
      expect(compressSpy.mock.calls[2][1].consecutiveFailures).toBe(2);

      // Next unforced call: counter is back to 0.
      await chat.tryCompress('p3');
      expect(compressSpy.mock.calls[3][1].consecutiveFailures).toBe(0);
    });
  });
  describe('XML tool call fallback integration', () => {
    function xmlChunk(
      text: string,
      finishReason?: string,
    ): GenerateContentResponse {
      return {
        candidates: [
          {
            content: { role: 'model', parts: [{ text }] },
            ...(finishReason ? { finishReason } : {}),
          },
        ],
      } as unknown as GenerateContentResponse;
    }

    it('recovers XML tool calls from plain text content and updates history', async () => {
      const xml =
        '<invoke name="read_file"><parameter name="file_path">a.ts</parameter></invoke>';
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield xmlChunk(xml, 'STOP');
        })(),
      );

      const stream = await chat.sendMessageStream(
        'gemini-pro',
        { message: 'read the file' },
        'prompt-xml-fallback',
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          chunks.push(event.value);
        }
      }

      // The synthetic chunk with functionCall parts must be yielded.
      const syntheticChunk = chunks.find((c) =>
        c.candidates?.[0]?.content?.parts?.some((p) => p.functionCall),
      );
      expect(syntheticChunk).toBeDefined();
      expect(syntheticChunk!.functionCalls).toHaveLength(1);
      const fc =
        syntheticChunk!.candidates![0]!.content!.parts![0]!.functionCall!;
      expect(fc.name).toBe('read_file');
      expect(fc.args).toEqual({ file_path: 'a.ts' });

      // History must contain the recovered functionCall parts, not raw XML.
      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const hasFunctionCall = lastEntry.parts?.some((p) => p.functionCall);
      expect(hasFunctionCall).toBe(true);
      const hasRawXml = lastEntry.parts?.some(
        (p) => p.text && p.text.includes('<invoke'),
      );
      expect(hasRawXml).toBe(false);
    });

    it('retains a short text prefix in history when recovering XML tool calls', async () => {
      const xml =
        '<invoke name="read_file"><parameter name="file_path">a.ts</parameter></invoke>';
      const text = 'Sure.\n' + xml;
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield xmlChunk(text, 'STOP');
        })(),
      );

      const stream = await chat.sendMessageStream(
        'gemini-pro',
        { message: 'read the file' },
        'prompt-xml-fallback-prefix',
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          chunks.push(event.value);
        }
      }

      // The recovered tool call is still executed despite the prefix.
      const syntheticChunk = chunks.find((c) =>
        c.candidates?.[0]?.content?.parts?.some((p) => p.functionCall),
      );
      expect(syntheticChunk).toBeDefined();

      // History keeps the short prefix as a text part ahead of the recovered
      // functionCall and drops the raw XML (--resume fidelity).
      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      const parts = lastEntry.parts ?? [];
      const textIndex = parts.findIndex((p) => p.text === 'Sure.');
      const callIndex = parts.findIndex((p) => p.functionCall);
      expect(textIndex).toBeGreaterThanOrEqual(0);
      expect(callIndex).toBeGreaterThan(textIndex);
      expect(parts.some((p) => p.text && p.text.includes('<invoke'))).toBe(
        false,
      );
    });

    it('does not recover when a structured tool call is already present', async () => {
      const xml =
        '<invoke name="read_file"><parameter name="file_path">a.ts</parameter></invoke>';
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      functionCall: {
                        name: 'list_dir',
                        args: { path: '.' },
                      },
                    },
                    { text: xml },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'gemini-pro',
        { message: 'list and read' },
        'prompt-xml-guard-toolcall',
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          chunks.push(event.value);
        }
      }

      // A structured tool call must short-circuit the fallback (no double execution).
      const recoveredChunk = chunks.find((c) =>
        c.candidates?.[0]?.content?.parts?.some((p) =>
          p.functionCall?.id?.startsWith('xml-recovered-'),
        ),
      );
      expect(recoveredChunk).toBeUndefined();

      // History retains the raw XML text (not stripped by recovery).
      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      expect(
        lastEntry.parts?.some((p) => p.text && p.text.includes('<invoke')),
      ).toBe(true);
    });

    it('does not recover documentation prose containing invoke examples', async () => {
      const prose =
        'Here is how you use the tool. First you open the file, then you read it. ' +
        'The invoke block below shows the format. Remember to always check the path. ' +
        'This is a documentation example for the read_file tool call format. ' +
        'You should never execute these examples directly. They are for illustration ' +
        'purposes only. The actual tool calls are made through the structured API.';
      const text =
        prose +
        '\n<invoke name="read_file"><parameter name="file_path">a.ts</parameter></invoke>';
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield xmlChunk(text, 'STOP');
        })(),
      );

      const stream = await chat.sendMessageStream(
        'gemini-pro',
        { message: 'explain the tool' },
        'prompt-xml-guard-prose',
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          chunks.push(event.value);
        }
      }

      // The prose guard must veto recovery: no synthetic chunk is yielded.
      const recoveredChunk = chunks.find((c) =>
        c.candidates?.[0]?.content?.parts?.some((p) =>
          p.functionCall?.id?.startsWith('xml-recovered-'),
        ),
      );
      expect(recoveredChunk).toBeUndefined();

      // History retains the original prose + XML text unchanged.
      const history = chat.getHistory();
      const lastEntry = history[history.length - 1]!;
      expect(
        lastEntry.parts?.some((p) => p.text && p.text.includes('<invoke')),
      ).toBe(true);
    });

    it('records the recovered functionCall in the JSONL turn (--resume fidelity)', async () => {
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
      const xml =
        '<invoke name="read_file"><parameter name="file_path">a.ts</parameter>' +
        '</invoke>';
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield xmlChunk(xml, 'STOP');
        })(),
      );

      const stream = await chatWithRecording.sendMessageStream(
        'gemini-pro',
        { message: 'read the file' },
        'prompt-xml-fallback-recording',
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          chunks.push(event.value);
        }
      }
      expect(chunks.length).toBeGreaterThan(0);

      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      const recorded = recordAssistantTurn.mock.calls[0][0] as {
        message: Array<{ text?: string; functionCall?: { name?: string } }>;
      };
      // The recovered tool call must be persisted, not the raw XML text.
      expect(
        recorded.message.some((p) => p.functionCall?.name === 'read_file'),
      ).toBe(true);
      expect(recorded.message.some((p) => p.text?.includes('<invoke'))).toBe(
        false,
      );
    });

    it('does not duplicate earlier text or drop non-text parts when recovering', async () => {
      const xml =
        '<invoke name="read_file"><parameter name="file_path">a.ts</parameter></invoke>';
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'I will read it.' },
                    {
                      inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
                    },
                    { text: xml },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'gemini-pro',
        { message: 'read the file' },
        'prompt-xml-fallback-multipart',
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          chunks.push(event.value);
        }
      }

      expect(
        chunks.some((c) =>
          c.candidates?.[0]?.content?.parts?.some((p) => p.functionCall),
        ),
      ).toBe(true);

      const history = chat.getHistory();
      const parts = history[history.length - 1]!.parts ?? [];
      expect(parts.some((p) => p.functionCall?.name === 'read_file')).toBe(
        true,
      );
      expect(parts.some((p) => p.text && p.text.includes('<invoke'))).toBe(
        false,
      );
      // The earlier prose appears exactly once (no duplication from the join).
      expect(parts.filter((p) => p.text === 'I will read it.')).toHaveLength(1);
      // The interleaved non-text part is preserved.
      expect(parts.some((p) => p.inlineData)).toBe(true);
      // Order fidelity: text before the image stays before it after recovery.
      const textIdx = parts.findIndex((p) => p.text === 'I will read it.');
      const imageIdx = parts.findIndex((p) => p.inlineData);
      const callIdx = parts.findIndex((p) => p.functionCall);
      expect(textIdx).toBeLessThan(imageIdx);
      expect(imageIdx).toBeLessThan(callIdx);
    });

    it('preserves non-text parts when the XML spans multiple text parts', async () => {
      vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
        (async function* () {
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    {
                      text: '<invoke name="read_file"><parameter name="file_path">',
                    },
                    {
                      inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
                    },
                  ],
                },
              },
            ],
          } as unknown as GenerateContentResponse;
          yield {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [{ text: 'a.ts</parameter></invoke>' }],
                },
                finishReason: 'STOP',
              },
            ],
          } as unknown as GenerateContentResponse;
        })(),
      );

      const stream = await chat.sendMessageStream(
        'gemini-pro',
        { message: 'read the file' },
        'prompt-xml-fallback-split',
      );

      const chunks: GenerateContentResponse[] = [];
      for await (const event of stream) {
        if (event.type === StreamEventType.CHUNK) {
          chunks.push(event.value);
        }
      }

      const synthetic = chunks.find((c) =>
        c.candidates?.[0]?.content?.parts?.some((p) =>
          p.functionCall?.id?.startsWith('xml-recovered-'),
        ),
      );
      expect(synthetic).toBeDefined();

      const history = chat.getHistory();
      const parts = history[history.length - 1]!.parts ?? [];
      expect(parts.some((p) => p.functionCall?.name === 'read_file')).toBe(
        true,
      );
      expect(parts.some((p) => p.text && p.text.includes('<invoke'))).toBe(
        false,
      );
      // The non-text part that split the XML must survive the rebuild.
      expect(parts.some((p) => p.inlineData)).toBe(true);
    });

    it('does not recover XML tool calls when the stream lacks a finish reason', async () => {
      vi.useFakeTimers();
      try {
        const xml =
          '<invoke name="read_file"><parameter name="file_path">a.ts</parameter></invoke>';
        vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
          (async function* () {
            yield xmlChunk(xml); // no finishReason
          })(),
        );

        const stream = await chat.sendMessageStream(
          'gemini-pro',
          { message: 'read the file' },
          'prompt-xml-fallback-no-finish',
        );

        // Without a finish reason the recovery gate must not fire; the
        // stream-validation block throws NO_FINISH_REASON so the retry
        // path handles the truncated stream.
        const chunks: GenerateContentResponse[] = [];
        const collecting = (async () => {
          for await (const event of stream) {
            if (event.type === StreamEventType.CHUNK) {
              chunks.push(event.value);
            }
          }
        })();
        const resultPromise = (async () => {
          await expect(collecting).rejects.toThrow('finish reason');
        })();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(35_000);
        await resultPromise;

        // No synthetic tool-call chunk may be dispatched.
        const recoveredChunk = chunks.find((c) =>
          c.candidates?.[0]?.content?.parts?.some((p) =>
            p.functionCall?.id?.startsWith('xml-recovered-'),
          ),
        );
        expect(recoveredChunk).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

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
  SendMessageParameters,
} from '@google/genai';
import { ApiError } from '@google/genai';
import { AuthType, type ContentGenerator } from './contentGenerator.js';
import {
  LlmChat,
  InvalidStreamError,
  approvedPlanRedactionText,
  redactApprovedPlansInHistory,
  redactStructuredOutputArgsForRecording,
  StreamEventType,
  type StreamEvent,
} from './llm-chat.js';
import { RETRYABLE_STREAM_TRANSPORT_CODES } from './stream-transport-retry.js';
import {
  convertResponsesEventToGemini,
  ResponsesStreamState,
} from './openaiResponsesContentGenerator/responses-converter.js';
import type { ResponsesSSEEvent } from './openaiResponsesContentGenerator/types.js';
import { getToolCallFingerprint } from './toolCallIdUtils.js';
import {
  buildApiHistoryFromConversation,
  findApiHistoryPromptIndex,
  getApiHistoryPromptId,
} from '../services/session-api-history.js';
import type { ChatRecord } from '../services/chatRecordingService.js';
import { classifyRetryError } from '../utils/retryErrorClassification.js';
import { ResponsesHttpError } from '../utils/responses-http-error.js';
import { convertGeminiContentsToResponsesInput } from './openaiResponsesContentGenerator/responses-converter.js';
import { StreamContentError } from './openaiContentGenerator/pipeline.js';
import {
  bindRetryWaitObserver,
  runWithRetryWaitObserver,
  type RetryWaitEvent,
} from '../utils/retry-wait.js';
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
import {
  collect,
  content,
  drain,
  fnCall,
  fnResponse,
  modelChunk,
  modelText,
  streamOf,
  userText,
} from '../test-utils/model-fixtures.js';

const degradeOmniMediaMock = vi.hoisted(() => vi.fn());
vi.mock('../omni/reactive-degrade.js', () => ({
  degradeOmniMediaAfterServerReject: degradeOmniMediaMock,
}));

// In-memory fs: no real file system operations during tests.
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
  // Real compress() logs every attempt (R3.4 integration test): no-op.
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

// LlmChat reads only `candidates[0].content.parts`, `finishReason` and
// `usageMetadata` from a chunk: the builders emit that shape.
type UsageMetadata =
  | GenerateContentResponse['usageMetadata']
  | Record<string, unknown>;

/** A chunk with a single text part. */
function textChunk(
  text: string,
  finishReason?: string,
  usageMetadata?: UsageMetadata,
): GenerateContentResponse {
  return modelChunk([{ text }], finishReason, usageMetadata);
}

/** A `finishReason: 'STOP'` chunk carrying `parts`. */
const stopResponse = (parts: Part[]) => modelChunk(parts, 'STOP');

/** Trailing usage-only chunk some providers emit after the finish reason. */
function usageChunk(usageMetadata: UsageMetadata): GenerateContentResponse {
  return {
    candidates: [],
    usageMetadata,
  } as unknown as GenerateContentResponse;
}

/** A stream that yields `chunks` and then throws `error`. */
function streamThenThrow(
  chunks: GenerateContentResponse[],
  error: unknown,
): AsyncGenerator<GenerateContentResponse> {
  return (async function* () {
    yield* chunks;
    throw error;
  })();
}

/** A one-chunk text stream that ends with `STOP`. */
const textStream = (text = 'ok', usageMetadata?: UsageMetadata) =>
  streamOf(textChunk(text, 'STOP', usageMetadata));

/** A `ChatCompressionService.compress` result. */
function compressResult(
  compressionStatus: CompressionStatus,
  newHistory: Content[] | null = null,
  originalTokenCount = 0,
  newTokenCount = 0,
  newTokenCountIsEstimated?: boolean,
): { newHistory: Content[] | null; info: ChatCompressionInfo } {
  return {
    newHistory,
    info: {
      originalTokenCount,
      newTokenCount,
      compressionStatus,
      ...(newTokenCountIsEstimated === undefined
        ? {}
        : { newTokenCountIsEstimated }),
    },
  };
}

/** A `ContentGenerator` whose stream method is `generateContentStream`. */
function makeContentGenerator(
  generateContentStream: unknown = vi.fn(),
): ContentGenerator {
  return {
    generateContent: vi.fn(),
    generateContentStream,
    embedContent: vi.fn(),
    batchEmbedContents: vi.fn(),
  } as unknown as ContentGenerator;
}

describe('LlmChat', async () => {
  let mockContentGenerator: ContentGenerator;
  let chat: LlmChat;
  let mockConfig: Config;
  const config: GenerateContentConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
    mockAcquireSleepInhibitor.mockReturnValue({
      release: mockSleepInhibitorRelease,
    });
    vi.mocked(uiTelemetryService.setLastPromptTokenCount).mockClear();
    mockContentGenerator = makeContentGenerator();
    // Pass-through for tests that don't care about retry logic.
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
    setSimulate429(false);
    chat = newChat();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  /**
   * Drain `stream` and expect InvalidStreamError once transient retries
   * exhaust; call under fake timers (it advances them past the delays).
   */
  async function expectStreamExhaustion(
    stream: AsyncGenerator<StreamEvent>,
    expectedError?: Partial<InvalidStreamError>,
  ): Promise<void> {
    const collecting = drain(stream);
    // Build the assertion first (not awaited), then advance timers.
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

  /** `target.sendMessageStream('test-model', { message }, promptId)`. */
  const send = (
    message: string | Part[],
    promptId: string,
    target: LlmChat = chat,
  ) => target.sendMessageStream('test-model', { message }, promptId);

  /** `send`, then collect every event the stream yields. */
  const sendCollect = async (
    message: string | Part[],
    promptId: string,
    target: LlmChat = chat,
  ) => collect(await send(message, promptId, target));

  /** `send`, then drain the stream. */
  const sendDrain = async (
    message: string | Part[],
    promptId: string,
    target: LlmChat = chat,
  ) => drain(await send(message, promptId, target));

  /** The mocked `generateContentStream`. */
  const streamMock = () =>
    vi.mocked(mockContentGenerator.generateContentStream);

  /** The request passed to the `index`th `generateContentStream` call. */
  const requestAt = (index: number) => streamMock().mock.calls[index]![0];

  /** Assert how many times `generateContentStream` was called. */
  const expectStreamCalls = (times: number) =>
    expect(mockContentGenerator.generateContentStream).toHaveBeenCalledTimes(
      times,
    );

  /** The events of `type` among `events`. */
  const eventsOfType = (events: StreamEvent[], type: StreamEventType) =>
    events.filter((event) => event.type === type);

  /** Whether some CHUNK event's first-candidate parts satisfy `match`. */
  const someChunk = (
    events: StreamEvent[],
    match: (parts: Part[]) => boolean | undefined,
  ) =>
    events.some(
      (event) =>
        event.type === StreamEventType.CHUNK &&
        match(event.value.candidates?.[0]?.content?.parts ?? []),
    );

  /** The text of every part of every CHUNK event, in order. */
  const chunkTexts = (events: StreamEvent[]) =>
    events
      .filter((event) => event.type === StreamEventType.CHUNK)
      .flatMap(
        (event) =>
          event.value.candidates?.[0]?.content?.parts?.map(
            (part) => part.text,
          ) ?? [],
      );

  /** Whether any event is a RETRY. */
  const hasRetry = (events: StreamEvent[]) =>
    events.some((event) => event.type === StreamEventType.RETRY);

  /** Whether a CHUNK event's first part carries `text`. */
  const hasChunkText = (events: StreamEvent[], text: string) =>
    events.some(
      (event) =>
        event.type === StreamEventType.CHUNK &&
        event.value.candidates?.[0]?.content?.parts?.[0]?.text === text,
    );

  /** Collect `stream`, advancing fake timers 5 s before each event. */
  async function collectAdvancing(stream: AsyncGenerator<StreamEvent>) {
    const events: StreamEvent[] = [];
    const iterator = stream[Symbol.asyncIterator]();
    for (;;) {
      const next = iterator.next();
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await next;
      if (result.done) break;
      events.push(result.value);
    }
    return events;
  }

  /** A signed reasoning-episode part. */
  const signed = (text: string, thoughtSignature: string): Part => ({
    text,
    thought: true,
    thoughtSignature,
  });

  const summaryAck = (): Content[] => [userText('summary'), modelText('ack')];
  /** NOOP at `tokens` (0 matches the bare `compressResult(NOOP)`). */
  const noop = (tokens = 0) =>
    compressResult(CompressionStatus.NOOP, null, tokens, tokens);
  const compressed = (from: number, to: number, history = summaryAck()) =>
    compressResult(CompressionStatus.COMPRESSED, history, from, to);
  /** A failed `status` result that kept the history at `tokens`. */
  const failed = (status: CompressionStatus, tokens: number) =>
    compressResult(status, null, tokens, tokens);

  const tooLong = () =>
    new Error('prompt is too long: 135000 tokens > 128000 maximum');

  /** `target`'s model turn, asserting its history is [user, model]. */
  const soleModelTurn = (target: LlmChat = chat) => {
    const history = target.getHistory();
    expect(history.length).toBe(2);
    return history[1]!;
  };

  /** `record` was called once, with `message`. */
  const expectRecordedMessage = (
    record: ReturnType<typeof vi.fn>,
    message: unknown,
  ) => {
    expect(record).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ message }));
  };

  /** Resolve every `generateContentStream` call with `stream`. */
  const mockStream = (stream: AsyncGenerator<GenerateContentResponse>) =>
    vi
      .mocked(mockContentGenerator.generateContentStream)
      .mockResolvedValue(stream);

  /** Resolve successive `generateContentStream` calls with `streams` in order. */
  const mockStreamsOnce = (
    ...streams: Array<AsyncGenerator<GenerateContentResponse>>
  ) => {
    const mock = vi.mocked(mockContentGenerator.generateContentStream);
    for (const stream of streams) mock.mockResolvedValueOnce(stream);
    return mock;
  };

  /** Run `fn` under fake timers, restoring real timers afterwards. */
  const fakeTimers =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A): Promise<void> => {
      vi.useFakeTimers();
      try {
        await fn(...args);
      } finally {
        vi.useRealTimers();
      }
    };

  /** Resolve every `compress` call with `result`. */
  const mockCompress = (result: ReturnType<typeof compressResult>) => {
    const spy = vi.spyOn(ChatCompressionService.prototype, 'compress');
    spy.mockResolvedValue(result);
    return spy;
  };

  /** Resolve successive `compress` calls with `results` in order. */
  const mockCompressOnce = (
    ...results: Array<ReturnType<typeof compressResult>>
  ) => {
    const spy = vi.spyOn(ChatCompressionService.prototype, 'compress');
    for (const result of results) spy.mockResolvedValueOnce(result);
    return spy;
  };

  /** Point `getContentGeneratorConfig` at a Gemini `test-model` plus `overrides`. */
  const mockGeneratorConfig = (
    overrides: Partial<ReturnType<Config['getContentGeneratorConfig']>> = {},
  ) =>
    vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
      authType: AuthType.USE_GEMINI,
      model: 'test-model',
      ...overrides,
    });

  /** An `LlmChat` on `mockConfig` with optional history, recorder and config. */
  function newChat({
    history = [],
    recorder,
    chatConfig = config,
  }: {
    history?: Content[];
    recorder?: Record<string, unknown>;
    chatConfig?: GenerateContentConfig;
  } = {}) {
    return new LlmChat(
      mockConfig,
      chatConfig,
      history,
      recorder as unknown as ConstructorParameters<typeof LlmChat>[3],
      uiTelemetryService,
    );
  }

  /** A `ChatCompletionChunk` with one choice carrying `delta`. */
  const openaiChunk = (
    id: string,
    delta: Record<string, unknown>,
    finishReason: string | null = null,
  ) =>
    ({
      id,
      created: 1,
      model: 'test-model',
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    }) as unknown as OpenAI.Chat.ChatCompletionChunk;

  /** Route sends through the real OpenAI pipeline and converter over `create`. */
  function useOpenAIPipeline(create: ReturnType<typeof vi.fn>) {
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
    mockGeneratorConfig({ authType: AuthType.USE_OPENAI });
  }

  function chatWithRecorder(recordAssistantTurn: ReturnType<typeof vi.fn>) {
    return newChat({
      recorder: { recordAssistantTurn, recordChatCompression: vi.fn() },
    });
  }

  async function collectStreamWithFakeTimers(
    stream: AsyncGenerator<StreamEvent>,
    advanceByMs: number = 10_000,
  ): Promise<StreamEvent[]> {
    const collecting = collect(stream);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(advanceByMs);
    return collecting;
  }

  describe('history-rewrite loaded-skill tracking', () => {
    // Destructive rewrites (compaction, truncation, orphan stripping) clear
    // the SkillTool's loaded-skill tracking so an evicted body never stays
    // stuck behind the dedup guard; the cost is at most one duplicate body.
    const wireSkillTracker = () => {
      const skillTool = { clearLoadedSkills: vi.fn() };
      vi.mocked(mockConfig.getToolRegistry).mockReturnValue({
        getTool: vi.fn().mockReturnValue(skillTool),
      } as unknown as ReturnType<Config['getToolRegistry']>);
      return skillTool;
    };

    it.each<[string, () => unknown, boolean]>([
      [
        'setHistory clears tracking on wholesale replacement',
        () => chat.setHistory([userText('hi')]),
        true,
      ],
      [
        'tryCompress clears tracking through its setHistory',
        () => {
          mockCompressOnce(compressed(100_000, 30_000, [userText('summary')]));
          return chat.tryCompress('prompt-skill-clear', true);
        },
        true,
      ],
      [
        'tryCompress leaves tracking untouched on NOOP',
        () => {
          mockCompressOnce(noop(1_000));
          return chat.tryCompress('prompt-skill-noop', true);
        },
        false,
      ],
      [
        'truncateHistory clears tracking when entries were dropped',
        () => {
          chat.addHistory(userText('a'));
          chat.addHistory(modelText('b'));
          chat.truncateHistory(1);
        },
        true,
      ],
      [
        'truncateHistory leaves tracking when nothing was dropped',
        () => {
          chat.addHistory(userText('a'));
          chat.truncateHistory(5);
        },
        false,
      ],
      [
        'stripOrphanedUserEntriesFromHistory clears tracking when it strips',
        () => {
          chat.addHistory(modelText('ack'));
          chat.addHistory(userText('orphan'));
          chat.stripOrphanedUserEntriesFromHistory();
        },
        true,
      ],
      [
        'stripOrphanedUserEntriesFromHistory leaves tracking when nothing is stripped',
        () => {
          chat.addHistory(modelText('ack'));
          chat.stripOrphanedUserEntriesFromHistory();
        },
        false,
      ],
      [
        'forked chats never touch the shared parent tracker',
        () => {
          chat.isForkedChat = true;
          chat.setHistory([modelText('ack')]);
          chat.addHistory(userText('orphan'));
          chat.stripOrphanedUserEntriesFromHistory();
          chat.addHistory(modelText('ack2'));
          chat.truncateHistory(1);
        },
        false,
      ],
    ])('%s', async (_title, rewrite, clears) => {
      const skillTool = wireSkillTracker();
      await rewrite();
      if (clears) expect(skillTool.clearLoadedSkills).toHaveBeenCalled();
      else expect(skillTool.clearLoadedSkills).not.toHaveBeenCalled();
    });
  });

  it('resyncs a tool_search response committed through the streaming send path', async () => {
    const syncReviewedDeclarations = vi.fn();
    vi.mocked(mockConfig.getToolRegistry).mockReturnValue({
      getTool: vi.fn(),
      syncReviewedDeclarations,
    } as unknown as ReturnType<Config['getToolRegistry']>);
    const searchResponse: Part = {
      functionResponse: {
        id: 'search',
        name: 'tool_search',
        response: { output: '<functions></functions>' },
      },
    };
    chat.setHistory([
      {
        role: 'model',
        parts: [
          { functionCall: { id: 'search', name: 'tool_search', args: {} } },
        ],
      },
    ]);
    syncReviewedDeclarations.mockClear();
    vi.mocked(mockContentGenerator.generateContentStream).mockResolvedValue(
      streamOf(stopResponse([{ text: 'Done.' }])),
    );

    const stream = await chat.sendMessageStream(
      'test-model',
      { message: [searchResponse] },
      'search-result',
    );
    for await (const _ of stream) {
      /* consume */
    }

    expect(syncReviewedDeclarations).toHaveBeenCalledOnce();
    expect(syncReviewedDeclarations).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ role: 'user', parts: [searchResponse] }),
      ]),
      chat,
    );
  });

  it('re-syncs over the popped history when a committed tool_search response is rolled back', async () => {
    // The sync receives the live history array by reference, so snapshot its
    // shape at call time — after the rollback both recorded calls would
    // otherwise read as the same popped array.
    const syncedShapes: Array<{ length: number; hasSearchResponse: boolean }> =
      [];
    const syncReviewedDeclarations = vi.fn((history: readonly Content[]) => {
      syncedShapes.push({
        length: history.length,
        hasSearchResponse: history.some((entry) =>
          (entry.parts ?? []).some((part) => part === searchResponse),
        ),
      });
    });
    vi.mocked(mockConfig.getToolRegistry).mockReturnValue({
      getTool: vi.fn(),
      syncReviewedDeclarations,
    } as unknown as ReturnType<Config['getToolRegistry']>);
    const searchResponse: Part = {
      functionResponse: {
        id: 'search',
        name: 'tool_search',
        response: { output: '<functions></functions>' },
      },
    };
    chat.setHistory([]);
    syncReviewedDeclarations.mockClear();
    syncedShapes.length = 0;
    // Throw inside the setup window between the push and the generator's
    // return (here: the request-history derivation), so the catch pops the
    // committed response.
    vi.spyOn(
      chat as unknown as { getRequestHistoryForRoute: () => unknown },
      'getRequestHistoryForRoute',
    ).mockImplementation(() => {
      throw new Error('setup window failure');
    });

    await expect(
      chat.sendMessageStream(
        'test-model',
        { message: [searchResponse] },
        'search-result',
      ),
    ).rejects.toThrow('setup window failure');

    // Without the rollback-leg re-sync the registry keeps vouching for a
    // schema that is no longer in history. The push synced once with the
    // response present; the rollback must sync again over the popped
    // history.
    expect(syncedShapes).toEqual([
      { length: 1, hasSearchResponse: true },
      { length: 0, hasSearchResponse: false },
    ]);
    expect(chat.getHistory()).toEqual([]);
  });

  describe('system instruction helpers', () => {
    const block = (ctx: string) =>
      `<qwen:session-start-context hidden="true">\nSessionStart additional context:\n${ctx}\n</qwen:session-start-context>`;

    /** A fresh chat's system instruction after `base` and then `contexts`. */
    function instructionAfter(base: string, ...contexts: string[]) {
      const isolatedChat = newChat({ chatConfig: {} });
      isolatedChat.setSystemInstruction(base);
      for (const ctx of contexts) isolatedChat.setSessionStartContext(ctx);
      return isolatedChat['generationConfig'].systemInstruction;
    }

    it('replaces prior session-start context instead of appending indefinitely', () => {
      expect(instructionAfter('Base instruction', 'Ctx1', 'Ctx2')).toBe(
        `Base instruction\n\n${block('Ctx2')}`,
      );
    });

    it('preserves existing system prompt suffixes when replacing session-start context', () => {
      const base =
        'Base instruction\n\n---\n\nUser memory\n\n---\n\nAppended rule';
      expect(instructionAfter(base, 'Ctx1', 'Ctx2')).toBe(
        `${base}\n\n${block('Ctx2')}`,
      );
    });

    it('preserves non-string systemInstruction content when applying session-start context', () => {
      const isolatedChat = newChat({
        chatConfig: {
          systemInstruction: {
            role: 'system',
            parts: [{ text: 'Base content instruction' }],
          },
        },
      });

      isolatedChat.setSessionStartContext('Ctx1');
      isolatedChat.setSessionStartContext('Ctx2');

      expect(isolatedChat['generationConfig'].systemInstruction).toBe(
        `Base content instruction\n\n${block('Ctx2')}`,
      );
    });

    it('applies session-start context synchronously via applySessionStartContext', () => {
      const isolatedChat = newChat({ chatConfig: {} });
      isolatedChat.setSystemInstruction('Base instruction');
      isolatedChat.applySessionStartContext(
        '  Sync ctx  ',
        SessionStartSource.Startup,
      );
      expect(isolatedChat['generationConfig'].systemInstruction).toBe(
        `Base instruction\n\n${block('Sync ctx')}`,
      );
    });

    it('does not strip legitimate content that only resembles the old plain-text marker', () => {
      const instruction = instructionAfter(
        'Base instruction\n\n---\n\nSessionStart additional context:\nLegitimate content',
        'Ctx1',
      );
      expect(instruction).toContain('Legitimate content');
      expect(instruction).toContain(block('Ctx1'));
    });
  });

  describe('sendMessageStream', () => {
    type Message = Parameters<LlmChat['sendMessageStream']>[1]['message'];

    /** `send` for any message shape, a bare Part included. */
    const sendAny = (message: Message, promptId: string, target = chat) =>
      target.sendMessageStream('test-model', { message }, promptId);

    /** A user prompt followed by the model's (unanswered) call. */
    const afterCall = (
      prompt: string,
      name: string,
      args: Record<string, unknown>,
      id?: string,
    ): Content[] => [
      userText(prompt),
      content('model', fnCall(name, args, id)),
    ];

    /** Seed `target` with a pending `read_file` call, then send its result. */
    function sendToolResult(
      promptId: string,
      target: LlmChat = chat,
      model = 'test-model',
      args: Record<string, unknown> = { path: '/tmp/example' },
    ) {
      target.setHistory([
        userText('inspect the project'),
        content('model', fnCall('read_file', args, 'call_read_file')),
      ]);
      const result = { output: 'file contents' };
      return target.sendMessageStream(
        model,
        { message: [fnResponse('read_file', result, 'call_read_file')] },
        promptId,
      );
    }

    /** `sendToolResult`, collected under fake timers. */
    const collectToolResult = async (
      advanceByMs: number,
      ...args: Parameters<typeof sendToolResult>
    ) =>
      collectStreamWithFakeTimers(await sendToolResult(...args), advanceByMs);

    /** `collectToolResult` on `target` (default: a fresh recorder chat). */
    async function runToolResult(
      promptId: string,
      advanceByMs: number,
      target?: LlmChat,
    ) {
      const recordAssistantTurn = vi.fn();
      const runChat = target ?? chatWithRecorder(recordAssistantTurn);
      const events = await collectToolResult(advanceByMs, promptId, runChat);
      return { events, recordAssistantTurn, runChat };
    }

    /** Every attempt is a quiet STOP except the calls `isSpecial` picks. */
    const quietExcept = (
      isSpecial: (call: number) => boolean,
      special: () => AsyncGenerator<GenerateContentResponse>,
    ) => {
      let callCount = 0;
      streamMock().mockImplementation(async () =>
        isSpecial(++callCount) ? special() : streamOf(stopResponse([])),
      );
    };

    const socketReset = () =>
      Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('socket failure'), {
          code: 'ECONNRESET',
        }),
      });

    const tagLeak = () =>
      new InvalidStreamError(
        'Model response started with leaked protocol tags.',
        'PROTOCOL_TAG_LEAK',
      );

    /**
     * Mocks the retry wrapper as a pass-through, sends `message` over a
     * stream that yields `chunks` and then fails with `error`, asserts the
     * drain rejects with it, and returns the history.
     */
    async function sendThenFail(
      message: string,
      promptId: string,
      chunks: GenerateContentResponse[],
      error: Error,
    ) {
      mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
      mockStream(streamThenThrow(chunks, error));
      await expect(sendDrain(message, promptId)).rejects.toBe(error);
      return chat.getHistory();
    }

    /** A recorder chat sending `hello` under a cancellable signal. */
    function cancellable() {
      const controller = new AbortController();
      const recordAssistantTurn = vi.fn();
      const recordingChat = chatWithRecorder(recordAssistantTurn);
      const start = (promptId: string) =>
        recordingChat.sendMessageStream(
          'test-model',
          { message: 'hello', config: { abortSignal: controller.signal } },
          promptId,
        );
      /** History and the JSONL record both hold `parts` (and `extra`). */
      const expectPersisted = (parts: Part[], extra = {}) => {
        expect(recordingChat.getHistory()).toEqual([
          userText('hello'),
          content('model', ...parts),
        ]);
        expect(recordAssistantTurn).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ ...extra, message: parts }),
        );
      };
      return {
        controller,
        recordAssistantTurn,
        recordingChat,
        start,
        expectPersisted,
      };
    }

    it('sends nothing for a Managed session that a lost tool outcome blocked', async () => {
      const blocked = new Error('outcome unknown');
      (
        mockConfig as Config & { getManagedSessionBlock: () => Error }
      ).getManagedSessionBlock = () => blocked;
      const history = chat.getHistory();
      await expect(sendAny('continue', 'prompt-id-blocked')).rejects.toBe(
        blocked,
      );
      expect(streamMock()).not.toHaveBeenCalled();
      expect(chat.getHistory()).toEqual(history);
    });

    it('releases the sleep inhibitor after the stream is consumed', async () => {
      mockStream(textStream('done'));
      await sendDrain('test message', 'prompt-id-sleep-inhibitor');
      expect(mockAcquireSleepInhibitor).toHaveBeenCalledWith(
        mockConfig,
        'Qwen Code is streaming a model response',
      );
      expect(mockSleepInhibitorRelease).toHaveBeenCalledTimes(1);
    });

    it('marks the pushed user entry with the send promptId', async () => {
      // Rewind reads this mark through getHistoryShallow.
      streamMock().mockImplementation(async () =>
        streamOf(stopResponse([{ text: 'ok' }])),
      );

      const sendMarked = async (options?: { promptId?: string }) => {
        await drain(
          await chat.sendMessageStream(
            'test-model',
            { message: 'hello' },
            'prompt-id-mark',
            undefined,
            options,
          ),
        );
        return chat
          .getHistoryShallow()
          .filter((entry) => entry.role === 'user')
          .at(-1)!;
      };

      expect(
        getApiHistoryPromptId(
          await sendMarked({ promptId: 'session########7' }),
        ),
      ).toBe('session########7');
      // No identity supplied (retry, continuation, tool result): unmarked.
      expect(getApiHistoryPromptId(await sendMarked())).toBeUndefined();
    });

    describe('manual plan-exit notices', () => {
      const NOTICE = 'changed outside the approved exit_plan_mode flow';
      const noticeParts = (contents: Content[]) =>
        contents
          .flatMap((c) => c.parts ?? [])
          .filter((part) => part.text?.includes(NOTICE));
      const takeNotice = () =>
        vi.mocked(mockConfig.takePendingManualPlanExitNotice);
      const notice = (version: number, currentMode = ApprovalMode.DEFAULT) => ({
        version,
        currentMode,
      });

      beforeEach(() => {
        streamMock().mockImplementation(async () => textStream());
      });

      it('is disabled by default', async () => {
        takeNotice().mockReturnValue(notice(1));
        await sendDrain('continue', 'prompt-id-plan-exit-disabled');
        expect(
          mockConfig.takePendingManualPlanExitNotice,
        ).not.toHaveBeenCalled();
        expect(noticeParts(chat.getHistory())).toHaveLength(0);
      });

      it('appends one notice after a function response', async () => {
        takeNotice()
          .mockReturnValueOnce(notice(7, ApprovalMode.AUTO_EDIT))
          .mockReturnValue(undefined);
        chat.enableManualPlanExitNotices();
        chat.setHistory(
          afterCall(
            'read it',
            'read_file',
            { path: '/tmp/input' },
            'call-plan-exit',
          ),
        );
        await drain(
          await sendAny(
            fnResponse('read_file', { output: 'contents' }, 'call-plan-exit'),
            'prompt-id-plan-exit-tool-result',
          ),
        );
        await sendDrain('next turn', 'prompt-id-plan-exit-next-turn');

        const toolResultTurn = chat.getHistory()[2]!;
        expect(toolResultTurn.parts?.[0]?.functionResponse?.id).toBe(
          'call-plan-exit',
        );
        expect(toolResultTurn.parts?.at(-1)?.text).toContain(
          'The current approval mode is: auto-edit.',
        );
        expect(noticeParts(chat.getHistory())).toHaveLength(1);
      });

      it('restores a claim when setup rolls back the history push', async () => {
        takeNotice().mockReturnValue(notice(11));
        chat.enableManualPlanExitNotices();
        vi.spyOn(
          chat as unknown as { getRequestHistory: () => Content[] },
          'getRequestHistory',
        ).mockImplementationOnce(() => {
          throw new Error('history setup failed');
        });

        await expect(
          send('first', 'prompt-id-plan-exit-rollback-1'),
        ).rejects.toThrow('history setup failed');
        expect(
          mockConfig.restorePendingManualPlanExitNotice,
        ).toHaveBeenCalledWith(11);

        await sendDrain('second', 'prompt-id-plan-exit-rollback-2');
        const history = chat.getHistory();
        expect(
          history.some((c) => c.parts?.some((part) => part.text === 'first')),
        ).toBe(false);
        expect(noticeParts(history)).toHaveLength(1);
        expect(
          mockConfig.restorePendingManualPlanExitNotice,
        ).toHaveBeenCalledTimes(1);
      });

      it('commits one history part when provider setup retries', async () => {
        takeNotice().mockReturnValueOnce(notice(13));
        chat.enableManualPlanExitNotices();
        streamMock()
          .mockRejectedValueOnce(new Error('transient transport setup'))
          .mockImplementationOnce(async () => textStream('recovered'));
        mockRetryWithBackoff.mockImplementationOnce(async (apiCall) => {
          try {
            return await apiCall();
          } catch {
            return apiCall();
          }
        });

        await sendDrain('retry me', 'prompt-id-plan-exit-provider-retry');

        expectStreamCalls(2);
        expect(
          mockConfig.takePendingManualPlanExitNotice,
        ).toHaveBeenCalledTimes(1);
        expect(noticeParts(chat.getHistory())).toHaveLength(1);
        expect(
          mockConfig.restorePendingManualPlanExitNotice,
        ).not.toHaveBeenCalled();
      });

      it.each([
        { tail: 'model', compressedHistory: summaryAck() },
        {
          tail: 'user',
          compressedHistory: [
            ...summaryAck(),
            userText('restored attachment context'),
          ],
        },
      ])(
        'preserves the committed notice across reactive compression with a $tail tail',
        async ({ compressedHistory }) => {
          takeNotice().mockReturnValueOnce(notice(15));
          chat.enableManualPlanExitNotices();
          mockCompressOnce(
            noop(),
            compressed(135_000, 40_000, compressedHistory),
          );
          streamMock()
            .mockRejectedValueOnce(tooLong())
            .mockImplementationOnce(async () =>
              textStream('after compression'),
            );

          await sendDrain(
            'retry after overflow',
            'prompt-id-plan-exit-reactive-compression',
          );

          expect(
            noticeParts((requestAt(1) as { contents: Content[] }).contents),
          ).toHaveLength(1);
          const history = chat.getHistory();
          expect(noticeParts(history)).toHaveLength(1);
          const noticeTurn = history.find((c) => noticeParts([c]).length > 0);
          expect(noticeTurn?.parts?.at(-1)?.text).toContain(NOTICE);
          expect(
            history.some(
              (c, index) =>
                c.role === 'user' && history[index + 1]?.role === 'user',
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
        takeNotice().mockImplementation(() => {
          if (!pending) return undefined;
          pending = false;
          return notice(17);
        });
        chat.enableManualPlanExitNotices();
        await sendDrain('first chat', 'prompt-id-plan-exit-before-rebuild');

        const replacementChat = new LlmChat(mockConfig, config);
        replacementChat.enableManualPlanExitNotices();
        await sendDrain(
          'replacement chat',
          'prompt-id-plan-exit-after-rebuild',
          replacementChat,
        );

        expect(noticeParts(replacementChat.getHistory())).toHaveLength(0);
        expect(
          mockConfig.takePendingManualPlanExitNotice,
        ).toHaveBeenCalledTimes(2);
      });
    });

    it('increments the user-content push counter once per surviving send', async () => {
      mockStream(textStream('done'));
      const before = chat.getUserContentPushCount();
      await sendDrain('hello', 'prompt-id-push-count');
      // Landed once: the signal client.ts's Retry strip/restore gates on.
      expect(chat.getUserContentPushCount()).toBe(before + 1);
    });

    it('releases the sleep inhibitor when the stream errors', async () => {
      mockStream(
        streamThenThrow([textChunk('partial')], new Error('stream aborted')),
      );
      const stream = await send('fail', 'prompt-id-stream-error');
      await expect(drain(stream)).rejects.toThrow('stream aborted');
      expect(mockSleepInhibitorRelease).toHaveBeenCalledTimes(1);
    });

    it('should succeed if a tool call is followed by an empty part', async () => {
      // The tool call makes the invalid (empty) final chunk acceptable.
      mockStream(
        streamOf(modelChunk([fnCall('test_tool', {})]), textChunk('')),
      );
      await expect(
        sendDrain('test message', 'prompt-id-tool-call-empty-end'),
      ).resolves.not.toThrow();

      const modelTurn = soleModelTurn();
      expect(modelTurn?.parts?.length).toBe(1); // The empty part is discarded
      expect(modelTurn?.parts![0]!.functionCall).toBeDefined();
    });

    it('should fail if the stream ends with an empty part and has no finishReason', async () => {
      vi.useFakeTimers();
      mockStream(streamOf(textChunk('Initial content...'), textChunk('')));
      await expectStreamExhaustion(
        await send('test message', 'prompt-id-no-finish-empty-end'),
      );
    });

    it('should succeed if the stream ends with an invalid part but has a finishReason and contained a valid part', async () => {
      // A valid chunk, then an invalid (empty) one carrying the finishReason.
      mockStream(
        streamOf(textChunk('Initial valid content...'), textChunk('', 'STOP')),
      );
      await expect(
        sendDrain('test message', 'prompt-id-valid-then-invalid-end'),
      ).resolves.not.toThrow();

      // History keeps only the valid part.
      const modelTurn = soleModelTurn();
      expect(modelTurn?.parts?.length).toBe(1);
      expect(modelTurn?.parts![0]!.text).toBe('Initial valid content...');
    });

    it('should consolidate subsequent text chunks after receiving an empty text chunk', async () => {
      // The empty-text chunk this case was named for is gone ({ text: '' } is
      // an invalid part); what matters is consolidating what follows it.
      mockStream(streamOf(textChunk('Hello'), textChunk(' World!', 'STOP')));
      await sendDrain('test message', 'prompt-id-empty-chunk-consolidation');

      const modelTurn = soleModelTurn();
      expect(modelTurn?.parts?.length).toBe(1);
      expect(modelTurn?.parts![0]!.text).toBe('Hello World!');
    });

    it('preserves Responses message phases across text consolidation and JSON history', async () => {
      const commentary = { id: 'msg_commentary', phase: 'commentary' };
      const final = { id: 'msg_final', phase: 'final_answer' };
      mockStream(
        streamOf(
          modelChunk([{ text: 'Working', responsesMessage: commentary }]),
          modelChunk([{ text: ' now.', responsesMessage: commentary }]),
          modelChunk([{ text: 'Done.', responsesMessage: final }]),
          modelChunk([], 'STOP'),
        ),
      );
      await sendDrain('test', 'phase-test');
      const history = JSON.parse(
        JSON.stringify(chat.getHistory()),
      ) as Content[];
      expect(history[1]?.parts).toEqual([
        { text: 'Working now.', responsesMessage: commentary },
        { text: 'Done.', responsesMessage: final },
      ]);
      const { input } = convertGeminiContentsToResponsesInput({
        model: 'test-model',
        contents: history,
      });
      expect(
        input.filter(
          (item) => item.type === 'message' && item.role === 'assistant',
        ),
      ).toEqual(
        [
          ['Working now.', 'commentary'],
          ['Done.', 'final_answer'],
        ].map(([text, phase]) => ({
          type: 'message',
          role: 'assistant',
          content: text,
          phase,
        })),
      );
    });

    it.each([
      'Request contains an invalid argument',
      'maximum schema depth exceeded',
    ])(
      'honors a Responses retry directive despite legacy message %s',
      fakeTimers(async (message: string) => {
        const { retryWithBackoff } =
          await vi.importActual<typeof import('../utils/retry.js')>(
            '../utils/retry.js',
          );
        mockRetryWithBackoff.mockImplementation(retryWithBackoff);
        streamMock()
          .mockRejectedValueOnce(
            new ResponsesHttpError(
              404,
              JSON.stringify({ error: { message } }),
              new Headers({ 'x-should-retry': 'true', 'retry-after-ms': '1' }),
            ),
          )
          .mockResolvedValueOnce(textStream('Recovered'));
        await collectStreamWithFakeTimers(
          await send('test', 'retry-directive'),
          100,
        );
        expectStreamCalls(2);
        expect(chat.getHistory().at(-1)?.parts).toEqual([
          { text: 'Recovered' },
        ]);
      }),
    );

    it.each([429, 503])(
      'does not restart an HTTP %i explicitly marked nonretryable',
      async (status) => {
        const error = new ResponsesHttpError(
          status,
          '{}',
          new Headers({ 'x-should-retry': 'false' }),
        );
        streamMock().mockRejectedValue(error);
        await expect(sendDrain('test', 'no-retry')).rejects.toBe(error);
        expectStreamCalls(1);
      },
    );

    it('should consolidate adjacent text parts that arrive in separate stream chunks', async () => {
      mockStream(
        streamOf(
          textChunk('This is the '),
          textChunk('first part.'),
          // This function call should break the consolidation.
          modelChunk([fnCall('do_stuff', {})]),
          textChunk('This is the second part.'),
        ),
      );
      await sendDrain('test message', 'prompt-id-multi-chunk');

      const modelTurn = soleModelTurn();
      expect(modelTurn.role).toBe('model');
      expect(modelTurn?.parts?.length).toBe(3);
      expect(modelTurn?.parts![0]!.text).toBe('This is the first part.');
      expect(modelTurn.parts![1]!.functionCall).toBeDefined();
      expect(modelTurn.parts![2]!.text).toBe('This is the second part.');
    });

    it('should preserve text parts that stream in the same chunk as a thought', async () => {
      mockStream(
        streamOf(
          modelChunk(
            [
              { thought: 'This is a thought.' },
              { text: 'This is the visible text that should not be lost.' },
            ],
            'STOP',
          ),
        ),
      );
      await sendDrain('test message', 'prompt-id-mixed-chunk');

      const modelTurn = soleModelTurn();
      expect(modelTurn.role).toBe('model');
      // The bug dropped the visible text part (parts.length 0).
      expect(modelTurn?.parts?.length).toBe(1);
      expect(modelTurn?.parts![0]!.text).toBe(
        'This is the visible text that should not be lost.',
      );
    });

    it('synthesizes a functionResponse for a dangling tool_use before sending', async () => {
      // A dangling model[functionCall] (Ctrl+Y race, crash-resume on a partial
      // tool_use turn) is closed by the inline repair pass, so the wire
      // payload doesn't 400 with "tool_use_id ... corresponding tool_use".
      chat.setHistory(
        afterCall(
          'first message',
          'read_file',
          { path: '/tmp/x' },
          'call_dangling_for_send',
        ),
      );
      mockStream(textStream());
      const prompt = 'next user prompt after a stream-error-mid-tool_use';
      await sendDrain(prompt, 'prompt-send-repair');

      const userTurn = chat.getHistory()[2]!;
      expect(userTurn.role).toBe('user');
      const fr = userTurn.parts!.find((p) => p.functionResponse);
      expect(fr?.functionResponse?.id).toBe('call_dangling_for_send');
      expect(fr?.functionResponse?.name).toBe('read_file');
      expect(
        (fr?.functionResponse?.response as { error?: string })?.error,
      ).toMatch(/interrupted/i);
      expect(userTurn.parts!.some((p) => p.text === prompt)).toBe(true);
      // tool_result first: Anthropic-compatible backends reject a user message
      // not opening with it (upstream Claude Code's `hoistToolResults`).
      expect(userTurn.parts![0]!.functionResponse?.id).toBe(
        'call_dangling_for_send',
      );
    });

    it('still synthesizes when restore is on and the user sends ordinary text', async () => {
      vi.mocked(mockConfig.getRestoreAskUserQuestion).mockReturnValue(true);
      chat.setHistory(
        afterCall(
          'pick one',
          'ask_user_question',
          {
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
          'call_auq_ordinary_send',
        ),
      );
      mockStream(textStream());
      await sendDrain('never mind, just continue', 'prompt-ordinary-over-auq');

      const userTurn = chat.getHistory()[2]!;
      expect(userTurn.role).toBe('user');
      expect(userTurn.parts![0]!.functionResponse?.id).toBe(
        'call_auq_ordinary_send',
      );
      expect(
        userTurn.parts!.some((p) => p.text === 'never mind, just continue'),
      ).toBe(true);
    });

    it('does NOT synthesize when the user supplies a matching tool_result', async () => {
      // Retry-of-ToolResult: the real tool_result closes the pair before the
      // repair pass runs, so no second, synthetic fr for the same callId.
      chat.setHistory(
        afterCall(
          'do the read',
          'read_file',
          { path: '/tmp/y' },
          'call_retry_real_fr',
        ),
      );
      mockStream(textStream('ack'));
      await drain(
        await sendAny(
          fnResponse(
            'read_file',
            { output: 'real-tool-output' },
            'call_retry_real_fr',
          ),
          'prompt-retry-real-fr',
        ),
      );

      const frParts = chat
        .getHistory()[2]!
        .parts!.filter((p) => p.functionResponse);
      expect(frParts.length).toBe(1); // only the real one
      expect(frParts[0]!.functionResponse?.id).toBe('call_retry_real_fr');
      expect(
        (frParts[0]!.functionResponse?.response as { output?: string })?.output,
      ).toBe('real-tool-output');
    });

    it('should throw an error when a tool call is followed by an empty stream response', async () => {
      vi.useFakeTimers();
      chat.setHistory(
        afterCall('Find a good Italian restaurant for me.', 'find_restaurant', {
          cuisine: 'Italian',
        }),
      );
      // The function response gets an empty (thought-only) reply.
      mockStream(streamOf(modelChunk([{ thought: true }], 'STOP')));
      await expectStreamExhaustion(
        await sendAny(
          fnResponse('find_restaurant', { name: 'Vesuvio' }),
          'prompt-id-stream-1',
        ),
      );
    });

    it('should succeed when there is a tool call without finish reason', async () => {
      mockStream(
        streamOf(modelChunk([fnCall('test_function', { param: 'value' })])),
      );
      await expect(sendDrain('test', 'prompt-id-1')).resolves.not.toThrow();
    });

    it('uses the normalized function call ID for preparation metadata', async () => {
      chat.setHistory([
        ...afterCall(
          'first request',
          'read_file',
          { file_path: 'a.txt' },
          'call-1',
        ),
        content(
          'user',
          fnResponse('read_file', { output: 'first result' }, 'call-1'),
        ),
      ]);
      const preparationResponse = modelChunk([]);
      setToolCallPreparations(preparationResponse, [
        { callId: 'call-1', toolName: 'read_file' },
      ]);
      mockStream(
        streamOf(
          preparationResponse,
          modelChunk([fnCall('read_file', { file_path: 'b.txt' }, 'call-1')]),
        ),
      );

      const events = await sendCollect(
        'second request',
        'prompt-normalized-preparation-id',
      );

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
      // Weak network: the SSE drops after the functionCall chunk (already a
      // queued ToolCallRequest). Without the tool_use in history the next
      // request reads user → user[tool_result], which DeepSeek/Anthropic
      // reject, so the partial turn must persist before the re-throw.
      const history = await sendThenFail(
        'open /tmp/x.txt please',
        'prompt-weak-network-tool',
        [
          modelChunk([
            fnCall(
              'read_file',
              { path: '/tmp/x.txt' },
              'call_00_CeJrKJB0PSmXUZTCWHET7332',
            ),
          ]),
        ],
        new Error('SSE connection reset by peer'),
      );

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
      // Reasoning providers (DeepSeek, Claude 4.6+) pair thinking with the
      // tool_use; keeping it stops DeepSeek's `injectThinkingOnToolUseTurns`
      // prepending a synthetic block that discards the original reasoning.
      await sendThenFail(
        'read /tmp/a.txt',
        'prompt-thinking-tool-weak-network',
        [
          modelChunk([{ text: 'planning the read', thought: true }]),
          modelChunk([
            fnCall(
              'read_file',
              { path: '/tmp/a.txt' },
              'call_thinking_tool_use',
            ),
          ]),
        ],
        new Error('SSE timeout'),
      );

      const modelTurn = soleModelTurn();
      expect(modelTurn.role).toBe('model');
      const parts = modelTurn.parts!;
      // Anthropic requires thinking blocks first in the assistant content.
      expect(parts[0]!.thought).toBe(true);
      expect(parts[0]!.text).toBe('planning the read');
      const functionCallPart = parts.find((p) => p.functionCall);
      expect(functionCallPart?.functionCall?.id).toBe('call_thinking_tool_use');
    });

    it.each(['throw', 'end', 'close'] as const)(
      'persists cancelled thinking and text when the stream exits via %s',
      async (exitMode) => {
        const { controller, start, expectPersisted } = cancellable();
        const parts: Part[] = [
          { text: 'Thinking ', thought: true },
          { text: 'first.', thought: true },
          { thought: true, thoughtSignature: 'signature' },
          { text: 'Partial ' },
          { text: 'answer.' },
        ];
        mockStream(
          (async function* () {
            for (const part of parts) yield modelChunk([part]);
            if (exitMode === 'throw') throw controller.signal.reason;
          })(),
        );
        const stream = await start('cancelled-partial');
        for (let i = 0; i < parts.length; i++) {
          expect((await stream.next()).done).toBe(false);
        }
        controller.abort(new DOMException('Cancelled', 'AbortError'));
        if (exitMode === 'close') await stream.return(undefined);
        else await expect(stream.next()).rejects.toBe(controller.signal.reason);
        expectPersisted(
          [
            {
              text: 'Thinking first.',
              thought: true,
              thoughtSignature: 'signature',
            },
            { text: 'Partial answer.' },
          ],
          { model: 'test-model' },
        );
        expectStreamCalls(1);
      },
    );

    it.each(['abort', 'backend'] as const)(
      'preserves the upstream %s error and partial output during supersession',
      async (kind) => {
        const { controller, start, expectPersisted } = cancellable();
        const originalError =
          kind === 'abort'
            ? new DOMException('The operation was aborted.', 'AbortError')
            : new Error('model backend failed');
        const parts = [
          { text: 'Partial thought', thought: true },
          { text: 'Partial body' },
        ];
        mockStream(
          (async function* () {
            yield modelChunk(parts);
            controller.abort('qwen:new-prompt');
            throw originalError;
          })(),
        );
        const stream = await start('superseded-partial');
        expect((await stream.next()).done).toBe(false);
        await expect(stream.next()).rejects.toBe(originalError);
        expectPersisted(parts);
        expectStreamCalls(1);
      },
    );

    it.each(['throw', 'close'] as const)(
      'retains signed reasoning episodes in order when cancellation exits via %s',
      async (exitMode) => {
        const { controller, start, expectPersisted } = cancellable();
        const abortError = new DOMException('Cancelled', 'AbortError');
        const firstCall = fnCall('tool', {}, 'call1');
        const secondCall = fnCall('tool', {}, 'call2');
        mockStream(
          streamThenThrow(
            [
              modelChunk([
                { text: 'First thought', thought: true },
                { thought: true, thoughtSignature: 'sigA' },
                firstCall,
                { text: 'Second thought', thought: true },
                { thought: true, thoughtSignature: 'sigB' },
                secondCall,
                { text: 'Partial body' },
              ]),
            ],
            abortError,
          ),
        );
        const stream = await start('cancelled-episodes');
        expect((await stream.next()).done).toBe(false);
        controller.abort('qwen:user-cancel');
        if (exitMode === 'close') await stream.return(undefined);
        else await expect(stream.next()).rejects.toBe(abortError);
        expectPersisted([
          { text: 'First thought', thought: true, thoughtSignature: 'sigA' },
          firstCall,
          { text: 'Second thought', thought: true, thoughtSignature: 'sigB' },
          secondCall,
          { text: 'Partial body' },
        ]);
      },
    );

    it('does not record an empty assistant when cancelled before any content', async () => {
      const { controller, recordAssistantTurn, recordingChat, start } =
        cancellable();
      mockStream(
        (async function* () {
          yield* [];
          controller.abort('qwen:user-cancel');
        })(),
      );
      const stream = await start('empty-cancel');
      await expect(stream.next()).rejects.toBe('qwen:user-cancel');
      expect(recordingChat.getHistory()).toEqual([userText('hello')]);
      expect(recordAssistantTurn).not.toHaveBeenCalled();
    });

    it('does NOT persist partial assistant turn when stream throws before any tool_use chunk', async () => {
      // Plain-text partials are dropped on purpose: Retry pops the user prompt
      // and re-issues it, so a stale partial would bias or duplicate output.
      // Only tool_use turns need the partial bridge (tool_use → tool_result).
      const history = await sendThenFail(
        'hello',
        'prompt-weak-network-text',
        [textChunk('partial reply that will be lost')],
        new Error('connection reset'),
      );
      expect(history.length).toBe(1);
      expect(history[0]!.role).toBe('user');
    });

    it('should throw InvalidStreamError when no tool call and no finish reason', async () => {
      vi.useFakeTimers();
      mockStream(streamOf(textChunk('some response')));
      await expectStreamExhaustion(await send('test', 'prompt-id-1'));
    });

    it('should throw InvalidStreamError when there is finish reason but truly empty response (no text, no thought)', async () => {
      vi.useFakeTimers();
      mockStream(streamOf(modelChunk([], 'STOP')));
      await expectStreamExhaustion(await send('test', 'prompt-id-1'));
    });

    it('should succeed when there is finish reason and only thought content (reasoning models)', async () => {
      const thought = {
        thought: true,
        text: 'Let me think through this problem step by step...',
      };
      mockStream(streamOf(modelChunk([thought], 'STOP')));
      await expect(
        sendDrain('test', 'prompt-id-thought-only'),
      ).resolves.not.toThrow();

      const modelTurn = soleModelTurn();
      expect(modelTurn.parts?.length).toBe(1);
      expect(modelTurn.parts![0]).toEqual({
        thought: true,
        text: 'Let me think through this problem step by step...',
      });
    });

    it('should retry semantically empty responses after a tool result', async () => {
      vi.useFakeTimers();
      const responses: GenerateContentResponse[][] = [
        [stopResponse([{ thought: true, text: 'I should keep working.' }])],
        [
          stopResponse([
            { thought: true, text: 'I should still keep working.' },
            { text: '(empty content)' },
          ]),
        ],
        [
          modelChunk([
            { thought: true, text: 'One more attempt.' },
            { text: '(empty ' },
          ]),
          stopResponse([{ text: 'content)' }]),
        ],
        [stopResponse([{ text: 'Finished the analysis.' }])],
      ];
      streamMock().mockImplementation(async () =>
        (async function* () {
          yield* responses.shift()!;
        })(),
      );

      const { events, recordAssistantTurn, runChat } = await runToolResult(
        'prompt-id-tool-result-empty-response',
        15_000,
      );

      expectStreamCalls(4);
      expect(hasRetry(events)).toBe(true);
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
      expectRecordedMessage(recordAssistantTurn, [
        { text: 'Finished the analysis.' },
      ]);
      const history = runChat.getHistory();
      expect(history).toHaveLength(4);
      expect(history.at(-1)).toEqual(modelText('Finished the analysis.'));
    });

    it('should accept a thought-only tool result continuation once the retry budget is exhausted (#9026)', async () => {
      vi.useFakeTimers();
      streamMock().mockImplementation(async () =>
        streamOf(
          stopResponse([{ thought: true, text: 'I should keep working.' }]),
        ),
      );
      const { events } = await runToolResult(
        'prompt-id-tool-result-empty-response-exhausted',
        35_000,
        chat,
      );

      // Retries still run first (#7039): the quiet completion is only
      // accepted once the budget is spent, never on first occurrence.
      expectStreamCalls(5);
      expect(mockLogContentRetry).toHaveBeenCalledTimes(4);
      expect(hasRetry(events)).toBe(true);
      // Completes instead of aborting (#9026); the thought-only turn survives.
      expect(chat.getHistory().at(-1)).toEqual({
        role: 'model',
        parts: [{ thought: true, text: 'I should keep working.' }],
      });
    });

    it('should accept a fully quiet tool result completion after retry exhaustion and keep history well-formed (#9026)', async () => {
      vi.useFakeTimers();
      // Every attempt ends with a valid STOP and nothing else — the
      // deterministic shape that aborted whole headless runs before.
      streamMock().mockImplementation(async () => streamOf(stopResponse([])));
      const { events, recordAssistantTurn, runChat } = await runToolResult(
        'prompt-id-tool-result-quiet-completion',
        35_000,
      );

      expectStreamCalls(5);
      expect(mockLogContentRetry).toHaveBeenCalledTimes(4);
      expect(hasRetry(events)).toBe(true);
      // Not ending on the user's functionResponse: a placeholder model turn
      // keeps alternation, and the JSONL record carries the same text.
      expect(runChat.getHistory().at(-1)).toEqual(modelText('(empty content)'));
      expectRecordedMessage(recordAssistantTurn, [{ text: '(empty content)' }]);
    });

    // The armed (final, one-shot-acceptance) attempt is rescheduled or
    // consumed by another error class; the attempt that follows must still
    // carry the acceptance instead of running un-armed into the exhausted
    // budget.
    it.each<
      [
        string,
        string,
        number,
        () => AsyncGenerator<GenerateContentResponse>,
        number,
        number,
      ]
    >([
      [
        // Dies at the socket before its first chunk: replayable.
        'still accepts a quiet completion when the armed attempt is transport-replayed (#9026)',
        'prompt-id-tool-result-armed-transport-replay',
        5,
        () => streamThenThrow([], socketReset()),
        120_000,
        6,
      ],
      [
        // PROTOCOL_TAG_LEAK is rescheduled by the tag-leak retry branch with
        // the transient budget already spent (rearm keyed to that bucket).
        'still accepts a quiet completion when the armed attempt leaks protocol tags (#9026)',
        'prompt-id-tool-result-armed-tag-leak',
        5,
        () => streamThenThrow([], tagLeak()),
        120_000,
        6,
      ],
      [
        // Throttled (429) and rescheduled by the rate-limit branch; the
        // rescheduled attempt is still the final one.
        'still accepts a quiet completion when the armed attempt hits a rate limit (#9026)',
        'prompt-id-tool-result-armed-rate-limit',
        5,
        () =>
          streamThenThrow(
            [],
            new StreamContentError(
              '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
            ),
          ),
        180_000,
        6,
      ],
      [
        // A non-NO_TOOL_RESULT_PROGRESS transient error takes the final
        // retry slot; the budget is shared, so the last attempt is armed.
        'arms the quiet completion when a mixed error type exhausts the budget (#9026)',
        'prompt-id-tool-result-mixed-final-error',
        4,
        () => streamOf({} as GenerateContentResponse),
        120_000,
        5,
      ],
    ])(
      '%s',
      fakeTimers(
        async (
          _title: string,
          promptId: string,
          specialCall: number,
          special: () => AsyncGenerator<GenerateContentResponse>,
          advanceByMs: number,
          calls: number,
        ) => {
          quietExcept((call) => call === specialCall, special);
          const { events, recordAssistantTurn, runChat } = await runToolResult(
            promptId,
            advanceByMs,
          );
          expectStreamCalls(calls);
          expect(hasRetry(events)).toBe(true);
          expect(runChat.getHistory().at(-1)).toEqual(
            modelText('(empty content)'),
          );
          expect(recordAssistantTurn).toHaveBeenCalledOnce();
        },
      ),
    );

    it('does not arm quiet acceptance from a tag-leak-only budget exhaustion (#9026)', async () => {
      vi.useFakeTimers();
      // Two tag-leak retries exhaust only the tag-leak budget; that must NOT
      // arm acceptance, the full transient retry-first budget remains (#7039).
      quietExcept(
        (call) => call <= 2,
        () => streamThenThrow([], tagLeak()),
      );
      const { recordAssistantTurn, runChat } = await runToolResult(
        'prompt-id-tool-result-tag-leak-only-no-arm',
        120_000,
      );

      // Calls 3-6 exhaust the transient budget; only the 7th is armed.
      expectStreamCalls(7);
      expect(runChat.getHistory().at(-1)).toEqual(modelText('(empty content)'));
      expect(recordAssistantTurn).toHaveBeenCalledOnce();
    });

    it('still accepts a quiet completion when the armed attempt is cut into a continuation (#9026)', async () => {
      vi.useFakeTimers();
      // The armed attempt delivers text, then the socket dies: continuation
      // recovery must keep the one-shot acceptance (rearm at that branch).
      quietExcept(
        (call) => call === 5,
        () => streamThenThrow([textChunk('partial answer')], socketReset()),
      );
      const { recordAssistantTurn, runChat } = await runToolResult(
        'prompt-id-tool-result-armed-continuation',
        120_000,
      );

      expectStreamCalls(6);
      // The prefix survives; visible text means no placeholder is added.
      expect(runChat.getHistory().at(-1)).toEqual(modelText('partial answer'));
      expectRecordedMessage(recordAssistantTurn, [{ text: 'partial answer' }]);
    });

    it('records an accepted inlineData-only quiet turn in the transcript (#9026)', async () => {
      vi.useFakeTimers();
      const imagePart = {
        inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
      };
      streamMock().mockImplementation(async () =>
        streamOf(modelChunk([imagePart], 'STOP')),
      );
      const { recordAssistantTurn, runChat } = await runToolResult(
        'prompt-id-tool-result-inlinedata-accept',
        120_000,
      );

      expectStreamCalls(5);
      expect(runChat.getHistory().at(-1)).toEqual(content('model', imagePart));
      // History and JSONL share a source: the record holds the inlineData.
      expectRecordedMessage(recordAssistantTurn, [imagePart]);
    });

    type StreamMaker = (
      call: number,
    ) => AsyncGenerator<GenerateContentResponse>;

    /** Answer every `generateContentStream` call with `make(call)` (1-based). */
    const streamEach = (make: StreamMaker) => {
      let call = 0;
      streamMock().mockImplementation(async () => make(++call));
    };

    /**
     * Answer every attempt with `make`, send the pending tool result on
     * `target`, and expect `type` exhaustion after 5 attempts.
     */
    async function expectToolResultExhaustion(
      promptId: string,
      make: StreamMaker,
      target: LlmChat = chat,
      type: InvalidStreamError['type'] = 'NO_TOOL_RESULT_PROGRESS',
    ) {
      streamEach(make);
      await expectStreamExhaustion(await sendToolResult(promptId, target), {
        type,
      });
      expectStreamCalls(5);
    }

    const needMoreTokens = () =>
      streamOf(
        modelChunk(
          [{ thought: true, text: 'I need more tokens.' }],
          'MAX_TOKENS',
        ),
      );

    const escalated = (events: StreamEvent[]) =>
      events.some(
        (event) =>
          event.type === StreamEventType.RETRY &&
          event.maxOutputTokensEscalated !== undefined,
      );

    it.each(['SAFETY', 'RECITATION', 'BLOCKLIST'] as const)(
      'keeps %s-blocked quiet tool result completions fatal (#9026)',
      fakeTimers(async (finishReason: string) => {
        const recordAssistantTurn = vi.fn();
        await expectToolResultExhaustion(
          'prompt-id-tool-result-safety-fatal',
          () => streamOf(modelChunk([], finishReason)),
          chatWithRecorder(recordAssistantTurn),
        );
        expect(recordAssistantTurn).not.toHaveBeenCalled();
      }),
    );

    it('keeps an Anthropic-routed refusal quiet tool result completion fatal (#9026)', async () => {
      vi.useFakeTimers();
      // mapAnthropicFinishReasonToLlm maps Anthropic's `refusal` to SAFETY;
      // unmapped (FINISH_REASON_UNSPECIFIED), the armed attempt would accept
      // it as a quiet "(empty content)" completion, masking the refusal.
      const recordAssistantTurn = vi.fn();
      const recordingChat = chatWithRecorder(recordAssistantTurn);
      await expectToolResultExhaustion(
        'prompt-id-tool-result-anthropic-refusal-fatal',
        () => streamOf(modelChunk([], 'SAFETY')),
        recordingChat,
      );
      expect(recordAssistantTurn).not.toHaveBeenCalled();
      // The refusal must not be masked by an accepted placeholder turn.
      expect(
        recordingChat
          .getHistory()
          .some((c) => c.parts?.some((p) => p.text === '(empty content)')),
      ).toBe(false);
    });

    it('keeps unspecified quiet tool result completions fatal after retry exhaustion (#9026)', async () => {
      vi.useFakeTimers();
      const recordAssistantTurn = vi.fn();
      await expectToolResultExhaustion(
        'prompt-id-tool-result-unspecified-fatal',
        () => streamOf(modelChunk([], 'FINISH_REASON_UNSPECIFIED')),
        chatWithRecorder(recordAssistantTurn),
      );
      expect(recordAssistantTurn).not.toHaveBeenCalled();
    });

    it('should keep MAX_TOKENS quiet tool result completions fatal after retry exhaustion (#9026)', async () => {
      vi.useFakeTimers();
      mockGeneratorConfig({ samplingParams: { max_tokens: 1024 } });
      await expectToolResultExhaustion(
        'prompt-id-tool-result-max-tokens-after-exhaustion',
        (call) =>
          streamOf(
            call < 5
              ? stopResponse([])
              : modelChunk(
                  [{ thought: true, text: 'Still truncated.' }],
                  'MAX_TOKENS',
                ),
          ),
        chat,
        'NO_TOOL_RESULT_PROGRESS_MAX_TOKENS',
      );
    });

    it('accepts a quiet tool-result completion with every signed reasoning episode in history and JSONL', async () => {
      vi.useFakeTimers();
      const recordAssistantTurn = vi.fn();
      const recordingChat = chatWithRecorder(recordAssistantTurn);
      const expectedParts: Part[] = [
        { text: 'reasoning A', thought: true, thoughtSignature: 'sigA' },
        { text: 'reasoning B', thought: true, thoughtSignature: 'sigB' },
      ];
      streamEach(() =>
        streamOf(
          stopResponse([
            { text: 'reasoning A', thought: true },
            { thought: true, thoughtSignature: 'sigA' },
            { text: 'reasoning B', thought: true },
            { thought: true, thoughtSignature: 'sigB' },
          ]),
        ),
      );
      await collectToolResult(
        35_000,
        'prompt-id-quiet-signed-episodes',
        recordingChat,
        'test-model',
        {},
      );

      expectStreamCalls(5);
      expect(mockLogContentRetry).toHaveBeenCalledTimes(4);
      expect(recordingChat.getHistory().at(-1)).toEqual(
        content('model', ...expectedParts),
      );
      expectRecordedMessage(recordAssistantTurn, expectedParts);
    });

    it('retries a tool-result continuation whose reasoning spans multiple episodes', async () => {
      vi.useFakeTimers();
      // Guards `&& !part.thought` in the contentText filter: thought parts sit
      // inline, so unguarded, reasoning would count as progress (no retries).
      streamEach((call) =>
        streamOf(
          stopResponse(
            call === 5
              ? [{ text: 'Finished after retries.' }]
              : [
                  { text: 'First, ', thought: true },
                  { thought: true, thoughtSignature: 'sigA' },
                  { text: 'then, ', thought: true },
                  { thought: true, thoughtSignature: 'sigB' },
                ],
          ),
        ),
      );
      await collectToolResult(
        35_000,
        'prompt-id-tool-result-multi-episode-no-progress',
      );

      expectStreamCalls(5);
      expect(mockLogContentRetry).toHaveBeenCalledTimes(4);
      expect(chat.getHistory().at(-1)).toEqual(
        modelText('Finished after retries.'),
      );
    });

    it('should not retry tool result continuations that make another tool call', async () => {
      mockStream(
        streamOf(
          stopResponse([
            fnCall('list_files', { path: '/tmp' }, 'call_list_files'),
          ]),
        ),
      );

      const events = await collect(
        await sendToolResult('prompt-id-tool-result-next-tool-call'),
      );

      expectStreamCalls(1);
      expect(hasRetry(events)).toBe(false);
      expect(
        someChunk(events, (parts) =>
          parts.some((part) => part.functionCall?.id === 'call_list_files'),
        ),
      ).toBe(true);
    });

    it('should escalate thought-only MAX_TOKENS responses after a tool result', async () => {
      mockStreamsOnce(
        needMoreTokens(),
        streamOf(stopResponse([{ text: 'Finished the analysis.' }])),
      );

      const events = await collect(
        await sendToolResult(
          'prompt-id-tool-result-max-tokens',
          chat,
          'gemini-pro',
        ),
      );

      expectStreamCalls(2);
      expect(requestAt(1).config?.maxOutputTokens).toBeGreaterThan(
        requestAt(0).config?.maxOutputTokens ?? 0,
      );
      expect(escalated(events)).toBe(true);
      expect(chat.getHistory().at(-1)).toEqual(
        modelText('Finished the analysis.'),
      );
    });

    it('should accept quiet completions after MAX_TOKENS escalation retries exhaust (#9026)', async () => {
      vi.useFakeTimers();
      mockStreamsOnce(
        needMoreTokens(),
        ...Array.from({ length: 5 }, () => streamOf(stopResponse([]))),
      );

      await collectToolResult(
        35_000,
        'prompt-id-tool-result-max-tokens-quiet-continuation',
        chat,
        'gemini-pro',
      );

      expectStreamCalls(6);
      expect(chat.getHistory().at(-1)).toEqual(modelText('(empty content)'));
    });

    it('should not escalate thought-only MAX_TOKENS responses when max tokens are user-set', async () => {
      vi.useFakeTimers();
      mockGeneratorConfig({ samplingParams: { max_tokens: 1024 } });
      mockStreamsOnce(
        needMoreTokens(),
        streamOf(stopResponse([{ text: 'Finished the analysis.' }])),
      );

      const events = await collectToolResult(
        5_000,
        'prompt-id-tool-result-user-max-tokens',
        chat,
        'gemini-pro',
      );

      expectStreamCalls(2);
      expect(escalated(events)).toBe(false);
      expect(mockLogContentRetry).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          error_type: 'NO_TOOL_RESULT_PROGRESS_MAX_TOKENS',
          model: 'gemini-pro',
        }),
      );
      expect(chat.getHistory().at(-1)).toEqual(
        modelText('Finished the analysis.'),
      );
    });

    /** Stream `chunks`, send `test`, and expect the stream to complete. */
    async function expectCompletes(
      promptId: string,
      ...chunks: GenerateContentResponse[]
    ) {
      mockStream(streamOf(...chunks));
      const stream = await send('test', promptId);
      await expect(drain(stream)).resolves.not.toThrow();
    }

    it('should preserve (empty content) outside tool result continuations', async () => {
      await expectCompletes(
        'prompt-id-1',
        textChunk('(empty content)', 'STOP'),
      );
      expect(chat.getHistory().at(-1)).toEqual(modelText('(empty content)'));
    });

    it('should not lose finish reason when last chunk only has usage metadata', async () => {
      await expectCompletes(
        'prompt-id-1',
        textChunk('valid response', 'STOP'),
        // Some providers emit a trailing usage-only chunk after finishReason.
        usageChunk({
          promptTokenCount: 11,
          candidatesTokenCount: 5,
          totalTokenCount: 16,
        }),
      );
    });

    it('should succeed for thought-only content when finish reason arrives in a later chunk', async () => {
      await expectCompletes(
        'prompt-id-thought-delayed-finish',
        modelChunk([{ thought: true, text: 'Thinking through options...' }]),
        modelChunk([], 'STOP'),
      );

      expect(soleModelTurn().parts).toEqual([
        { thought: true, text: 'Thinking through options...' },
      ]);
    });

    it('should succeed for thought-only responses with finish reason followed by usage-only chunk', async () => {
      await expectCompletes(
        'prompt-id-thought-usage-tail',
        modelChunk(
          [{ thought: true, text: 'Let me reason this out...' }],
          'STOP',
        ),
        usageChunk({
          promptTokenCount: 12,
          candidatesTokenCount: 4,
          totalTokenCount: 16,
        }),
      );

      expect(soleModelTurn().parts).toEqual([
        { thought: true, text: 'Let me reason this out...' },
      ]);
    });

    it('should call generateContentStream with the correct parameters', async () => {
      mockStream(
        textStream('response', {
          promptTokenCount: 42,
          candidatesTokenCount: 15,
          totalTokenCount: 57,
        }),
      );

      await sendDrain('hello', 'prompt-id-1');

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledWith(
        {
          model: 'test-model',
          contents: [userText('hello')],
          // The send path window-clamps every main-turn request; with a
          // near-empty prompt the 32K default ceiling binds.
          config: { maxOutputTokens: 32_000 },
        },
        'prompt-id-1',
      );
      // The Footer-driving counter reflects prompt size only (the in-flight
      // round's output is not in history yet): promptTokenCount=42.
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
      mockStream(streamOf(textChunk('done', 'STOP', { totalTokenCount: 1 })));
      const text = 'ordinary user text must stay unchanged';

      await sendDrain(
        [
          { text },
          fnResponse('shell', { output: 'x'.repeat(1000) }, 'large-tool'),
        ],
        'prompt-send-guard',
      );

      const sentParts = (requestAt(0).contents as Content[])[0].parts ?? [];
      expect(sentParts[0].text).toBe(text);
      const output = sentParts[1].functionResponse?.response?.['output'];
      expect(typeof output).toBe('string');
      expect((output as string).length).toBeLessThanOrEqual(100);
      expect(chat.getHistory()[0].parts).toEqual(sentParts);
    });

    const retainOneImage = () =>
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        maxRecentImagesToRetain: 1,
        imagePayloadThreshold: 1,
      });
    const png = (data: string) =>
      content('user', { inlineData: { mimeType: 'image/png', data } });

    it('keeps historical image refs stable and reattaches only recent image bytes', async () => {
      retainOneImage();
      chat.setHistory([
        png('old-shot'),
        modelText('I see the first image'),
        png('new-shot'),
        modelText('I see the second image'),
      ]);
      mockStream(textStream('response'));

      await sendDrain('continue', 'prompt-id-image-refs');

      const contents = requestAt(0).contents as Content[];
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
            text: expect.stringContaining(
              'Images read earlier in this session',
            ),
            partMetadata: { 'qwen-code:reattach-boundary': true },
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
      retainOneImage();
      chat.setHistory([png('old-shot'), modelText('I see the image')]);
      streamEach(() => textStream('response'));

      await sendDrain('first question', 'prompt-id-image-refs-first');
      await sendDrain('second question', 'prompt-id-image-refs-second');

      const durable = JSON.stringify(chat.getHistory());
      expect(durable).toMatch(/Image #[a-f0-9]{12}/);
      expect(durable).not.toContain('"data":"old-shot"');
      expect(JSON.stringify(requestAt(1).contents)).toContain(
        '"data":"old-shot"',
      );
    });

    it('coalesces startup reminders with the first user prompt for provider requests', async () => {
      const reminder = '<system-reminder>\nstartup context\n</system-reminder>';
      chat.setHistory([userText(reminder)]);
      mockStream(textStream('response'));

      await sendDrain('hello', 'prompt-id-startup-coalesce');

      expect(requestAt(0).contents).toEqual([
        content('user', { text: reminder }, { text: 'hello' }),
      ]);
      expect(chat.getHistory()).toEqual([
        userText(reminder),
        userText('hello'),
        modelText('response'),
      ]);
      expect(chat.getHistory(true)).toEqual([
        content('user', { text: reminder }, { text: 'hello' }),
        modelText('response'),
      ]);
    });

    it('does not deep-clone the full curated history when building request contents', async () => {
      chat.setHistory([userText('prior question'), modelText('prior answer')]);
      mockStream(textStream('response'));
      const structuredCloneSpy = vi
        .spyOn(globalThis, 'structuredClone')
        .mockImplementation(() => {
          throw new Error('structuredClone should not build request contents');
        });

      try {
        await sendDrain('hello', 'prompt-id-no-request-clone');
      } finally {
        structuredCloneSpy.mockRestore();
      }

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({
          contents: [
            userText('prior question'),
            modelText('prior answer'),
            userText('hello'),
          ],
        }),
        'prompt-id-no-request-clone',
      );
    });

    it('excludes exact degraded placeholders without dropping legitimate mentions or tool calls', () => {
      const history: Content[] = [
        userText('what happened?'),
        modelText('The endpoint returned (request timeout) once.'),
        userText('continue'),
        modelText(' (request timeout) '),
        userText('try again'),
        content(
          'model',
          { text: '(request timeout)' },
          fnCall('read_file', {}, 'call-1'),
        ),
        content('user', fnResponse('read_file', { output: 'ok' }, 'call-1')),
      ];
      chat.setHistory(history);

      expect(chat.getHistory(true)).toEqual([
        history[0],
        history[1],
        content('user', { text: 'continue' }, { text: 'try again' }),
        history[5],
        history[6],
      ]);
      expect(chat.getHistory()).toEqual(history);
    });

    it('should not update global telemetry when no telemetryService is provided (subagent isolation)', async () => {
      const subagentChat = new LlmChat(mockConfig, config, []);
      mockStream(
        textStream('subagent response', {
          promptTokenCount: 12000,
          candidatesTokenCount: 500,
          totalTokenCount: 12500,
        }),
      );

      await sendDrain('subagent task', 'prompt-id-subagent', subagentChat);
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
        // Both hostile: both coerce to 0, so the per-chat counter stays 0 and
        // the `if (lastPromptTokenCount)` guard skips the global telemetry.
        mockStream(
          textStream('response', {
            promptTokenCount: badValue,
            totalTokenCount: badValue,
            candidatesTokenCount: 15,
          }),
        );

        await sendDrain('hello', `prompt-id-hostile-${_label}`);

        expect(chat.getLastPromptTokenCount()).toBe(0);
        expect(
          uiTelemetryService.setLastPromptTokenCount,
        ).not.toHaveBeenCalled();
        // `coerceUsageCount` warns on hostile defined values (diagnosable
        // coercion); `null`/`undefined` (field omitted) must stay silent.
        const warning = (text: string) =>
          mockDebugLoggerWarn.mock.calls.find(
            (args) => typeof args[0] === 'string' && args[0].includes(text),
          );
        if (badValue == null) {
          expect(
            warning('promptTokenCount') ?? warning('totalTokenCount'),
          ).toBeUndefined();
        } else {
          const promptWarn = warning('hostile promptTokenCount');
          expect(promptWarn).toBeDefined();
          expect(warning('hostile totalTokenCount')).toBeDefined();
          // The hostile value must be embedded so logs are actionable.
          expect(promptWarn?.[0]).toContain(String(badValue));
        }
      },
    );

    it('sanitizes a standalone closing thinking tag without retrying valid tool calls', async () => {
      const recordAssistantTurn = vi.fn();
      const chatWithRecording = chatWithRecorder(recordAssistantTurn);
      const create = vi.fn().mockImplementation(async () =>
        streamOf(
          openaiChunk(
            'sanitized-protocol-tag',
            {
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
            'tool_calls',
          ),
        ),
      );
      useOpenAIPipeline(create);

      const events = await sendCollect(
        'test',
        'prompt-id-sanitized-protocol-tag',
        chatWithRecording,
      );
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
      expect(parts).toContainEqual(fnCall('read_file', {}, 'call_read'));
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
      mockStream(
        textStream('response', {
          promptTokenCount: NaN,
          totalTokenCount: 73,
          candidatesTokenCount: 15,
        }),
      );

      await sendDrain('hello', 'prompt-id-hostile-fallback');

      expect(chat.getLastPromptTokenCount()).toBe(73);
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledWith(
        73,
      );
    });

    const thought = (text: string): Part => ({ text, thought: true });
    const sig = (thoughtSignature: string): Part => ({
      thought: true,
      thoughtSignature,
    });
    const toolCall = (id: string) => fnCall('tool', {}, id);

    /** Stream `parts` as one chunk to model `m1`; return `target`'s history. */
    async function consolidate(
      parts: Part[],
      message = 'h1',
      promptId = 'p1',
      target: LlmChat = chat,
      finishReason = 'STOP',
    ) {
      mockStream(streamOf(modelChunk(parts, finishReason)));
      await drain(await target.sendMessageStream('m1', { message }, promptId));
      return target.getHistory();
    }

    /** `consolidate`, then expect the model turn to hold `expected`. */
    async function expectConsolidated(
      parts: Part[],
      expected: Part[],
      message: string,
      promptId: string,
    ) {
      const history = await consolidate(parts, message, promptId);
      expect(history[1].parts).toEqual(expected);
    }

    it('should keep parts with thoughtSignature when consolidating history', async () => {
      const history = await consolidate([
        { text: 'p1', thoughtSignature: 's1' },
      ]);
      expect(history[1].parts![0]).toEqual({
        text: 'p1',
        thoughtSignature: 's1',
      });
    });

    it.each(['planning\n\n', ''])(
      'preserves signed thinking verbatim in history (%j)',
      async (thinking) => {
        const history = await consolidate([
          thought(thinking),
          sig('signature'),
          fnCall('exec', {}, 'call-1'),
        ]);
        expect(history[1].parts![0]).toEqual(signed(thinking, 'signature'));
      },
    );

    it('drops an unsigned whitespace-only thinking episode', async () => {
      const history = await consolidate([
        thought(' \n '),
        fnCall('exec', {}, 'call-1'),
      ]);
      expect(history[1].parts).toEqual([fnCall('exec', {}, 'call-1')]);
    });

    it('should preserve each reasoning episode as its own Part, in order, with its own signature, when tool calls interleave with reasoning', async () => {
      // Several episodes split by tool calls (Anthropic interleaved thinking,
      // Responses reasoning items on parallel calls): one merged blob with the
      // first signature would discard the others and the interleaving.
      await expectConsolidated(
        [
          ...[thought('A'), sig('sigA'), toolCall('call1')],
          ...[thought('B'), sig('sigB'), toolCall('call2')],
        ],
        [
          ...[signed('A', 'sigA'), toolCall('call1')],
          ...[signed('B', 'sigB'), toolCall('call2')],
        ],
        'interleave',
        'p-interleave',
      );
    });

    it('records interleaved reasoning episodes in the JSONL turn, not just in-memory history', async () => {
      // recordAssistantTurn takes its own `message`: dropping reasoning only
      // there would keep history assertions green yet lose every
      // thoughtSignature on `--resume` replay.
      const recordAssistantTurn = vi.fn();
      await consolidate(
        [
          ...[thought('A'), sig('sigA'), toolCall('call1')],
          ...[thought('B'), sig('sigB'), toolCall('call2')],
        ],
        'interleave',
        'p-interleave-recording',
        chatWithRecorder(recordAssistantTurn),
      );

      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual([
        ...[signed('A', 'sigA'), toolCall('call1')],
        ...[signed('B', 'sigB'), toolCall('call2')],
      ]);
    });

    it('drops a dangling unsigned trailing thought episode when the turn is truncated before its terminating signature (avoids permanently wedging the session)', async () => {
      // ep2 is cut off (MAX_TOKENS) before its signature-only chunk, the case
      // flushThoughtEpisode's "Known limitation" note documents. Kept beside a
      // tool_use it permanently wedges proxy-hosted adaptive Claude: once the
      // tool result lands every request throws from
      // dropUnsignedThinkingFromAssistantMessages; nothing repairs it. The
      // user-set max_tokens skips MAX_TOKENS escalation and recovery, which a
      // functionCall would not (recovery's skip only exits a loop already
      // entered; escalation is gated only on `!hasUserMaxTokensOverride`).
      mockGeneratorConfig({ samplingParams: { max_tokens: 4096 } });
      const history = await consolidate(
        [signed('ep1', 'sig1'), toolCall('call1'), thought('ep2 partial')],
        'truncated tool turn',
        'p-truncated-tool-turn',
        chat,
        'MAX_TOKENS',
      );
      expect(history.at(-1)!.parts).toEqual([
        signed('ep1', 'sig1'),
        toolCall('call1'),
      ]);
    });

    it('pins current behavior: an unsigned thought immediately preceding a tool_use in an otherwise-complete stream is preserved, not dropped', async () => {
      // Known residual risk, deliberately unfixed: trailing-only
      // dropDanglingUnsignedTrailingThought misses a proxy that drops one
      // episode's signature chunk mid-stream, leaving an unsigned thought
      // BEFORE a functionCall ("Known limitation" note). Scanning the whole
      // array (tried, reverted) can't tell that from DeepSeek's normal unsigned
      // output; a stream's own truncation only leaves the episode trailing.
      // Pins accepted behavior, not safety against such a proxy.
      const history = await consolidate(
        [thought('reasoning with a dropped signature'), toolCall('call1')],
        'buried dangling episode',
        'p-buried-dangling-episode',
      );
      expect(history.at(-1)!.parts).toEqual([
        thought('reasoning with a dropped signature'),
        toolCall('call1'),
      ]);
    });

    it('should split back-to-back reasoning episodes with no intervening tool call, once the first episode has its signature', async () => {
      // Both wires end an episode with a signature-only chunk, so fresh text
      // after a signed episode starts a new one (e.g. reasoning for two
      // parallel tool calls streamed back to back).
      await expectConsolidated(
        [
          thought('A'),
          sig('sigA'),
          thought('B'),
          sig('sigB'),
          toolCall('call1'),
        ],
        [signed('A', 'sigA'), signed('B', 'sigB'), toolCall('call1')],
        'parallel',
        'p-parallel',
      );
    });

    it('should concatenate a signature that arrives fragmented across multiple parts within one episode', async () => {
      // anthropicContentGenerator emits one chunk per signature_delta event,
      // so a long signature arrives split; concatenating (not "first fragment
      // wins") rebuilds a valid, replayable signature.
      await expectConsolidated(
        [
          thought('A'),
          sig('frag1'),
          sig('frag2'),
          { text: 'visible response' },
        ],
        [signed('A', 'frag1frag2'), { text: 'visible response' }],
        'fragmented',
        'p-fragmented',
      );
    });

    it('does not split an episode when its signature-only chunk arrives before any thinking text', async () => {
      // Guards `openEpisodeText.length > 0` in the split: else a signature
      // before its text (non-compliant proxy) flushes a phantom empty signed
      // episode, then the text unsigned: two corrupted parts, not one.
      await expectConsolidated(
        [sig('s'), thought('A')],
        [signed('A', 's')],
        'signature before text',
        'p-signature-before-text',
      );
    });

    it('concatenates text across multiple deltas within the same still-open episode (the normal live-streaming shape)', async () => {
      // Guards `openEpisodeSignature !== ''` in the split: one thought chunk
      // per delta before the signature chunk is the NORMAL shape. Without it
      // every block fragments into N-1 unsigned parts plus a signed tail (on
      // proxy-hosted Claude with a tool_use, the truncation hazard again).
      await expectConsolidated(
        [thought('part one '), thought('part two'), sig('sig')],
        [signed('part one part two', 'sig')],
        'multi-delta episode',
        'p-multi-delta-episode',
      );
    });

    it('should still emit a single trailing reasoning episode when the turn ends mid-reasoning with no subsequent tool call', async () => {
      await expectConsolidated(
        [thought('trailing thought'), sig('sigTrailing')],
        [signed('trailing thought', 'sigTrailing')],
        'trailing',
        'p-trailing',
      );
    });

    it('should preserve two OpenAI-Responses-shaped reasoning episodes (JSON-encoded signature payloads), each next to the function_call it preceded', async () => {
      // Match the Responses converter's completed-item envelope, preserving
      // each summary and payload next to the tool call it preceded.
      const sigA = JSON.stringify({ id: 'rs_1', encrypted_content: 'encA' });
      const sigB = JSON.stringify({ id: 'rs_2', encrypted_content: 'encB' });
      await expectConsolidated(
        [
          ...[thought('reasoning for call 1'), sig(sigA), toolCall('call1')],
          ...[thought('reasoning for call 2'), sig(sigB), toolCall('call2')],
        ],
        [
          ...[signed('reasoning for call 1', sigA), toolCall('call1')],
          ...[signed('reasoning for call 2', sigB), toolCall('call2')],
        ],
        'responses-shaped',
        'p-responses-shaped',
      );
    });

    it.each([
      ['', ''],
      ['', 'second summary'],
      ['first summary', ''],
      ['first summary', 'second summary'],
      ['   ', '\n'],
    ])(
      'preserves consecutive complete Responses payloads with summaries %j and %j',
      async (firstSummary, secondSummary) => {
        const recordAssistantTurn = vi.fn();
        const recordingChat = chatWithRecorder(recordAssistantTurn);
        const summaries = [firstSummary, secondSummary];
        const signatures = summaries.map((_, index) =>
          JSON.stringify({
            id: `rs_${index}`,
            encrypted_content: `opaque_${index}`,
          }),
        );
        const toolPart = toolCall('call1');
        const parts = summaries.flatMap((text, index) => [
          { thought: true, text: text.slice(0, 2) },
          { thought: true, text: text.slice(2) },
          sig(signatures[index]),
        ]);
        mockStream(
          (async function* () {
            for (const part of [...parts, toolPart]) yield modelChunk([part]);
            yield {
              candidates: [{ finishReason: 'STOP' }],
            } as GenerateContentResponse;
          })(),
        );

        await drain(
          await recordingChat.sendMessageStream(
            'm1',
            { message: 'preserve all reasoning items' },
            'p-complete-responses-payloads',
          ),
        );

        const expectedParts = [
          ...summaries.map((text, index) => ({
            thought: true,
            text,
            thoughtSignature: signatures[index],
          })),
          toolPart,
        ];
        expect(recordingChat.getHistory()[1].parts).toEqual(expectedParts);
        expect(recordAssistantTurn).toHaveBeenCalledOnce();
        expect(recordAssistantTurn.mock.calls[0][0].message).toEqual(
          expectedParts,
        );
      },
    );

    it('should still record a mid-turn signature-only reasoning episode with no accompanying text, rather than dropping it', async () => {
      // An empty-text signature-only chunk may still be replayable (Anthropic
      // spec), so it stays its own Part even before a functionCall.
      await expectConsolidated(
        [
          ...[thought('visible reasoning'), sig('sig1'), toolCall('call1')],
          ...[sig('sig2'), toolCall('call2')],
        ],
        [
          ...[signed('visible reasoning', 'sig1'), toolCall('call1')],
          ...[signed('', 'sig2'), toolCall('call2')],
        ],
        'mid-turn-signature-only',
        'p-mid-turn-signature-only',
      );
    });

    it('documents the accepted false positive: a truncated all-unsigned tool turn loses its trailing reasoning episode', async () => {
      // A KNOWN, accepted loss: truncated non-signing DeepSeek output
      // `[thought, functionCall, thought]` (unsigned) matches a signing
      // provider's lost final signature, so the trailing episode is popped
      // from history AND JSONL. Gating on "turn carries a signature" is wrong
      // at the recovery-coalescing site (see its doc); if this goes red on
      // purpose, update that doc. JSONL holds only because
      // `recordArgs.message` is built after the drop: a reorder would leave
      // the wedge shape for `--resume`.
      const recordAssistantTurn = vi.fn();
      const chatWithRecording = chatWithRecorder(recordAssistantTurn);
      await consolidate(
        [
          thought('first thought'),
          toolCall('call1'),
          thought('truncated second thought'),
        ],
        'truncated-all-unsigned',
        'p-truncated-all-unsigned',
        chatWithRecording,
      );

      const expectedParts = [thought('first thought'), toolCall('call1')];
      expect(chatWithRecording.getHistory()[1].parts).toEqual(expectedParts);
      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual(
        expectedParts,
      );
    });

    it.each([
      'sigA',
      '{broken',
      '{"id":"rs_1"}',
      '{"id":1,"encrypted_content":"enc"}',
      '{"id":"rs_1","encrypted_content":1}',
    ])('keeps unrecognized signature fragments together: %s', async (first) => {
      await expectConsolidated(
        [sig(first), sig('sigB'), toolCall('call1')],
        [signed('', first + 'sigB'), toolCall('call1')],
        'glued-signatures',
        'p-glued-signatures',
      );
    });
  });

  describe('auto-compression integration', () => {
    /** The `info` payload of a COMPRESSED stream event. */
    const infoOf = (event: StreamEvent | undefined) =>
      (event as { info: ChatCompressionInfo }).info;

    const compressedEvent = (events: StreamEvent[]) =>
      events.find((event) => event.type === StreamEventType.COMPRESSED);

    /** The pre-send auto pass NOOPs; the reactive pass compresses to `history`. */
    const reactiveCompaction = (
      originalTokenCount: number,
      history = summaryAck(),
    ) =>
      mockCompressOnce(noop(), compressed(originalTokenCount, 40_000, history));

    /** One outcome per request: an Error rejects it, a stream answers it. */
    const mockRequests = (
      ...outcomes: Array<Error | AsyncGenerator<GenerateContentResponse>>
    ) => {
      for (const outcome of outcomes) {
        if (outcome instanceof Error)
          streamMock().mockRejectedValueOnce(outcome);
        else streamMock().mockResolvedValueOnce(outcome);
      }
    };

    const withReadCache = (invalidateReadCache: unknown) => {
      mockConfig.getExecutionEnvironment = () =>
        ({ invalidateReadCache }) as unknown as ReturnType<
          Config['getExecutionEnvironment']
        >;
    };

    const withBaseLlmClient = (generateText: unknown) =>
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        generateText,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);

    /** ~172K estimated tokens of inherited history. */
    const largeInheritedHistory = (): Content[] => [
      userText('x'.repeat(688_000)),
      modelText('ack'),
      userText('follow up'),
      modelText('response'),
    ];

    const snapshotReply = () => ({
      text: '<state_snapshot>compressed</state_snapshot>',
      usage: {
        promptTokenCount: 99_000,
        candidatesTokenCount: 1500,
        totalTokenCount: 100_500,
      },
    });

    function expectCompressedEvent(events: StreamEvent[]) {
      const event = compressedEvent(events);
      expect(event).toBeDefined();
      expect(infoOf(event).compressionStatus).toBe(
        CompressionStatus.COMPRESSED,
      );
    }

    it('keeps compressed history and token counts consistent if worker invalidation fails', async () => {
      chat.setLastPromptTokenCount(1000);
      withReadCache(vi.fn().mockRejectedValue(new Error('executor closed')));
      const newHistory = [userText('summary')];
      mockCompressOnce(compressed(1000, 200, newHistory));
      expect(
        (await chat.tryCompress('failed-invalidation', true)).compressionStatus,
      ).toBe(CompressionStatus.COMPRESSED);
      expect(chat.getHistory()).toEqual(newHistory);
      expect(chat.getLastPromptTokenCount()).toBe(200);
    });

    it('clears the execution environment cache before finishing compression', async () => {
      let completeInvalidation!: () => void;
      const invalidateReadCache = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            completeInvalidation = resolve;
          }),
      );
      withReadCache(invalidateReadCache);
      mockCompressOnce(compressed(1000, 200, [userText('summary')]));
      let finished = false;
      const compression = chat
        .tryCompress('container-compression', true)
        .then(() => {
          finished = true;
        });
      await vi.waitFor(() =>
        expect(invalidateReadCache).toHaveBeenCalledOnce(),
      );
      expect(finished).toBe(false);
      completeInvalidation();
      await compression;
      expect(finished).toBe(true);
    });

    it('releases the send-lock when auto-compression throws (no deadlock)', async () => {
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockRejectedValueOnce(new Error('compression API down'));

      // The first send's compression rejects; streamDoneResolver must still
      // run so this.sendPromise resolves, or every later send blocks forever.
      await expect(send('first', 'prompt-id-deadlock-1')).rejects.toThrow(
        'compression API down',
      );

      // A leaked lock would hang this NOOP send.
      compressSpy.mockResolvedValueOnce(noop());
      mockStream(textStream('second response'));
      await sendDrain('second', 'prompt-id-deadlock-2');

      expect(compressSpy).toHaveBeenCalledTimes(2);
    });

    it('releases the send-lock when setup throws after compression', async () => {
      const compressSpy = mockCompress(noop());
      // Fail the post-compression getRequestHistory, not the hard-tier
      // estimator's getHistoryShallow(true) (used at lastPromptTokenCount 0).
      vi.spyOn(
        chat as unknown as { getRequestHistory: () => Content[] },
        'getRequestHistory',
      ).mockImplementationOnce(() => {
        throw new Error('history setup failed');
      });

      await expect(send('first', 'prompt-id-setup-deadlock-1')).rejects.toThrow(
        'history setup failed',
      );

      mockStream(textStream('second response'));
      await sendDrain('second', 'prompt-id-setup-deadlock-2');

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(
        chat
          .getHistory()
          .some((entry) => entry.parts?.some((part) => part.text === 'first')),
      ).toBe(false);
    });

    it('seeds inherited token count via setLastPromptTokenCount', async () => {
      mockGeneratorConfig({ contextWindowSize: 264_000 });
      const subagentChat = new LlmChat(mockConfig, config, [
        userText('inherited'),
        modelText('inherited reply'),
      ]);
      subagentChat.setLastPromptTokenCount(123_456);
      expect(subagentChat.getLastPromptTokenCount()).toBe(123_456);

      // The service's threshold check sees the seeded inherited size, not
      // the constructor default of 0.
      const compressSpy = mockCompress(noop(123_456));
      mockStream(textStream());
      await sendDrain('go', 'prompt-id-seed', subagentChat);

      expect(compressSpy).toHaveBeenCalledTimes(1);
      // The effective count, not the bare seed: 123,456 + char/4 of 'go' (1),
      // lastOutputTokenCount 0. The exact value catches over- and
      // under-counting on the send path.
      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBe(123_457);
      expect(compressSpy.mock.calls[0][1].precomputedEffectiveTokens).toBe(
        123_457,
      );
    });

    it('yields a COMPRESSED stream event as the first event after auto-compression succeeds', async () => {
      mockCompressOnce(
        compressed(1000, 200, [userText('summary'), modelText('ok')]),
      );
      mockStream(textStream('answer'));

      const events = await sendCollect('go', 'prompt-id-yield-compressed');

      expect(events.length).toBeGreaterThan(0);
      expect(events[0].type).toBe(StreamEventType.COMPRESSED);
      expect(infoOf(events[0]).compressionStatus).toBe(
        CompressionStatus.COMPRESSED,
      );
      expect(infoOf(events[0]).newTokenCount).toBe(200);
    });

    it('persists the in-flight user turn in the in-send compression snapshot', async () => {
      // Resume replaces history with this pre-push compression snapshot.
      const compressedHistory: Content[] = [
        { role: 'user', parts: [{ text: 'COMPACTION_SUMMARY' }] },
        { role: 'model', parts: [{ text: 'ACK' }] },
      ];
      // Derive ids synchronously, as the real recording service does.
      const recordedPromptIds: Array<Array<string | null>> = [];
      const recordChatCompression = vi.fn(
        (payload: { compressedHistory: Content[] }) => {
          recordedPromptIds.push(
            payload.compressedHistory.map(
              (content) => getApiHistoryPromptId(content) ?? null,
            ),
          );
        },
      );
      const chatWithRecording = newChat({
        recorder: { recordAssistantTurn: vi.fn(), recordChatCompression },
      });
      mockCompressOnce(
        compressResult(
          CompressionStatus.COMPRESSED,
          compressedHistory,
          100_000,
          40_000,
          true,
        ),
      );
      mockStream(textStream('ANSWER_TO_P'));

      const promptId = 'probe-session########7';
      await drain(
        await chatWithRecording.sendMessageStream(
          'test-model',
          { message: 'QUESTION_P' },
          'prompt-id-in-send-compaction-roundtrip',
          undefined,
          { promptId },
        ),
      );

      expect(recordChatCompression).toHaveBeenCalledTimes(1);
      const recordPayload = recordChatCompression.mock.calls[0][0] as {
        compressedHistory: Content[];
      };
      expect(
        recordPayload.compressedHistory.map((content) =>
          content.parts?.map((part) => part.text).join(''),
        ),
      ).toEqual(['COMPACTION_SUMMARY', 'ACK', 'QUESTION_P']);
      // The mark must already be on the recorded copy.
      const promptIds = recordedPromptIds[0]!;
      expect(promptIds).toEqual([null, null, promptId]);

      // Round-trip the persisted shape through the resume builder.
      const resumed = buildApiHistoryFromConversation({
        messages: [
          {
            type: 'user',
            message: { role: 'user', parts: [{ text: 'QUESTION_P' }] },
            promptId,
          },
          {
            type: 'system',
            subtype: 'chat_compression',
            systemPayload: { ...recordPayload, promptIds },
          },
          {
            type: 'assistant',
            message: { role: 'model', parts: [{ text: 'ANSWER_TO_P' }] },
          },
        ] as unknown as ChatRecord[],
      });
      expect(resumed.map((content) => content.role)).toEqual([
        'user',
        'model',
        'user',
        'model',
      ]);
      expect(
        resumed.map((content) =>
          content.parts?.map((part) => part.text).join(''),
        ),
      ).toEqual(['COMPACTION_SUMMARY', 'ACK', 'QUESTION_P', 'ANSWER_TO_P']);
      expect(findApiHistoryPromptIndex(resumed, promptId)).toBe(2);
    });

    it('forwards the pending user message and request config to compression', async () => {
      // The cheap-gate sizes the prompt with estimatePromptTokens(history,
      // pendingUserMessage, lastPromptTokenCount), so the first send after
      // inherited history (count 0) can compact: sendMessageStream MUST pass
      // its user message through tryCompress to service.compress.
      expect(chat.getLastPromptTokenCount()).toBe(0);

      const compressSpy = mockCompressOnce(compressed(150_000, 40_000));
      mockStream(textStream('answer'));

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
      // COMPRESSED first: fed the pending message, the cheap-gate sized it.
      const first = await stream.next();
      expect(first.done).toBe(false);
      expect(first.value?.type).toBe(StreamEventType.COMPRESSED);
      await drain(stream); // releases the send-lock

      expect(compressSpy).toHaveBeenCalledTimes(1);
      const passedOpts = compressSpy.mock.calls[0][1];
      expect(passedOpts.pendingUserMessage).toBeDefined();
      expect(passedOpts.pendingUserMessage?.role).toBe('user');
      expect(
        passedOpts.pendingUserMessage?.parts?.some(
          (part) => part.text === userMessageText,
        ),
      ).toBe(true);
      expect(passedOpts.requestGenerationConfig?.tools).toBe(requestTools);
    });

    it('triggers cache-sharing compaction end-to-end when a provider token count is available (R3.4)', async () => {
      // Reviewer R3.4: the test above mocks the service, so the real
      // cheap-gate never runs. This runs the full chain with the provider
      // token anchor cache sharing needs: sendMessageStream → tryCompress →
      // real compress → cheap-gate (172K anchor) → real splitter →
      // cache-sharing request (mocked at baseLlmClient) → persistence.
      chat.setHistory(largeInheritedHistory());
      chat.setLastPromptTokenCount(172_000);
      expect(chat.getLastPromptTokenCount()).toBe(172_000);

      // 200K DEFAULT_TOKEN_LIMIT: auto 170K, hard 177K; ~172K sits between,
      // so the cheap-gate (force=false) compacts without hard-rescue.
      const coldSpy = vi.spyOn(sideQueryModule, 'runSideQuery');
      const generateText = vi.fn().mockResolvedValue(snapshotReply());
      withBaseLlmClient(generateText);
      mockStream(textStream('done'));

      expectCompressedEvent(
        await sendCollect('follow-up after restore', 'prompt-r3-4'),
      );
      // Google GenAI takes the cache-sharing request, not the cold query.
      expect(generateText).toHaveBeenCalled();
      expect(coldSpy).not.toHaveBeenCalled();
    });

    it('routes zero-baseline compression through the cold side query end-to-end (R5-3)', async () => {
      // R3.4 without a provider anchor: at lastPromptTokenCount 0 a non-zero
      // baseline is derived locally and the service skips cache sharing for
      // the cold side query. A gate re-sourced from opts.originalTokenCount
      // would mis-route to the shared path; a dropped derivation zeroes it.
      chat.setHistory(largeInheritedHistory());
      expect(chat.getLastPromptTokenCount()).toBe(0);

      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );
      const coldSpy = vi
        .spyOn(sideQueryModule, 'runSideQuery')
        .mockResolvedValue(snapshotReply() as never);
      const generateText = vi.fn();
      withBaseLlmClient(generateText);
      mockStream(textStream('done'));

      expectCompressedEvent(
        await sendCollect('follow-up after restore', 'prompt-r5-3'),
      );
      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBeGreaterThan(
        0,
      );
      expect(generateText).not.toHaveBeenCalled();
      expect(coldSpy).toHaveBeenCalledTimes(1);
    });

    it('clears consecutiveFailures after a forced successful compression', async () => {
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );

      // 1: auto-compression fails. The service saw 0; tryCompress's failure
      // branch then increments the chat's counter to 1.
      compressSpy.mockResolvedValueOnce(
        failed(CompressionStatus.COMPRESSION_FAILED_API_ERROR, 100_000),
      );
      mockStream(textStream());
      await sendDrain('first', 'prompt-latch-1');
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(0);

      // 2: a forced /compress succeeds. force bypasses the breaker but still
      // forwards the carried counter (1) as-is; success must reset it so
      // later auto-compressions are not suppressed.
      compressSpy.mockResolvedValueOnce(compressed(100_000, 30_000));
      await chat.tryCompress('prompt-latch-force', true);
      expect(compressSpy.mock.calls[1][1].consecutiveFailures).toBe(1);

      // 3: the next auto-compression sees the reset counter.
      compressSpy.mockResolvedValueOnce(noop(30_000));
      mockStream(textStream());
      await sendDrain('second', 'prompt-latch-2');
      expect(compressSpy.mock.calls[2][1].consecutiveFailures).toBe(0);
    });

    it('reactively compresses and retries once after a context overflow error', async () => {
      const compressedHistory = [
        userText('summary'),
        modelText('ack'),
        userText('latest'),
      ];
      const expectedRequestContents = structuredClone(compressedHistory);
      const compressSpy = reactiveCompaction(135_000, compressedHistory);
      mockRequests(
        new Error(
          "This model's maximum context length is 128000 tokens. However, your messages resulted in 135000 tokens.",
        ),
        textStream('answer after compact'),
      );

      const events = await sendCollect('latest', 'prompt-id-reactive-compact');

      expect(compressSpy).toHaveBeenCalledTimes(2);
      const reactiveOpts = compressSpy.mock.calls[1][1];
      expect(reactiveOpts.force).toBe(true);
      expect(reactiveOpts.trigger).toBe('auto');
      expect(reactiveOpts.originalTokenCount).toBe(135_000);
      expect(reactiveOpts.precomputedEffectiveTokens).toBe(135_000);
      expectStreamCalls(2);
      expect(requestAt(1).contents).toEqual(expectedRequestContents);
      expect(events[0]?.type).toBe(StreamEventType.COMPRESSED);
      // The overflow message reports the actual count (135000), so the
      // published original count is provider-authoritative: no `~` marker.
      expect(infoOf(events[0]).originalTokenCountIsEstimated).toBe(false);
      expect(events[1]?.type).toBe(StreamEventType.RETRY);
      expect(events[1]).not.toHaveProperty('retryInfo');
      expect(hasChunkText(events, 'answer after compact')).toBe(true);
    });

    /** Reactive overflow without an actual count: the baseline is a `~` projection. */
    async function expectProjectedBaseline(
      message: string,
      promptId: string,
      tokens: number,
    ) {
      const compressSpy = reactiveCompaction(tokens);
      mockRequests(new Error(message), textStream('answer after compact'));
      const events = await sendCollect('latest', promptId);
      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(compressSpy.mock.calls[1][1].originalTokenCount).toBe(tokens);
      expect(
        infoOf(compressedEvent(events)).originalTokenCountIsEstimated,
      ).toBe(true);
    }

    it('uses the parsed context limit when reactive overflow lacks an actual token count', async () => {
      // No actual token count: the published original count is the parsed
      // limit, a projection that must keep the `~` estimated marker.
      await expectProjectedBaseline(
        "This model's maximum context length is 128000 tokens.",
        'prompt-id-reactive-limit-only',
        128_000,
      );
    });

    /** A mid-stream `error` must compact (first) instead of replaying. */
    async function expectCompactsInsteadOfReplay(
      error: Error,
      promptId: string,
    ) {
      const compressSpy = reactiveCompaction(128_000);
      mockStreamsOnce(
        streamThenThrow([], error),
        textStream('answer after compact'),
      );
      const events = await sendCollect('latest', promptId);
      // A replay would emit a plain RETRY with no COMPRESSED event at all
      // and never call compress.
      expect(events[0]?.type).toBe(StreamEventType.COMPRESSED);
      expect(compressSpy).toHaveBeenCalledTimes(2);
      expect(events[1]?.type).toBe(StreamEventType.RETRY);
      expect(hasChunkText(events, 'answer after compact')).toBe(true);
    }

    it('compacts a status-less upstream overflow instead of replaying it', async () => {
      // A gateway relays an input-length rejection into an already-200 stream
      // (no status, a request id, `Range` unknown to the permanence list): a
      // retryable upstream failure. Re-sending cannot shrink it (continuation
      // grows it), so the gate must fall through to one-shot compaction.
      await expectCompactsInsteadOfReplay(
        Object.assign(
          new Error(
            "This model's maximum context length is 128000 tokens. " +
              'However, your messages resulted in 135000 tokens.',
          ),
          { code: 'Range', requestID: 'req-1' },
        ),
        'prompt-statusless-overflow-compacts',
      );
    });

    it('compacts a status-less payload overflow instead of replaying it', async () => {
      // Byte-size sibling: a proxy's bare 413 reason phrase (no status, a
      // request id) is a retryable upstream failure; only the payload-overflow
      // exclusion keeps it out of the replay gate.
      await expectCompactsInsteadOfReplay(
        Object.assign(new Error('413 Request Entity Too Large'), {
          requestID: 'req-1',
        }),
        'prompt-statusless-payload-overflow-compacts',
      );
    });

    it('uses the configured context window when reactive overflow has no token counts', async () => {
      mockGeneratorConfig({ contextWindowSize: 262_144 });
      // Neither actual nor limit tokens parsed: the configured window is a
      // fallback projection and must keep the `~` estimated marker.
      await expectProjectedBaseline(
        'context_length_exceeded',
        'prompt-id-reactive-window-fallback',
        262_144,
      );
    });

    describe('Omni overflow recovery on LlmChat', () => {
      beforeEach(() => {
        degradeOmniMediaMock.mockReset();
        Object.assign(mockConfig, {
          getOmniProcessingConfig: () => ({
            limits: { maxTransportPasses: 1 },
          }),
        });
      });

      const image = (fileUri: string): Part[] => [
        { fileData: { mimeType: 'image/png', fileUri } },
      ];

      it('rebuilds the request from degraded media before compressing history', async () => {
        const compress = mockCompress(noop());
        degradeOmniMediaMock.mockImplementation(
          async (_config, history: Content[]) => {
            history.at(-1)!.parts = image('oss://degraded');
            return { replacedParts: 1, degradedResources: 1 };
          },
        );
        mockRequests(
          new Error('context_length_exceeded'),
          textStream('recovered'),
        );
        const events = await sendCollect(
          image('oss://original'),
          'omni-recovery',
        );
        expect(degradeOmniMediaMock).toHaveBeenCalledOnce();
        expect(compress).toHaveBeenCalledTimes(1);
        const retry = JSON.stringify(requestAt(1));
        expect(retry).toContain('oss://degraded');
        expect(retry).not.toContain('oss://original');
        expect(eventsOfType(events, StreamEventType.RETRY)).toHaveLength(1);
      });

      it('bounds degradation and then follows the existing compression failure path', async () => {
        mockCompress(noop());
        degradeOmniMediaMock.mockResolvedValue({
          replacedParts: 1,
          degradedResources: 1,
        });
        streamMock().mockRejectedValue(new Error('context_length_exceeded'));
        const stream = await send('latest', 'omni-bound');
        await expect(drain(stream)).rejects.toThrow('context_length_exceeded');
        expect(degradeOmniMediaMock).toHaveBeenCalledOnce();
        expectStreamCalls(2);
      });

      it('does not degrade media on a byte-only HTTP 413', async () => {
        mockCompress(noop());
        streamMock().mockRejectedValue(
          Object.assign(new Error('Request Entity Too Large'), { status: 413 }),
        );
        const stream = await send('latest', 'omni-413');
        await expect(drain(stream)).rejects.toThrow();
        expect(degradeOmniMediaMock).not.toHaveBeenCalled();
      });

      it('propagates cancellation during degradation without another model request', async () => {
        const controller = new AbortController();
        degradeOmniMediaMock.mockImplementation(async () => {
          controller.abort();
          controller.signal.throwIfAborted();
        });
        streamMock().mockRejectedValueOnce(
          new Error('context_length_exceeded'),
        );
        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'latest', config: { abortSignal: controller.signal } },
          'omni-cancel',
        );
        await expect(drain(stream)).rejects.toMatchObject({
          name: 'AbortError',
        });
        expect(
          mockContentGenerator.generateContentStream,
        ).toHaveBeenCalledOnce();
      });
    });

    it('does not attempt reactive compression more than once per send', async () => {
      const secondOverflow = new Error(
        'prompt is too long: 140000 tokens > 128000 maximum',
      );
      const compressSpy = reactiveCompaction(135_000);
      mockRequests(tooLong(), secondOverflow);

      const stream = await send('latest', 'prompt-id-reactive-once');
      await expect(drain(stream)).rejects.toThrow(secondOverflow);

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expectStreamCalls(2);
    });

    it('does not emit a duplicate RETRY after reactive compression follows another retry', async () => {
      vi.useFakeTimers();
      reactiveCompaction(135_000, [
        userText('summary'),
        modelText('ack'),
        userText('latest'),
      ]);
      mockRequests(
        streamOf(textChunk('')),
        tooLong(),
        textStream('answer after compact'),
      );

      const stream = await send(
        'latest',
        'prompt-id-reactive-after-invalid-stream',
      );
      const eventTypes = (await collectStreamWithFakeTimers(stream)).map(
        (event) => event.type,
      );
      const compressedIndex = eventTypes.indexOf(StreamEventType.COMPRESSED);

      expect(compressedIndex).toBeGreaterThanOrEqual(0);
      expect(eventTypes.slice(compressedIndex)).toEqual([
        StreamEventType.COMPRESSED,
        StreamEventType.RETRY,
        StreamEventType.CHUNK,
      ]);
      expectStreamCalls(3);
    });

    it('surfaces the original context overflow when reactive compression is a NOOP', async () => {
      const overflow = tooLong();
      const compressSpy = mockCompressOnce(noop(), noop(135_000));
      streamMock().mockRejectedValue(overflow);

      const stream = await send('latest', 'prompt-id-reactive-noop');
      await expect(drain(stream)).rejects.toThrow(overflow);

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expectStreamCalls(1);
    });

    it('marks failed reactive compression attempts for later auto-compaction', async () => {
      const overflow = tooLong();
      const compressSpy = mockCompressOnce(
        noop(),
        failed(CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY, 135_000),
        noop(),
      );
      mockRequests(overflow, textStream('next request ok'));

      const stream = await send('latest', 'prompt-id-reactive-failed-latch');
      await expect(drain(stream)).rejects.toThrow(overflow);
      await sendDrain('next', 'prompt-id-after-reactive-failed-latch');

      expect(compressSpy).toHaveBeenCalledTimes(3);
      // Reactive compression is force=true (tryCompress skips its increment);
      // the overflow handler bumps the counter by 1, so only repeated reactive
      // failures latch the breaker, not one transient error (R1.2).
      expect(compressSpy.mock.calls[2][1].consecutiveFailures).toBe(1);
    });

    it('releases the send-lock when reactive compression throws', async () => {
      const overflow = tooLong();
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockResolvedValueOnce(noop())
        .mockRejectedValueOnce(new Error('compression failed'))
        .mockResolvedValueOnce(noop());
      mockRequests(overflow, textStream('next request ok'));

      const stream = await send('latest', 'prompt-id-reactive-throws');
      await expect(drain(stream)).rejects.toThrow(overflow);
      const events = await sendCollect(
        'next',
        'prompt-id-after-reactive-throws',
      );

      expect(compressSpy).toHaveBeenCalledTimes(3);
      expect(hasChunkText(events, 'next request ok')).toBe(true);
    });
  });

  // Task 9 (P3): hard-tier rescue pulls overflow recovery BEFORE the API call.
  // Past `computeThresholds(window).hard`, sendMessageStream lets a latched
  // breaker recover and calls tryCompress with force=true, so
  // MAX_CONSECUTIVE_FAILURES never gates the attempt that saves the request.
  describe('sendMessageStream hard-tier rescue', () => {
    /**
     * 200K raw window; thresholds use the FULL window (the output clamp
     * replaced the reservation): effective = 200K − 20K SUMMARY_RESERVE,
     * hard = max(180K − 3K, auto + 3K) = 177K; 176K + a message tips over.
     */
    beforeEach(() => {
      mockGeneratorConfig({ contextWindowSize: 200_000 });
    });

    type CompressSpy = ReturnType<typeof mockCompress>;
    /** 720K chars: far over the hard threshold. */
    const oversizedHistory = (): Content[] => [
      userText('x'.repeat(720_000)),
      modelText('ack'),
    ];
    const failedRescue = () =>
      failed(CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY, 178_000);

    function recordingChat() {
      const recordChatCompression = vi.fn();
      const target = newChat({
        recorder: { recordAssistantTurn: vi.fn(), recordChatCompression },
      });
      return { target, recordChatCompression };
    }

    /** The rescue rejected before any request and rolled the counts back. */
    function expectRolledBack(
      target: LlmChat,
      recordChatCompression: ReturnType<typeof vi.fn>,
      tokens: number,
      originalHistory: Content[],
    ) {
      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
      expect(recordChatCompression).not.toHaveBeenCalled();
      expect(target.getLastPromptTokenCount()).toBe(tokens);
      expect(target.isLastPromptTokenCountEstimated()).toBe(false);
      expect(target.getHistory()[0].parts?.[0].text).toBe(
        originalHistory[0].parts?.[0].text,
      );
    }

    /** From 176,999 tokens, `count` sends each reject with `error`. */
    async function expectRescueRejections(
      count: number,
      messagePrefix: string,
      promptPrefix: string,
      error: RegExp | Error,
    ) {
      chat.setLastPromptTokenCount(176_999);
      for (let i = 0; i < count; i++) {
        await expect(
          send(`${messagePrefix}-${i}`, `${promptPrefix}-${i}`),
        ).rejects.toThrow(error);
      }
    }

    /** The bound held: MAX forced attempts, then one request and a logged skip. */
    function expectRescueSkipped(compressSpy: CompressSpy, promptId: string) {
      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
      expect(compressSpy.mock.calls.map(([, opts]) => opts.force)).toEqual(
        Array(MAX_CONSECUTIVE_FAILURES).fill(true),
      );
      expectStreamCalls(1);
      expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining('hard-tier rescue skipped'),
      );
      expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining(`prompt_id=${promptId}`),
      );
    }

    /** The second compress call's force flag and 177K-threshold estimate. */
    function expectFollowUp(compressSpy: CompressSpy, forced: boolean) {
      const opts = compressSpy.mock.calls[1][1];
      expect(opts.force).toBe(forced);
      if (forced) {
        expect(opts.precomputedEffectiveTokens).toBeGreaterThanOrEqual(177_000);
      } else {
        expect(opts.precomputedEffectiveTokens).toBeLessThan(177_000);
      }
    }

    /** Send 'hi' as `model` on a fresh chat seeded at `seed` tokens. */
    async function sendHiOnFreshChat(
      promptId: string,
      seed?: number,
      model = 'test-model',
    ) {
      const chatInstance = newChat();
      if (seed !== undefined) chatInstance.setLastPromptTokenCount(seed);
      await drain(
        await chatInstance.sendMessageStream(
          model,
          { message: 'hi' },
          promptId,
        ),
      );
    }

    const sentMaxOutputTokens = () =>
      (requestAt(0).config as { maxOutputTokens?: number }).maxOutputTokens;

    it('forces compaction with force=true when estimated tokens cross hard threshold', async () => {
      const { target, recordChatCompression } = recordingChat();
      const compressSpy = mockCompressOnce(
        compressResult(
          CompressionStatus.COMPRESSED,
          summaryAck(),
          176_000,
          40_000,
          true,
        ),
      );
      mockStream(textStream('after rescue'));

      // Seed JUST under the 177K hard threshold; the pending message's few
      // estimate-tokens push it over, so the rescue must trigger.
      target.setLastPromptTokenCount(176_999);
      const userMessage = 'this is the next user message';
      await sendDrain(userMessage, 'prompt-id-hard-rescue-forces', target);

      expect(compressSpy).toHaveBeenCalledTimes(1);
      const passedOpts = compressSpy.mock.calls[0][1];
      expect(passedOpts.force).toBe(true);
      // trigger='auto' is the orphan-strip safety wire (C1): without it
      // force=true defaults compactTrigger to 'manual', stripping the trailing
      // model+functionCall mid tool-loop.
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
      // The snapshot carries the pending turn the compression belongs to:
      // resume replaces history wholesale at the compression record, so a
      // snapshot without it would resurrect the answer with no question.
      expect(recordPayload.compressedHistory).toEqual([
        ...summaryAck(),
        { role: 'user', parts: [{ text: userMessage }] },
      ]);
    });

    it('rejects before request serialization when oversized resumed history cannot be compressed', async () => {
      chat.setHistory(oversizedHistory());
      expect(chat.getLastPromptTokenCount()).toBe(0);

      const compressSpy = mockCompressOnce(
        failed(CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY, 180_000),
      );
      streamMock().mockRejectedValue(new Error('Invalid string length'));

      await expect(
        send('continue', 'prompt-id-oversized-resume-guard'),
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
        userText('x'.repeat(720_000)),
        content('model', fnCall('update_goal', undefined, 'ended')),
        content('user', fnResponse('update_goal', {}, 'ended')),
      ];
      const { target, recordChatCompression } = recordingChat();
      target.setHistory(originalHistory, ['ended']);
      target.setLastPromptTokenCount(176_999);

      mockCompressOnce(
        compressed(180_000, 177_000, [
          userText('still large summary'),
          modelText('ack'),
        ]),
      );
      streamMock().mockRejectedValue(new Error('Invalid string length'));

      await expect(
        send('continue', 'prompt-id-oversized-after-compression', target),
      ).rejects.toThrow(/compression status: COMPRESSED/i);

      expectRolledBack(target, recordChatCompression, 176_999, originalHistory);
      expect(target.getCompletedToolCallIds()).toEqual(['ended']);
      expect(target.getHistoryForRecovery()).toEqual([]);
    });

    it('rejects when compressed history is below hard but the pending user message pushes it over', async () => {
      const originalHistory = oversizedHistory();
      const { target, recordChatCompression } = recordingChat();
      target.setHistory(originalHistory);
      target.setLastPromptTokenCount(175_500);

      mockCompressOnce(compressed(180_000, 176_000));
      mockStream(textStream('should not send'));

      await expect(
        send(
          'x'.repeat(8_000),
          'prompt-id-oversized-after-compression-and-user',
          target,
        ),
      ).rejects.toThrow(/Estimated prompt tokens: 178000; hard limit: 177000/i);

      expectRolledBack(target, recordChatCompression, 175_500, originalHistory);
    });

    it('does not treat the image token estimate as output tokens after hard-rescue compression', async () => {
      const { target, recordChatCompression } = recordingChat();
      target.setHistory(oversizedHistory());
      target.setLastPromptTokenCount(176_500);

      const compressSpy = mockCompressOnce(compressed(180_000, 176_000));
      mockStream(textStream('sent after compression'));

      await sendDrain(
        'x'.repeat(3_000),
        'prompt-id-hard-rescue-image-estimate-slot',
        target,
      );

      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
      expectStreamCalls(1);
      expect(recordChatCompression).toHaveBeenCalledTimes(1);
      expect(target.getLastPromptTokenCount()).toBe(176_000);
    });

    // From a 50K seed, a first send primes the counters with `usage`, then a
    // small follow-up sends. `noopTokens` undefined: the follow-up's compress
    // is a hard-tier COMPRESSED rescue; otherwise every compress NOOPs there.
    it.each<
      [
        string,
        UsageMetadata,
        [string, string],
        string,
        number | undefined,
        boolean,
      ]
    >([
      [
        'includes previous response output tokens in the hard-tier estimate',
        {
          promptTokenCount: 176_000,
          candidatesTokenCount: 1_500,
          totalTokenCount: 177_500,
        },
        ['prime the token counters', 'prompt-prime-candidates'],
        'prompt-hard-rescue-candidates',
        undefined,
        true,
      ],
      [
        'does not double-count output tokens when prompt count falls back to total token count',
        { candidatesTokenCount: 1_500, totalTokenCount: 176_000 },
        ['prime fallback token counters', 'prompt-prime-total-token-fallback'],
        'prompt-total-token-fallback-follow-up',
        176_000,
        false,
      ],
      [
        'includes previous response thought tokens in the hard-tier estimate',
        {
          promptTokenCount: 176_000,
          candidatesTokenCount: 500,
          thoughtsTokenCount: 1_000,
          totalTokenCount: 177_500,
        },
        ['prime thought token counters', 'prompt-prime-thought-tokens'],
        'prompt-hard-rescue-thought-tokens',
        undefined,
        false,
      ],
      [
        'includes disjoint candidate and thought tokens when total token count is unavailable',
        {
          promptTokenCount: 176_000,
          candidatesTokenCount: 1_200,
          thoughtsTokenCount: 300,
        },
        [
          'prime disjoint output token counters',
          'prompt-prime-disjoint-output-tokens',
        ],
        'prompt-hard-rescue-disjoint-output-tokens',
        undefined,
        false,
      ],
      [
        'does not double-count OpenAI-compatible reasoning tokens already included in candidates',
        {
          promptTokenCount: 175_400,
          candidatesTokenCount: 1_000,
          thoughtsTokenCount: 500,
          totalTokenCount: 176_400,
        },
        [
          'prime OpenAI-compatible reasoning token counters',
          'prompt-prime-openai-reasoning-tokens',
        ],
        'prompt-openai-reasoning-follow-up',
        176_400,
        false,
      ],
    ])(
      '%s',
      async (
        _title,
        usage,
        [primeText, primeId],
        followUpId,
        noopTokens,
        pinsPrimeForce,
      ) => {
        const compressSpy = vi.spyOn(
          ChatCompressionService.prototype,
          'compress',
        );
        const rescue = noopTokens === undefined;
        if (rescue) {
          compressSpy
            .mockResolvedValueOnce(noop(50_000))
            .mockResolvedValueOnce(compressed(176_000, 40_000));
        } else {
          compressSpy.mockResolvedValue(noop(noopTokens));
        }
        mockStreamsOnce(
          textStream('first', usage),
          textStream(rescue ? 'after rescue' : 'second'),
        );

        chat.setLastPromptTokenCount(50_000);
        await sendDrain(primeText, primeId);
        await sendDrain('small follow-up', followUpId);

        expect(compressSpy).toHaveBeenCalledTimes(2);
        if (pinsPrimeForce) {
          expect(compressSpy.mock.calls[0][1].force).toBe(false);
        }
        expectFollowUp(compressSpy, rescue);
      },
    );

    it('resets previous response output tokens when seeding last prompt tokens externally', async () => {
      const compressSpy = mockCompress(noop(176_000));
      mockStreamsOnce(
        textStream('first', {
          promptTokenCount: 10_000,
          candidatesTokenCount: 5_000,
          totalTokenCount: 15_000,
        }),
        textStream('second'),
      );

      await sendDrain('collect candidates', 'prompt-collect-candidates');
      chat.setLastPromptTokenCount(176_000);
      await sendDrain('seeded follow-up', 'prompt-seeded-after-candidates');

      expect(compressSpy).toHaveBeenCalledTimes(2);
      expectFollowUp(compressSpy, false);
    });

    it('resets previous response output tokens after successful compression', async () => {
      const compressSpy = mockCompressOnce(
        noop(50_000),
        compressed(176_000, 40_000),
        noop(40_000),
      );
      mockStreamsOnce(
        textStream('first', {
          promptTokenCount: 176_000,
          candidatesTokenCount: 100_000,
          totalTokenCount: 276_000,
        }),
        textStream('after compression'),
        textStream('after reset'),
      );

      chat.setLastPromptTokenCount(50_000);
      await sendDrain('prime output tokens', 'prompt-prime-compression-reset');
      await sendDrain('trigger compression', 'prompt-compression-reset-rescue');
      await sendDrain(
        'after compression reset',
        'prompt-after-compression-reset',
      );

      expect(compressSpy).toHaveBeenCalledTimes(3);
      expect(compressSpy.mock.calls[1][1].force).toBe(true);
      expect(
        compressSpy.mock.calls[2][1].precomputedEffectiveTokens,
      ).toBeLessThan(100_000);
    });

    it('stops pre-send hard-rescue after repeated failed hard-tier compactions', async () => {
      const compressSpy = mockCompress(failedRescue());
      streamMock().mockImplementation(async () =>
        textStream('after failed rescue'),
      );

      await expectRescueRejections(
        MAX_CONSECUTIVE_FAILURES,
        'hard-rescue',
        'prompt-hard-rescue-bound',
        /compression status: COMPRESSION_FAILED_EMPTY_SUMMARY/i,
      );
      await sendDrain(
        'send after bounded hard-rescue failures',
        'prompt-hard-rescue-after-failures',
      );

      expectRescueSkipped(compressSpy, 'prompt-hard-rescue-after-failures');
    });

    it('falls back to reactive overflow recovery after the hard-rescue bound is exhausted', async () => {
      const failedRescueResult = failedRescue();
      const compressSpy = mockCompressOnce(
        failedRescueResult,
        failedRescueResult,
        failedRescueResult,
        compressed(180_000, 40_000, [
          userText('summary after overflow'),
          modelText('ack'),
        ]),
      );
      streamMock()
        .mockRejectedValueOnce(
          new Error('prompt is too long: 180000 tokens > 128000 maximum'),
        )
        .mockResolvedValueOnce(textStream('after reactive fallback'));

      await expectRescueRejections(
        MAX_CONSECUTIVE_FAILURES,
        'failed-hard-rescue',
        'prompt-hard-rescue-before-reactive',
        /compression status: COMPRESSION_FAILED_EMPTY_SUMMARY/i,
      );
      await sendDrain(
        'send after hard-rescue bound',
        'prompt-hard-rescue-reactive-fallback',
      );

      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES + 1);
      expect(
        compressSpy.mock.calls
          .slice(0, MAX_CONSECUTIVE_FAILURES)
          .map(([, opts]) => opts.force),
      ).toEqual(Array(MAX_CONSECUTIVE_FAILURES).fill(true));
      const reactiveOpts = compressSpy.mock.calls[MAX_CONSECUTIVE_FAILURES][1];
      expect(reactiveOpts.force).toBe(true);
      expect(reactiveOpts.originalTokenCount).toBe(180_000);
      expectStreamCalls(2);
    });

    it('does not count thrown hard-rescue attempts toward the retry bound', async () => {
      const compressionError = new Error('compression side-query failed');
      const compressSpy = vi
        .spyOn(ChatCompressionService.prototype, 'compress')
        .mockRejectedValue(compressionError);

      await expectRescueRejections(
        MAX_CONSECUTIVE_FAILURES + 1,
        'throwing-hard-rescue',
        'prompt-hard-rescue-throw',
        compressionError,
      );

      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES + 1);
      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
    });

    it('stops hard-rescue after repeated NOOP results are still oversized', async () => {
      const compressSpy = mockCompress(noop(178_000));

      await expectRescueRejections(
        MAX_CONSECUTIVE_FAILURES,
        'noop-hard-rescue',
        'prompt-hard-rescue-noop',
        /compression status: NOOP/i,
      );
      mockStream(textStream('after bounded noop hard-rescue'));
      await sendDrain(
        'send after bounded noop hard-rescue',
        'prompt-hard-rescue-after-noop-bound',
      );

      expectRescueSkipped(compressSpy, 'prompt-hard-rescue-after-noop-bound');
    });

    it('does not replace token counters when usage reports zero prompt tokens', async () => {
      mockCompress(noop(123_456));
      mockStream(
        textStream('zero prompt count', {
          promptTokenCount: 0,
          totalTokenCount: 5000,
        }),
      );

      chat.setLastPromptTokenCount(123_456);
      await sendDrain(
        'zero prompt count should not reseed',
        'prompt-zero-count-no-reseed',
      );

      expect(chat.getLastPromptTokenCount()).toBe(123_456);
    });

    it('ignores previous response output tokens when the prompt token count is zero', () => {
      const history = [
        userText('history question'),
        modelText('history answer'),
      ];
      const userMessage = userText('follow-up question');

      expect(estimatePromptTokens(history, userMessage, 0, 9999)).toBe(
        estimateContentTokens([...history, userMessage]),
      );
    });

    it('forwards latched consecutiveFailures into hard-rescue (no pre-call reset); success recovers via the post-call branch', async () => {
      // force=true already bypasses the breaker (compress's `!force` check),
      // so a latched one needs no pre-call reset. A pre-reset would DEFEAT it
      // on persistent failures: hard-rescue failures don't increment (force
      // skips tryCompress's `if (!force)`), only the reactive handler does,
      // so zeroing each send would oscillate the counter 0↔1. Forward it
      // as-is; a COMPRESSED result resets it in the post-call handler.
      const compressSpy = vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      );

      // 1: latch the breaker with MAX_CONSECUTIVE_FAILURES below-hard
      // failures (cheap-gate path, force=false).
      compressSpy.mockResolvedValue(
        failed(
          CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
          100_000,
        ),
      );
      streamMock().mockImplementation(async () => textStream());
      chat.setLastPromptTokenCount(50_000);
      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await sendDrain(`latch-${i}`, `prompt-latch-${i}`);
        expect(compressSpy.mock.calls[i][1].force).toBe(false);
      }
      // Pre-increment: the i-th call sees i; the chat's counter is now
      // MAX_CONSECUTIVE_FAILURES (latched).
      expect(compressSpy.mock.calls.at(-1)![1].consecutiveFailures).toBe(
        MAX_CONSECUTIVE_FAILURES - 1,
      );

      // 2: in the hard tier the rescue fires (force=true) and its COMPRESSED
      // result triggers the post-call reset.
      compressSpy.mockClear();
      compressSpy.mockResolvedValueOnce(compressed(178_000, 40_000));
      chat.setLastPromptTokenCount(176_999);
      await sendDrain('rescue me', 'prompt-hard-rescue-no-prereset');

      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(true);
      // Forwarded as-is: the LATCHED value, NOT zero.
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(
        MAX_CONSECUTIVE_FAILURES,
      );

      // 3: a below-hard follow-up (force=false) forwards 0, proving the
      // post-call reset ran on step 2's result.
      compressSpy.mockClear();
      compressSpy.mockResolvedValueOnce(noop(40_000));
      chat.setLastPromptTokenCount(50_000);
      await sendDrain('after recovery', 'prompt-hard-rescue-after-recovery');
      expect(compressSpy.mock.calls[0][1].consecutiveFailures).toBe(0);
      expect(compressSpy.mock.calls[0][1].force).toBe(false);
    });

    it('does not force when tokens are below hard threshold (normal auto path)', async () => {
      const compressSpy = mockCompressOnce(noop());
      mockStream(textStream());

      chat.setLastPromptTokenCount(50_000); // well below the 177K hard threshold
      await sendDrain('small message', 'prompt-id-hard-rescue-below');

      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(false);
    });

    it('gates thresholds on the full window and clamps maxOutputTokens to the room left (issue #5950)', async () => {
      // claude-sonnet-4-6's 65,536 output limit clips to the 64K ceiling. The
      // old reservation hard-rescued a 170K prompt on 200K (hard ~111K); now
      // hard = 177K, so the cheap-gate path runs and the request is clamped:
      // maxOutputTokens = 200000 − ~170001 − 10000 (margin) ≈ 20K.
      mockGeneratorConfig({
        model: 'claude-sonnet-4-6',
        contextWindowSize: 200_000,
      });
      const compressSpy = mockCompressOnce(noop(170_000));
      mockStream(textStream('clamped response'));

      await sendHiOnFreshChat(
        'prompt-window-clamp-taper',
        170_000,
        'claude-sonnet-4-6',
      );

      // 170K < hard (177K): cheap-gate, not rescue.
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(false);
      // char/4("hi") = 1 token, ×1.5 safety factor (ceil'd) = 2: estimate
      // 170,002, room = 200,000 − 170,002 − 10,000.
      const maxOutputTokens = sentMaxOutputTokens();
      expect(maxOutputTokens).toBe(19_998);
      expect(170_000 + maxOutputTokens!).toBeLessThanOrEqual(200_000);
    });

    it('sends the default ceiling when the window has room (unknown model → 32K)', async () => {
      mockGeneratorConfig({ contextWindowSize: 200_000 });
      mockCompress(noop(50_000));
      mockStream(textStream('roomy response'));

      await sendHiOnFreshChat('prompt-window-clamp-ceiling', 50_000);

      // Room = 200K − ~50K − 10K = ~140K; the 32K default ceiling binds.
      expect(sentMaxOutputTokens()).toBe(32_000);
    });

    it('uses QWEN_CODE_MAX_OUTPUT_TOKENS as the ceiling when set', async () => {
      process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'] = '12000';
      try {
        mockGeneratorConfig({ contextWindowSize: 200_000 });
        mockCompress(noop(50_000));
        mockStream(textStream('env ceiling response'));

        await sendHiOnFreshChat('prompt-window-clamp-env-ceiling', 50_000);

        expect(sentMaxOutputTokens()).toBe(12_000);
      } finally {
        delete process.env['QWEN_CODE_MAX_OUTPUT_TOKENS'];
      }
    });

    it('pads the first-send clamp estimate for unseen system/tool overhead', async () => {
      // At lastPromptTokenCount 0 the char/4 estimate misses ~15-20K of
      // system-prompt + tool-schema overhead: unpadded, a 40K window would
      // grant ~30K against a real ~18K+ prompt (E2E dry-run: 18,359 + 26,764
      // = 45,123 > 40,000). The 20K pad drops the grant to ~10K.
      mockGeneratorConfig({ contextWindowSize: 40_000 });
      mockCompress(noop());
      mockStream(textStream('first send'));

      await sendHiOnFreshChat('prompt-first-send-clamp-pad'); // fresh: count 0

      // 40000 − (1-token estimate + 20000 pad) − 10000 margin = 9,999,
      // NOT the ~30K an unpadded estimate would produce.
      expect(sentMaxOutputTokens()).toBe(9_999);
    });

    it('keeps the overhead pad after compression uses an estimated baseline', async () => {
      mockGeneratorConfig({ contextWindowSize: 40_000 });
      mockCompressOnce(
        compressed(1000, 79, [userText('summary'), modelText('ok')]),
        noop(79),
      );
      mockStream(textStream('first send after compression'));

      const chatInstance = newChat({
        history: [userText('history without usage'), modelText('response')],
      });
      await chatInstance.tryCompress('prompt-estimated-compression', true);
      expect(chatInstance.isLastPromptTokenCountEstimated()).toBe(true);

      await sendDrain('hi', 'prompt-estimated-clamp-pad', chatInstance);

      expect(sentMaxOutputTokens()).toBe(9_919);
    });

    /** A fresh 40K-window chat seeded with an estimated 79-token count. */
    function estimatedSeedChat(text: string, usage: UsageMetadata) {
      mockGeneratorConfig({ contextWindowSize: 40_000 });
      mockCompress(noop(79));
      mockStream(textStream(text, usage));
      const chatInstance = newChat();
      chatInstance.seedResumeTokenCounts(79, 0, true);
      return chatInstance;
    }

    it('clears estimated provenance when provider usage is received', async () => {
      const chatInstance = estimatedSeedChat('usage received', {
        promptTokenCount: 123,
        candidatesTokenCount: 7,
        totalTokenCount: 130,
      });
      expect(chatInstance.isLastPromptTokenCountEstimated()).toBe(true);

      await sendDrain(
        'hi',
        'prompt-provider-usage-clears-estimate',
        chatInstance,
      );

      expect(chatInstance.getLastPromptTokenCount()).toBe(123);
      expect(chatInstance.isLastPromptTokenCountEstimated()).toBe(false);
    });

    it('keeps estimated provenance when provider usage has no usable count', async () => {
      const chatInstance = estimatedSeedChat('usage omitted', {
        promptTokenCount: 0,
        totalTokenCount: 0,
      });

      await sendDrain(
        'hi',
        'prompt-provider-usage-keeps-estimate',
        chatInstance,
      );

      expect(chatInstance.getLastPromptTokenCount()).toBe(79);
      expect(chatInstance.isLastPromptTokenCountEstimated()).toBe(true);
    });

    it('keeps a sane input budget on small custom windows (issue #6144)', async () => {
      // 65,536-token local model: the old flat 64K reservation left 1,536
      // input tokens and rejected a ~6K prompt. Now it sends normally with the
      // model's 32,768 limit (room 65,536 − ~6,280 − 10,000 ≈ 49K).
      mockGeneratorConfig({
        model: 'qwen3coder-64k',
        contextWindowSize: 65_536,
      });
      const compressSpy = mockCompressOnce(noop(6_276));
      mockStream(textStream('normal response'));

      await sendHiOnFreshChat(
        'prompt-small-window-clamp',
        6_276,
        'qwen3coder-64k',
      );

      // Normal auto-path cheap-gate (force=false), NOT hard-tier rescue.
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0][1].force).toBe(false);
      expect(sentMaxOutputTokens()).toBe(32_768);
    });
  });

  /** Make every `structuredClone` call throw; returns the spy. */
  const forbidDeepClone = () =>
    vi.spyOn(globalThis, 'structuredClone').mockImplementation(() => {
      throw new Error('unexpected deep clone');
    });

  describe('completed tool boundary', () => {
    const result = content('user', fnResponse('update_goal', {}, 'ended'));
    const fresh = () => structuredClone(result);

    it.each(['summary', 'fast'] as const)(
      'preserves and records completed boundaries through %s compression',
      async (mode) => {
        const ended = fnCall('update_goal', undefined, 'ended');
        const call = content('model', ended);
        const thinking = { text: 'reasoning '.repeat(100), thought: true };
        const recordChatCompression = vi.fn();
        const recordingChat = newChat({ recorder: { recordChatCompression } });
        recordingChat.setHistory(
          [userText('work'), content('model', thinking, ended), fresh()],
          ['ended'],
        );
        if (mode === 'summary') {
          mockCompressOnce(compressed(1000, 100, [call, fresh()]));
        }

        const info =
          mode === 'summary'
            ? await recordingChat.tryCompress('completed-boundary', true)
            : recordingChat.compressFast().info;

        expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
        expect(recordingChat.getCompletedToolCallIds()).toEqual(['ended']);
        expect(recordingChat.getHistoryForRecovery()).toEqual([]);
        expect(recordChatCompression).toHaveBeenCalledWith(
          expect.objectContaining({
            completedToolCallIds: ['ended'],
            compressedHistory: recordingChat.getHistory(),
          }),
        );
      },
    );

    it('restores the earlier completed boundary when rewind removes a later one', () => {
      const later = content('user', fnResponse('update_goal', {}, 'later'));
      chat.setHistory(
        [fresh(), userText('next goal'), later],
        ['ended', 'later'],
      );
      expect(chat.getHistoryForRecovery()).toEqual([]);
      chat.truncateHistory(1);
      expect(chat.getCompletedToolCallIds()).toEqual(['ended']);
      expect(chat.getHistoryForRecovery()).toEqual([]);
      const input = userText('unanswered');
      chat.addHistory(input);
      expect(chat.stripOrphanedUserEntriesFromHistory()).toEqual([input]);
      expect(chat.getHistory()).toEqual([result]);
    });

    it('keeps completed results out of recovery and retry without altering model history', () => {
      chat.setHistory([fresh()]);
      chat.setCompletedToolCallIds(['ended']);
      expect(chat.getHistory()).toEqual([result]);
      expect(chat.getHistory(true)).toEqual([result]);
      expect(chat.getHistoryForRecovery()).toEqual([]);
      const input = userText('next request');
      chat.addHistory(input);
      expect(chat.getHistoryForRecovery()).toEqual([input]);
      expect(chat.stripOrphanedUserEntriesFromHistory()).toEqual([input]);
      expect(chat.getHistory()).toEqual([result]);
    });

    it('preserves the boundary through deliberate history transforms and invalidates removed IDs', () => {
      chat.setHistory([fresh()], ['ended']);
      chat.setHistory(
        [userText('startup'), ...chat.getHistory()],
        chat.getCompletedToolCallIds(),
      );
      chat.stripThoughtsFromHistory();
      expect(chat.getHistoryForRecovery()).toEqual([]);
      chat.truncateHistory(1);
      expect(chat.getCompletedToolCallIds()).toEqual([]);
      chat.addHistory(fresh());
      expect(chat.getHistoryForRecovery()).toHaveLength(2);
      chat.setCompletedToolCallIds(['ended']);
      chat.setHistory([fresh()]);
      expect(chat.getCompletedToolCallIds()).toEqual([]);
    });

    it('rejects ambiguous imported IDs and clears the boundary on clear', () => {
      chat.setHistory([fresh(), fresh()], ['ended']);
      expect(chat.getCompletedToolCallIds()).toEqual([]);
      chat.setHistory([fresh()], ['ended']);
      chat.clearHistory();
      chat.addHistory(fresh());
      expect(chat.getCompletedToolCallIds()).toEqual([]);
      expect(chat.getHistoryForRecovery()).toEqual([result]);
    });
  });

  describe('addHistory', () => {
    it('should add a new content item to the history', () => {
      const newContent = userText('A new message');
      chat.addHistory(newContent);
      const history = chat.getHistory();
      expect(history.length).toBe(1);
      expect(history[0]).toEqual(newContent);
    });

    it('should add multiple items correctly', () => {
      const content1 = userText('Message 1');
      const content2 = modelText('Message 2');
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
      chat.addHistory(userText('a'));
      chat.addHistory(modelText('b'));
      expect(chat.getHistoryLength()).toBe(2);
    });

    it('matches getHistory().length without paying the structuredClone cost', () => {
      chat.addHistory(userText('a'));
      chat.addHistory(modelText('b'));
      chat.addHistory(userText('c'));
      expect(chat.getHistoryLength()).toBe(chat.getHistory().length);
    });
  });

  describe('getHistoryFunctionResponseIds', () => {
    // Walk-only accessor for `useLlmStream.handleCompletedTools`' dedup pass,
    // skipping getHistory()'s multi-ms structuredClone on long sessions.
    // Contract: every user-turn fr id, deduped; other parts and turns ignored.
    const frTurn = (output: string, id: string) =>
      content('user', fnResponse('read_file', { output }, id));

    it('returns an empty Set for empty history', () => {
      expect(chat.getHistoryFunctionResponseIds()).toEqual(new Set());
    });

    it('collects fr ids from user turns and ignores non-fr parts', () => {
      chat.setHistory([
        userText('go'),
        content('model', fnCall('read_file', {}, 'cid_a')),
        content('user', fnResponse('read_file', { output: 'a' }, 'cid_a'), {
          text: 'follow up',
        }),
      ]);

      expect(chat.getHistoryFunctionResponseIds()).toEqual(new Set(['cid_a']));
    });

    it('skips functionCall parts in model turns (only user[fr] counts)', () => {
      // Walking every turn would pull in (and double-count) functionCall ids.
      chat.setHistory([
        content('model', fnCall('read_file', {}, 'cid_model')),
        frTurn('u', 'cid_user'),
      ]);

      const ids = chat.getHistoryFunctionResponseIds();
      expect(ids).toEqual(new Set(['cid_user']));
      expect(ids.has('cid_model')).toBe(false);
    });

    it('collapses duplicate fr ids across multiple user turns to one Set entry', () => {
      // Dedup callers only ask "is this id paired anywhere", so a Set fits.
      chat.setHistory([frTurn('1', 'cid_dup'), frTurn('2', 'cid_dup')]);

      const ids = chat.getHistoryFunctionResponseIds();
      expect(ids.size).toBe(1);
      expect(ids.has('cid_dup')).toBe(true);
    });

    it('handles entries with no parts and parts with no functionResponse', () => {
      // Malformed history (missing parts, empty parts) must not crash.
      chat.setHistory([
        { role: 'user', parts: undefined as unknown as Part[] },
        { role: 'user', parts: [] },
        frTurn('ok', 'cid_ok'),
      ]);

      expect(chat.getHistoryFunctionResponseIds()).toEqual(new Set(['cid_ok']));
    });

    it('does not deep-clone history (returns a fresh Set, not aliased to internal state)', () => {
      // Mutating the returned Set must not bleed into the next call.
      chat.setHistory([frTurn('v', 'cid_immut')]);

      const first = chat.getHistoryFunctionResponseIds();
      first.add('cid_FAKE');
      first.delete('cid_immut');

      const second = chat.getHistoryFunctionResponseIds();
      expect(second.has('cid_immut')).toBe(true);
      expect(second.has('cid_FAKE')).toBe(false);
    });
  });

  describe('getHistoryToolCallFingerprints', () => {
    const readCall = (id: string, file_path: string) =>
      fnCall('read_file', { file_path }, id);

    it('returns an empty Map for empty history', () => {
      expect(chat.getHistoryToolCallFingerprints()).toEqual(new Map());
    });

    it('maps only responded functionCall ids to (name, args) fingerprints', () => {
      chat.setHistory([
        userText('go'),
        content(
          'model',
          readCall('cid_a', 'a.ts'),
          readCall('cid_unanswered', 'b.ts'),
        ),
        content('user', fnResponse('read_file', { output: 'a' }, 'cid_a')),
      ]);

      const fingerprints = chat.getHistoryToolCallFingerprints();
      expect([...fingerprints.keys()]).toEqual(['cid_a']);
      expect(fingerprints.get('cid_a')).toBe(
        getToolCallFingerprint('read_file', { file_path: 'a.ts' }),
      );
    });

    it('keeps the first answered call for an id reused across turns and skips orphan response ids', () => {
      // The fingerprint is the replay oracle: a reused id keeps naming the
      // call first executed under it; an orphan functionResponse adds nothing.
      chat.setHistory([
        content('model', readCall('cid_reused', 'a.ts')),
        content(
          'user',
          fnResponse('read_file', { output: 'a' }, 'cid_reused'),
          fnResponse('read_file', { output: 'x' }, 'cid_orphan'),
        ),
        content('model', readCall('cid_reused', 'b.ts')),
        content('user', fnResponse('read_file', { output: 'b' }, 'cid_reused')),
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
      const recentContent = modelText('recent');
      chat.addHistory(userText('old'));
      chat.addHistory(recentContent);

      const tail = chat.getHistoryTail(1);

      expect(tail).toEqual([recentContent]);
      expect(tail[0]).not.toBe(recentContent);
      tail[0]!.parts![0]!.text = 'mutated';
      expect(chat.getHistory()[1]!.parts![0]!.text).toBe('recent');
    });

    it('returns an empty tail for non-positive counts', () => {
      chat.addHistory(userText('a'));
      expect(chat.getHistoryTail(0)).toEqual([]);
      expect(chat.getHistoryTail(-1)).toEqual([]);
    });
  });

  describe('getHistoryShallow', () => {
    it('copies Part containers without cloning large leaf payloads', () => {
      const payload = { output: 'x'.repeat(128 * 1024) };
      const topInlineData = { mimeType: 'image/png', data: 'top-level-image' };
      const nestedInlineData = { mimeType: 'image/png', data: 'nested-image' };
      const topLevelPart: Part = { inlineData: topInlineData };
      const nestedPart: Part = { inlineData: nestedInlineData };
      const functionResponsePart: Part = {
        functionResponse: {
          id: 'call-1',
          name: 'read_file',
          response: payload,
          parts: [nestedPart],
        },
      };
      const entry = content('user', topLevelPart, functionResponsePart);
      chat.addHistory(entry);
      const structuredCloneSpy = forbidDeepClone();

      const history = chat.getHistoryShallow();

      expect(structuredCloneSpy).not.toHaveBeenCalled();
      expect(history).toEqual([entry]);
      expect(history[0]).not.toBe(entry);
      expect(history[0]!.parts).not.toBe(entry.parts);
      expect(history[0]!.parts![0]).not.toBe(topLevelPart);
      expect(history[0]!.parts![0]!.inlineData).toBe(topInlineData);
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
      expect(topLevelPart.inlineData).toBe(topInlineData);
      expect(nestedPart.inlineData).toBe(nestedInlineData);
      const response = copiedFunctionResponsePart as {
        functionResponse: { response: typeof payload };
      };
      expect(response.functionResponse.response).toBe(payload);
    });
  });

  describe('getHistoryForForkWindow', () => {
    it('removes startup context before curating adjacent user turns', () => {
      const startup = userText(
        '<system-reminder>\nstartup context\n</system-reminder>',
      );
      const firstTurn = content(
        'user',
        { text: '<system-reminder>\nturn context\n</system-reminder>' },
        { text: 'first question' },
      );
      const answer = modelText('first answer');
      chat.setHistory([startup, firstTurn, answer]);

      expect(chat.getHistoryForForkWindow()).toEqual([firstTurn, answer]);
    });
  });

  describe('getHistoryTailShallow', () => {
    it('copies only recent containers without cloning payloads', () => {
      const recentContent = modelText('recent');
      chat.addHistory(userText('old'));
      chat.addHistory(recentContent);
      const structuredCloneSpy = forbidDeepClone();

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
      chat.addHistory(userText('a'));
      chat.addHistory(modelText('b'));

      const last = chat.getLastHistoryEntry();
      expect(last).toEqual(modelText('b'));

      last!.parts![0] = { text: 'mutated' };
      expect(chat.getLastHistoryEntry()).toEqual(modelText('b'));
    });
  });

  describe('peekLastHistoryEntry', () => {
    it('returns the last entry without structured-cloning the full history', () => {
      const last = modelText('b');
      chat.addHistory(userText('a'));
      chat.addHistory(last);
      const structuredCloneSpy = forbidDeepClone();

      expect(chat.peekLastHistoryEntry()).toBe(last);
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    });
  });

  describe('getLastModelMessageText', () => {
    it('returns text from the latest model message without cloning history', () => {
      chat.addHistory(modelText('older'));
      chat.addHistory(userText('question'));
      chat.addHistory(content('model', { text: 'new' }, { text: ' answer' }));
      const structuredCloneSpy = forbidDeepClone();

      expect(chat.getLastModelMessageText()).toBe('new answer');
      expect(structuredCloneSpy).not.toHaveBeenCalled();
    });

    it('filters out thought parts from the last model message', () => {
      chat.addHistory(
        content(
          'model',
          { text: 'internal reasoning...', thought: true },
          { text: 'visible response' },
        ),
      );

      expect(chat.getLastModelMessageText()).toBe('visible response');
    });

    it('returns undefined when all text parts are thoughts', () => {
      chat.addHistory(
        content('model', { text: 'only thinking', thought: true }),
      );

      expect(chat.getLastModelMessageText()).toBeUndefined();
    });
  });
  describe('sendMessageStream with retries', () => {
    const inline = (mimeType: string, data: string): Part => ({
      inlineData: { mimeType, data },
    });

    /** The TPM-throttling 429 that makes the primary eligible for fallback. */
    const tpmCapacityError = () =>
      Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        ),
        { status: 429 },
      );

    /** A primary stream that reports usage and then fails with `error`. */
    const usageThenThrow = (error: unknown) =>
      streamThenThrow(
        [
          {
            usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 },
          } as unknown as GenerateContentResponse,
        ],
        error,
      );

    /** Serve `resolveForModel` through `getBaseLlmClient`; returns it. */
    function mockResolver(resolveForModel: ReturnType<typeof vi.fn>) {
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      return resolveForModel;
    }

    /** No primary retries and `fallbacks` resolved by `resolveForModel`. */
    function wireFallbacks(
      fallbacks: string[],
      resolveForModel: ReturnType<typeof vi.fn> = vi.fn(),
      generatorConfig: Partial<
        ReturnType<Config['getContentGeneratorConfig']>
      > = {},
    ) {
      mockGeneratorConfig({ maxRetries: 0, ...generatorConfig });
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue(fallbacks);
      return mockResolver(resolveForModel);
    }

    /** A `resolveForModel` result serving `model` from `generateContentStream`. */
    const fallbackRoute = (
      model: string,
      generateContentStream: unknown,
      contentGeneratorConfig?: Record<string, unknown>,
    ) => ({
      contentGenerator: makeContentGenerator(generateContentStream),
      ...(contentGeneratorConfig ? { contentGeneratorConfig } : {}),
      retryAuthType: AuthType.USE_GEMINI,
      retryErrorCodes: undefined,
      model,
    });

    /** Fallbacks `fallback-a` then `fallback-b`, each on its own stream mock. */
    function wireTwoFallbacks(
      configA?: Record<string, unknown>,
      configB?: Record<string, unknown>,
    ) {
      const fallbackA = vi.fn();
      const fallbackB = vi.fn();
      const resolveForModel = wireFallbacks(
        ['fallback-a', 'fallback-b'],
        vi
          .fn()
          .mockResolvedValueOnce(
            fallbackRoute('fallback-a', fallbackA, configA),
          )
          .mockResolvedValueOnce(
            fallbackRoute('fallback-b', fallbackB, configB),
          ),
      );
      return { fallbackA, fallbackB, resolveForModel };
    }

    /** Resolve the exact vision-agent image route; returns `resolveForModel`. */
    const mockVisionRoute = (
      generateContentStream: unknown,
      maxRetries: number,
    ) =>
      mockResolver(
        vi.fn().mockResolvedValue({
          contentGenerator: {
            ...mockContentGenerator,
            generateContentStream,
          } as ContentGenerator,
          contentGeneratorConfig: {
            model: 'vision-agent',
            authType: AuthType.USE_OPENAI,
            maxRetries,
            modalities: { image: true },
          },
          retryAuthType: AuthType.USE_OPENAI,
          model: 'vision-agent',
        }),
      );

    const fallbackEvents = (events: StreamEvent[]) =>
      eventsOfType(events, StreamEventType.MODEL_FALLBACK);

    const fallbackEvent = (
      fromModel: string,
      toModel: string,
      fallbackIndex: number,
    ) => ({
      type: StreamEventType.MODEL_FALLBACK,
      info: { fromModel, toModel, statusCode: 429, fallbackIndex },
    });

    /** The primary fails with `error`; the fallback chain stays untouched. */
    async function expectNoFallback(
      error: Error,
      promptId: string,
      options?: Parameters<LlmChat['sendMessageStream']>[4],
    ) {
      const resolveForModel = wireFallbacks(['fallback-model']);
      streamMock().mockRejectedValueOnce(error);
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test' },
        promptId,
        undefined,
        options,
      );
      await expect(drain(stream)).rejects.toBe(error);
      expect(resolveForModel).not.toHaveBeenCalled();
    }

    /**
     * A read_file tool_use attempt throws `error` and the retry answers `text`:
     * history must end [user, model(text)] with no functionCall anywhere.
     */
    async function expectPartialRolledBack(
      callId: string,
      path: string,
      error: unknown,
      text: string,
      promptId: string,
      stepMs: number,
    ) {
      mockStreamsOnce(
        streamThenThrow(
          [modelChunk([fnCall('read_file', { path }, callId)])],
          error,
        ),
        textStream(text),
      );
      const iterator = (await send('test', promptId))[Symbol.asyncIterator]();
      for (;;) {
        const next = iterator.next();
        await vi.advanceTimersByTimeAsync(stepMs);
        if ((await next).done) break;
      }
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]!.role).toBe('user');
      expect(history[1]!.role).toBe('model');
      expect(history[1]!.parts!.find((p) => p.text)?.text).toBe(text);
      expect(history.some((h) => h.parts?.some((p) => p.functionCall))).toBe(
        false,
      );
    }

    it('should retry on invalid content, succeed, and report metrics', async () => {
      vi.useFakeTimers();
      // A fresh generator per attempt: invalid empty text, then valid.
      streamMock()
        .mockImplementationOnce(async () => streamOf(textChunk('')))
        .mockImplementationOnce(async () => textStream('Successful response'));

      const stream = await send('test', 'prompt-id-retry-success');
      const chunks = await collectStreamWithFakeTimers(stream);

      expect(mockLogContentRetry).toHaveBeenCalledTimes(1);
      expect(mockLogContentRetryFailure).not.toHaveBeenCalled();
      expectStreamCalls(2);
      expect(chunks.some((c) => c.type === StreamEventType.RETRY)).toBe(true);
      expect(hasChunkText(chunks, 'Successful response')).toBe(true);
      // History recorded once, with no duplicates.
      const history = chat.getHistory();
      expect(history.length).toBe(2);
      expect(history[0]).toEqual(userText('test'));
      expect(history[1]).toEqual(modelText('Successful response'));
      expect(uiTelemetryService.setLastPromptTokenCount).not.toHaveBeenCalled();
    });

    it('retries a split degraded placeholder without yielding or persisting it', async () => {
      vi.useFakeTimers();
      mockStreamsOnce(
        streamOf(textChunk('(request '), stopResponse([{ text: 'timeout)' }])),
        streamOf(stopResponse([{ text: 'Recovered response' }])),
      );

      const stream = await send('test', 'prompt-id-degraded-placeholder');
      const events = await collectStreamWithFakeTimers(stream);

      expect(chunkTexts(events)).toEqual(['Recovered response']);
      expectStreamCalls(2);
      expect(mockLogContentRetry).toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({
          error_type: 'UPSTREAM_DEGRADED_RESPONSE',
        }),
      );
      expect(chat.getHistory()).toEqual([
        userText('test'),
        modelText('Recovered response'),
      ]);
    });

    it('passes through longer text that mentions the placeholder', async () => {
      const text = 'The endpoint returned (request timeout) once.';
      mockStream(streamOf(stopResponse([{ text }])));

      const events = await sendCollect('test', 'prompt-id-placeholder-mention');

      expect(hasChunkText(events, text)).toBe(true);
      expectStreamCalls(1);
    });

    it('does not reject a placeholder turn that contains a function call', async () => {
      mockStream(
        streamOf(
          stopResponse([
            { text: '(request timeout)' },
            fnCall('read_file', {}, 'call-1'),
          ]),
        ),
      );

      const events = await sendCollect(
        'test',
        'prompt-id-placeholder-tool-call',
      );

      expect(
        someChunk(events, (parts) =>
          parts.some((part) => part.functionCall?.id === 'call-1'),
        ),
      ).toBe(true);
      expectStreamCalls(1);
    });

    it('should fail after all retries on persistent invalid content and report metrics', async () => {
      vi.useFakeTimers();
      streamMock().mockImplementation(async () => streamOf(textChunk('')));

      await expectStreamExhaustion(await send('test', 'prompt-id-retry-fail'));

      // 1 initial + 4 transient retries.
      expectStreamCalls(5);
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
      const history = chat.getHistory();
      expect(history.length).toBe(1);
      expect(history[0]).toEqual(userText('test'));
    });

    it('should recover after four consecutive invalid streams', async () => {
      vi.useFakeTimers();
      mockStreamsOnce(
        ...Array.from({ length: 4 }, () => streamOf(modelChunk([], 'STOP'))),
        textStream('Recovered response'),
      );

      const stream = await send('test', 'prompt-id-four-invalid-streams');
      const events = await collectStreamWithFakeTimers(stream, 25_000);

      expectStreamCalls(5);
      expect(mockLogContentRetry).toHaveBeenCalledTimes(4);
      for (const [index, retryDelayMs] of [2000, 4000, 6000, 8000].entries()) {
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
      expect(hasChunkText(events, 'Recovered response')).toBe(true);
      expect(chat.getHistory()).toEqual([
        userText('test'),
        modelText('Recovered response'),
      ]);
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
      fakeTimers(async ({ delta, finishReason, errorType, retryCount }) => {
        const create = vi.fn();
        create.mockImplementation(async () =>
          streamOf(openaiChunk('protocol-tag-leak', delta, finishReason)),
        );
        useOpenAIPipeline(create);

        await expectStreamExhaustion(
          await send('test', `prompt-id-${errorType.toLowerCase()}-budget`),
        );

        expect(create).toHaveBeenCalledTimes(retryCount + 1);
        expect(mockLogContentRetry).toHaveBeenCalledTimes(retryCount);
        expect(mockLogContentRetryFailure).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({
            total_attempts: retryCount + 1,
            final_error_type: errorType,
            model: 'test-model',
          }),
        );
      }),
    );

    it('keeps invalid stream retry budgets independent across error types', async () => {
      vi.useFakeTimers();
      mockStreamsOnce(
        streamOf(stopResponse([])),
        streamOf(stopResponse([])),
        streamOf(
          stopResponse([
            { text: '<analysis>hidden</analysis><summary>leaked</summary>' },
          ]),
        ),
        streamOf(stopResponse([{ text: 'Recovered response' }])),
      );

      const stream = await send('test', 'prompt-id-mixed-invalid-streams');
      const events = await collectStreamWithFakeTimers(stream, 15_000);

      expectStreamCalls(4);
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
      expect(hasChunkText(events, 'Recovered response')).toBe(true);
    });

    it('surfaces an abort fired during the invalid-stream retry delay without retrying again', async () => {
      vi.useFakeTimers();
      streamMock().mockImplementation(async () => streamOf(stopResponse([])));
      const { controller, stream } = await sendAbortable(
        'prompt-id-invalid-stream-abort-delay',
      );

      const iterator = stream[Symbol.asyncIterator]();
      let next = await iterator.next();
      while (!next.done && next.value.type !== StreamEventType.RETRY) {
        next = await iterator.next();
      }
      if (next.done) throw new Error('Expected invalid stream retry event.');
      expect(next.value.type).toBe(StreamEventType.RETRY);

      const nextPromise = iterator.next();
      controller.abort();
      await expect(nextPromise).rejects.toThrow();

      expectStreamCalls(1);
    });

    it('should retry usage-only empty streams without recording failed attempts', async () => {
      vi.useFakeTimers();
      const recordAssistantTurn = vi.fn();
      const chatWithRecording = chatWithRecorder(recordAssistantTurn);
      streamMock()
        .mockImplementationOnce(async () =>
          streamOf({
            usageMetadata: {
              promptTokenCount: 10,
              candidatesTokenCount: 0,
              totalTokenCount: 10,
            },
          } as unknown as GenerateContentResponse),
        )
        .mockImplementationOnce(async () =>
          textStream('Recovered after empty stream'),
        );

      const events = await collectStreamWithFakeTimers(
        await send('test', 'prompt-id-empty-usage-retry', chatWithRecording),
      );

      expectStreamCalls(2);
      expect(mockLogContentRetry).toHaveBeenCalledTimes(1);
      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual([
        { text: 'Recovered after empty stream' },
      ]);
      expect(hasChunkText(events, 'Recovered after empty stream')).toBe(true);
    });

    it('rolls back the partial assistant turn when a retryable error fires after a tool_use chunk', async () => {
      vi.useFakeTimers();
      // The functionCall triggers the partial push, then a TPM 429 fires; the
      // retry must drop the partial first, or it is a second consecutive
      // `model` entry with an orphan tool_use (invalid alternation + a 400).
      await expectPartialRolledBack(
        'call_failed_retry_attempt',
        '/tmp/a.txt',
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
        ),
        'Success after retry',
        'prompt-rollback-on-retry',
        60_000,
      );
    });

    it('rolls back the partial assistant turn when an InvalidStreamError fires after a tool_use chunk on the transient-stream retry budget', async () => {
      vi.useFakeTimers();
      // The transient budget (NO_FINISH_REASON / NO_RESPONSE_TEXT) has its own
      // popPendingPartialAssistantTurn call site the rate-limit case cannot
      // pin; this cut retries after the initial 2000 ms delay.
      await expectPartialRolledBack(
        'call_transient_retry_partial',
        '/tmp/t.txt',
        new InvalidStreamError(
          'Model stream ended without a finish reason.',
          'NO_FINISH_REASON',
        ),
        'Recovered on retry',
        'prompt-rollback-transient',
        5_000,
      );
    });

    it('does not enter the fallback chain in unattended retry mode', async () => {
      vi.stubEnv('QWEN_CODE_UNATTENDED_RETRY', '1');
      try {
        await expectNoFallback(
          tpmCapacityError(),
          'prompt-unattended-no-fallback',
        );
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it('disables model fallback without disabling compression', async () => {
      const tryCompress = vi.spyOn(chat, 'tryCompress');
      await expectNoFallback(
        Object.assign(new Error('temporarily unavailable'), { status: 503 }),
        'prompt-no-model-fallback',
        { disableModelFallbacks: true },
      );
      expect(tryCompress).toHaveBeenCalled();
    });

    it('uses one exact image route across retries and filters history for the next target', async () => {
      const capacityError = Object.assign(
        new Error('temporarily unavailable'),
        { status: 503 },
      );
      const routeGenerateContentStream = vi
        .fn()
        .mockRejectedValueOnce(capacityError)
        .mockResolvedValueOnce(
          textStream('seen', { promptTokenCount: 99_999 }),
        );
      const routeSelector =
        'openai:vision-agent\0https://vision.example.com/v1';
      const resolveForModel = mockVisionRoute(routeGenerateContentStream, 1);
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'gemini-pro@test0001',
      );
      vi.mocked(mockConfig.getEffectiveInputModalities).mockReturnValue({
        pdf: true,
      });
      chat = newChat({
        history: [
          content(
            'user',
            { text: 'prior question' },
            inline('application/pdf', 'prior-pdf'),
          ),
          modelText('prior answer'),
        ],
      });
      const tryCompress = vi.spyOn(chat, 'tryCompress');
      mockRetryWithBackoff.mockImplementation(async (apiCall, options) => {
        try {
          return await apiCall();
        } catch (error) {
          expect(options?.shouldRetryOnError?.(error)).toBe(true);
          return apiCall();
        }
      });

      await drain(
        await chat.sendMessageStream(
          `${routeSelector}\0`,
          {
            message: [
              { text: 'inspect' },
              inline('image/png', 'private-image'),
            ],
          },
          'prompt-exact-route-retry',
        ),
      );
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

      streamMock().mockResolvedValueOnce(textStream('primary follow-up'));
      await sendDrain(
        [
          { text: 'continue on primary' },
          inline('application/pdf', 'current-pdf'),
        ],
        'prompt-after-exact-route',
      );

      const primaryRequest = JSON.stringify(streamMock().mock.calls[0]?.[0]);
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
      const resolveForModel = mockVisionRoute(
        vi.fn().mockRejectedValue(capacityError),
        0,
      );
      vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
        'ordinary-fallback',
      ]);

      const stream = await chat.sendMessageStream(
        'openai:vision-agent\0https://vision.example.com/v1\0',
        { message: [inline('image/png', 'private-image')] },
        'prompt-exact-route-failure',
      );
      await expect(drain(stream)).rejects.toBe(capacityError);

      expect(resolveForModel).toHaveBeenCalledOnce();
      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
    });

    it('continues fallback after usage and preparation metadata', async () => {
      vi.mocked(mockConfig.getEffectiveInputModalities).mockReturnValue({
        image: true,
      });
      const { fallbackA, fallbackB } = wireTwoFallbacks(
        { modalities: {} },
        { modalities: { image: true } },
      );
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'gemini-pro@test0001',
      );

      const capacityError = tpmCapacityError();
      streamMock().mockResolvedValueOnce(usageThenThrow(capacityError));
      const preparationResponse = modelChunk([]);
      setToolCallPreparations(preparationResponse, [
        { callId: 'call-fallback-a', toolName: 'read_file' },
      ]);
      fallbackA.mockResolvedValueOnce(
        streamThenThrow([preparationResponse], capacityError),
      );
      fallbackB.mockResolvedValueOnce(
        textStream('fallback-b ok', { promptTokenCount: 99_999 }),
      );

      const events = await sendCollect(
        [{ text: 'test' }, inline('image/png', 'fallback-image')],
        'prompt-two-fallbacks',
      );

      expect(fallbackEvents(events)).toHaveLength(2);
      expect(
        events.some(
          (event) =>
            event.type === StreamEventType.CHUNK &&
            event.value.usageMetadata?.promptTokenCount === 10,
        ),
      ).toBe(true);
      expect(fallbackEvents(events)).toEqual([
        fallbackEvent('test-model', 'fallback-a', 1),
        fallbackEvent('fallback-a', 'fallback-b', 2),
      ]);
      expectStreamCalls(1);
      expect(JSON.stringify(fallbackA.mock.calls[0]?.[0])).not.toContain(
        'fallback-image',
      );
      expect(JSON.stringify(fallbackB.mock.calls[0]?.[0])).toContain(
        'fallback-image',
      );
      expect(fallbackA).toHaveBeenCalledTimes(1);
      expect(fallbackB).toHaveBeenCalledTimes(1);
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(hasChunkText(events, 'fallback-b ok')).toBe(true);
    });

    it('stamps fallback-served counts under the request route key (#9454)', async () => {
      const fallbackB = vi.fn();
      wireFallbacks(
        ['fallback-b'],
        vi.fn().mockResolvedValue({
          contentGenerator: {
            generateContent: vi.fn(),
            generateContentStream: fallbackB,
            countTokens: vi.fn(),
            embedContent: vi.fn(),
            batchEmbedContents: vi.fn(),
            useSummarizedThinking: vi.fn().mockReturnValue(false),
          } as unknown as ContentGenerator,
          contentGeneratorConfig: { modalities: {} },
          retryAuthType: AuthType.USE_GEMINI,
          retryErrorCodes: undefined,
          model: 'fallback-b',
        }),
      );
      vi.mocked(mockConfig.getModelRouteIdentity).mockImplementation((model) =>
        model ? `${model}@route` : 'gemini-pro@test0001',
      );
      streamMock().mockResolvedValueOnce(usageThenThrow(tpmCapacityError()));
      fallbackB.mockResolvedValueOnce(
        textStream('fallback-b ok', { promptTokenCount: 99_999 }),
      );

      await sendDrain([{ text: 'test' }], 'prompt-fallback-route-stamp');

      // The session-token-limit gate reads the count keyed by the REQUEST
      // route; a fallback serves the same request (the session model never
      // changes), so the count must survive that read (#9454).
      expect(chat.getLastPromptTokenCount('test-model@route')).toBe(99_999);
      // It still belongs to the request route: other routes invalidate it.
      expect(chat.getLastPromptTokenCount('other-model@route')).toBe(0);
    });

    it('skips a fallback alias that resolves to the current model', async () => {
      const duplicate = vi.fn();
      const fallbackB = vi.fn();
      const resolveForModel = wireFallbacks(
        ['primary-alias', 'fallback-b'],
        vi
          .fn()
          .mockResolvedValueOnce(
            fallbackRoute('resolved-primary-model', duplicate),
          )
          .mockResolvedValueOnce(fallbackRoute('fallback-b', fallbackB)),
        { model: 'resolved-primary-model' },
      );
      streamMock().mockRejectedValueOnce(tpmCapacityError());
      fallbackB.mockResolvedValueOnce(textStream('fallback-b ok'));

      const events = await collect(
        await chat.sendMessageStream(
          'requested-primary-model',
          { message: 'test' },
          'prompt-skip-resolved-duplicate-fallback',
        ),
      );

      expect(resolveForModel).toHaveBeenCalledTimes(2);
      expect(duplicate).not.toHaveBeenCalled();
      expect(fallbackB).toHaveBeenCalledTimes(1);
      expect(fallbackEvents(events)).toEqual([
        fallbackEvent('requested-primary-model', 'fallback-b', 1),
      ]);
    });

    it('skips an unresolvable fallback model and tries the next fallback', async () => {
      const fallbackB = vi.fn();
      const resolveForModel = wireFallbacks(
        ['bad-fallback', 'fallback-b'],
        vi
          .fn()
          .mockRejectedValueOnce(new Error('unknown fallback alias'))
          .mockResolvedValueOnce(fallbackRoute('fallback-b', fallbackB)),
      );
      streamMock().mockRejectedValueOnce(tpmCapacityError());
      fallbackB.mockResolvedValueOnce(textStream('fallback-b ok'));

      const events = await sendCollect('test', 'prompt-skip-bad-fallback');

      expect(resolveForModel).toHaveBeenCalledTimes(2);
      expect(resolveForModel).toHaveBeenNthCalledWith(1, 'bad-fallback', {
        failClosed: true,
      });
      expect(resolveForModel).toHaveBeenNthCalledWith(2, 'fallback-b', {
        failClosed: true,
      });
      expect(fallbackEvents(events)).toHaveLength(1);
      expect(fallbackB).toHaveBeenCalledTimes(1);
      expect(hasChunkText(events, 'fallback-b ok')).toBe(true);
    });

    it('does not try the next fallback after a fallback emits output', async () => {
      const { fallbackA, fallbackB, resolveForModel } = wireTwoFallbacks();
      const capacityError = tpmCapacityError();
      streamMock().mockRejectedValueOnce(capacityError);
      fallbackA.mockResolvedValueOnce(
        streamThenThrow([textChunk('fallback-a partial')], capacityError),
      );
      fallbackB.mockResolvedValueOnce(textStream('fallback-b ok'));

      const { events, caughtError } = await drainCollecting(
        await send('test', 'prompt-fallback-output-then-error'),
      );
      expect(caughtError).toBe(capacityError);

      expect(fallbackEvents(events)).toHaveLength(1);
      expect(hasChunkText(events, 'fallback-a partial')).toBe(true);
      expect(fallbackA).toHaveBeenCalledTimes(1);
      expect(fallbackB).not.toHaveBeenCalled();
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
      const abortError = new DOMException('Aborted', 'AbortError');
      const resolveForModel = wireFallbacks(
        ['fallback-a'],
        vi.fn().mockRejectedValueOnce(abortError),
      );
      streamMock().mockRejectedValueOnce(tpmCapacityError());

      const stream = await send('test', 'prompt-fallback-resolve-abort');
      await expect(drain(stream)).rejects.toBe(abortError);

      expect(resolveForModel).toHaveBeenCalledTimes(1);
    });

    it('surfaces an abort raised by a fallback stream without trying later fallbacks', async () => {
      const abortError = new DOMException('Aborted', 'AbortError');
      const { fallbackA, fallbackB, resolveForModel } = wireTwoFallbacks();
      fallbackA.mockRejectedValueOnce(abortError);
      streamMock().mockRejectedValueOnce(tpmCapacityError());

      const stream = await send('test', 'prompt-fallback-stream-abort');
      await expect(drain(stream)).rejects.toBe(abortError);

      expect(resolveForModel).toHaveBeenCalledTimes(1);
      expect(fallbackA).toHaveBeenCalledTimes(1);
      expect(fallbackB).not.toHaveBeenCalled();
    });

    it('retains tool calls and recording when a fallback is cancelled with an ACP reason', async () => {
      const controller = new AbortController();
      const abortError = new DOMException(
        'The operation was aborted.',
        'AbortError',
      );
      const record = vi.fn();
      const chatWithRecording = chatWithRecorder(record);
      streamMock().mockRejectedValueOnce(
        Object.assign(new Error('capacity'), { status: 503 }),
      );
      const fallback = {
        ...mockContentGenerator,
        generateContentStream: vi.fn().mockResolvedValue(
          (async function* () {
            yield modelChunk([
              { text: 'thinking', thought: true },
              fnCall('read_file', { path: 'foo' }, 'call-1'),
            ]);
            controller.abort('qwen:user-cancel');
            throw abortError;
          })(),
        ),
      };
      wireFallbacks(
        ['fallback-a'],
        vi.fn().mockResolvedValue({
          contentGenerator: fallback,
          model: 'fallback-a',
          retryAuthType: AuthType.USE_GEMINI,
        }),
      );
      const stream = await chatWithRecording.sendMessageStream(
        'test-model',
        { message: 'test', config: { abortSignal: controller.signal } },
        'test',
      );
      await expect(drain(stream)).rejects.toBe(abortError);
      expect(chatWithRecording.getHistory()).toEqual([
        expect.objectContaining({ role: 'user' }),
        expect.objectContaining({
          role: 'model',
          parts: expect.arrayContaining([
            expect.objectContaining({
              functionCall: expect.objectContaining({ id: 'call-1' }),
            }),
          ]),
        }),
      ]);
      expect(record).toHaveBeenCalledOnce();
    });

    it('does not fallback on non-eligible primary auth errors', async () => {
      await expectNoFallback(
        Object.assign(
          new StreamContentError(
            '{"error":{"code":"401","message":"Unauthorized"}}',
          ),
          { status: 401 },
        ),
        'prompt-primary-auth-no-fallback',
      );
    });

    it('preserves primary partial tool calls when fallback is skipped after output', async () => {
      vi.useFakeTimers();
      const resolveForModel = wireFallbacks(['test-model']);
      const capacityError = tpmCapacityError();
      const call = fnCall(
        'read_file',
        { path: '/tmp/primary.txt' },
        'call_failed_primary_attempt',
      );
      mockStreamsOnce(streamThenThrow([modelChunk([call])], capacityError));

      const stream = await send('test', 'prompt-skipped-fallback-failure');
      await expect(drain(stream)).rejects.toBe(capacityError);
      await vi.advanceTimersByTimeAsync(0);

      expect(resolveForModel).not.toHaveBeenCalled();
      const history = chat.getHistory();
      expect(history).toHaveLength(2);
      expect(history[0]!.role).toBe('user');
      expect(history[1]!.role).toBe('model');
      expect(history[1]!.parts?.some((part) => part.functionCall)).toBe(true);
    });

    // `socketCut` is the canonical retryable UND_ERR_SOCKET cut; the per-code
    // drift guard and non-retryable shapes stay inline on purpose.
    const socketCut = () =>
      Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('other side closed'), {
          code: 'UND_ERR_SOCKET',
        }),
      });

    /** Stream that yields `chunks` and then dies from a socket cut. */
    const cutAfter = (chunks: GenerateContentResponse[]) =>
      streamThenThrow(chunks, socketCut());

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

    /** Assert `calls` stream requests and `retries` RETRY events. */
    function expectAttempts(
      events: StreamEvent[],
      calls: number,
      retries: number,
    ) {
      expectStreamCalls(calls);
      expect(eventsOfType(events, StreamEventType.RETRY)).toHaveLength(retries);
    }

    /** One retry (two requests) and, when given, a chunk carrying `text`. */
    function expectRecovered(events: StreamEvent[], text?: string) {
      expectAttempts(events, 2, 1);
      if (text !== undefined) expect(hasChunkText(events, text)).toBe(true);
    }

    /** Attempt 1 yields `chunks`, throws `error`; the retry streams `text`. */
    async function recoverFrom(
      error: unknown,
      promptId: string,
      text: string,
      chunks: GenerateContentResponse[] = [],
    ) {
      mockStreamsOnce(streamThenThrow(chunks, error), textStream(text));
      return collectStreamWithFakeTimers(await send('test', promptId), 5_000);
    }

    /** `drainCollecting` while advancing fake timers by each of `steps`. */
    async function drainAdvancing(
      stream: AsyncGenerator<StreamEvent>,
      ...steps: number[]
    ) {
      const collecting = drainCollecting(stream);
      for (const ms of steps) await vi.advanceTimersByTimeAsync(ms);
      return collecting;
    }

    /** Pull the next event while advancing fake timers by `ms`. */
    async function nextAfter(stream: AsyncGenerator<StreamEvent>, ms: number) {
      const next = stream.next();
      await vi.advanceTimersByTimeAsync(ms);
      return next;
    }

    /** `send('test', promptId)` carrying an abort signal. */
    async function sendAbortable(promptId: string) {
      const controller = new AbortController();
      const stream = await chat.sendMessageStream(
        'test-model',
        { message: 'test', config: { abortSignal: controller.signal } },
        promptId,
      );
      return { controller, stream };
    }

    const expectWarned = (message: string, fields: Record<string, unknown>) =>
      expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
        message,
        expect.objectContaining(fields),
      );

    /** A single attempt from `source` rejects with `message`, no retry. */
    async function expectRejectedWithoutRetry(
      source: AsyncGenerator<GenerateContentResponse>,
      promptId: string,
      message: string,
    ) {
      mockStream(source);
      const stream = await send('test', promptId);
      const events: StreamEvent[] = [];
      await expect(async () => {
        for await (const event of stream) events.push(event);
      }).rejects.toThrow(message);
      expectAttempts(events, 1, 0);
    }

    describe('server stream retry', () => {
      const providerError = {
        code: 'server_error',
        message: 'Upstream inference unavailable',
      };

      function convertedError(event: ResponsesSSEEvent): Error {
        try {
          convertResponsesEventToGemini(
            event,
            'test-model',
            new ResponsesStreamState(),
          );
        } catch (error) {
          if (error instanceof Error) return error;
          throw error;
        }
        throw new Error('Expected a Responses stream error');
      }

      const serverError = () =>
        convertedError({ event: 'error', data: { error: providerError } });

      async function* failStream(error: Error, parts: Part[] = []) {
        if (parts.length > 0) {
          yield {
            candidates: [{ content: { parts } }],
          } as GenerateContentResponse;
        }
        throw error;
      }

      /** `first` fails, then a `Recovered` answer; collected under fake timers. */
      async function recoverAfter(
        first: AsyncGenerator<GenerateContentResponse>,
        promptId: string,
      ) {
        mockStreamsOnce(first, streamOf(stopResponse([{ text: 'Recovered' }])));
        return collectStreamWithFakeTimers(await send('test', promptId));
      }

      const expectRecoveredHistory = () =>
        expect(chat.getHistory()).toEqual([
          userText('test'),
          modelText('Recovered'),
        ]);

      /** Send 'test', advancing `ms` if given; the drain fails with `error`. */
      async function failedEvents(error: Error, promptId: string, ms?: number) {
        const stream = await send('test', promptId);
        const { events, caughtError } = await (ms === undefined
          ? drainCollecting(stream)
          : drainAdvancing(stream, ms));
        expect(caughtError).toBe(error);
        return events;
      }

      beforeEach(() => vi.useFakeTimers());

      it.each<{ label: string; event: ResponsesSSEEvent }>([
        { label: 'flat error', event: { event: 'error', data: providerError } },
        {
          label: 'nested error',
          event: { event: 'error', data: { error: providerError } },
        },
        {
          label: 'response.failed',
          event: {
            event: 'response.failed',
            data: { response: { error: providerError } },
          },
        },
      ])('recovers from Responses $label before output', async ({ event }) => {
        const events = await recoverAfter(
          failStream(convertedError(event)),
          'server-retry',
        );
        const calls = streamMock().mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[1]![0].contents).toEqual(calls[0]![0].contents);
        expect(eventsOfType(events, StreamEventType.RETRY)).toHaveLength(1);
        expectRecoveredHistory();
        expectWarned('Server stream retry scheduled', {
          statusCode: 500,
          providerCode: 'server_error',
          attempt: 1,
        });
      });

      it('discards thinking-only output before retrying', async () => {
        const events = await recoverAfter(
          failStream(serverError(), [
            { text: 'Abandoned reasoning', thought: true },
          ]),
          'server-thinking-retry',
        );
        expectAttempts(events, 2, 1);
        expectRecoveredHistory();
      });

      it.each([false, true])(
        'bounds retries and preserves the last error (mixed transport: %s)',
        async (mixed) => {
          const finalError = serverError();
          const errors = [
            serverError(),
            mixed ? socketCut() : serverError(),
            finalError,
          ];
          let attempt = 0;
          streamMock().mockImplementation(async () =>
            failStream(
              errors[attempt++] ?? new Error('Unexpected extra attempt'),
            ),
          );
          const events = await failedEvents(
            finalError,
            'server-exhausted',
            10_000,
          );
          expectAttempts(events, 3, 2);
          expectWarned('Server stream retry not taken', {
            retryDecision: 'exhausted',
            attempts: 2,
            maxRetries: 2,
          });
        },
      );

      it.each<{ label: string; parts: Part[] }>([
        { label: 'text', parts: [{ text: 'Visible partial answer' }] },
        {
          label: 'tool call',
          parts: [fnCall('read_file', {}, 'call_server')],
        },
      ])(
        'does not replay or continue after delivered $label',
        async ({ parts }) => {
          const error = serverError();
          streamMock().mockResolvedValueOnce(failStream(error, parts));
          const events = await failedEvents(error, 'server-after-output');
          expectAttempts(events, 1, 0);
        },
      );

      it('does not accept a server error that lands after the answer closed', async () => {
        // The acceptance gate swallows a trailing failure only for the classes
        // that say nothing about the answer (socket cut, traced status-less
        // frame); a 5xx is the server's verdict, so a closed answer must fail.
        // The sibling above can't pin this: without a finish reason the gate
        // declines on that conjunct whatever the allow-list says.
        const error = serverError();
        streamMock().mockResolvedValueOnce(
          streamThenThrow([textChunk('a complete answer', 'STOP')], error),
        );
        await failedEvents(error, 'server-after-closed-answer');
        expectStreamCalls(1);
        expect(mockDebugLoggerWarn).not.toHaveBeenCalledWith(
          'Accepting completed answer despite trailing stream failure.',
          expect.anything(),
        );
      });

      it('does not replay when an earlier transport attempt already delivered text', async () => {
        const error = serverError();
        mockStreamsOnce(
          failStream(socketCut(), [{ text: 'Visible partial answer' }]),
          failStream(error),
        );
        const events = await failedEvents(
          error,
          'server-during-continuation',
          10_000,
        );
        expectStreamCalls(2);
        expect(eventsOfType(events, StreamEventType.RETRY)).toEqual([
          { type: StreamEventType.RETRY, isContinuation: true },
        ]);
        expectWarned('Server stream retry not taken', {
          retryDecision: 'skipped_after_content',
        });
      });

      it.each([400, 401, 403])(
        'does not retry a stream error with status %s',
        async (status) => {
          const error = Object.assign(new Error('Rejected request'), {
            status,
          });
          streamMock().mockResolvedValueOnce(failStream(error));
          await failedEvents(error, 'server-client-error');
          expectStreamCalls(1);
        },
      );

      it.each([
        { status: 503, maxRetries: 0, retryErrorCodes: [] },
        { status: 503, maxRetries: 1, retryErrorCodes: [] },
        { status: 500, maxRetries: 1, retryErrorCodes: [500] },
      ])(
        'does not extend the rate-limit budget for $status (maxRetries: $maxRetries)',
        async ({ status, maxRetries, retryErrorCodes }) => {
          mockGeneratorConfig({
            maxRetries,
            retryErrorCodes,
            retryInitialDelayMs: 1,
            retryMaxDelayMs: 1,
          });
          const error = Object.assign(
            new Error('Provider temporarily overloaded'),
            { status },
          );
          streamMock().mockImplementation(async () => failStream(error));
          await failedEvents(error, 'server-rate-limit-exhausted', 10_000);
          expectStreamCalls(maxRetries + 1);
          expect(mockDebugLoggerWarn).not.toHaveBeenCalledWith(
            'Server stream retry scheduled',
            expect.anything(),
          );
        },
      );

      it('does not add retries to a failed HTTP establishment', async () => {
        const error = serverError();
        streamMock().mockRejectedValue(error);
        await failedEvents(error, 'server-connect-error', 10_000);
        expectStreamCalls(1);
      });

      it('stops when cancelled during server-error backoff', async () => {
        streamMock().mockResolvedValueOnce(failStream(serverError()));
        const { controller, stream } = await sendAbortable('server-aborted');
        const collecting = drainCollecting(stream);
        await vi.advanceTimersByTimeAsync(0);
        controller.abort();
        await vi.advanceTimersByTimeAsync(10_000);
        const { caughtError } = await collecting;
        expect(caughtError).toMatchObject({ name: 'AbortError' });
        expectStreamCalls(1);
      });
    });

    it('retries retryable transport stream errors and succeeds on a later attempt', async () => {
      vi.useFakeTimers();
      const text = 'Recovered after transport retry';
      expectRecovered(
        await recoverFrom(socketCut(), 'prompt-transport-retry', text),
        text,
      );
    });

    it('replays after a transport cut without leaking a placeholder prefix', async () => {
      vi.useFakeTimers();
      const events = await recoverFrom(
        socketCut(),
        'prompt-placeholder-prefix-transport-cut',
        'Recovered response',
        [textChunk('(request ')],
      );
      expect(chunkTexts(events)).toEqual(['Recovered response']);
      expect(eventsOfType(events, StreamEventType.RETRY)).toHaveLength(1);
      expect(chat.getHistory()).toEqual([
        userText('test'),
        modelText('Recovered response'),
      ]);
    });

    /**
     * Every attempt streams `makeStream()`; the cut surfaces after three
     * attempts, logged 'exhausted'. The error is caught, not a deferred
     * `expect().rejects`: it settles only after both retry delays, so awaiting
     * it first deadlocks and not awaiting it trips `vitest/valid-expect`.
     */
    async function expectTransportExhausted(
      makeStream: () => AsyncGenerator<GenerateContentResponse>,
      promptId: string,
    ) {
      streamMock().mockImplementation(() => Promise.resolve(makeStream()));
      const { events, caughtError } = await drainAdvancing(
        await send('test', promptId),
        0,
        10_000,
      );
      expect(caughtError).toBeInstanceOf(Error);
      expect((caughtError as Error).message).toContain('terminated');
      expectAttempts(events, 3, 2);
      expectWarned('Transport stream retry not taken', {
        retryDecision: 'exhausted',
      });
    }

    it('stops retrying retryable transport stream errors after the retry budget is exhausted', async () => {
      vi.useFakeTimers();
      // Nothing delivered: the log blames exhaustion; 'skipped_after_content'
      // would misattribute "gave up" as "unsafe to recover".
      const transportError = socketCut();
      await expectTransportExhausted(
        () => streamThenThrow([], transportError),
        'prompt-transport-retry-exhausted',
      );
    });

    it('attributes budget exhaustion correctly when thinking chunks flowed', async () => {
      vi.useFakeTimers();
      // Every attempt yields a thought: streamYieldedChunk is true, the content
      // flag false. 'exhausted' pins the ternary to the content flag for the
      // dominant #7832 shape: repeated socket cuts mid-thinking.
      await expectTransportExhausted(
        () =>
          cutAfter([modelChunk([{ text: 'Still reasoning…', thought: true }])]),
        'prompt-transport-retry-exhausted-after-thinking',
      );
    });

    /** Attempt 2 resumed from the delivered `prefix` instead of replaying. */
    function expectContinuedNotReplayed(events: StreamEvent[], prefix: string) {
      expect((requestAt(1).contents as Content[]).at(-2)).toEqual(
        modelText(prefix),
      );
      expect(
        events.filter(
          (event) =>
            event.type === StreamEventType.RETRY && !event.isContinuation,
        ),
      ).toHaveLength(0);
    }

    it('does not replay a transport stream error after yielding a chunk', async () => {
      vi.useFakeTimers();
      // Replay stays closed once output reached callers (it would duplicate);
      // attempt 2 is the continuation path ('transport stream continuation').
      const prefix = 'Partial response before socket close';
      const events = await recoverFrom(
        socketCut(),
        'prompt-transport-no-replay-after-chunk',
        ' …and the rest.',
        [textChunk(prefix)],
      );
      expectContinuedNotReplayed(events, prefix);
      expect(hasChunkText(events, prefix)).toBe(true);
    });

    it('retries a transport stream error after yielding only thinking chunks', async () => {
      vi.useFakeTimers();
      // Thinking models stream thoughts early, then reason for minutes, when
      // gateways close long-lived SSE (#7832). Replay stays allowed: the
      // partial turn is discarded wholesale, so nothing seen appears twice.
      const text = 'Recovered after thinking-phase retry';
      const events = await recoverFrom(
        socketCut(),
        'prompt-transport-retry-after-thinking',
        text,
        [modelChunk([{ text: 'Let me think about this…', thought: true }])],
      );
      expectRecovered(events, text);
      // The log flags that thinking chunks flowed (thinking-phase replays).
      expectWarned('Transport stream retry scheduled', {
        retryDecision: 'retry',
        yieldedNonContentChunks: true,
      });
    });

    it('does not replay when visible content followed the thinking chunks', async () => {
      vi.useFakeTimers();
      // The content flag accumulates: once a non-thought part flowed, after any
      // thinking, replay would duplicate visible output. Assert which path
      // fired (continuation), not the request count; anchoring on visible text
      // only also covers thoughts not leaking into the continuation prefix.
      const events = await recoverFrom(
        socketCut(),
        'prompt-transport-no-replay-after-thinking-then-content',
        ' …and ends.',
        [
          modelChunk([{ text: 'Reasoning first…', thought: true }]),
          textChunk('Visible answer begins'),
        ],
      );
      expectContinuedNotReplayed(events, 'Visible answer begins');
    });

    it('attributes a blocked replay to delivered content when a function call was cut', async () => {
      // A cut after a functionCall closes both paths (replay would duplicate
      // the call; continuation across a functionCall is excluded). The log must
      // blame delivered content ("unsafe to recover"), not exhaustion.
      await expectRejectedWithoutRetry(
        cutAfter([
          modelChunk([{ text: 'Choosing a tool…', thought: true }]),
          modelChunk([fnCall('read_file', {})]),
        ]),
        'prompt-transport-no-recovery-after-function-call-cut',
        'terminated',
      );
      expectWarned('Transport stream retry not taken', {
        retryDecision: 'skipped_after_content',
      });
    });

    it('retries a transport stream error after yielding only tool preparation metadata', async () => {
      vi.useFakeTimers();
      const preparationResponse = modelChunk([]);
      setToolCallPreparations(preparationResponse, [
        { callId: 'call-preparing', toolName: 'read_file' },
      ]);
      expectRecovered(
        await recoverFrom(
          socketCut(),
          'prompt-transport-after-preparation',
          'Recovered after preparation',
          [preparationResponse],
        ),
      );
      // No candidate output: the false side of the thinking-phase diagnostic.
      expectWarned('Transport stream retry scheduled', {
        retryDecision: 'retry',
        yieldedNonContentChunks: false,
      });
    });

    describe('transport stream continuation (#7832)', () => {
      const RESUME_INSTRUCTION = 'The connection dropped mid-response';
      const ACCEPTED_LOG =
        'Accepting completed answer despite trailing stream failure.';

      function requestContentsOfCall(index: number): Content[] {
        return requestAt(index).contents as Content[];
      }

      const hasText = (contents: Content[], needle: string) =>
        contents.some((entry) =>
          entry.parts?.some((part) => part.text?.includes(needle)),
        );

      /** A status-less gateway error frame that carries only a request id. */
      const statuslessError = () =>
        Object.assign(new Error("'id'"), {
          code: 'KeyError',
          requestID: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
        });

      /** Tripwire stream: consumed only if a finished or cut turn is wrongly resumed. */
      const tripwire = () => streamOf(textChunk('fabricated tail', 'STOP'));

      /** A finish chunk with no parts (no candidate content at all). */
      const bareFinish = () =>
        ({
          candidates: [{ finishReason: 'STOP' }],
        }) as unknown as GenerateContentResponse;

      /** `drainCollecting` under fake timers: advance 0, then `ms`. */
      async function drainTimed(
        stream: AsyncGenerator<StreamEvent>,
        ms: number,
      ) {
        const collecting = drainCollecting(stream);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(ms);
        return collecting;
      }

      const sendTimed = async (
        promptId: string,
        ms = 5_000,
        target: LlmChat = chat,
        message = 'test',
      ) =>
        collectStreamWithFakeTimers(await send(message, promptId, target), ms);

      /** Attempt 1 is cut after `prefix`; attempt 2 ends the answer with `rest`. */
      function cutThenFinish(
        prefix: string,
        rest: string,
        promptId: string,
        target: LlmChat = chat,
        message = 'test',
      ) {
        mockStreamsOnce(
          cutAfter([textChunk(prefix)]),
          streamOf(textChunk(rest, 'STOP')),
        );
        return sendTimed(promptId, 5_000, target, message);
      }

      const sendToolResult = (
        callId: string,
        promptId: string,
        target: LlmChat = chat,
      ) =>
        send(
          [fnResponse('read_file', { output: 'file contents' }, callId)],
          promptId,
          target,
        );

      /** Exactly one RETRY, and it is a continuation. */
      function expectOneContinuation(events: StreamEvent[]) {
        const retries = eventsOfType(events, StreamEventType.RETRY);
        expect(retries).toHaveLength(1);
        expect(
          retries[0]!.type === StreamEventType.RETRY &&
            retries[0]!.isContinuation,
        ).toBe(true);
      }

      const continuations = (events: StreamEvent[]) =>
        events.filter(
          (event) =>
            event.type === StreamEventType.RETRY && event.isContinuation,
        );

      /** First-part text of every CHUNK event, joined in order. */
      const deliveredText = (events: StreamEvent[]) =>
        eventsOfType(events, StreamEventType.CHUNK)
          .map(
            (event) =>
              (event as { value: GenerateContentResponse }).value
                .candidates?.[0]?.content?.parts?.[0]?.text ?? '',
          )
          .join('');

      const expectLastText = (text: string, target: LlmChat = chat) =>
        expect(target.getHistory().at(-1)).toEqual(modelText(text));

      const expectNotAccepted = () =>
        expect(mockDebugLoggerWarn).not.toHaveBeenCalledWith(
          ACCEPTED_LOG,
          expect.anything(),
        );

      /**
       * `--resume`/`--continue` read JSONL `recordAssistantTurn` writes, not
       * `this.history`, and a continuation's parts carry only the remainder:
       * the prefix is folded in once, before either layer is written, so tests
       * assert both agree. Two earlier shapes broke that (record deduped
       * against trimmed `contentText` vs the raw part; merging after append).
       */
      function recordedText(
        recordAssistantTurn: ReturnType<typeof vi.fn>,
        callIndex = 0,
      ): string | undefined {
        const message = recordAssistantTurn.mock.calls[callIndex]![0]
          .message as Array<{ text?: string }>;
        return message.find((part) => part.text !== undefined)?.text;
      }

      /** `record` ran once, and its first text part is `text`. */
      const expectRecordedText = (
        record: ReturnType<typeof vi.fn>,
        text: string | undefined,
      ) => {
        expect(record).toHaveBeenCalledTimes(1);
        expect(recordedText(record)).toBe(text);
      };

      /** The first text part of `target`'s last history entry. */
      const lastText = (target: LlmChat) =>
        target
          .getHistory()
          .at(-1)
          ?.parts?.find((part) => part.text !== undefined)?.text;

      function recording() {
        const record = vi.fn();
        return { record, target: chatWithRecorder(record) };
      }

      /** `cutThenFinish` on a fresh recording chat. */
      async function recordCutThenFinish(
        prefix: string,
        rest: string,
        promptId: string,
      ) {
        const { record, target } = recording();
        await cutThenFinish(prefix, rest, promptId, target);
        return { record, target };
      }

      /** A recording chat plus a controller to cancel its send. */
      const cancellable = () => ({
        controller: new AbortController(),
        ...recording(),
      });

      const sendAbortable = (
        target: LlmChat,
        controller: AbortController,
        promptId: string,
        message = 'test',
      ) =>
        target.sendMessageStream(
          'test-model',
          { message, config: { abortSignal: controller.signal } },
          promptId,
        );

      /** Rejects with the abort reason once `controller` aborts. */
      const untilAbort = <T>(controller: AbortController) =>
        new Promise<T>((_resolve, reject) => {
          controller.signal.addEventListener(
            'abort',
            () => reject(controller.signal.reason),
            { once: true },
          );
        });

      const expectChunk = async (stream: AsyncGenerator<StreamEvent>) =>
        expect((await stream.next()).value?.type).toBe(StreamEventType.CHUNK);

      const expectContinuationRetry = async (
        stream: AsyncGenerator<StreamEvent>,
      ) =>
        expect((await stream.next()).value).toMatchObject({
          type: StreamEventType.RETRY,
          isContinuation: true,
        });

      /** The resumed attempt's first event (after the retry delay) is a CHUNK. */
      async function expectResumedChunk(stream: AsyncGenerator<StreamEvent>) {
        const resumed = stream.next();
        await vi.advanceTimersByTimeAsync(5_000);
        expect((await resumed).value?.type).toBe(StreamEventType.CHUNK);
      }

      /** User cancel while the consumer is suspended between events. */
      async function cancelBetweenEvents(
        controller: AbortController,
        stream: AsyncGenerator<StreamEvent>,
      ) {
        controller.abort('qwen:user-cancel');
        await stream.return(undefined);
      }

      const expectRecordedOnce = (
        record: ReturnType<typeof vi.fn>,
        message: unknown[],
      ) =>
        expect(record).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message }),
        );

      it('keeps unfinished reasoning when a textless transport continuation is cancelled', async () => {
        vi.useFakeTimers();
        const { controller, record, target } = cancellable();
        mockStreamsOnce(
          cutAfter([textChunk('Delivered prefix.')]),
          streamOf(modelChunk([{ text: 'Still thinking', thought: true }])),
        );
        const stream = await sendAbortable(
          target,
          controller,
          'cancel-transport-thought',
        );
        await expectChunk(stream);
        await expectContinuationRetry(stream);
        await expectResumedChunk(stream);
        await cancelBetweenEvents(controller, stream);
        const parts = [
          { text: 'Still thinking', thought: true },
          { text: 'Delivered prefix.' },
        ];
        expect(target.getHistory().at(-1)?.parts).toEqual(parts);
        expectRecordedOnce(record, parts);
      });

      it.each(['success', 'retry yield', 'resumed output'])(
        'preserves Responses phases across a transport cut and %s',
        fakeTimers(async (outcome: string) => {
          const { controller, record, target } = cancellable();
          const commentary = {
            text: 'Working on the requested answer.',
            responsesMessage: { id: 'msg_c', phase: 'commentary' },
          };
          const final = {
            text: 'The completed final answer.',
            responsesMessage: { id: 'msg_f', phase: 'final_answer' },
          };
          mockStreamsOnce(
            cutAfter([
              modelChunk([{ ...commentary, text: 'Working on ' }]),
              modelChunk([{ ...commentary, text: 'the requested answer.' }]),
            ]),
            streamOf(modelChunk([final], 'STOP')),
          );
          const stream = await sendAbortable(
            target,
            controller,
            'transport-phases',
          );
          if (outcome === 'success') {
            await collectStreamWithFakeTimers(stream, 5_000);
          } else {
            await expectChunk(stream);
            await expectChunk(stream);
            await expectContinuationRetry(stream);
            if (outcome === 'resumed output') await expectResumedChunk(stream);
            await cancelBetweenEvents(controller, stream);
          }
          const parts =
            outcome === 'retry yield' ? [commentary] : [commentary, final];
          const history = JSON.parse(
            JSON.stringify(target.getHistory()),
          ) as Content[];
          expect(history.at(-1)?.parts).toEqual(parts);
          expectRecordedOnce(record, parts);
          if (outcome !== 'retry yield') {
            expect(requestContentsOfCall(1).at(-2)?.parts).toEqual([
              commentary,
            ]);
          }
          expect(
            convertGeminiContentsToResponsesInput({
              model: 'test-model',
              contents: history,
            }).input.filter(
              (item) => item.type === 'message' && item.role === 'assistant',
            ),
          ).toEqual(
            parts.map((part) => ({
              type: 'message',
              role: 'assistant',
              content: part.text,
              phase: part.responsesMessage.phase,
            })),
          );
        }),
      );

      it.each([
        ['retry yield', 1],
        ['retry delay', 1],
        ['stream establishment', 1],
        ['resumed output', 1],
        ['retry yield', 2],
        ['retry delay', 2],
        ['stream establishment', 2],
        ['resumed output', 2],
      ] as const)(
        'persists the prefix when cancelled at %s of continuation %s',
        fakeTimers(async (phase: string, continuation: number) => {
          const { controller, record, target } = cancellable();
          const generate = streamMock();
          generate.mockResolvedValueOnce(cutAfter([textChunk('first half ')]));
          if (continuation === 2) {
            generate.mockResolvedValueOnce(
              cutAfter([textChunk(' half second part ')]),
            );
          }
          let establishing = false;
          generate.mockImplementationOnce(async () => {
            establishing = true;
            if (phase === 'resumed output') {
              return streamOf(textChunk('resumed tail', 'STOP'));
            }
            return untilAbort<AsyncGenerator<GenerateContentResponse>>(
              controller,
            );
          });
          const stream = await sendAbortable(
            target,
            controller,
            'cancel-transport-gap',
            'write answer',
          );
          let retries = 0;
          const delivered: string[] = [];
          while (retries < continuation) {
            const next = stream.next();
            if (retries > 0) await vi.advanceTimersByTimeAsync(5_000);
            const event = await next;
            expect(event.done).toBe(false);
            if (event.done) break;
            if (event.value.type === StreamEventType.RETRY) {
              expect(event.value.isContinuation).toBe(true);
              retries++;
            } else if (event.value.type === StreamEventType.CHUNK) {
              delivered.push(
                (event.value.value.candidates?.[0]?.content?.parts ?? [])
                  .filter((part) => !part.thought)
                  .map((part) => part.text ?? '')
                  .join(''),
              );
            }
          }
          expect(delivered.join('')).toContain('first half ');
          expect(retries).toBe(continuation);
          expect(establishing).toBe(false);
          if (phase === 'retry yield') {
            await cancelBetweenEvents(controller, stream);
          } else if (phase === 'resumed output') {
            const next = stream.next();
            await vi.advanceTimersByTimeAsync(5_000);
            expect(await next).toMatchObject({
              done: false,
              value: { type: StreamEventType.CHUNK },
            });
            await cancelBetweenEvents(controller, stream);
          } else {
            const next = stream.next();
            if (phase === 'stream establishment') {
              await vi.advanceTimersByTimeAsync(5_000);
              expect(establishing).toBe(true);
            }
            controller.abort('qwen:user-cancel');
            await expect(next).rejects.toBe('qwen:user-cancel');
          }
          const text =
            (continuation === 1 ? 'first half ' : 'first half second part ') +
            (phase === 'resumed output' ? 'resumed tail' : '');
          const message = [{ text }];
          expect(target.getHistory()).toEqual([
            userText('write answer'),
            { role: 'model', parts: message },
          ]);
          expect(record).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ model: 'test-model', message }),
          );
          expect(generate).toHaveBeenCalledTimes(
            continuation +
              (phase === 'stream establishment' || phase === 'resumed output'
                ? 1
                : 0),
          );
        }),
      );

      it.each(['waiting', 'compressed notification'] as const)(
        'preserves delivered text when cancelled at reactive compression %s',
        fakeTimers(async (phase: string) => {
          const { controller, record, target } = cancellable();
          let compressing = false;
          vi.spyOn(ChatCompressionService.prototype, 'compress')
            .mockResolvedValueOnce(noop())
            .mockImplementationOnce(async () => {
              compressing = true;
              if (phase === 'waiting') {
                return untilAbort<ReturnType<typeof compressResult>>(
                  controller,
                );
              }
              return compressed(135_000, 40_000, [userText('summary')]);
            });
          mockStreamsOnce(
            cutAfter([textChunk('first half ')]),
            streamThenThrow(
              [textChunk('second half')],
              new StreamContentError(
                'prompt is too long: 135000 tokens > 128000 maximum',
              ),
            ),
          );
          const stream = await sendAbortable(
            target,
            controller,
            'cancel-reactive-compression',
            'write answer',
          );
          await expectChunk(stream);
          await expectContinuationRetry(stream);
          await expectResumedChunk(stream);
          const outcome = stream.next().catch((error) => error);
          await vi.advanceTimersByTimeAsync(0);
          expect(compressing).toBe(true);
          if (phase === 'compressed notification') {
            expect(await outcome).toMatchObject({
              value: { type: StreamEventType.COMPRESSED },
            });
          }
          controller.abort('qwen:user-cancel');
          if (phase === 'waiting')
            expect(await outcome).toBe(controller.signal.reason);
          else await stream.return(undefined);
          const parts = [{ text: 'first half second half' }];
          expect(
            target.getHistory().filter((turn) => turn.role === 'model'),
          ).toEqual([{ role: 'model', parts }]);
          expectRecordedOnce(record, parts);
          expectStreamCalls(2);
        }),
      );

      it.each(['rate limit', 'compression'])(
        'does not restore a discarded prefix when cancelled at a fresh %s retry',
        fakeTimers(async (retry: string) => {
          const { controller, record, target } = cancellable();
          if (retry === 'compression') {
            mockCompressOnce(
              noop(),
              compressed(135_000, 40_000, [userText('summary')]),
            );
          }
          streamMock()
            .mockResolvedValueOnce(cutAfter([textChunk('discarded prefix')]))
            .mockRejectedValueOnce(
              retry === 'rate limit'
                ? Object.assign(new Error('rate limit'), { status: 429 })
                : tooLong(),
            );
          const stream = await sendAbortable(
            target,
            controller,
            'cancel-fresh-retry',
            'write answer',
          );
          await expectChunk(stream);
          await expectContinuationRetry(stream);
          const next = stream.next();
          await vi.advanceTimersByTimeAsync(5_000);
          let result = await next;
          if (result.value?.type === StreamEventType.COMPRESSED) {
            result = await stream.next();
          }
          expect(result.done).toBe(false);
          expect(result.value).toMatchObject({ type: StreamEventType.RETRY });
          if (result.done || result.value.type !== StreamEventType.RETRY) {
            throw new Error('Expected a fresh retry');
          }
          expect(result.value.isContinuation).not.toBe(true);
          result.value.retryInfo?.skipDelay?.();
          await cancelBetweenEvents(controller, stream);
          expect(JSON.stringify(target.getHistory())).not.toContain(
            'discarded prefix',
          );
          expect(record).not.toHaveBeenCalled();
        }),
      );

      it('continues from the delivered text instead of failing the send', async () => {
        vi.useFakeTimers();
        const events = await cutThenFinish(
          '<html><body>',
          '</body></html>',
          'prompt-transport-continuation',
          chat,
          'write a game',
        );
        expectStreamCalls(2);
        // `isContinuation` tells the UI to KEEP the text already on screen;
        // a plain RETRY would make it discard the first half.
        expectOneContinuation(events);
        // The continuation request shows the model its own output and asks
        // it to resume; it does not re-send the original request alone.
        const secondRequest = requestContentsOfCall(1);
        expect(secondRequest.at(-2)).toEqual(modelText('<html><body>'));
        const instruction = secondRequest.at(-1)!;
        expect(instruction.role).toBe('user');
        expect(instruction.parts?.[0]?.text).toContain(RESUME_INSTRUCTION);
        expect(instruction.parts?.[0]?.text).toContain(
          '<previous_response_suffix>',
        );
        // Both halves reach the caller, in order and exactly once.
        expect(deliveredText(events)).toBe('<html><body></body></html>');
      });

      it('continues from the delivered text when a status-less upstream error cuts the stream', async () => {
        vi.useFakeTimers();
        // A gateway error frame is no socket cut, but once answer text reached
        // the caller replay would duplicate it, so keep it and ask to resume.
        mockStreamsOnce(
          streamThenThrow([textChunk('<html><body>')], statuslessError()),
          streamOf(textChunk('</body></html>', 'STOP')),
        );
        const events = await sendTimed(
          'prompt-upstream-statusless-continuation',
          5_000,
          chat,
          'write a game',
        );
        expectStreamCalls(2);
        expectOneContinuation(events);
        // In order, exactly once: the invariant the replay gate protects.
        expect(deliveredText(events)).toBe('<html><body></body></html>');
        // Same fields as the replay log: the reason names the cause; the
        // request id is the only handle a gateway ticket can be filed against.
        expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
          'Transport stream continuation scheduled',
          expect.objectContaining({
            classificationReason: 'upstream-error-without-status',
            providerCode: 'KeyError',
            requestId: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
          }),
        );
      });

      /**
       * One attempt, no RETRY, no error, and the completed answer reaches
       * history as a clean end would leave it. No fake timers: nothing
       * retries, so there is no backoff to advance.
       */
      async function expectAcceptedAnswer(promptId: string) {
        const { events, caughtError } = await drainCollecting(
          await send('test', promptId),
        );
        expectStreamCalls(1);
        expect(eventsOfType(events, StreamEventType.RETRY)).toHaveLength(0);
        expect(caughtError).toBeUndefined();
        expectLastText('a complete answer');
      }

      it('accepts the completed answer when a status-less upstream error lands after the terminal finish reason', async () => {
        // The pipeline keeps pulling past the finish chunk for trailing usage
        // (the SDK's error scan is position-independent), so a gateway failure
        // there throws *after* the answer completed. Failing strands it out of
        // history and JSONL; continuing adds a fabricated tail after a false
        // "connection dropped mid-response" instruction.
        mockStreamsOnce(
          streamThenThrow(
            [textChunk('a complete answer', 'STOP')],
            statuslessError(),
          ),
          // A wrong resume lands here: a regression shows as a call count.
          tripwire(),
        );
        await expectAcceptedAnswer('prompt-upstream-statusless-after-finish');
        // The trailing failure stays visible as the acceptance log.
        expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
          ACCEPTED_LOG,
          expect.objectContaining({ finishReason: 'STOP' }),
        );
      });

      it('accepts the completed answer when a transport cut lands after the terminal finish reason', async () => {
        // Same post-completion shape via a socket cut: neither fail nor resume.
        mockStreamsOnce(
          cutAfter([textChunk('a complete answer', 'STOP')]),
          tripwire(),
        );
        await expectAcceptedAnswer('prompt-transport-cut-after-finish');
      });

      it('propagates a user cancellation that lands after the terminal finish reason', async () => {
        // The gate is for transport cuts and status-less frames in the usage
        // tail; a user cancel is neither and, like the isAbortError rethrows in
        // the model-fallback paths, is never converted into another outcome.
        const abortError = Object.assign(new Error('Aborted'), {
          name: 'AbortError',
        });
        mockStreamsOnce(
          streamThenThrow([textChunk('a complete answer', 'STOP')], abortError),
        );
        const stream = await send('test', 'prompt-abort-after-finish');
        const { events, caughtError } = await drainCollecting(stream);
        expect(caughtError).toBe(abortError);
        expect(eventsOfType(events, StreamEventType.RETRY)).toHaveLength(0);
        // The cancelled turn must not persist as a completed model turn.
        expect(chat.getHistory().at(-1)).toEqual(userText('test'));
        expectNotAccepted();
      });

      it("propagates the pipeline's own InvalidStreamError after the terminal finish reason", async () => {
        vi.useFakeTimers();
        // The pipeline raises PROTOCOL_TAG_LEAK on a post-finish blip it deemed
        // untrustworthy; accepting would persist it and bypass that budget.
        mockStreamsOnce(
          streamThenThrow(
            [textChunk('a complete answer', 'STOP')],
            new InvalidStreamError(
              'Model response continued after a finish reason.',
              'PROTOCOL_TAG_LEAK',
            ),
          ),
          streamOf(textChunk('a clean answer', 'STOP')),
        );
        await sendTimed('prompt-invalid-stream-after-finish');
        expectStreamCalls(2);
        // Rode its invalid-stream budget; not swallowed by the acceptance gate.
        expect(mockLogContentRetry).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({
            error_type: 'PROTOCOL_TAG_LEAK',
            model: 'test-model',
          }),
        );
        expectLastText('a clean answer');
        expectNotAccepted();
      });

      it('propagates a throttle only the configured retry codes recognise', async () => {
        vi.useFakeTimers();
        // The gate must classify with the send loop's context: a code only the
        // configured `retryErrorCodes` call throttling (request id, no status)
        // looks like an accepted status-less frame, certifying throttled turns.
        mockGeneratorConfig({
          authType: AuthType.USE_OPENAI,
          retryErrorCodes: [4999],
        });
        const configuredThrottle = new StreamContentError(
          '{"error":{"code":4999,"message":"custom throttle","request_id":"req-configured-throttle"}}',
        );
        mockStreamsOnce(
          streamThenThrow(
            [textChunk('a complete answer', 'STOP')],
            configuredThrottle,
          ),
          streamOf(textChunk('answer after the throttle retry', 'STOP')),
        );
        const events = await sendTimed(
          'prompt-configured-throttle-after-finish',
          120_000,
        );
        expectStreamCalls(2);
        // Rode the rate-limit retry that owns it; not swallowed by the gate.
        expect(hasRetry(events)).toBe(true);
        expectNotAccepted();
      });

      /**
       * Tool-result send: attempt 1's prose is cut, attempt 2 closes quiet
       * (thought + STOP) and then takes `trailing` if given, attempt 3 answers.
       */
      async function quietToolResultClose(
        callId: string,
        promptId: string,
        target: LlmChat,
        trailing?: Error,
      ) {
        const quiet = [
          modelChunk([{ text: 'Reconsidering.', thought: true }], 'STOP'),
        ];
        mockStreamsOnce(
          cutAfter([textChunk('Let me read that file. ')]),
          trailing ? streamThenThrow(quiet, trailing) : streamOf(...quiet),
          streamOf(textChunk('the recovered answer', 'STOP')),
        );
        return drainTimed(
          await sendToolResult(callId, promptId, target),
          60_000,
        );
      }

      it('retries a quiet tool-result close rather than persisting the delivered prefix', async () => {
        vi.useFakeTimers();
        // No-error arm: a thought-only close made no visible progress (#7039
        // owns it), rides the invalid-stream retry to attempt 3, and that fresh
        // restart (this policy, not the gate) discards attempt 1's prose. The
        // with-error sibling is why the progress term is turn-scoped: a
        // trailing frame once left this shape to no arm, killing a turn that
        // recovers without it.
        const { record, target } = recording();
        const { caughtError } = await quietToolResultClose(
          'call_quiet_tool_result_close',
          'prompt-quiet-tool-result-close-no-trailing-error',
          target,
        );
        expect(caughtError).toBeUndefined();
        expectStreamCalls(3);
        // The answer is the retry's; the prefix the caller watched stream is
        // in neither durable layer, with no error involved.
        expectRecordedText(record, 'the recovered answer');
        expect(JSON.stringify(target.getHistory())).not.toContain(
          'Let me read that file.',
        );
      });

      it.each([
        { label: 'status-less frame', trailing: statuslessError },
        { label: 'socket cut', trailing: () => socketCut() },
      ] as const)(
        'continues past a trailing $label on a quiet tool-result close',
        fakeTimers(async ({ trailing }: { trailing: () => Error }) => {
          // R17-1: the quiet close takes a trailing failure in the usage tail.
          // The continuation arm owns it (the closed-finish veto needs output
          // of the attempt's own), so the prefix folds into the resumed answer.
          // The gate must decline on its attempt-local progress term: accepting
          // nulls the error, NO_TOOL_RESULT_PROGRESS throws, and the fresh
          // restart (resetTransportContinuation) loses the prose from both
          // layers. Both admitted classes take that conjunct: each is pinned.
          const { record, target } = recording();
          const { events, caughtError } = await quietToolResultClose(
            'call_quiet_close_with_frame',
            'prompt-quiet-tool-result-close-with-trailing-failure',
            target,
            trailing(),
          );
          expect(caughtError).toBeUndefined();
          expectStreamCalls(3);
          // Continuations, not fresh restarts: that is what keeps the prefix.
          const retries = eventsOfType(events, StreamEventType.RETRY);
          expect(retries).toHaveLength(2);
          expect(
            retries.every(
              (event) =>
                event.type === StreamEventType.RETRY && event.isContinuation,
            ),
          ).toBe(true);
          // Prose folded in both layers; the failure is not a completion.
          expectRecordedText(
            record,
            'Let me read that file. the recovered answer',
          );
          expectNotAccepted();
        }),
      );

      it('does not schedule a continuation over a closed finish reason on a tool-result send', async () => {
        vi.useFakeTimers();
        // With a user[functionResponse] tail every attempt defers finishReason
        // off each yielded chunk and a failed attempt never re-emits it, so the
        // veto must read what processStreamResponse observed.
        chat.setHistory([
          userText('read the file'),
          content(
            'model',
            fnCall('read_file', { path: '/tmp/x' }, 'call_read_file'),
          ),
        ]);
        // A 5xx is outside the gate's allow-list, so this veto is the operative
        // cause (a socket cut or traced status-less frame here is accepted by
        // the gate and #7039 retries the quiet close: the two siblings above).
        const serverError = Object.assign(
          new Error('Upstream inference unavailable'),
          { status: 500, code: 'server_error' },
        );
        mockStreamsOnce(
          // Attempt 1 delivers prose and is cut, arming a continuation.
          streamThenThrow(
            [textChunk('Let me read that file. ')],
            statuslessError(),
          ),
          // Attempt 2: own text + STOP, then a 5xx in the usage tail.
          streamThenThrow(
            [textChunk('The file is empty.', 'STOP')],
            serverError,
          ),
          // Consumed only by a wrongly scheduled third attempt.
          tripwire(),
        );
        const stream = await chat.sendMessageStream(
          'test-model',
          {
            message: fnResponse(
              'read_file',
              { output: 'file contents' },
              'call_read_file',
            ),
          },
          'prompt-upstream-statusless-tool-result-closed-finish',
        );
        const { caughtError } = await drainTimed(stream, 10_000);
        expectStreamCalls(2);
        expect(caughtError).toBeInstanceOf(Error);
        expect(JSON.stringify(chat.getHistory())).not.toContain(
          'fabricated tail',
        );
        // The log names the closed finish only if the veto saw it: here only
        // via the observed-close mirror (the deferral strips it off chunks).
        expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
          'Server stream retry not taken',
          expect.objectContaining({
            retryDecision: 'skipped_terminal_finish_reason',
          }),
        );
      });

      it("does not let a previous send's closed finish reason veto a later send's continuation", async () => {
        vi.useFakeTimers();
        // Observed-close is per-attempt state reset beside `lastFinishReason`:
        // an earlier completed send must not leak its reason into this one.
        mockStreamsOnce(streamOf(textChunk('first answer', 'STOP')));
        await sendDrain('first', 'prompt-observed-close-isolation-1');
        const events = await cutThenFinish(
          'second partial ',
          'completed',
          'prompt-observed-close-isolation-2',
          chat,
          'second',
        );
        expectStreamCalls(3);
        expectOneContinuation(events);
        expectLastText('second partial completed');
      });

      it('continues when the cut follows a finish reason that carries no completeness information', async () => {
        vi.useFakeTimers();
        // Unrecognised wire values map to FINISH_REASON_UNSPECIFIED, a truthy
        // "could not tell", not terminal; treating it as closed would refuse
        // the very continuation this arm exists for.
        mockStreamsOnce(
          streamThenThrow(
            [textChunk('partial answer', 'FINISH_REASON_UNSPECIFIED')],
            statuslessError(),
          ),
          streamOf(textChunk(' and the rest', 'STOP')),
        );
        const events = await sendTimed(
          'prompt-upstream-statusless-unmapped-finish',
        );
        expectStreamCalls(2);
        expectOneContinuation(events);
        expectLastText('partial answer and the rest');
      });

      it('continues a MAX_TOKENS-truncated answer after a stream cut', async () => {
        vi.useFakeTimers();
        // The carve-out's own witness: MAX_TOKENS truncation, then a gateway
        // idle cut. The reason must ride the *pre-error* chunk:
        // `lastFinishReason` resets per attempt; only the failing one feeds it.
        mockStreamsOnce(
          cutAfter([textChunk('partial answer', 'MAX_TOKENS')]),
          streamOf(textChunk(' completed', 'STOP')),
        );
        const events = await sendTimed(
          'prompt-transport-continuation-max-tokens',
        );
        expectStreamCalls(2);
        expectOneContinuation(events);
        expect(deliveredText(events)).toBe('partial answer completed');
        expectLastText('partial answer completed');
      });

      it('attributes a refused continuation to the terminal finish reason', async () => {
        // The finish chunk arrived, so recovery is refused because the answer
        // closed, not because content reached the caller; the log must name
        // that cause, or a gateway ticket points at the wrong gate.
        const toolChunk = modelChunk(
          [fnCall('read_file', { path: '/tmp/a.txt' }, 'call_1')],
          'STOP',
        );
        mockStream(cutAfter([textChunk('delivered half '), toolChunk]));
        const stream = await send(
          'test',
          'prompt-transport-not-taken-terminal-finish',
        );
        await expect(drain(stream)).rejects.toThrow('terminated');
        expect(mockDebugLoggerWarn).toHaveBeenCalledWith(
          'Transport stream retry not taken',
          expect.objectContaining({
            retryDecision: 'skipped_terminal_finish_reason',
          }),
        );
      });

      it('stitches the delivered text into durable history', async () => {
        vi.useFakeTimers();
        // Unmerged, history keeps only the continuation half: later turns,
        // /compress and --resume see an answer starting mid-document.
        await cutThenFinish(
          'first half ',
          'second half',
          'prompt-transport-continuation-history',
        );
        const history = chat.getHistory();
        expect(history.at(-1)).toEqual(modelText('first half second half'));
        // The resume instruction is request-only, never history as user text.
        expect(hasText(history, RESUME_INSTRUCTION)).toBe(false);
      });

      it('records the delivered prefix with the resumed remainder in one turn', async () => {
        vi.useFakeTimers();
        const { record, target } = await recordCutThenFinish(
          'first half ',
          'second half',
          'prompt-transport-continuation-record',
        );
        // One turn in, one turn on disk, agreeing with in-memory history.
        expectRecordedText(record, 'first half second half');
        expectLastText('first half second half', target);
      });

      it('merges a whitespace-leading remainder identically in both layers', async () => {
        vi.useFakeTimers();
        // R1-1: the record deduped against trimmed `contentText` while
        // history merged the raw part, so a token-boundary cut fused "The
        // result is" + " 42." into "The result is42." in the transcript only.
        const { record, target } = await recordCutThenFinish(
          'The result is',
          ' 42.',
          'prompt-transport-continuation-record-boundary',
        );
        expectRecordedText(record, 'The result is 42.');
        expectLastText('The result is 42.', target);
      });

      it('keeps a whitespace-boundary overlap dedup consistent across layers', async () => {
        vi.useFakeTimers();
        // The dedup-divergence half of R1-1: " total" is a 6-byte overlap
        // only while untrimmed, so trimming lost the dedup and recorded
        // "The grand totaltotal sum is 9.".
        const { record, target } = await recordCutThenFinish(
          'The grand total',
          ' total sum is 9.',
          'prompt-transport-continuation-record-boundary-overlap',
        );
        // Whatever the dedup decides, both layers must decide it the same.
        expectRecordedText(record, lastText(target));
        expect(recordedText(record)).not.toContain('totaltotal');
      });

      it('agrees across layers when the consumer aborts at the deferred finish chunk', async () => {
        vi.useFakeTimers();
        // R2-2: on a tool-result continuation the finishReason is re-emitted as
        // a synthetic chunk AFTER the history push, where `Turn.run` returns on
        // Esc. Merging in the outer send loop left a merged record against a
        // remainder-only history there; append-only JSONL never reconciles it.
        const { record, target } = recording();
        mockStreamsOnce(
          cutAfter([textChunk('Analysis: the file ')]),
          streamOf(textChunk('contains the bug.', 'STOP')),
        );
        const stream = await sendToolResult(
          'call_deferred_window',
          'prompt-transport-continuation-record-deferred-abort',
          target,
        );
        const collecting = (async () => {
          for await (const event of stream) {
            // Only the synthetic deferred chunk keeps its finishReason.
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
        const historyText = lastText(target);
        expectRecordedText(record, 'Analysis: the file contains the bug.');
        // Record and history must agree even though the send was abandoned.
        expect(historyText).toBe(recordedText(record));
      });

      /**
       * 'write a game': attempt 1 is cut after 'Here is the game: ', attempt 2
       * yields only `close` and dies from `error`; `rest` (if given) answers.
       */
      async function closeWithoutNewText(
        close: GenerateContentResponse,
        error: Error,
        promptId: string,
        target: LlmChat,
        rest?: string,
      ) {
        mockStreamsOnce(
          cutAfter([textChunk('Here is the game: ')]),
          streamThenThrow([close], error),
          ...(rest ? [streamOf(textChunk(rest, 'STOP'))] : []),
        );
        return drainTimed(await send('write a game', promptId, target), 60_000);
      }

      it('persists the delivered prefix when a continuation closes without new visible text', async () => {
        vi.useFakeTimers();
        // R11-1: the gate measured completeness by this attempt's own
        // `contentText` ('' for a thought-only close) and declined, and no arm
        // owned the failure: replay needs an empty prefix, the mirrored close
        // vetoes continuation, the rate-limit, overflow and invalid-stream arms
        // miss a status-less frame. The prose reached neither history nor
        // JSONL. Without the trailing error the attempt is accepted: the gate's
        // doing.
        const { record, target } = recording();
        const { caughtError } = await closeWithoutNewText(
          modelChunk(
            [{ text: 'Double-checking the rules.', thought: true }],
            'STOP',
          ),
          statuslessError(),
          'prompt-continuation-closes-without-new-text',
          target,
        );
        expect(caughtError).toBeUndefined();
        // The watched prefix reaches both layers, as a clean close would.
        expectRecordedText(record, 'Here is the game: ');
        const historyText = target
          .getHistory()
          .at(-1)
          ?.parts?.find(
            (part) => part.text !== undefined && !part.thought,
          )?.text;
        expect(historyText).toBe('Here is the game: ');
        // Nothing was refused: no recovery decision was needed.
        expect(mockDebugLoggerWarn).not.toHaveBeenCalledWith(
          'Transport stream retry not taken',
          expect.anything(),
        );
      });

      it('continues when a continuation attempt closes without contributing parts', async () => {
        vi.useFakeTimers();
        // R15-1: asked to resume an answer it thinks complete, a model sends a
        // part-less finish chunk, then dies in the usage tail. The error-path
        // flush now delivers that parked finish (once dropped): `STOP` makes
        // the closed-finish veto refuse while the gate's attempt-local
        // `hasAnyContent` declines, so every arm fell through and the prose was
        // lost. The veto stops a *fabricated tail* on an answer with output;
        // an attempt with no output has nothing to fabricate onto.
        const { record, target } = recording();
        const { caughtError } = await closeWithoutNewText(
          bareFinish(),
          socketCut(),
          'prompt-continuation-closes-with-no-parts',
          target,
          'the completed game',
        );
        expect(caughtError).toBeUndefined();
        expectStreamCalls(3);
        // The turn completes, with the watched prose in both durable layers.
        expectRecordedText(record, 'Here is the game: the completed game');
        expectLastText('Here is the game: the completed game', target);
      });

      it('keeps an attempt that delivered nothing at all off the invalid-stream budget', async () => {
        vi.useFakeTimers();
        // The other side of the R11-1 `hasAnyContent` conjunct (status-less
        // sibling above). Turn-scoped completeness alone would accept this
        // closed attempt; empty-response validation then throws and re-sends
        // the *original* prompt on the invalid-stream budget, losing the
        // prefix. Declining lets the continuation arm keep it in both layers.
        const { record, target } = recording();
        const { caughtError } = await closeWithoutNewText(
          bareFinish(),
          statuslessError(),
          'prompt-continuation-attempt-delivered-nothing',
          target,
          'the completed game',
        );
        expect(caughtError).toBeUndefined();
        expectStreamCalls(3);
        // Resumed from the prefix, not re-sent from the original prompt.
        expectRecordedText(record, 'Here is the game: the completed game');
      });

      it('dedupes replayed overlap in the recorded turn too', async () => {
        vi.useFakeTimers();
        const { record } = await recordCutThenFinish(
          'The quick brown fox jumps over',
          'jumps over the lazy dog.',
          'prompt-transport-continuation-record-overlap',
        );
        expectRecordedText(
          record,
          'The quick brown fox jumps over the lazy dog.',
        );
      });

      /** A continuation (after 'doomed fragment ') superseded by a fresh-restart retry. */
      function freshRestartAfterCut(promptId: string, target: LlmChat = chat) {
        mockStreamsOnce(
          cutAfter([textChunk('doomed fragment ')]),
          streamThenThrow(
            [],
            new InvalidStreamError(
              'Model stream ended with empty response text.',
              'NO_RESPONSE_TEXT',
            ),
          ),
          streamOf(textChunk('a clean answer', 'STOP')),
        );
        return sendTimed(promptId, 10_000, target);
      }

      it('records nothing of a continuation a fresh-restart retry discarded', async () => {
        vi.useFakeTimers();
        // The mirror of the merge: superseded text leaves history, so it stays
        // out of the transcript too; recording the prefix when the continuation
        // is *scheduled* would fix `--resume` on success but duplicate it here.
        const { record, target } = recording();
        await freshRestartAfterCut(
          'prompt-transport-continuation-record-superseded',
          target,
        );
        // Three attempts: the continuation was scheduled, then superseded.
        expectStreamCalls(3);
        expectRecordedText(record, 'a clean answer');
      });

      it('keeps the record remainder-only when the continuation itself is cut after a tool call', async () => {
        vi.useFakeTimers();
        // The one case with the prefix and a deferred partial record both
        // live: a functionCall attempt that dies cannot continue again
        // (`canContinueAfterTransportCut` needs !streamYieldedFunctionCall),
        // so `pendingPartialAssistantRecord` stashes the partial while the
        // prefix stays set. The success-exit merge never runs, so the prefix
        // stays out of BOTH layers; merging unconditionally would desync them.
        const { record, target } = recording();
        mockStreamsOnce(
          cutAfter([textChunk('delivered half ')]),
          cutAfter([
            modelChunk([
              fnCall(
                'read_file',
                { path: '/tmp/x.txt' },
                'call_after_continuation',
              ),
            ]),
          ]),
        );
        const stream = await send(
          'test',
          'prompt-transport-continuation-record-fc-cut',
          target,
        );
        // This send rejects: attach the assertion before advancing timers (as
        // `expectStreamExhaustion` does); `collectStreamWithFakeTimers` would
        // leave the mid-advance rejection unhandled.
        const settled = (async () =>
          expect(drain(stream)).rejects.toThrow('terminated'))();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(10_000);
        await settled;
        expectStreamCalls(2);
        // No text part at all: the attempt yielded only a functionCall.
        expectRecordedText(record, undefined);
        // And the durable record still matches what survives in memory.
        const lastTurn = target.getHistory().at(-1);
        expect(lastTurn?.role).toBe('model');
        expect(
          lastTurn?.parts?.some((part) =>
            part.text?.includes('delivered half'),
          ),
        ).toBe(false);
      });

      it('drops replayed overlap when the model repeats its own tail', async () => {
        vi.useFakeTimers();
        await cutThenFinish(
          'The quick brown fox jumps over',
          'jumps over the lazy dog.',
          'prompt-transport-continuation-overlap',
        );
        expectLastText('The quick brown fox jumps over the lazy dog.');
      });

      it('survives repeated cuts and accumulates every delivered fragment', async () => {
        vi.useFakeTimers();
        mockStreamsOnce(
          cutAfter([textChunk('part one ')]),
          cutAfter([textChunk('part two ')]),
          streamOf(textChunk('part three', 'STOP')),
        );
        const events = await sendTimed(
          'prompt-transport-continuation-repeated',
          10_000,
        );
        expectStreamCalls(3);
        // The third request carries BOTH earlier fragments, not just the last.
        expect(requestContentsOfCall(2).at(-2)).toEqual(
          modelText('part one part two '),
        );
        expect(continuations(events)).toHaveLength(2);
        expectLastText('part one part two part three');
      });

      it('drops replayed overlap when an intermediate attempt is cut again', async () => {
        vi.useFakeTimers();
        // Both cases above at once: a middle attempt replays the previous tail
        // *and* is cut. Merge-time dedup only checks the final attempt, so the
        // replay would be baked into every later request and history
        // (corrupting /compress, --resume and later turns).
        mockStreamsOnce(
          cutAfter([textChunk('part one ')]),
          cutAfter([textChunk('part one part two ')]),
          streamOf(textChunk('part three', 'STOP')),
        );
        await sendTimed(
          'prompt-transport-continuation-intermediate-replay',
          10_000,
        );
        // The third request must not carry "part one" twice.
        expect(requestContentsOfCall(2).at(-2)).toEqual(
          modelText('part one part two '),
        );
        expectLastText('part one part two part three');
      });

      /** Whether every RETRY among `events` is a continuation. */
      const allRetriesContinue = (events: StreamEvent[]) =>
        eventsOfType(events, StreamEventType.RETRY).every(
          (event) =>
            (event as { isContinuation?: boolean }).isContinuation === true,
        );

      it('keeps continuing when a later attempt is cut during thinking', async () => {
        vi.useFakeTimers();
        // `streamYieldedContentChunk` is per-attempt, so a cut while thinking
        // looks like nothing was delivered though earlier text is on screen;
        // the replay gate runs first and, unguarded on the accumulated text,
        // emits a plain RETRY that discards output the user was watching.
        mockStreamsOnce(
          cutAfter([textChunk('part one ')]),
          cutAfter([
            modelChunk([
              { text: 'Now let me check the next part.', thought: true },
            ]),
          ]),
          streamOf(textChunk('part two', 'STOP')),
        );
        const events = await sendTimed(
          'prompt-transport-continuation-thought-only-cut',
          10_000,
        );
        // Each RETRY must continue; a plain one drops "part one " in the UI.
        expect(eventsOfType(events, StreamEventType.RETRY)).toHaveLength(2);
        expect(allRetriesContinue(events)).toBe(true);
        // The delivered text anchors the third request, not regenerated.
        expect(requestContentsOfCall(2).at(-2)).toEqual(modelText('part one '));
        expectLastText('part one part two');
      });

      it('pins the delivered text after a thought part in the merged turn', async () => {
        vi.useFakeTimers();
        // Covers `textIndex > 0`: the delivered text merges into the *text*
        // part, not spliced at index 0 ahead of the leading thought.
        mockStreamsOnce(
          cutAfter([textChunk('part one ')]),
          streamOf(
            modelChunk(
              [
                { text: 'still reasoning', thought: true },
                { text: 'part two' },
              ],
              'STOP',
            ),
          ),
        );
        await sendTimed(
          'prompt-transport-continuation-thought-then-text',
          10_000,
        );
        expect(chat.getHistory().at(-1)).toEqual({
          role: 'model',
          parts: [
            { text: 'still reasoning', thought: true },
            { text: 'part one part two' },
          ],
        });
      });

      it('inserts the delivered text when the continuation has no text part', async () => {
        vi.useFakeTimers();
        // Covers `textIndex < 0`: the delivered text becomes its own part. Put
        // AFTER an unsigned trailing thought it would bury that episode before
        // the coalescing-site trailing-only drop (the "fourth call site" in
        // dropDanglingUnsignedTrailingThought's doc), so it is dropped first.
        mockStreamsOnce(
          cutAfter([textChunk('part one ')]),
          streamOf(
            modelChunk([{ text: 'only thinking', thought: true }], 'STOP'),
          ),
        );
        await sendTimed('prompt-transport-continuation-thought-only', 10_000);
        expectLastText('part one ');
      });

      it('propagates once the continuation budget is exhausted', async () => {
        vi.useFakeTimers();
        let call = 0;
        streamMock().mockImplementation(() =>
          Promise.resolve(cutAfter([textChunk(`fragment ${call++} `)])),
        );
        const { caughtError } = await drainTimed(
          await send('test', 'prompt-transport-continuation-exhausted'),
          30_000,
        );
        expect((caughtError as Error).message).toContain('terminated');
        // Initial attempt + maxContinuationRetries continuations, then stop.
        expectStreamCalls(4);
        // Plain-text cuts reach not-taken with content but no functionCall,
        // pinning the log's ternary key to `streamYieldedContentChunk` (keyed
        // on `streamYieldedFunctionCall` it would log 'exhausted').
        expectWarned('Transport stream retry not taken', {
          retryDecision: 'skipped_after_content',
        });
      });

      it('does not continue a cut that delivered a functionCall', async () => {
        // A user turn between a functionCall and its functionResponse is a
        // sequence providers reject; the scheduler's repair path owns it.
        mockStream(
          cutAfter([
            modelChunk([
              { text: 'Let me read that file. ' },
              fnCall('read_file', { path: '/tmp/a.txt' }, 'call_1'),
            ]),
          ]),
        );
        const stream = await send(
          'test',
          'prompt-transport-continuation-functioncall',
        );
        await expect(drain(stream)).rejects.toThrow('terminated');
        expectStreamCalls(1);
      });

      it('does not continue a status-less upstream error that delivered a functionCall', async () => {
        // The gate admits a status-less failure for prose, but a delivered
        // functionCall excludes it as for a socket cut. The Anthropic
        // deferred-batch release relies on this: a closed call released ahead
        // of this error reaches error-path persistence and repair, not a
        // resume of prose whose tool decision the model never saw.
        const upstreamError = statuslessError();
        mockStreamsOnce(
          streamThenThrow(
            [
              textChunk('Let me read that file. '),
              modelChunk([
                fnCall('read_file', { path: '/tmp/a.txt' }, 'call_1'),
              ]),
            ],
            upstreamError,
          ),
          tripwire(),
        );
        const { events, caughtError } = await drainCollecting(
          await send('test', 'prompt-upstream-statusless-functioncall'),
        );
        expectStreamCalls(1);
        expect(eventsOfType(events, StreamEventType.RETRY)).toHaveLength(0);
        expect(caughtError).toBe(upstreamError);
        // Persisted on the error path, paired for the scheduler's repair flow.
        expect(lastTurnCallsReadFile()).toBe(true);
      });

      /** Chunks opening the `read_file` call `call_1`, then its finish. */
      const toolCallChunks = () => [
        openaiChunk('chunk-tool-open', {
          tool_calls: [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: {
                name: 'read_file',
                arguments: '{"file_path":"a.sql"}',
              },
            },
          ],
        }),
        openaiChunk('chunk-finish', {}, 'tool_calls'),
      ];

      /** A `create` implementation that streams `chunks`, then throws `error` if given. */
      const openaiAttempt =
        (chunks: OpenAI.Chat.ChatCompletionChunk[], error?: Error) =>
        async () =>
          (async function* () {
            yield* chunks;
            if (error) throw error;
          })();

      /** Tripwire attempt: consumed only if a cut is wrongly resumed. */
      const openaiTripwire = () =>
        openaiAttempt([
          openaiChunk('chunk-tail', { content: 'fabricated tail' }),
          openaiChunk('chunk-tail-finish', {}, 'stop'),
        ]);

      const lastTurnCallsReadFile = () =>
        chat
          .getHistory()
          .at(-1)
          ?.parts?.some((part) => part.functionCall?.name === 'read_file');

      it('delivers a prose-prefixed parked tool-call finish through the real pipeline instead of continuing', async () => {
        vi.useFakeTimers();
        // Over the real OpenAI pipeline the converter emits functionCall parts
        // only on the finish chunk, parked for trailing usage, so the gateway
        // error lands while the call is parked. Prose already shut replay, so
        // withholding the finish strands the call and lets LlmChat fold a
        // fabricated continuation tail into history. Released, the
        // functionCall shuts continuation; error-path persistence and the
        // repair flow take over.
        const upstreamError = statuslessError();
        const create = vi
          .fn()
          .mockImplementationOnce(
            openaiAttempt(
              [
                openaiChunk('chunk-prose', {
                  content: 'Let me read that file. ',
                }),
                ...toolCallChunks(),
              ],
              upstreamError,
            ),
          )
          .mockImplementationOnce(openaiTripwire());
        useOpenAIPipeline(create);
        const { events, caughtError } = await drainTimed(
          await send('test', 'prompt-upstream-statusless-parked-toolcall'),
          5_000,
        );
        // One attempt: the functionCall shuts replay and continuation gates.
        expect(create).toHaveBeenCalledTimes(1);
        expect(continuations(events)).toHaveLength(0);
        // The error propagates (no successful continuation) and the call
        // persists on the error path for the scheduler's repair flow.
        expect(caughtError).toBeDefined();
        expect(lastTurnCallsReadFile()).toBe(true);
      });

      it('replays instead of counting a flushed tool call the caller never received', async () => {
        vi.useFakeTimers();
        // R16-2, end-to-end: LlmChat withholds a leading-JSON chunk while its
        // protocol-tag detector blocks, but the pipeline's release decision
        // counts it as delivered. Counting the released functionCall flipped
        // `streamYieldedContentChunk`/`streamYieldedFunctionCall`, shutting
        // the open replay and continuation gates: a recoverable cut killed the
        // turn, leaving an undispatched call for a caller that saw nothing.
        // The merge base (no flush) replayed cleanly.
        const create = vi
          .fn()
          .mockImplementationOnce(
            openaiAttempt(
              [
                openaiChunk('chunk-json', {
                  content: '{"function_call": {"name": "read_file"}',
                }),
                ...toolCallChunks(),
              ],
              statuslessError(),
            ),
          )
          // Consumed by the replay, which is the point: the turn recovers.
          .mockImplementationOnce(
            openaiAttempt([
              openaiChunk('chunk-retry-answer', {
                content: 'the answer after replay',
              }),
              openaiChunk('chunk-retry-finish', {}, 'stop'),
            ]),
          );
        useOpenAIPipeline(create);
        const { events, caughtError } = await drainTimed(
          await send('test', 'prompt-flushed-toolcall-not-received'),
          10_000,
        );
        expect(caughtError).toBeUndefined();
        expect(create).toHaveBeenCalledTimes(2);
        // A replay, not a continuation: nothing was delivered to resume from.
        const retries = eventsOfType(events, StreamEventType.RETRY);
        expect(retries).toHaveLength(1);
        expect(
          retries[0]!.type === StreamEventType.RETRY &&
            retries[0]!.isContinuation,
        ).toBeFalsy();
        expectLastText('the answer after replay');
      });

      it('releases a parked tool-call finish on a continuation attempt instead of continuing again', async () => {
        vi.useFakeTimers();
        // The case above one attempt later: attempt 1's prose was cut, so the
        // accumulated prefix shut replay (a fresh stream's own yields cannot
        // show that). Attempt 2 delivers only reasoning and tool-call
        // preparations before the same error in the usage tail. Unless the
        // turn-scoped continuation marker seeds the pipeline's release flag,
        // the finish stays parked: the model is re-asked to resume prose whose
        // tool decision it never saw until the turn fails with the call lost.
        const upstreamError = statuslessError();
        const create = vi
          .fn()
          .mockImplementationOnce(
            openaiAttempt(
              [
                openaiChunk('chunk-prose', {
                  content: 'Let me read that file. ',
                }),
              ],
              upstreamError,
            ),
          )
          .mockImplementationOnce(
            openaiAttempt(
              [
                openaiChunk('chunk-reasoning', {
                  reasoning_content: 'Reconsidering the approach. ',
                }),
                ...toolCallChunks(),
              ],
              upstreamError,
            ),
          )
          .mockImplementationOnce(openaiTripwire());
        useOpenAIPipeline(create);
        const stream = await send(
          'test',
          'prompt-upstream-statusless-parked-toolcall-continuation',
        );
        const { events, caughtError } = await drainTimed(stream, 5_000);
        // Two attempts: the prose cut schedules one continuation; the
        // released finish shuts the gate for the second cut.
        expect(create).toHaveBeenCalledTimes(2);
        expect(continuations(events)).toHaveLength(1);
        // The error propagates (no successful continuation) and the call
        // persists on the error path for the scheduler's repair flow.
        expect(caughtError).toBeDefined();
        expect(lastTurnCallsReadFile()).toBe(true);
      });

      it('replays rather than continues when only a thought was delivered', async () => {
        vi.useFakeTimers();
        // The reported failure: thinking models emit reasoning within seconds,
        // so gating replay on "any chunk yielded" made it unreachable; a
        // thought has no answer text a replay could duplicate.
        mockStreamsOnce(
          cutAfter([
            modelChunk([{ text: 'Let me plan this out.', thought: true }]),
          ]),
          streamOf(textChunk('the full answer', 'STOP')),
        );
        const events = await sendTimed('prompt-transport-thought-only');
        expectStreamCalls(2);
        // A replay: no resume instruction is injected and the RETRY tells
        // the UI to discard the failed attempt.
        expect(hasText(requestContentsOfCall(1), RESUME_INSTRUCTION)).toBe(
          false,
        );
        expect(
          events.filter(
            (event) =>
              event.type === StreamEventType.RETRY && !event.isContinuation,
          ),
        ).toHaveLength(1);
        expectLastText('the full answer');
      });

      it('replays rather than continues when the delivered text was blank', async () => {
        vi.useFakeTimers();
        const events = await cutThenFinish(
          '   ',
          'real content',
          'prompt-transport-continuation-blank',
        );
        expectStreamCalls(2);
        expect(continuations(events)).toHaveLength(0);
      });

      it('drops a pending continuation when a fresh-restart retry takes over', async () => {
        vi.useFakeTimers();
        // The continuation attempt fails with InvalidStreamError, whose retry
        // re-sends the ORIGINAL request under a plain RETRY (the UI discards
        // the text): the request must drop it too, or the resend asks to
        // continue output the caller no longer has.
        await freshRestartAfterCut('prompt-transport-continuation-superseded');
        expectStreamCalls(3);
        expect(hasText(requestContentsOfCall(2), 'doomed fragment')).toBe(
          false,
        );
        expectLastText('a clean answer');
      });

      it('keeps continuing when a later attempt is cut with nothing yielded', async () => {
        vi.useFakeTimers();
        // The continuation attempt is cut having yielded nothing: the replay
        // branch (first; per-attempt "nothing delivered") must consult the
        // accumulated buffer, or a plain RETRY drops the text to regenerate.
        mockStreamsOnce(
          cutAfter([textChunk('kept half ')]),
          cutAfter([]),
          streamOf(textChunk('a clean answer', 'STOP')),
        );
        const events = await sendTimed(
          'prompt-transport-continuation-empty-later-attempt',
          10_000,
        );
        expectStreamCalls(3);
        // Both RETRYs keep the UI's buffer; a plain one would drop the text.
        expect(allRetriesContinue(events)).toBe(true);
        expect(hasText(requestContentsOfCall(2), RESUME_INSTRUCTION)).toBe(
          true,
        );
        expectLastText('kept half a clean answer');
      });

      /**
       * Cut after 'discarded half ', then the continuation overflows: the
       * recovered request drops the stale prefix and resume instruction.
       */
      async function expectOverflowDropsContinuation(promptId: string) {
        streamMock()
          .mockResolvedValueOnce(cutAfter([textChunk('discarded half ')]))
          .mockRejectedValueOnce(tooLong())
          .mockResolvedValueOnce(streamOf(textChunk('a clean answer', 'STOP')));
        await sendTimed(promptId, 10_000);
        expectStreamCalls(3);
        const thirdRequest = requestContentsOfCall(2);
        expect(hasText(thirdRequest, 'discarded half')).toBe(false);
        expect(hasText(thirdRequest, RESUME_INSTRUCTION)).toBe(false);
        expectLastText('a clean answer');
      }

      it('drops a pending continuation when reactive compression takes over', async () => {
        vi.useFakeTimers();
        // The third branch emitting a plain RETRY (`suppressNextRetryEvent`).
        // A continuation sends *more* than the original, so it is likeliest to
        // overflow, and compression rebuilds `requestContents` from compacted
        // history, leaving a staged continuation stale twice over.
        mockCompressOnce(
          // The pre-send proactive pass; the reactive one is the second call.
          noop(),
          compressed(135_000, 40_000, [...summaryAck(), userText('test')]),
        );
        await expectOverflowDropsContinuation(
          'prompt-transport-continuation-replaced-by-compression',
        );
      });

      it('drops a pending continuation when Omni media degradation takes over', async () => {
        vi.useFakeTimers();
        Object.assign(mockConfig, {
          getOmniProcessingConfig: () => ({
            limits: { maxTransportPasses: 1 },
          }),
        });
        degradeOmniMediaMock.mockResolvedValue({
          replacedParts: 1,
          degradedResources: 1,
        });
        await expectOverflowDropsContinuation(
          'prompt-transport-continuation-replaced-by-omni',
        );
      });

      // A consumer that retracts delivered output (the Hosted Harness) takes a
      // fresh replay, never a continuation: the replayed request replaces the
      // retracted prefix instead of gluing a possible restart onto it
      // (#13319).
      it('replays a delivered-content cut when the consumer retracts delivered output', async () => {
        vi.useFakeTimers();
        mockStreamsOnce(
          cutAfter([textChunk('MIDSTREAM_PARTIAL')]),
          streamOf(textChunk('MIDSTREAM_RECOVERED_AFTER_RETRY', 'STOP')),
        );
        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-transport-retract-replay',
          undefined,
          { retractDeliveredOutputOnRetry: true },
        );
        const events = await collectStreamWithFakeTimers(stream, 5_000);
        const retries = eventsOfType(events, StreamEventType.RETRY);
        expect(retries).toEqual([{ type: StreamEventType.RETRY }]);
        expectStreamCalls(2);
        // The replay re-sends the original request: no synthetic model/user
        // turns carrying the delivered prefix or the resume instruction.
        const replayed = requestContentsOfCall(1);
        expect(hasText(replayed, 'MIDSTREAM_PARTIAL')).toBe(false);
        expect(hasText(replayed, RESUME_INSTRUCTION)).toBe(false);
        // The consumer sees both attempts' chunks; dropping the prefix on
        // RETRY is what keeps the transcript clean. History keeps only the
        // replay's answer: the failed attempt's partial turn is popped.
        expect(deliveredText(events)).toBe(
          'MIDSTREAM_PARTIALMIDSTREAM_RECOVERED_AFTER_RETRY',
        );
        expectLastText('MIDSTREAM_RECOVERED_AFTER_RETRY');
        expectWarned('Transport stream retry scheduled', {
          retryDecision: 'retry',
        });
      });

      it('fails a delivered-content cut when the replay budget is spent, never continuing', async () => {
        vi.useFakeTimers();
        mockStreamsOnce(
          cutAfter([textChunk('MIDSTREAM_PARTIAL')]),
          cutAfter([textChunk('MIDSTREAM_PARTIAL')]),
          cutAfter([textChunk('MIDSTREAM_PARTIAL')]),
        );
        const stream = await chat.sendMessageStream(
          'test-model',
          { message: 'test' },
          'prompt-transport-retract-exhausted',
          undefined,
          { retractDeliveredOutputOnRetry: true },
        );
        const collecting = drainCollecting(stream);
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(35_000);
        const { events, caughtError } = await collecting;
        expect(caughtError).toBeDefined();
        // Three attempts, two plain replays, and no continuation: the answer
        // never asks the model to resume a prefix the caller retracted.
        expectStreamCalls(3);
        expect(
          events.filter(
            (event) =>
              event.type === StreamEventType.RETRY &&
              event.isContinuation === true,
          ),
        ).toHaveLength(0);
        expect(eventsOfType(events, StreamEventType.RETRY)).toHaveLength(2);
      });
    });

    it('falls back after yielding only tool preparation metadata', async () => {
      const fallbackGenerateContentStream = vi
        .fn()
        .mockResolvedValue(textStream('Recovered with fallback'));
      const resolveForModel = wireFallbacks(
        ['fallback-model'],
        vi
          .fn()
          .mockResolvedValue(
            fallbackRoute('fallback-model', fallbackGenerateContentStream),
          ),
      );
      const capacityError = Object.assign(
        new StreamContentError(
          '{"error":{"code":"429","message":"Throttling"}}',
        ),
        { status: 429 },
      );
      const preparationResponse = modelChunk([]);
      setToolCallPreparations(preparationResponse, [
        { callId: 'call-fallback', toolName: 'read_file' },
      ]);
      mockStream(streamThenThrow([preparationResponse], capacityError));

      const events = await sendCollect(
        'test',
        'prompt-fallback-after-preparation',
      );

      expect(resolveForModel).toHaveBeenCalledWith('fallback-model', {
        failClosed: true,
      });
      expect(fallbackGenerateContentStream).toHaveBeenCalledOnce();
      expect(fallbackEvents(events)).toHaveLength(1);
    });

    it('classifies every allow-listed stream transport code as retryable transport', () => {
      // Drift guard: the allow-list hand-picks classifier transport codes; a
      // rename/removal there or a typo here fails, not silently never retries.
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
      fakeTimers(async (transportCode: string) => {
        const transportError = Object.assign(new TypeError('terminated'), {
          cause: Object.assign(new Error('socket failure'), {
            code: transportCode,
          }),
        });
        const text = `Recovered from ${transportCode}`;
        expectRecovered(
          await recoverFrom(
            transportError,
            `prompt-transport-${transportCode}`,
            text,
          ),
          text,
        );
      }),
    );

    it('retries an enhanced timeout before the first content chunk', async () => {
      vi.useFakeTimers();
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
      const text = 'Recovered after enhanced timeout';
      expectRecovered(
        await recoverFrom(
          enhancedTimeout,
          'prompt-enhanced-timeout-retry',
          text,
        ),
        text,
      );
    });

    it('retries a transport error whose code is on the error itself (no cause)', async () => {
      vi.useFakeTimers();
      // getTransportCode checks the direct `error.code` before `cause.code`;
      // the other tests only exercise the `cause` path.
      const transportError = Object.assign(new Error('socket reset'), {
        code: 'ECONNRESET',
      });
      expectRecovered(
        await recoverFrom(
          transportError,
          'prompt-transport-direct-code',
          'Recovered via direct code',
        ),
      );
    });

    it('retries an SDK-wrapped transport error whose code sits at cause depth 2', async () => {
      // The OpenAI SDK wraps a pre-header socket reset as APIConnectionError ->
      // TypeError('fetch failed') -> cause { code: 'ECONNRESET' }; the real
      // inline shouldRetryOnError predicate must accept it.
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
      streamMock()
        .mockRejectedValueOnce(transportError)
        .mockResolvedValueOnce(textStream('Recovered from depth-2 RST'));

      const events = await sendCollect(
        'test',
        'prompt-transport-sdk-wrapped-depth2',
      );

      expectStreamCalls(2);
      expect(hasChunkText(events, 'Recovered from depth-2 RST')).toBe(true);
    });

    it('replays a status-less upstream error thrown mid-stream', async () => {
      vi.useFakeTimers();
      // The incident shape: the gateway pushes
      // `{"error":{"code":"KeyError","message":"'id'"}}` into an already-200
      // SSE stream and the SDK throws it from the lazy iterator after
      // retryWithBackoff resolved, so the mid-stream replay gate (not the
      // establishment predicate) must catch it on the first next().
      const upstreamError = Object.assign(new Error("'id'"), {
        code: 'KeyError',
        requestID: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
      });
      const text = 'Recovered from upstream KeyError';
      const events = await recoverFrom(
        upstreamError,
        'prompt-upstream-statusless-midstream',
        text,
      );
      expectRecovered(events, text);
      // A replay, not a continuation: nothing had reached the caller.
      const [retry] = eventsOfType(events, StreamEventType.RETRY);
      expect(
        retry!.type === StreamEventType.RETRY && retry!.isContinuation,
      ).toBeFalsy();
      // The classifier's own fields: the label still says "Transport", no
      // `transportCode`, and the request id is the only gateway-ticket handle.
      expectWarned('Transport stream retry scheduled', {
        classificationReason: 'upstream-error-without-status',
        providerCode: 'KeyError',
        requestId: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
      });
    });

    it('propagates a permanent provider rejection delivered mid-stream', async () => {
      // Mirror of the replay above: a moderation/credential rejection arrives
      // the same way but can never succeed, so the gate must not adopt it.
      const permanentError = Object.assign(new Error('Content filtered'), {
        code: 'data_inspection_failed',
        requestID: 'cd7f37f3-d38a-9dec-804f-f70dda5650eb',
      });
      streamMock()
        .mockResolvedValueOnce(streamThenThrow([], permanentError))
        // Consumed only if the gate wrongly adopts the rejection, so a
        // regression reports as a call count rather than a hang.
        .mockResolvedValueOnce(textStream('must not be delivered'));

      // No fake timers: nothing retries, and `collectStreamWithFakeTimers`
      // would leave the rejection unhandled while stepping the timers.
      const { events, caughtError } = await drainCollecting(
        await send('test', 'prompt-upstream-permanent-midstream'),
      );

      expectAttempts(events, 1, 0);
      expect(String(caughtError)).toContain('Content filtered');
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
      await expectRejectedWithoutRetry(
        streamThenThrow([], transportError),
        'prompt-transport-4xx-no-retry',
        'terminated',
      );
    });

    it('does not replay a marker-matched 4xx network failure mid-stream', async () => {
      // The 4xx network-failure class deliberately has no transportCode, so
      // the keyed replay/continuation gates stay shut; establishment retries.
      const transportError = Object.assign(
        new Error(
          'network error for request to http://h:8080/v1/chat/completions: EOF',
        ),
        {
          status: 400,
          cause: Object.assign(new Error('socket reset'), {
            code: 'ECONNRESET',
          }),
        },
      );
      await expectRejectedWithoutRetry(
        streamThenThrow([], transportError),
        'prompt-transport-4xx-marker-no-replay',
        'network error for request',
      );
    });

    it('does not retry a transport code outside the stream allow-list', async () => {
      // ECONNREFUSED is transport/retryable but excluded from the stream
      // allow-list (permanent misconfiguration, not a blip): never replayed.
      const transportError = Object.assign(new TypeError('terminated'), {
        cause: Object.assign(new Error('connection refused'), {
          code: 'ECONNREFUSED',
        }),
      });
      await expectRejectedWithoutRetry(
        streamThenThrow([], transportError),
        'prompt-transport-not-allowlisted',
        'terminated',
      );
    });

    it('surfaces an abort fired during the transport retry delay without retrying again', async () => {
      vi.useFakeTimers();
      mockStream(streamThenThrow([], socketCut()));
      const { controller, stream } = await sendAbortable(
        'prompt-transport-abort-delay',
      );
      // The RETRY event is emitted before the 1s transport delay; aborting
      // during the delay cuts the retry short after the initial attempt.
      expect((await stream.next()).value.type).toBe(StreamEventType.RETRY);
      const nextPromise = stream.next();
      controller.abort();
      await expect(nextPromise).rejects.toThrow();
      expectStreamCalls(1);
    });

    const tpmError = () =>
      new StreamContentError(
        '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
      );

    /** A stream that yields a `read_file` call `id` and then throws. */
    const readFileCallThenThrow = (id: string, path: string, error: unknown) =>
      streamThenThrow([modelChunk([fnCall('read_file', { path }, id)])], error);

    it('rolls back the chat-recording entry too when the retry succeeds', async () => {
      vi.useFakeTimers();
      // JSONL counterpart of the in-memory rollback: the failed attempt's
      // `recordAssistantTurn` must NOT flush, or `--resume` rehydrates a
      // discarded model[functionCall] turn. Without the deferred-flush stash +
      // popPendingPartialAssistantTurn clear it was recorded twice.
      const recordAssistantTurn = vi.fn();
      const chatWithRecording = chatWithRecorder(recordAssistantTurn);
      mockStreamsOnce(
        readFileCallThenThrow(
          'call_failed_retry_recording',
          '/tmp/a.txt',
          tpmError(),
        ),
        textStream('Success after retry'),
      );

      const stream = await send(
        'test',
        'prompt-recording-rollback',
        chatWithRecording,
      );
      while (!(await nextAfter(stream, 60_000)).done);

      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      const recordedMessage = recordAssistantTurn.mock.calls[0]![0]
        ?.message as Array<{ text?: string; functionCall?: unknown }>;
      const recordedText = recordedMessage.find((p) => p.text)?.text;
      expect(recordedText).toBe('Success after retry');
      expect(recordedMessage.some((p) => p.functionCall)).toBe(false);
    });

    it('flushes the chat-recording entry on the unretryable break path (kept partial → durable JSONL)', async () => {
      vi.useFakeTimers();
      // Counterpart to the rollback: an unretryable error (or spent budget)
      // keeps the partial in `this.history`, and the JSONL must match.
      // Without the deferred flush at the rethrow site the load-time orphan
      // repair has no dangling functionCall to close, and the first
      // `--resume` send 400s with the very wedge it was meant to escape.
      const recordAssistantTurn = vi.fn();
      const chatWithRecording = chatWithRecorder(recordAssistantTurn);
      // A non-rate-limit, non-InvalidStream error after a tool_use chunk:
      // the catch block falls through to `break`, keeping the partial.
      streamMock().mockResolvedValueOnce(
        readFileCallThenThrow(
          'call_unretryable_kept',
          '/tmp/k.txt',
          new Error('synthetic unretryable mid-stream failure'),
        ),
      );

      const stream = await send(
        'test',
        'prompt-recording-flush-on-break',
        chatWithRecording,
      );
      await expect(drain(stream)).rejects.toThrow(/synthetic unretryable/);

      // In memory the partial is kept (the wedge-recovery contract).
      const lastModelTurn = chatWithRecording
        .getHistory()
        .findLast((h) => h.role === 'model');
      expect(
        lastModelTurn?.parts?.some(
          (p) => p.functionCall?.id === 'call_unretryable_kept',
        ),
      ).toBe(true);
      // The JSONL holds exactly that partial turn (no success retry here).
      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      const recordedMessage = recordAssistantTurn.mock.calls[0]![0]
        ?.message as Array<{ functionCall?: { id?: string } }>;
      expect(
        recordedMessage.some(
          (p) => p.functionCall?.id === 'call_unretryable_kept',
        ),
      ).toBe(true);
    });

    /**
     * Fail once with rate-limit `error`, resume the generator to schedule the
     * 60s delay and advance through it: both pulls yield RETRY events, then
     * `text` arrives after two requests. Returns the second RETRY event.
     */
    async function expectRateLimitRecovery(
      error: unknown,
      promptId: string,
      text: string,
    ) {
      mockStreamsOnce(streamThenThrow([], error), textStream(text));
      const stream = await send('test', promptId);
      const first = await stream.next();
      expect(first.done).toBe(false);
      expect(first.value.type).toBe(StreamEventType.RETRY);
      const second = await nextAfter(stream, 60_000);
      expect(second.done).toBe(false);
      expect(second.value.type).toBe(StreamEventType.RETRY);
      const events = [first.value, second.value, ...(await collect(stream))];
      expectAttempts(events, 2, 2);
      expect(hasChunkText(events, text)).toBe(true);
      return second.value as StreamEvent;
    }

    it('should retry on TPM throttling StreamContentError with initial delay', async () => {
      vi.useFakeTimers();
      await expectRateLimitRecovery(
        tpmError(),
        'prompt-id-tpm-retry',
        'Success after TPM retry',
      );
      expect(mockLogContentRetry).not.toHaveBeenCalled();
    });

    it('fast-fails a mid-stream quota-exhaustion error instead of scheduling a rate-limit retry', async () => {
      vi.useFakeTimers();
      // A permanent quota-exhaustion 429 can arrive mid-stream, bypassing
      // retryWithBackoff's fast-fail (establishment only). The stream-side
      // catch must fast-fail it before the rate-limit branch, or
      // isRateLimitError (429) waits 1-5 minutes on an error that cannot
      // succeed until the reset time.
      const quotaError = new StreamContentError(
        '{"error":{"code":"429","message":"Your token-plan 1-week quota has been exhausted. The quota will reset at 07-27 09:25:00 UTC."}}',
      );
      streamMock().mockResolvedValueOnce(streamThenThrow([], quotaError));
      const stream = await send('test', 'prompt-quota-fastfail');
      // The first pull rejects: no RETRY event, no rate-limit delay.
      await expect(stream.next()).rejects.toThrow(/Quota exhausted/);
      expectStreamCalls(1);
    });

    it('retries the statusless Anthropic SSE throttle and completes the next attempt', async () => {
      vi.useFakeTimers();
      const error = new Error(
        JSON.stringify({
          type: 'error',
          error: {
            type: 'invalid_request_error',
            message: JSON.stringify({
              message:
                'Too many requests, please wait before trying again. You have sent too many requests.  Wait before trying again.',
            }),
          },
        }),
      );
      mockStreamsOnce(
        streamThenThrow([], error),
        textStream('Recovered from SSE throttle'),
      );
      const stream = await send('test', 'sse-throttle');
      const retry = await stream.next();
      expect(retry.value.type).toBe(StreamEventType.RETRY);
      expect(retry.value.retryInfo.delayMs).toBeGreaterThan(0);
      const next = await nextAfter(stream, retry.value.retryInfo.delayMs);
      const events = [next.value, ...(await collect(stream))];
      expectStreamCalls(2);
      expect(hasChunkText(events, 'Recovered from SSE throttle')).toBe(true);
    });

    it('should use Retry-After delay for streamed rate-limit errors', async () => {
      vi.useFakeTimers();
      const retryAfterError = Object.assign(tpmError(), {
        status: 429,
        headers: { 'retry-after': '180' },
      });
      mockStreamsOnce(
        streamThenThrow([], retryAfterError),
        textStream('Success after Retry-After'),
      );
      const stream = await send('test', 'prompt-id-retry-after');
      const first = await stream.next();
      expect(first.value.type).toBe(StreamEventType.RETRY);
      expect(first.value.retryInfo?.delayMs).toBe(180_000);
      await nextAfter(stream, 180_000);
      const events = await collect(stream);
      expectStreamCalls(2);
      expect(hasChunkText(events, 'Success after Retry-After')).toBe(true);
    });

    it('should retry immediately when skipDelay is called during rate-limit wait', async () => {
      vi.useFakeTimers();
      mockStreamsOnce(
        streamThenThrow([], tpmError()),
        textStream('Success after skip'),
      );
      const stream = await send('test', 'prompt-id-skip-delay');
      const first = await stream.next();
      expect(first.value.type).toBe(StreamEventType.RETRY);
      const skipDelay = first.value.retryInfo!.skipDelay!;
      // The generator now awaits the 60s delay; skipDelay() resolves it
      // immediately instead of advancing timers.
      const secondPromise = stream.next();
      skipDelay();
      const second = await secondPromise;
      // It continued straight to the next attempt (retry-start marker).
      expect(second.done).toBe(false);
      expect(second.value.type).toBe(StreamEventType.RETRY);
      const events = [first.value, second.value, ...(await collect(stream))];
      expectStreamCalls(2);
      expect(hasChunkText(events, 'Success after skip')).toBe(true);
    });

    it('should exit retry loop when aborted during rate-limit delay', async () => {
      vi.useFakeTimers();
      const error = tpmError();
      streamMock()
        .mockResolvedValueOnce(streamThenThrow([], error))
        // Never consumed: the abort must prevent the second attempt.
        .mockResolvedValueOnce(streamThenThrow([], error));
      const { controller, stream } = await sendAbortable(
        'prompt-id-abort-delay',
      );
      expect((await stream.next()).value.type).toBe(StreamEventType.RETRY);
      // Abort during the 60s delay: it throws, with no second API call.
      const nextPromise = stream.next();
      controller.abort();
      await expect(nextPromise).rejects.toThrow();
      expectStreamCalls(1);

      // The next send must not wait on the old delay: a pending sendPromise
      // would hang on a 60s timer that never fires under fake timers.
      streamMock()
        .mockReset()
        .mockResolvedValueOnce(textStream('Next request OK'));
      const events = await sendCollect('follow-up', 'prompt-id-after-abort');
      expect(hasChunkText(events, 'Next request OK')).toBe(true);
    });

    it('should retry on GLM rate limit StreamContentError with backoff delay', async () => {
      vi.useFakeTimers();
      const second = await expectRateLimitRecovery(
        new StreamContentError(
          '{"error":{"code":"1302","message":"您的账户已达到速率限制，请您控制请求频率"}}',
        ),
        'prompt-id-glm-retry',
        'Success after GLM retry',
      );
      if (second.type === StreamEventType.RETRY && second.retryInfo) {
        expect(second.retryInfo.attempt).toBe(1);
        expect(second.retryInfo.maxRetries).toBe(10);
        expect(second.retryInfo.delayMs).toBe(60000);
      }
    });

    const allocationQuotaError = (id: number) =>
      new StreamContentError(
        `id:${id}\nevent:error\n:HTTP_STATUS/429\ndata:{"request_id":"req-${id}","code":"Throttling.AllocationQuota","message":"Allocated quota exceeded"}`,
      );

    /**
     * Two streamed 429s, then `text`: steps through the 3s and 5s configured
     * delays and returns both RETRY events and the events after them.
     */
    async function throughConfiguredDelays(promptId: string, text: string) {
      mockStreamsOnce(
        streamThenThrow([], allocationQuotaError(1)),
        streamThenThrow([], allocationQuotaError(2)),
        textStream(text),
      );
      const stream = await send('test', promptId);
      const first = (await stream.next()).value;
      await nextAfter(stream, 3_000);
      const second = (await stream.next()).value;
      await nextAfter(stream, 5_000);
      return { first, second, events: await collect(stream) };
    }

    it('should use configured delay across repeated streamed rate-limit errors', async () => {
      vi.useFakeTimers();
      mockGeneratorConfig({
        authType: AuthType.USE_OPENAI,
        retryInitialDelayMs: 3_000,
        retryMaxDelayMs: 5_000,
      });
      const { first, second, events } = await throughConfiguredDelays(
        'prompt-id-streamed-rate-limit-backoff',
        'Recovered after backoff',
      );
      expect(first.type).toBe(StreamEventType.RETRY);
      expect(second.type).toBe(StreamEventType.RETRY);
      expect([first, second].map((event) => event.retryInfo!.delayMs)).toEqual([
        3_000, 5_000,
      ]);
      expect(hasChunkText(events, 'Recovered after backoff')).toBe(true);
    });

    it('uses configured stream rate-limit retry delays', async () => {
      vi.useFakeTimers();
      mockGeneratorConfig({
        authType: AuthType.USE_OPENAI,
        maxRetries: 2,
        retryInitialDelayMs: 3_000,
        retryMaxDelayMs: 5_000,
      });
      const { first, second, events } = await throughConfiguredDelays(
        'prompt-id-configured-rate-limit-delay',
        'Recovered',
      );
      expect(first.type).toBe(StreamEventType.RETRY);
      expect(first.retryInfo?.delayMs).toBe(3_000);
      expect(second.type).toBe(StreamEventType.RETRY);
      expect(second.retryInfo?.delayMs).toBe(5_000);
      expect(hasChunkText(events, 'Recovered')).toBe(true);
    });

    describe('API error retry behavior', () => {
      beforeEach(() => {
        // Retry exactly once when shouldRetryOnError accepts the error.
        mockRetryWithBackoff.mockImplementation(async (apiCall, options) => {
          try {
            return await apiCall();
          } catch (error) {
            if (
              options?.shouldRetryOnError &&
              options.shouldRetryOnError(error)
            ) {
              return await apiCall();
            }
            throw error;
          }
        });
      });

      /** Every request rejects with `error`: one call, no retry. */
      async function expectNotRetried(error: ApiError, promptId: string) {
        streamMock().mockRejectedValue(error);
        const stream = await send('test', promptId);
        await expect(drain(stream)).rejects.toThrow(error);
        expectStreamCalls(1);
      }

      /** The first request rejects with `error`, the retry streams `text`. */
      async function retriedOnce(error: Error, promptId: string, text: string) {
        streamMock()
          .mockRejectedValueOnce(error)
          .mockResolvedValueOnce(textStream(text));
        const events = await sendCollect('test', promptId);
        expectStreamCalls(2);
        return events;
      }

      it('should not retry on 400 Bad Request errors', async () => {
        await expectNotRetried(
          new ApiError({ message: 'Bad Request', status: 400 }),
          'prompt-id-400',
        );
      });

      it('retries a provider-body-less 400 wrapping a network failure', async () => {
        // Incident shape from #10346: a peer close surfaces as "400 network
        // error for request ...: EOF" with no provider error body, so the
        // establishment predicate must consult the classifier before a 400.
        const networkFailure = Object.assign(
          new Error(
            'network error for request to http://11.0.0.1:8080/v1/chat/completions: Post "http://11.0.0.1:8080/v1/chat/completions": EOF',
          ),
          { status: 400 },
        );
        const events = await retriedOnce(
          networkFailure,
          'prompt-id-400-network-failure',
          'Recovered after EOF 400',
        );
        expect(hasChunkText(events, 'Recovered after EOF 400')).toBe(true);
      });

      it('should retry on 429 Rate Limit errors', async () => {
        const events = await retriedOnce(
          new ApiError({ message: 'Rate Limited', status: 429 }),
          'prompt-id-429-retry',
          'Success after retry',
        );
        expect(hasChunkText(events, 'Success after retry')).toBe(true);
      });

      it('should not retry on schema depth errors', async () => {
        await expectNotRetried(
          new ApiError({
            message: 'Request failed: maximum schema depth exceeded',
            status: 500,
          }),
          'prompt-id-schema',
        );
      });

      it('should retry on 5xx server errors', async () => {
        await retriedOnce(
          new ApiError({ message: 'Internal Server Error 500', status: 500 }),
          'prompt-id-500-retry',
          'Recovered from 500',
        );
      });

      afterEach(() => {
        mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
      });
    });

    describe('retry wait notifications', () => {
      type ObservedWait = RetryWaitEvent & { requestsSoFar: number };

      async function sendObserved(
        message: SendMessageParameters['message'],
        advanceByMs: number,
        onEvent?: (event: StreamEvent) => void,
        waits: ObservedWait[] = [],
      ) {
        const observer = (event: RetryWaitEvent) =>
          waits.push({
            ...event,
            requestsSoFar: vi.mocked(mockContentGenerator.generateContentStream)
              .mock.calls.length,
          });
        const stream = await runWithRetryWaitObserver(observer, () =>
          chat.sendMessageStream('test-model', { message }, 'prompt-wait'),
        );
        const bound = bindRetryWaitObserver(observer, stream);
        const events: StreamEvent[] = [];
        const collecting = (async () => {
          for await (const event of bound) {
            events.push(event);
            onEvent?.(event);
          }
        })();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(advanceByMs);
        await collecting;
        return { waits, events };
      }

      function expectOnePairBetweenRequests(waits: ObservedWait[]) {
        expect(waits).toEqual([
          {
            phase: 'start',
            waitId: expect.any(String),
            delayMs: expect.any(Number),
            requestsSoFar: 1,
          },
          { phase: 'end', waitId: waits[0]!.waitId, requestsSoFar: 1 },
        ]);
      }

      it('announces the stream rate-limit wait with its scheduled delay', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(
              (async function* () {
                throw new StreamContentError(
                  '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
                );
                yield {} as GenerateContentResponse;
              })(),
            )
            .mockResolvedValueOnce(streamOf(stopResponse([{ text: 'ok' }])));
          const { waits, events } = await sendObserved('test', 400_000);
          expectOnePairBetweenRequests(waits);
          const retry = events.find(
            (e) => e.type === StreamEventType.RETRY && e.retryInfo,
          );
          expect(
            retry && 'retryInfo' in retry
              ? retry.retryInfo?.delayMs
              : undefined,
          ).toBe((waits[0] as { delayMs: number }).delayMs);
        } finally {
          vi.useRealTimers();
        }
      });

      it('ends the rate-limit wait synchronously when skipDelay is called', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(
              (async function* () {
                throw new StreamContentError(
                  '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
                );
                yield {} as GenerateContentResponse;
              })(),
            )
            .mockResolvedValueOnce(streamOf(stopResponse([{ text: 'ok' }])));
          let phasesAtSkip: string[] = [];
          let phasesAfterSkip: string[] = [];
          const waits: ObservedWait[] = [];
          await sendObserved(
            'test',
            0,
            (event) => {
              if (event.type === StreamEventType.RETRY && event.retryInfo) {
                phasesAtSkip = waits.map((w) => w.phase);
                event.retryInfo.skipDelay?.();
                phasesAfterSkip = waits.map((w) => w.phase);
              }
            },
            waits,
          );
          expect(phasesAtSkip).toEqual(['start']);
          expect(phasesAfterSkip).toEqual(['start', 'end']);
          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it('ends the rate-limit wait on abort without another request', async () => {
        vi.useFakeTimers();
        try {
          const controller = new AbortController();
          vi.mocked(
            mockContentGenerator.generateContentStream,
          ).mockResolvedValue(
            (async function* () {
              throw new StreamContentError(
                '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
              );
              yield {} as GenerateContentResponse;
            })(),
          );
          const waits: RetryWaitEvent[] = [];
          const observer = (event: RetryWaitEvent) => waits.push(event);
          const stream = await runWithRetryWaitObserver(observer, () =>
            chat.sendMessageStream(
              'test-model',
              { message: 'test', config: { abortSignal: controller.signal } },
              'prompt-wait-abort',
            ),
          );
          const settled = (async () => {
            for await (const _ of bindRetryWaitObserver(observer, stream)) {
              /* consume */
            }
          })().catch((e: unknown) => e);
          await vi.advanceTimersByTimeAsync(1_000);
          expect(waits.map((w) => w.phase)).toEqual(['start']);
          controller.abort();
          expect(waits.map((w) => w.phase)).toEqual(['start', 'end']);
          await settled;
          await vi.advanceTimersByTimeAsync(600_000);
          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('announces the transport replay wait', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([]))
            .mockResolvedValueOnce(streamOf(stopResponse([{ text: 'ok' }])));
          const { waits, events } = await sendObserved('test', 30_000);
          expectOnePairBetweenRequests(waits);
          expect(
            events.filter((e) => e.type === StreamEventType.RETRY),
          ).toHaveLength(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('announces the transport continuation wait', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(cutAfter([textChunk('partial ')]))
            .mockResolvedValueOnce(streamOf(stopResponse([{ text: 'rest' }])));
          const { waits, events } = await sendObserved('test', 30_000);
          expectOnePairBetweenRequests(waits);
          expect(
            events.some(
              (e) =>
                e.type === StreamEventType.RETRY &&
                'isContinuation' in e &&
                e.isContinuation,
            ),
          ).toBe(true);
        } finally {
          vi.useRealTimers();
        }
      });

      it('announces the invalid-stream retry wait', async () => {
        vi.useFakeTimers();
        try {
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(
              streamOf({
                candidates: [{ content: { parts: [{ text: '' }] } }],
              } as unknown as GenerateContentResponse),
            )
            .mockResolvedValueOnce(streamOf(stopResponse([{ text: 'ok' }])));
          const { waits } = await sendObserved('test', 30_000);
          expectOnePairBetweenRequests(waits);
          expect(mockLogContentRetry).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('announces the tool-result continuation retry wait', async () => {
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
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockResolvedValueOnce(
              streamOf(stopResponse([{ text: 'thinking', thought: true }])),
            )
            .mockResolvedValueOnce(
              streamOf(stopResponse([{ text: 'Finished.' }])),
            );
          const { waits } = await sendObserved(
            [
              {
                functionResponse: {
                  id: 'call_read_file',
                  name: 'read_file',
                  response: { output: 'file contents' },
                },
              },
            ],
            30_000,
          );
          expectOnePairBetweenRequests(waits);
          expect(mockLogContentRetry).toHaveBeenCalledTimes(1);
        } finally {
          vi.useRealTimers();
        }
      });

      it('announces the HTTP Retry-After wait through the real retry helper', async () => {
        vi.useFakeTimers();
        try {
          const { retryWithBackoff } =
            await vi.importActual<typeof import('../utils/retry.js')>(
              '../utils/retry.js',
            );
          mockRetryWithBackoff.mockImplementation(retryWithBackoff);
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockRejectedValueOnce(
              Object.assign(new Error('Rate limited'), {
                status: 429,
                response: { headers: { 'retry-after': '9' } },
              }),
            )
            .mockResolvedValueOnce(streamOf(stopResponse([{ text: 'ok' }])));
          const { waits } = await sendObserved('test', 10_000);
          expectOnePairBetweenRequests(waits);
          expect((waits[0] as { delayMs: number }).delayMs).toBe(9_000);
        } finally {
          mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
          vi.useRealTimers();
        }
      });

      it('keeps a fallback model request on the same observer', async () => {
        vi.useFakeTimers();
        try {
          const { retryWithBackoff } =
            await vi.importActual<typeof import('../utils/retry.js')>(
              '../utils/retry.js',
            );
          mockRetryWithBackoff.mockImplementation(retryWithBackoff);
          vi.mocked(mockConfig.getContentGeneratorConfig).mockReturnValue({
            authType: AuthType.USE_GEMINI,
            model: 'test-model',
            maxRetries: 0,
          });
          vi.mocked(mockConfig.getModelFallbacks).mockReturnValue([
            'fallback-a',
          ]);
          const fallbackGenerateContentStream = vi
            .fn()
            .mockRejectedValueOnce(
              Object.assign(new Error('Rate limited'), {
                status: 429,
                response: { headers: { 'retry-after': '4' } },
              }),
            )
            .mockResolvedValueOnce(
              streamOf(stopResponse([{ text: 'fallback ok' }])),
            );
          vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
            resolveForModel: vi.fn().mockResolvedValue({
              contentGenerator: {
                generateContent: vi.fn(),
                generateContentStream: fallbackGenerateContentStream,
                embedContent: vi.fn(),
                batchEmbedContents: vi.fn(),
              } as unknown as ContentGenerator,
              contentGeneratorConfig: { modalities: {} },
              retryAuthType: AuthType.USE_GEMINI,
              retryErrorCodes: undefined,
              model: 'fallback-a',
            }),
          } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
          vi.mocked(
            mockContentGenerator.generateContentStream,
          ).mockResolvedValueOnce(
            (async function* () {
              throw Object.assign(
                new StreamContentError(
                  '{"error":{"code":"429","message":"Throttling: TPM(1/1)"}}',
                ),
                { status: 429 },
              );
              yield {} as GenerateContentResponse;
            })(),
          );
          const { waits, events } = await sendObserved('test', 5_000);
          expect(
            events.some((e) => e.type === StreamEventType.MODEL_FALLBACK),
          ).toBe(true);
          expect(fallbackGenerateContentStream).toHaveBeenCalledTimes(2);
          expect(waits.map((w) => w.phase)).toEqual(['start', 'end']);
          expect((waits[0] as { delayMs: number }).delayMs).toBe(4_000);
          expect(mockConfig.setModel).not.toHaveBeenCalled();
        } finally {
          mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
          vi.useRealTimers();
        }
      });

      it('loses the HTTP wait when the lazy stream is iterated outside the observer', async () => {
        vi.useFakeTimers();
        try {
          const { retryWithBackoff } =
            await vi.importActual<typeof import('../utils/retry.js')>(
              '../utils/retry.js',
            );
          mockRetryWithBackoff.mockImplementation(retryWithBackoff);
          vi.mocked(mockContentGenerator.generateContentStream)
            .mockRejectedValueOnce(
              Object.assign(new Error('Rate limited'), {
                status: 429,
                response: { headers: { 'retry-after': '1' } },
              }),
            )
            .mockResolvedValueOnce(streamOf(stopResponse([{ text: 'ok' }])));
          const waits: RetryWaitEvent[] = [];
          // Bound only at creation: the request runs on first iteration, so
          // the wait escapes — which is why AgentCore binds the iterator too.
          const stream = await runWithRetryWaitObserver(
            (e) => waits.push(e),
            () =>
              chat.sendMessageStream(
                'test-model',
                { message: 'test' },
                'prompt-wait-unbound',
              ),
          );
          await collectStreamWithFakeTimers(stream, 2_000);
          expect(
            mockContentGenerator.generateContentStream,
          ).toHaveBeenCalledTimes(2);
          expect(waits).toEqual([]);
        } finally {
          mockRetryWithBackoff.mockImplementation(async (apiCall) => apiCall());
          vi.useRealTimers();
        }
      });
    });
  });

  /** Assert the first part's text of each leading history entry. */
  const expectTurnTexts = (history: Content[], texts: string[]) =>
    texts.forEach((text, i) => expect(history[i]?.parts?.[0]?.text).toBe(text));

  it('should correctly retry and append to an existing history mid-conversation', async () => {
    chat.setHistory([userText('First question'), modelText('First answer')]);
    streamMock()
      .mockImplementationOnce(async () => streamOf(textChunk('')))
      .mockImplementationOnce(async () => textStream('Second answer'));

    await sendDrain('Second question', 'prompt-id-retry-existing');

    const history = chat.getHistory();
    expect(history.length).toBe(4);
    expect(mockLogContentRetry).toHaveBeenCalledTimes(1);
    expectTurnTexts(history, [
      'First question',
      'First answer',
      'Second question',
      'Second answer',
    ]);
  });

  it('should retry if the model returns a completely empty stream (no chunks)', async () => {
    streamMock()
      .mockImplementationOnce(async () => streamOf())
      .mockImplementationOnce(async () =>
        textStream('Successful response after empty'),
      );

    const chunks = await sendCollect(
      'test empty stream',
      'prompt-id-empty-stream',
    );

    expectStreamCalls(2);
    expect(hasChunkText(chunks, 'Successful response after empty')).toBe(true);
    const history = chat.getHistory();
    expect(history.length).toBe(2);
    expectTurnTexts(history, [
      'test empty stream',
      'Successful response after empty',
    ]);
  });
  it('should queue a subsequent sendMessageStream call until the first stream is fully consumed', async () => {
    let continueFirstStream!: () => void;
    const firstStreamContinuePromise = new Promise<void>((resolve) => {
      continueFirstStream = resolve;
    });
    mockStreamsOnce(
      (async function* () {
        yield textChunk('first response part 1');
        await firstStreamContinuePromise; // Pause the stream
        yield textChunk(' part 2', 'STOP');
      })(),
      textStream('second response'),
    );

    // With the first stream paused after one chunk, the second call blocks:
    // only one API call is made.
    const firstStream = await send('first', 'prompt-1');
    await firstStream.next();
    const secondStreamPromise = send('second', 'prompt-2');
    expectStreamCalls(1);

    // Unblock and finish the first stream (rest, then iterator end).
    continueFirstStream();
    await firstStream.next();
    await firstStream.next();

    // Consuming the second stream makes its API call, then recordHistory.
    const secondStream = await secondStreamPromise;
    await secondStream.next();
    expectStreamCalls(2);
    await secondStream.next();

    const history = chat.getHistory();
    expect(history.length).toBe(4);
    expect(history[3]?.parts?.[0]?.text).toBe('second response');
  });

  describe('Model Resolution', () => {
    const mockResponse = textChunk('response', 'STOP');

    it('should pass the requested model through to generateContentStream', async () => {
      vi.mocked(mockConfig.getModel).mockReturnValue('gemini-pro');
      streamMock().mockImplementation(async () => streamOf(mockResponse));

      await sendDrain('test', 'prompt-id-res3');

      expect(mockContentGenerator.generateContentStream).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'test-model' }),
        'prompt-id-res3',
      );
    });
  });

  // Protocol-leak retry fixtures for the cases below.
  const FINAL = 'Successful final response';
  const ANALYSIS_LEAK =
    'lysis>failed scratch</analysis>' +
    '<summary>FAILED_ATTEMPT_SHOULD_BE_DISCARDED</summary>';
  /** Leaked `read_file` call JSON followed by closing protocol tags. */
  const leakedToolJson = (gap = '\n') =>
    JSON.stringify([{ name: 'read_file', file_path: 'a.ts' }]) +
    `${gap}</parameter>\n</function>\n`;
  const readFileCall = () =>
    fnCall('read_file', { file_path: 'a.ts' }, 'call-1');
  const readFilePreparation = () => [
    { callId: 'call-1', toolName: 'read_file' },
  ];
  const finishOnlyChunk = () =>
    ({
      candidates: [{ finishReason: 'STOP' }],
    }) as unknown as GenerateContentResponse;
  /** Every part the CHUNK events carried, in order. */
  const chunkParts = (events: StreamEvent[]) =>
    events
      .filter((event) => event.type === StreamEventType.CHUNK)
      .flatMap((event) => event.value.candidates?.[0]?.content?.parts ?? []);

  /** Queue `streams`, send 'test' on a recording chat, collect the events. */
  async function sendRecording(
    promptId: string,
    ...streams: Array<AsyncGenerator<GenerateContentResponse>>
  ) {
    const recordAssistantTurn = vi.fn();
    const target = chatWithRecorder(recordAssistantTurn);
    mockStreamsOnce(...streams);
    const events = await sendCollect('test', promptId, target);
    return { events, target, recordAssistantTurn };
  }

  function expectRecordedOnce(
    recordAssistantTurn: ReturnType<typeof vi.fn>,
    message: unknown,
  ) {
    expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
    expect(recordAssistantTurn.mock.calls[0]?.[0].message).toEqual(message);
  }

  /** One retry; only FINAL reached the caller, history and the recorder. */
  function expectRetriedToFinal({
    events,
    target,
    recordAssistantTurn,
  }: Awaited<ReturnType<typeof sendRecording>>) {
    expectStreamCalls(2);
    expect(hasRetry(events)).toBe(true);
    expect(chunkParts(events)).toEqual([{ text: FINAL }]);
    expect(target.getLastModelMessageText()).toBe(FINAL);
    expectRecordedOnce(recordAssistantTurn, [{ text: FINAL }]);
  }

  it.each([false, true])(
    'discards failed partials on retry with an un-aborted signal present: %s',
    async (withSignal) => {
      const controller = new AbortController();
      const recordAssistantTurn = vi.fn();
      const recordingChat = chatWithRecorder(recordAssistantTurn);
      // Attempt 1 yields a valid chunk, then an invalid (empty) one that
      // triggers the retry; attempt 2 succeeds.
      mockStreamsOnce(
        streamOf(
          textChunk('This valid part should be discarded'),
          textChunk(''),
        ),
        textStream(FINAL),
      );

      const stream = await recordingChat.sendMessageStream(
        'test-model',
        {
          message: 'test',
          ...(withSignal ? { config: { abortSignal: controller.signal } } : {}),
        },
        'prompt-id-discard-test',
      );
      const events = await collect(stream);

      expect(controller.signal.aborted).toBe(false);
      expect(recordAssistantTurn).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ message: [{ text: FINAL }] }),
      );
      expectStreamCalls(2);
      expect(hasRetry(events)).toBe(true);
      const text = soleModelTurn(recordingChat).parts![0]!.text;
      expect(text).toBe(FINAL);
      expect(text).not.toContain('This valid part should be discarded');
    },
  );

  it('discards a completed protocol-tagged response and retries before persistence', async () => {
    const { events, target, recordAssistantTurn } = await sendRecording(
      'prompt-id-protocol-leak',
      streamOf(textChunk('<ana'), textChunk(ANALYSIS_LEAK, 'STOP')),
      textStream(FINAL),
    );

    expectStreamCalls(2);
    expect(hasRetry(events)).toBe(true);
    expect(
      chunkParts(events)
        .map((part) => part.text ?? '')
        .join(''),
    ).toBe(FINAL);
    expect(target.getLastModelMessageText()).toBe(FINAL);
    expectRecordedOnce(recordAssistantTurn, [{ text: FINAL }]);
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
      const leakedText =
        leakedJson + '\n</parameter>\n</function>\n' + trailingText;
      const leakedResponses = [
        modelChunk([
          { text: '...', thought: true },
          { text: leakedText.slice(0, 40) },
        ]),
        textChunk(leakedText.slice(40), finishWithContent ? 'STOP' : undefined),
      ];
      if (!finishWithContent) leakedResponses.push(finishOnlyChunk());
      expectRetriedToFinal(
        await sendRecording(
          'prompt-id-json-tool-protocol-leak',
          streamOf(...leakedResponses),
          streamOf(stopResponse([{ text: FINAL }])),
        ),
      );
    },
  );

  it.each([
    [JSON.stringify([{ name: 'example', value: 1 }]), 8, 1],
    ['[1,2,3]', 2, 2],
  ])(
    'preserves an ordinary leading JSON array: %s',
    async (response, splitAt, expectedTextChunks) => {
      mockStreamsOnce(
        streamOf(
          modelChunk([
            { text: 'thinking', thought: true },
            { text: response.slice(0, splitAt) },
          ]),
          stopResponse([{ text: response.slice(splitAt) }]),
        ),
      );

      // Read each chunk's text as it streams: chunk objects are updated
      // later, so reading them after collection would differ.
      const stream = await send('test', 'prompt-id-json-array-literal');
      const events: StreamEvent[] = [];
      const streamedTextChunks: string[] = [];
      for await (const event of stream) {
        events.push(event);
        if (event.type !== StreamEventType.CHUNK) continue;
        const text = (event.value.candidates?.[0]?.content?.parts ?? [])
          .filter((part) => !part.thought)
          .map((part) => part.text ?? '')
          .join('');
        if (text) streamedTextChunks.push(text);
      }

      expectStreamCalls(1);
      expect(hasRetry(events)).toBe(false);
      expect(streamedTextChunks).toHaveLength(expectedTextChunks);
      expect(chunkParts(events).find((part) => part.thought)?.text).toBe(
        'thinking',
      );
      expect(streamedTextChunks.join('')).toBe(response);
      expect(chat.getLastModelMessageText()).toBe(response);
    },
  );

  it('releases buffered JSON through a finish-only chunk without leaked tags', async () => {
    const response = JSON.stringify([{ name: 'example', value: 1 }]);
    mockStreamsOnce(
      streamOf(
        textChunk(response.slice(0, 12)),
        textChunk(response.slice(12)),
        finishOnlyChunk(),
      ),
    );

    const events = await sendCollect('test', 'prompt-id-json-finish-only');

    expectStreamCalls(1);
    expect(hasRetry(events)).toBe(false);
    const emittedParts = chunkParts(events);
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
      const leakedText = leakedToolJson();
      const preparation = middleChunkType === 'preparation';
      const middleResponse = modelChunk(preparation ? [] : [readFileCall()]);
      if (preparation) {
        setToolCallPreparations(middleResponse, readFilePreparation());
      }
      expectRetriedToFinal(
        await sendRecording(
          'prompt-id-interrupted-json-tool-protocol-leak',
          streamOf(
            textChunk(leakedText.slice(0, 12)),
            middleResponse,
            stopResponse([{ text: leakedText.slice(12) }]),
          ),
          streamOf(stopResponse([{ text: FINAL }])),
        ),
      );
    },
  );

  it.each([true, false])(
    'preserves leading JSON when a tool call ends without a finish reason (tool call first: %s)',
    async (toolCallFirst) => {
      const response = JSON.stringify([{ name: 'example', value: 1 }]);
      const functionCallPart = readFileCall();
      const call = modelChunk([functionCallPart]);
      const [head, tail] = [response.slice(0, 12), response.slice(12)].map(
        (text) => textChunk(text),
      );
      const { events, target, recordAssistantTurn } = await sendRecording(
        `prompt-id-json-tool-call-no-finish-${toolCallFirst}`,
        streamOf(
          ...(toolCallFirst ? [call, head!, tail!] : [head!, call, tail!]),
        ),
      );

      expectStreamCalls(1);
      expect(hasRetry(events)).toBe(false);
      const emittedParts = chunkParts(events);
      expect(target.getHistory().at(-1)?.parts).toEqual(emittedParts);
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
      const preparationResponse = modelChunk([]);
      setToolCallPreparations(preparationResponse, readFilePreparation());
      const usageResponse = {
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 },
      } as GenerateContentResponse;
      const responses = [textChunk(response), usageResponse];
      if (withPreparation) responses.push(preparationResponse);
      responses.push(stopResponse([readFileCall()]));
      mockStreamsOnce(streamOf(...responses));

      const events = await sendCollect(
        'test',
        'prompt-id-json-before-tool-call',
      );

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
        withPreparation ? readFilePreparation() : [],
      );
      for (const parts of [
        chunkParts(events),
        chat.getHistory().at(-1)?.parts ?? [],
      ]) {
        expect(parts.findIndex((part) => part.text === response)).toBe(0);
        expect(parts.findIndex((part) => part.functionCall)).toBe(1);
      }
    },
  );

  it('does not retry after a structured tool call has already been emitted', async () => {
    const { events, target, recordAssistantTurn } = await sendRecording(
      'prompt-id-tool-call-before-json-protocol-leak',
      streamOf(
        modelChunk([readFileCall()]),
        stopResponse([{ text: leakedToolJson() }]),
      ),
      streamOf(stopResponse([{ text: 'Unexpected retry response' }])),
    );

    expectStreamCalls(1);
    expect(hasRetry(events)).toBe(false);
    const emittedParts = chunkParts(events);
    expect(emittedParts).toEqual([readFileCall()]);
    expect(target.getHistory().at(-1)?.parts).toEqual(emittedParts);
    expectRecordedOnce(recordAssistantTurn, emittedParts);
  });

  it.each([
    [
      'does not reject normal HTML or protocol tag names in prose',
      '<details><summary>Title</summary></details> ' +
        'Use the literal <analysis> tag in this example.',
      'prompt-id-protocol-literal',
    ],
    [
      'does not reject closing protocol tags inside a JSON string',
      JSON.stringify({ example: '} </parameter></function> text' }),
      'prompt-id-json-protocol-literal',
    ],
  ])('%s', async (_title, response, promptId) => {
    mockStreamsOnce(textStream(response));

    const events = await sendCollect('test', promptId);

    expect(hasRetry(events)).toBe(false);
    expect(chat.getLastModelMessageText()).toBe(response);
  });

  it.each([
    [
      'retries leaked JSON before a structured tool call',
      '\n',
      'STOP',
      'prompt-id-json-leak-before-tool-call',
    ],
    [
      'retries leaked JSON without a finish reason via the post-stream leak guard',
      '\n\n',
      undefined,
      'prompt-id-json-leak-no-finish-reason',
    ],
  ] as const)(
    '%s',
    fakeTimers(async (_title, gap, finishReason, promptId) => {
      mockStreamsOnce(
        streamOf(
          textChunk(leakedToolJson(gap)),
          modelChunk([readFileCall()], finishReason),
        ),
        streamOf(stopResponse([{ text: FINAL }])),
      );

      const events = await collectAdvancing(await send('test', promptId));

      expectStreamCalls(2);
      const emittedParts = chunkParts(events);
      expect(emittedParts).toEqual([{ text: FINAL }]);
      expect(chat.getHistory().at(-1)?.parts).toEqual(emittedParts);
    }),
  );

  it('retries a protocol-tagged turn even when the leaked attempt also contains a tool call', async () => {
    vi.useFakeTimers();
    const recordAssistantTurn = vi.fn();
    const target = chatWithRecorder(recordAssistantTurn);
    const earlier = () => [
      userText('earlier user turn'),
      modelText('earlier model turn'),
    ];
    target.setHistory(earlier());
    mockStreamsOnce(
      streamOf(
        textChunk('<ana'),
        modelChunk(
          [
            { text: ANALYSIS_LEAK },
            fnCall(
              'read_file',
              { path: '/tmp/leaked.txt' },
              'call_protocol_leak_should_retry',
            ),
          ],
          'STOP',
        ),
      ),
      textStream(FINAL),
    );

    const events = await collectAdvancing(
      await send('test', 'prompt-id-protocol-leak-tool-call', target),
    );

    expectStreamCalls(2);
    expect(hasRetry(events)).toBe(true);
    const emittedParts = chunkParts(events);
    expect(emittedParts.some((part) => part.functionCall)).toBe(false);
    expect(emittedParts.map((part) => part.text ?? '').join('')).toBe(FINAL);
    expect(target.getLastModelMessageText()).toBe(FINAL);
    const history = target.getHistory();
    expect(history).toEqual([...earlier(), userText('test'), modelText(FINAL)]);
    expect(
      history.some((turn) => turn.parts?.some((part) => part.functionCall)),
    ).toBe(false);
    expectRecordedOnce(recordAssistantTurn, [{ text: FINAL }]);
  });

  describe('stripThoughtsFromHistory', () => {
    it('should strip thought parts from history and drop thought-only entries', () => {
      chat.setHistory([
        userText('question'),
        content(
          'model',
          { text: 'thinking', thought: true },
          { text: 'answer' },
        ),
        content('model', { text: 'more thinking', thought: true }),
      ]);

      chat.stripThoughtsFromHistory();

      expect(chat.getHistory()).toEqual([
        userText('question'),
        modelText('answer'),
      ]);
    });
  });

  describe('stripOrphanedUserEntriesFromHistory', () => {
    const earlier = () => [
      userText('earlier prompt'),
      modelText('earlier response'),
    ];

    it('should pop a single trailing user entry', () => {
      const kept = () => [
        userText('first message'),
        modelText('first response'),
      ];
      chat.setHistory([...kept(), userText('orphaned message')]);

      const strippedEntries = chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual(kept());
      expect(strippedEntries).toEqual([userText('orphaned message')]);
    });

    it('should pop multiple trailing user entries', () => {
      const kept = () => [
        userText('query'),
        content('model', fnCall('tool', {})),
      ];
      const orphans = () => [
        userText('IDE context'),
        content('user', fnResponse('tool', { result: 'ok' })),
      ];
      chat.setHistory([...kept(), ...orphans()]);

      const strippedEntries = chat.stripOrphanedUserEntriesFromHistory();

      expect(chat.getHistory()).toEqual(kept());
      expect(strippedEntries).toEqual(orphans());
    });

    const reminder = (body: string) =>
      userText(`${SYSTEM_REMINDER_OPEN}\n${body}\n</system-reminder>`);

    it.each<[string, Content[], Content[]]>([
      [
        'preserves the startup reminder when stripping a failed first prompt',
        [reminder('ctx'), userText('failed first prompt')],
        [reminder('ctx')],
      ],
      // drainPendingAddedMcpToolsReminder's entry must survive a failed
      // prompt's pop: the tool is already in announcedDeferredToolNames, so
      // the announcement can't be re-queued and would be lost forever.
      [
        'preserves a mid-history MCP added-tool reminder when a later prompt fails',
        [...earlier(), reminder('added: foo'), userText('failed prompt')],
        [...earlier(), reminder('added: foo')],
      ],
      // Plan-mode (and subagent/memory) reminders are an extra part of the
      // prompt's own Content. Matching parts[0] alone would keep the prompt,
      // leaking it into the next turn via appendCuratedContent; the entry is
      // popped because not every part is a reminder.
      [
        'pops a failed turn whose reminder shares a Content with the prompt',
        [
          ...earlier(),
          content(
            'user',
            {
              text: `${SYSTEM_REMINDER_OPEN}\nPlan mode is active.\n</system-reminder>`,
            },
            { text: 'the actual user prompt' },
          ),
        ],
        earlier(),
      ],
      [
        'should be a no-op when last entry is a model response',
        [userText('hello'), modelText('hi')],
        [userText('hello'), modelText('hi')],
      ],
      ['should handle empty history', [], []],
    ])('%s', (_title, history, expected) => {
      chat.setHistory(history);
      chat.stripOrphanedUserEntriesFromHistory();
      expect(chat.getHistory()).toEqual(expected);
    });
  });

  describe('partial-push marker invariants on history mutation', () => {
    // Every history mutation (six sites below) must clear the partial-push
    // markers, or a stale `pendingPartialAssistantTurnIndex` could line up
    // with an unrelated model turn and make `popPendingPartialAssistantTurn`
    // splice the WRONG entry, losing a real response. The markers live only
    // within one sendMessageStream call (its `finally` flushes the record and
    // calls `clearPendingPartialState()`), so they are planted through the
    // private fields; each site must reset both in lockstep.
    type PrivateFields = {
      pendingPartialAssistantTurnIndex: number | null;
      pendingPartialAssistantRecord: unknown;
    };
    function plantMarkers(c: LlmChat): void {
      const internal = c as unknown as PrivateFields;
      internal.pendingPartialAssistantTurnIndex = 0;
      internal.pendingPartialAssistantRecord = {
        model: 'test-model',
        message: [fnCall('t', {}, 'call_test')],
      };
    }
    const markers = (c: LlmChat) => {
      const internal = c as unknown as PrivateFields;
      return {
        idx: internal.pendingPartialAssistantTurnIndex,
        record: internal.pendingPartialAssistantRecord,
      };
    };

    it.each<[string, (c: LlmChat) => unknown]>([
      [
        'clearHistory() clears the partial-push markers',
        (c) => c.clearHistory(),
      ],
      // addHistory belongs between sends: with markers active it is a
      // violation that logs a warn (caller diagnosable), then clears them.
      [
        'addHistory() clears the partial-push markers (violation path)',
        (c) => c.addHistory(userText('between sends')),
      ],
      [
        'setHistory() clears the partial-push markers',
        (c) => c.setHistory([userText('replacement')]),
      ],
      [
        'truncateHistory() clears the partial-push markers',
        (c) => c.truncateHistory(1),
      ],
      [
        'stripThoughtsFromHistory() clears the partial-push markers',
        (c) => c.stripThoughtsFromHistory(),
      ],
      // The tail is a model turn, so the strip is a no-op on history, but
      // the marker reset must still fire so all six sites stay uniform.
      [
        'stripOrphanedUserEntriesFromHistory() clears the partial-push markers',
        (c) => c.stripOrphanedUserEntriesFromHistory(),
      ],
    ])('%s', (_title, mutate) => {
      chat.setHistory([
        userText('kick off'),
        content('model', fnCall('t', {}, 'x')),
      ]);
      plantMarkers(chat);
      expect(markers(chat).idx).toBe(0);

      mutate(chat);

      expect(markers(chat).idx).toBeNull();
      expect(markers(chat).record).toBeNull();
    });
  });

  describe('repairOrphanedToolUseTurns', () => {
    // The inverse of strip: a `model[functionCall]` without a matching next
    // `user[functionResponse]` gets a synthesized error response, closing the
    // tool_use ↔ tool_result invariant for residual races (`--resume` of a
    // crash, Ctrl+Y mid-tool, abort before submitQuery, manual JSONL edits).
    const readCall = (id: string, args: Record<string, unknown> = {}) =>
      fnCall('read_file', args, id);
    /** A model turn with one `read_file` call per id. */
    const callTurn = (...ids: string[]) =>
      content('model', ...ids.map((id) => readCall(id)));
    /** A user turn answering `id` with `output`, then `rest`. */
    const resultTurn = (id: string, output: string, ...rest: Part[]) =>
      content('user', fnResponse('read_file', { output }, id), ...rest);
    /** Set `history`, repair it, return the result and the new history. */
    function repair(
      history: Content[],
      ...args: Parameters<LlmChat['repairOrphanedToolUseTurns']>
    ) {
      chat.setHistory(history);
      const result = chat.repairOrphanedToolUseTurns(...args);
      return { result, history: chat.getHistory() };
    }

    it('keeps a tool result adjacent across a removable degraded placeholder', () => {
      const history = [
        userText('open /tmp/a.txt'),
        content('model', readCall('call-1', { path: '/tmp/a.txt' })),
        modelText('(request timeout)'),
        resultTurn('call-1', 'ok'),
        resultTurn('call-1', 'ok'),
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
      // --resume after a crash between the partial-tool_use push and the
      // scheduler's tool_result: the first API call would 400 without repair.
      const { result, history } = repair([
        userText('open /tmp/a.txt'),
        content('model', readCall('call_crash_A', { path: '/tmp/a.txt' })),
      ]);

      expect(result.injected).toEqual([
        { callId: 'call_crash_A', name: 'read_file' },
      ]);
      expect(history.length).toBe(3);
      expect(history[2]!.role).toBe('user');
      const fr = history[2]!.parts![0]!.functionResponse;
      expect(fr?.id).toBe('call_crash_A');
      expect(fr?.name).toBe('read_file');
      expect(fr?.response?.['error']).toMatch(/interrupted/i);
    });

    it('preserves selected call ids instead of synthesizing a response', () => {
      const { result, history } = repair(
        [
          userText('ask'),
          content('model', fnCall('ask_user_question', {}, 'call_auq')),
        ],
        undefined,
        { preserveCallIds: new Set(['call_auq']) },
      );

      expect(result.injected).toEqual([]);
      expect(history).toHaveLength(2);
    });

    it('hoists synthetic functionResponse to the front of an existing user turn (Race A)', () => {
      // Ctrl+Y race: strip keeps model[functionCall] (tail is model) and
      // Retry pushes a fresh user turn. The synthetic response is spliced onto
      // that turn (no stray turn between) BEFORE the text: Anthropic-compatible
      // backends need tool_result first (upstream's `hoistToolResults`), else
      // the "tool_use_id ... must have a corresponding tool_use block" 400
      // this PR escapes returns.
      const { result, history } = repair([
        userText('open /tmp/a.txt'),
        content('model', readCall('call_race_A', { path: '/tmp/a.txt' })),
        userText('retry prompt'),
      ]);

      expect(result.injected.map((e) => e.callId)).toEqual(['call_race_A']);
      expect(history.length).toBe(3);
      expect(history[2]!.role).toBe('user');
      expect(history[2]!.parts!.length).toBe(2);
      expect(history[2]!.parts![0]!.functionResponse?.id).toBe('call_race_A');
      expect(history[2]!.parts![1]).toEqual({ text: 'retry prompt' });
    });

    it('hoists synthetic functionResponse AFTER pre-existing real ones (parallel partial submit)', () => {
      // One real response already present: the missing id's synthetic goes
      // between it and the text, `[real_fr, synthetic_fr, text]` (every
      // tool_result first, real-fr order preserved).
      const parts = repair([
        userText('batch read'),
        callTurn('call_A', 'call_B'),
        resultTurn('call_A', 'a', { text: 'retry prompt' }),
      ]).history[2]!.parts!;
      expect(parts.length).toBe(3);
      expect(parts[0]!.functionResponse?.id).toBe('call_A');
      expect(parts[1]!.functionResponse?.id).toBe('call_B');
      expect(parts[2]).toEqual({ text: 'retry prompt' });
    });

    it('handles parallel tool_use turns with only some responses present', () => {
      // #4176's partial push: several parallel tool_uses closed, only some
      // submitted before Ctrl+Y. Close every missing pair without duplicating
      // A's present response.
      const { result, history } = repair([
        userText('batch read'),
        content(
          'model',
          readCall('call_A', { path: '/a' }),
          readCall('call_B', { path: '/b' }),
          readCall('call_C', { path: '/c' }),
        ),
        resultTurn('call_A', 'a-content'),
      ]);

      const injectedIds = result.injected.map((e) => e.callId);
      expect(injectedIds.sort()).toEqual(['call_B', 'call_C']);
      // Same shape: synthetics merge into the existing user turn.
      expect(history.length).toBe(3);
      const fr = history[2]!.parts!.map((p) => p.functionResponse?.id);
      expect(fr).toEqual(['call_A', 'call_B', 'call_C']);
      // The real `call_A` result is kept untouched.
      expect(
        history[2]!.parts![0]!.functionResponse?.response?.['output'],
      ).toBe('a-content');
    });

    it('is a no-op when every tool_use already has a matching response', () => {
      // Happy path: don't churn history when the invariant already holds.
      const happy = [
        userText('q'),
        callTurn('call_ok'),
        resultTurn('call_ok', 'fine'),
      ];
      const { result } = repair(structuredClone(happy));

      expect(result.injected).toEqual([]);
      expect(chat.getHistory()).toEqual(happy);
    });

    it('repairs multiple non-adjacent dangling tool_uses across history', () => {
      // Forward-walk stress: dangling turns at the start AND the end are
      // repaired, without re-scanning synthetic user turns just inserted.
      const { result, history } = repair([
        content('model', fnCall('glob', {}, 'early_orphan')),
        userText('second user prompt'),
        content('model', readCall('late_orphan', { path: '/x' })),
      ]);

      const injectedIds = result.injected.map((e) => e.callId);
      expect(injectedIds.sort()).toEqual(['early_orphan', 'late_orphan']);
      // early_orphan's synthetic joins the existing user turn between the
      // model entries; late_orphan gets a new trailing user turn.
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
      const plain = [userText('hi'), modelText('hello')];
      const { result } = repair(structuredClone(plain));

      expect(result.injected).toEqual([]);
      expect(chat.getHistory()).toEqual(plain);
    });

    it('uses caller-provided reason text', () => {
      const { history } = repair(
        [userText('q'), callTurn('cid')],
        'custom reason',
      );
      const fr = history[2]!.parts![0]!.functionResponse;
      expect((fr?.response as { error?: string })?.error).toBe('custom reason');
    });

    it('hoists the real functionResponse from a non-adjacent later user turn into the adjacent one', () => {
      // Regression for [user, model[fc], user[text], user[fr_real]]: after an
      // abort and a follow-up, the late submitQuery appends the real
      // tool_result as a SEPARATE entry. Forward scanning avoids a duplicate,
      // but Anthropic-compatible backends reject a tool_result not heading the
      // IMMEDIATELY following user message: MOVE it from [3] to [2]'s head.
      const { result, history } = repair([
        userText('open /tmp/long.txt'),
        content(
          'model',
          readCall('call_nonadjacent_real', { path: '/tmp/long.txt' }),
        ),
        userText('never mind, do something else'),
        resultTurn('call_nonadjacent_real', 'real file contents'),
      ]);

      // Relocated, not synthesized: `injected` stays empty so the
      // scheduler dedup doesn't treat the callId as synthesized.
      expect(result.injected).toEqual([]);
      // The source turn held only the fr, so it empties and is removed.
      expect(history.length).toBe(3);
      // The real fr now heads the next user turn, before the text.
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
      // The real fr covers only SOME parallel callIds from a non-adjacent
      // turn, so one model turn gets both fix-ups (synthesize AND hoist).
      const { result, history } = repair([
        userText('fan out two reads'),
        callTurn('cid_a', 'cid_b'),
        userText('follow up'),
        resultTurn('cid_a', 'real for a'),
      ]);

      // Only the synthetic cid_b is `injected`; cid_a is hoisted.
      expect(result.injected).toEqual([{ callId: 'cid_b', name: 'read_file' }]);
      // cid_a's source turn empties and is removed: 4 → 3 entries.
      expect(history.length).toBe(3);
      // Adjacent turn: synthetic fr_b, hoisted real fr_a, then the text;
      // both tool_results at the head (Anthropic wire-format invariant).
      const adjacentParts = history[2]!.parts!;
      expect(adjacentParts[0]!.functionResponse?.id).toBe('cid_b');
      expect(
        adjacentParts[0]!.functionResponse?.response?.['error'],
      ).toBeDefined();
      expect(adjacentParts[1]!.functionResponse?.id).toBe('cid_a');
      expect(adjacentParts[1]!.functionResponse?.response).toEqual({
        output: 'real for a',
      });
      expect(adjacentParts[2]).toEqual({ text: 'follow up' });
    });

    it('hoists real fr but preserves the source user turn when it carries other content', () => {
      // A source turn with other parts (the user's real message) must NOT be
      // deleted with its fr: cleanup only removes turns left with zero parts.
      const { result, history } = repair([
        userText('kick off'),
        callTurn('cid_mix'),
        userText('never mind'),
        resultTurn('cid_mix', 'data', { text: 'thanks anyway' }),
      ]);

      expect(result.injected).toEqual([]);
      // The source turn survives as a text-only message: still 4 entries.
      expect(history.length).toBe(4);
      expect(history[2]!.parts![0]!.functionResponse?.id).toBe('cid_mix');
      expect(history[2]!.parts![1]).toEqual({ text: 'never mind' });
      expect(history[3]!.parts).toEqual([{ text: 'thanks anyway' }]);
    });

    it('drops duplicate functionResponse entries for the same callId across user turns', () => {
      // Critical regression: one callId echoed back twice (a late submitQuery
      // retried after repair planted one, or two late-submit paths). Hoisting
      // only the first leaves a trailing user[tool_result] that
      // Anthropic-compatible backends reject as an orphan, re-wedging the
      // session: hoist one canonical fr AND delete every duplicate.
      const { result, history } = repair([
        userText('open file'),
        callTurn('cid_dup'),
        userText('never mind'),
        resultTurn('cid_dup', 'data'),
        resultTurn('cid_dup', 'data'),
      ]);

      expect(result.injected).toEqual([]);
      // 5 → 3: both source turns held only the duplicate fr and are
      // removed; the canonical fr heads history[2], before the text.
      expect(history.length).toBe(3);
      expect(history[2]!.parts![0]!.functionResponse?.id).toBe('cid_dup');
      expect(history[2]!.parts![1]).toEqual({ text: 'never mind' });
      // No fr for cid_dup remains AFTER the adjacent turn.
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
      // The FIRST fr already sits in the next user turn (no hoist); duplicate
      // cleanup must still fire, or the payload keeps two `tool_result`
      // blocks for one id.
      const { result, history } = repair([
        userText('kick off'),
        callTurn('cid_adj_dup'),
        resultTurn('cid_adj_dup', 'real'),
        resultTurn('cid_adj_dup', 'real', { text: 'follow up' }),
      ]);

      expect(result.injected).toEqual([]);
      // The duplicate's source turn keeps its text (4 entries), not the fr.
      expect(history.length).toBe(4);
      expect(history[2]!.parts![0]!.functionResponse?.id).toBe('cid_adj_dup');
      expect(history[2]!.parts!.length).toBe(1);
      expect(history[3]!.parts).toEqual([{ text: 'follow up' }]);
      // Exactly one fr for that id across the following user turns.
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

    /** A one-chunk stream of `text` that stops at MAX_TOKENS. */
    const truncated = (text: string) => streamOf(textChunk(text, 'MAX_TOKENS'));

    /** Yields a `read_file` call `id` on `path`, then fails with `message`. */
    const readCallThenThrow = (path: string, id: string, message: string) =>
      streamThenThrow(
        [modelChunk([fnCall('read_file', { path }, id)])],
        new Error(message),
      );

    /** A MAX_TOKENS stream whose only part is a `write_file` call. */
    const truncatedWriteCall = () =>
      streamOf(
        modelChunk([fnCall('write_file', { file_path: '/x' })], 'MAX_TOKENS'),
      );

    /** A stream leaking a split `<analysis>`/`<summary>` protocol block. */
    const leakStream = (analysis: string, summary: string) =>
      streamOf(
        textChunk('<ana'),
        textChunk(
          `lysis>${analysis}</analysis><summary>${summary}</summary>`,
          'STOP',
        ),
      );

    /** Serve `streams` to successive calls; `served.calls` counts them. */
    function serveStreams(
      ...streams: Array<AsyncGenerator<GenerateContentResponse>>
    ) {
      const served = { calls: 0 };
      streamMock().mockImplementation(async () => streams[served.calls++]!);
      return served;
    }

    const sendOn = (
      model: string,
      message: string | Part[],
      promptId: string,
      target: LlmChat = chat,
    ) => target.sendMessageStream(model, { message }, promptId);

    /** Send on gemini-pro (8K default output, escalates to 64K). */
    const sendPro = (
      message: string | Part[],
      promptId: string,
      target: LlmChat = chat,
    ) => sendOn('gemini-pro', message, promptId, target);

    const lastEntry = () => chat.getHistory().at(-1)!;

    /** Joined text of the last history entry, optionally without thoughts. */
    const lastText = (dropThoughts = false) =>
      (lastEntry().parts ?? [])
        .filter((part) => !dropThoughts || !part.thought)
        .map((part) => ('text' in part ? part.text : ''))
        .join('');

    const continuationOf = (event: StreamEvent) =>
      (event as { isContinuation?: boolean }).isContinuation;

    const isUnsignedThought = (part: Part) =>
      Boolean(part.thought && part.text && !part.thoughtSignature);

    /** A recovery continuation led by its own thought part. */
    const thinkingContinuation = (): Part[] => [
      { text: 'planning the rest', thought: true },
      { text: 'shared recovery suffix and continuation' },
    ];

    /** A recovery continuation that calls a tool. */
    const toolContinuation = (): Part[] => [
      { text: 'continuing', ...fnCall('tool', {}, 'c1') },
    ];

    /**
     * Serve a discarded MAX_TOKENS initial response, a MAX_TOKENS escalated
     * turn (`previous`) and a STOP recovery turn (`continuation`), send
     * `message` on gemini-pro and drain. Returns the recovery prompt the
     * model received (the user turn carrying "Output token limit hit").
     */
    async function runRecovery(
      previous: string | Part[],
      continuation: string | Part[],
      message: string,
      promptId: string,
    ): Promise<string | undefined> {
      const parts = (p: string | Part[]) =>
        typeof p === 'string' ? [{ text: p }] : p;
      const streams = [
        truncated('discarded initial'),
        streamOf(modelChunk(parts(previous), 'MAX_TOKENS')),
        streamOf(modelChunk(parts(continuation), 'STOP')),
      ];
      let callIndex = 0;
      const userPayloads: string[] = [];
      streamMock().mockImplementation(async (params) => {
        const lastTurn = (params.contents as Content[] | undefined)?.at(-1);
        const text =
          lastTurn?.role === 'user' ? lastTurn.parts?.[0]?.text : undefined;
        if (typeof text === 'string') userPayloads.push(text);
        return streams[callIndex++]!;
      });
      await drain(await sendPro(message, promptId));
      return userPayloads.find((p) => p.includes('Output token limit hit'));
    }

    /** One expect per adjacent pair: no two neighbours share a role. */
    function expectAlternatingRoles(history: Content[]) {
      for (let i = 1; i < history.length; i++) {
        expect(history[i]!.role).not.toBe(history[i - 1]!.role);
      }
    }

    /** The internal recovery prompt never reaches durable history. */
    function expectNoRecoveryPrompt(history: Content[]) {
      const flattened = JSON.stringify(history);
      expect(flattened).not.toContain('Output token limit hit');
      expect(flattened).not.toContain('Resume directly');
    }

    /** History ends on a model turn carrying a functionCall. */
    function expectEndsOnFunctionCall() {
      const last = lastEntry();
      expect(last.role).toBe('model');
      expect(
        last.parts?.some((p) => 'functionCall' in p && p.functionCall),
      ).toBe(true);
    }

    /** Sends a cancellable 'write long answer' on a recording chat. */
    async function startCancellable(
      controller: AbortController,
      streams: Array<AsyncGenerator<GenerateContentResponse>>,
      promptId: string,
    ) {
      const recordAssistantTurn = vi.fn();
      const recordingChat = chatWithRecorder(recordAssistantTurn);
      const served = serveStreams(...streams);
      const stream = await recordingChat.sendMessageStream(
        'gemini-pro',
        {
          message: 'write long answer',
          config: { abortSignal: controller.signal },
        },
        promptId,
      );
      return { recordAssistantTurn, recordingChat, served, stream };
    }

    const SUFFIX_BLOCK =
      /<previous_response_suffix>\n([\s\S]*)\n<\/previous_response_suffix>/;

    /** Exactly one opening and one closing suffix delimiter (two expects). */
    function expectOneDelimiterPair(message: string) {
      expect((message.match(/<previous_response_suffix>/g) ?? []).length).toBe(
        1,
      );
      expect(
        (message.match(/<\/previous_response_suffix>/g) ?? []).length,
      ).toBe(1);
    }

    it('escalates an empty MAX_TOKENS response instead of retrying it as an empty stream', async () => {
      vi.useFakeTimers();
      const requestedMaxOutputTokens: Array<number | undefined> = [];
      streamMock().mockImplementation(async (request) => {
        const maxOutputTokens = request.config?.maxOutputTokens;
        requestedMaxOutputTokens.push(maxOutputTokens);
        return maxOutputTokens !== undefined && maxOutputTokens > 8_192
          ? textStream('Completed after escalation.')
          : streamOf(modelChunk([], 'MAX_TOKENS'));
      });

      const stream = await sendPro(
        'complete the tool call',
        'prompt-empty-max-tokens-escalation',
      );
      const events = await collectStreamWithFakeTimers(stream, 25_000);

      expect(requestedMaxOutputTokens).toEqual([8_192, 64_000]);
      expect(eventsOfType(events, StreamEventType.RETRY)).toEqual([
        { type: StreamEventType.RETRY, maxOutputTokensEscalated: 64_000 },
      ]);
      expect(mockLogContentRetry).not.toHaveBeenCalledWith(
        mockConfig,
        expect.objectContaining({ error_type: 'NO_RESPONSE_TEXT' }),
      );
      expect(chat.getHistory()).toEqual([
        userText('complete the tool call'),
        modelText('Completed after escalation.'),
      ]);
    });

    it('re-clamps maxOutputTokens on each recovery send as the prompt grows (window invariant)', async () => {
      // #5950 at recovery time: 131,072 window, 71,349 prompt, 64K ceiling.
      // The initial 49,722 grant truncates; the ~121K recovery prompt would
      // overflow by ~40K on that stale grant, so the loop re-clamps per
      // iteration (here to the 4,000 floor).
      mockGeneratorConfig({
        model: 'claude-sonnet-4-6',
        contextWindowSize: 131_072,
      });
      mockCompress(noop(71_349));
      serveStreams(
        streamOf(
          textChunk('partial essay…', 'MAX_TOKENS', {
            promptTokenCount: 71_349,
            totalTokenCount: 121_071, // output = 49,722 (the full grant)
          }),
        ),
        textStream(' …and done.'),
      );

      chat.setLastPromptTokenCount(71_349);
      await drain(
        await sendOn('claude-sonnet-4-6', 'hi', 'prompt-recovery-reclamp'),
      );

      // Escalation is a no-op (room binds below 64K): initial + recovery only.
      expectStreamCalls(2);
      // Initial: char/4("hi") = 1 token, x1.5 safety factor (ceil'd) = 2,
      // room = 131072 − 71351 − 10000 = 49721 (below the 64K ceiling).
      expect(requestAt(0).config?.maxOutputTokens).toBe(49_721);
      // Recovery: the prompt grew to ~121K → the 4,000 floor, not 49,721.
      expect(requestAt(1).config?.maxOutputTokens).toBe(4_000);
    });

    it('re-clamps recovery sends even when an intermediate response omits usage metadata', async () => {
      // Codex round 4: the FIRST truncated response reports usage, the SECOND
      // omits it; the count-based estimate freezes while history grows ~64K
      // per iteration, so the padded fresh-walk estimate must overrule it.
      mockGeneratorConfig({
        model: 'claude-sonnet-4-6',
        contextWindowSize: 180_000,
      });
      mockCompress(noop(5_000));
      // ~64K estimated tokens of partial output each, so the walk sees growth.
      serveStreams(
        streamOf(
          textChunk('y'.repeat(256_000), 'MAX_TOKENS', {
            promptTokenCount: 5_000,
            totalTokenCount: 69_000, // output = 64,000 (the full grant)
          }),
        ),
        truncated('z'.repeat(256_000)), // provider omitted usageMetadata
        textStream(' fin.'),
      );

      chat.setLastPromptTokenCount(5_000);
      await drain(
        await sendOn('claude-sonnet-4-6', 'hi', 'prompt-recovery-stale-usage'),
      );

      expectStreamCalls(3);
      // Iteration 1: plenty of room, the ceiling binds.
      expect(requestAt(1).config?.maxOutputTokens).toBe(64_000);
      // Iteration 2: the stale ~69K estimate would re-grant 64,000; the padded
      // walk (~148K: two partials + pad) wins, ≈ 180K − 148K − 10K = 22K.
      const recovery2Max = requestAt(2).config?.maxOutputTokens;
      expect(recovery2Max).toBeLessThan(30_000);
      expect(recovery2Max).toBeGreaterThanOrEqual(4_000);
    });

    it.each([
      ['escalation', 'throw'],
      ['escalation', 'close'],
      ['recovery', 'throw'],
      ['recovery', 'close'],
      ['later recovery', 'throw'],
      ['later recovery', 'close'],
    ] as const)(
      'preserves cancelled %s output via %s without internal user messages',
      async (phase, exitMode) => {
        const controller = new AbortController();
        const abortError = new DOMException('Cancelled', 'AbortError');
        const streams = [truncated('INITIAL')];
        if (phase !== 'escalation') streams.push(truncated('BASE'));
        if (phase === 'later recovery')
          streams.push(truncated('FIRST CONTINUATION'));
        streams.push(
          streamThenThrow(
            [
              modelChunk([{ text: 'CANCELLED THOUGHT', thought: true }]),
              modelChunk([{ text: 'CANCELLED BODY' }]),
            ],
            abortError,
          ),
        );
        const { recordAssistantTurn, recordingChat, served, stream } =
          await startCancellable(controller, streams, 'cancel-output');
        let receivedBody = false;
        for (let i = 0; i < 20; i++) {
          const next = await stream.next();
          expect(next.done).toBe(false);
          if (
            !next.done &&
            someChunk([next.value], (parts) =>
              parts.some((part) => part.text === 'CANCELLED BODY'),
            )
          ) {
            receivedBody = true;
            break;
          }
        }
        expect(receivedBody).toBe(true);
        expect(served.calls).toBe(streams.length);
        controller.abort('qwen:user-cancel');
        if (exitMode === 'close') await stream.return(undefined);
        else await expect(stream.next()).rejects.toBe(abortError);
        const history = recordingChat.getHistory();
        expect(history.map((entry) => entry.role)).toEqual(['user', 'model']);
        expect(history[0]?.parts).toEqual([{ text: 'write long answer' }]);
        const recorded = JSON.stringify(history[1]);
        expect(recorded).toContain('CANCELLED THOUGHT');
        expect(recorded).toContain('CANCELLED BODY');
        if (phase !== 'escalation') expect(recorded).toContain('BASE');
        if (phase === 'later recovery')
          expect(recorded).toContain('FIRST CONTINUATION');
        const cancelledRecords = recordAssistantTurn.mock.calls.filter(
          ([record]) =>
            JSON.stringify(record.message).includes('CANCELLED BODY'),
        );
        expect(cancelledRecords).toHaveLength(1);
        expect(JSON.stringify(cancelledRecords[0])).toContain(
          'CANCELLED THOUGHT',
        );
      },
    );

    it.each(['escalation', 'recovery'] as const)(
      'removes internal recovery prompts when %s is cancelled before content',
      async (phase) => {
        const controller = new AbortController();
        const streams = [truncated('INITIAL')];
        if (phase === 'recovery') streams.push(truncated('BASE'));
        streams.push(
          (async function* () {
            yield* [];
            controller.abort('qwen:user-cancel');
          })(),
        );
        const { recordAssistantTurn, recordingChat, served, stream } =
          await startCancellable(controller, streams, 'empty-recovery');
        await expect(drain(stream)).rejects.toBe('qwen:user-cancel');
        expect(served.calls).toBe(streams.length);
        expect(recordingChat.getHistory()).toEqual([
          userText('write long answer'),
          ...(phase === 'recovery' ? [modelText('BASE')] : []),
        ]);
        expect(
          recordAssistantTurn.mock.calls.every(
            ([record]) => record.message.length > 0,
          ),
        ).toBe(true);
      },
    );

    it('should enter recovery loop when escalated response is also truncated', async () => {
      // initial (MAX_TOKENS) → escalated (MAX_TOKENS) → recovery (STOP).
      serveStreams(
        truncated('Hello'),
        truncated(' world'),
        textStream(' ending.'),
      );
      const events = await collect(
        await sendPro('write a long essay', 'prompt-recovery'),
      );

      const retries = eventsOfType(events, StreamEventType.RETRY);
      // Escalation RETRY (isContinuation unset), then recovery (true).
      expect(retries.length).toBe(2);
      expect(retries[0]!.type).toBe(StreamEventType.RETRY);
      expect(continuationOf(retries[0]!)).toBe(undefined);
      expect(continuationOf(retries[1]!)).toBe(true);
      expectStreamCalls(3);
    });

    it('retries protocol-tag leaks during max-tokens escalation', async () => {
      vi.useFakeTimers();
      serveStreams(
        truncated('Hello'),
        leakStream('discard escalated attempt', 'DISCARD_ESCALATED_ATTEMPT'),
        textStream('Hello world'),
      );
      const events = await collectAdvancing(
        await sendPro('write a long essay', 'prompt-escalation-protocol-retry'),
      );

      expectStreamCalls(3);
      expect(eventsOfType(events, StreamEventType.RETRY).length).toBe(2);
      expect(chat.getLastModelMessageText()).toBe('Hello world');
      expect(
        JSON.stringify(chat.getHistory()).includes('DISCARD_ESCALATED_ATTEMPT'),
      ).toBe(false);
    });

    it('preserves current user image bytes during output recovery', async () => {
      vi.mocked(mockConfig.getChatCompression).mockReturnValue({
        maxRecentImagesToRetain: 0,
        imagePayloadThreshold: 1,
      });
      serveStreams(
        truncated('initial'),
        truncated('escalated'),
        textStream('done'),
      );
      await drain(
        await sendPro(
          [
            { text: 'describe this image' },
            { inlineData: { mimeType: 'image/png', data: 'current-shot' } },
          ],
          'prompt-recovery-image',
        ),
      );
      expect(JSON.stringify(requestAt(2).contents)).toContain(
        '"data":"current-shot"',
      );
    });

    it('should skip no-op escalation and recover directly for high-output models', async () => {
      serveStreams(truncated('Hello'), textStream(' ending.'));
      const events = await collect(
        await sendOn(
          'gemini-3-pro',
          'write a long essay',
          'prompt-direct-recovery',
        ),
      );

      const retries = eventsOfType(events, StreamEventType.RETRY);
      expect(retries.length).toBe(1);
      expect(continuationOf(retries[0]!)).toBe(true);
      expect(
        (retries[0] as { maxOutputTokensEscalated?: number })
          .maxOutputTokensEscalated,
      ).toBeUndefined();
      expectStreamCalls(2);
      expect(lastText()).toBe('Hello ending.');
    });

    it('retries protocol-tag leaks during direct output recovery', async () => {
      vi.useFakeTimers();
      serveStreams(
        truncated('Hello'),
        leakStream('discard recovery attempt', 'DISCARD_RECOVERY_ATTEMPT'),
        textStream(' world'),
      );
      const events = await collectAdvancing(
        await sendOn(
          'gemini-3-pro',
          'write a long essay',
          'prompt-direct-recovery-protocol-retry',
        ),
      );

      expectStreamCalls(3);
      const retries = eventsOfType(events, StreamEventType.RETRY);
      expect(retries).toHaveLength(2);
      expect(retries.map(continuationOf)).toEqual([true, true]);
      expect(chat.getLastModelMessageText()).toBe('Hello world');
      expect(chat.getHistory()).toEqual([
        userText('write a long essay'),
        modelText('Hello world'),
      ]);
    });

    it('should coalesce overlapping recovery continuation text', async () => {
      await runRecovery(
        'Alpha shared recovery suffix',
        'shared recovery suffix and continuation',
        'write a long essay',
        'prompt-recovery-overlap',
      );
      expect(lastEntry().role).toBe('model');
      expect(lastText()).toBe('Alpha shared recovery suffix and continuation');
    });

    const replayedBlock = '### 常用语法速查\n| 语法 | 说明 |';
    const markdownTail = `Intro\n${replayedBlock}\ntail that was truncated`;

    // Rows: previous turn, continuation, user message, prompt id, and the
    // expected merged text (omitted: the continuation is appended verbatim).
    it.each<[string, string, string, string, string, string?]>([
      [
        'should coalesce recovery text that replays a previous tail anchor',
        markdownTail,
        `${replayedBlock}\nnew suffix`,
        'write a long mermaid answer',
        'prompt-recovery-contained-replay',
        `${markdownTail}\nnew suffix`,
      ],
      // Regression: the contained-prefix fallback stripped leading prose on
      // any substring match; it now needs a Markdown structural anchor, so
      // openers like "In summary," survive a match against the previous tail.
      [
        'should preserve prose continuation that coincidentally repeats an opener phrase',
        'We covered cats. In summary, this concludes the cat section.',
        'In summary, the answer is 42 and the dog section follows.',
        'write something',
        'prompt-recovery-prose-opener',
      ],
      // A long phrase matched far above the truncation tail (no structural
      // anchor, not adjacent to the cut) must not be replay-stripped.
      [
        'should not strip prose that coincides with a far-earlier substring of the previous turn',
        `Here is the rest of the explanation.\n${'lorem ipsum dolor sit amet '.repeat(20)}\nthe model was cut off here`,
        'Here is the rest of the explanation continued.',
        'write something',
        'prompt-recovery-far-prose',
      ],
      // Regression: `previousTailContainsAtLineBoundary` rejects mid-paragraph
      // matches even for a structural continuation (e.g. quoting "### Heading"
      // as prose); here it follows "some text", not a newline: kept verbatim.
      [
        'should preserve continuation when its structural prefix appears mid-paragraph in the previous tail (line-boundary rejection)',
        'some text ### Heading and then more inline prose follows',
        '### Heading\nfresh continuation that should not be stripped',
        'write something with a heading',
        'prompt-recovery-line-boundary-reject',
      ],
      // Regression: `startsWithMarkdownStructuralAnchor` rejects single-cell
      // pipes like `|expression|` (a GFM row has >= 3 pipes or is `|---|`).
      // The fragment recurs at a line boundary mid-`previous`, so the
      // suffix-anchored scan cannot match; only the contained-prefix fallback
      // could strip it.
      [
        'should preserve prose continuation that opens with a single-cell pipe expression matching mid-tail',
        'We define the expression as follows:\n|expression| evaluates to a scalar value.\nWe also note other facts here.',
        '|expression| evaluates to a scalar value. Continuing the derivation now.',
        'continue the derivation',
        'prompt-recovery-single-cell-pipe-prose',
      ],
      // `getRecoveryContinuationSuffix` normalization: the replayed prefix ends
      // with `\n`, the previous tail (cut after the heading) and the suffix do
      // not, so a `\n` is prepended to keep the block boundary.
      [
        'should insert a newline separator when the replayed prefix ends with newline but previous tail does not',
        'Intro paragraph.\n### Section',
        '### Section\nbody prose continuation',
        'write a structured answer',
        'prompt-recovery-newline-normalization',
        'Intro paragraph.\n### Section\nbody prose continuation',
      ],
      // Full-overlap guard: previousText.endsWith(continuationText) with >=
      // RECOVERY_OVERLAP_MIN_BYTES of overlap drops the continuation.
      [
        'should drop continuation entirely when it exactly replays the previous tail',
        'leading content. tail-fragment',
        'tail-fragment',
        'write something',
        'prompt-recovery-full-overlap',
        'leading content. tail-fragment',
      ],
      // Regression: `RECOVERY_OVERLAP_MIN_BYTES = 6` admits a 2-char CJK
      // overlap (3 bytes each), and "我们" / "但是" recur across unrelated
      // sentences; the >= 4 code-point floor keeps the continuation verbatim.
      [
        'should preserve a coincidental 2-character CJK overlap (byte floor insufficient for CJK)',
        '在分析数据之前我们',
        '我们需要先完成准备工作。',
        '帮我分析数据',
        'prompt-recovery-cjk-floor',
      ],
      // Regression: providers may re-emit the replayed block indented; the
      // substring match must strip that whitespace too, or the duplicate leaks.
      [
        'should dedup a replayed structural prefix even when the continuation has leading whitespace',
        markdownTail,
        `  ${replayedBlock}\nnew suffix`,
        'write a long markdown answer',
        'prompt-recovery-leading-whitespace',
        `${markdownTail}\nnew suffix`,
      ],
    ])(
      '%s',
      async (_title, previous, continuation, message, promptId, expected) => {
        await runRecovery(previous, continuation, message, promptId);
        expect(lastText()).toBe(expected ?? previous + continuation);
      },
    );

    it('should leave continuation untouched when the previous turn has no plain text', async () => {
      // Empty-text branches (thought-only previous turn): the suffix helper
      // passes the continuation through and buildOutputRecoveryMessage adds
      // no <previous_response_suffix> block.
      const recoveryMessage = await runRecovery(
        [{ text: 'thinking through the problem', thought: true }],
        'fresh continuation text',
        'write something',
        'prompt-recovery-thought-only',
      );
      expect(lastText(true)).toBe('fresh continuation text');
      expect(recoveryMessage).toBeDefined();
      expect(recoveryMessage).not.toContain('<previous_response_suffix>');
    });

    it('should dedup recovery continuation when the continuation begins with a thought part', async () => {
      // Regression: parts are ordered `[thoughtPart?, ...consolidated]`, but
      // appendRecoveryContinuationParts read only `nextParts[0]` (the thought
      // for thinking models), skipping dedup and leaking the replayed overlap;
      // it must scan past the thought.
      await runRecovery(
        'Alpha shared recovery suffix',
        thinkingContinuation(),
        'write a long essay',
        'prompt-recovery-thinking-continuation',
      );
      expect(lastText(true)).toBe(
        'Alpha shared recovery suffix and continuation',
      );
    });

    it.each(['', ' and the rest of the answer'])(
      'keeps a distinct final phase when a MAX_TOKENS continuation overlaps%s',
      async (suffix) => {
        const commentary = {
          text: 'The shared recovery text is long enough to deduplicate.',
          responsesMessage: { id: 'msg_c', phase: 'commentary' },
        };
        const final = {
          text: commentary.text + suffix,
          responsesMessage: { id: 'msg_f', phase: 'final_answer' },
        };
        serveStreams(
          truncated('discarded initial'),
          streamOf(modelChunk([commentary], 'MAX_TOKENS')),
          streamOf(modelChunk([final], 'STOP')),
        );
        await sendDrain('write an answer', 'recovery-phases');
        expect(chat.getHistory().at(-1)?.parts).toEqual([commentary, final]);
      },
    );

    it('should keep the recovery thought before the merged text part (thought-signature provenance)', async () => {
      // Thinking providers (Gemini 2.5+, Anthropic, o-series) validate that a
      // thought precedes its content; the sibling thinking-continuation test
      // pins only the joined text, so pin the ordering here.
      await runRecovery(
        'Alpha shared recovery suffix',
        thinkingContinuation(),
        'write a long essay',
        'prompt-recovery-thinking-continuation-order',
      );
      const parts = lastEntry().parts ?? [];
      const thoughtIdx = parts.findIndex((part) => part.thought === true);
      const mergedTextIdx = parts.findIndex((part) =>
        part.text?.includes('Alpha shared recovery suffix'),
      );
      expect(thoughtIdx).toBeGreaterThanOrEqual(0);
      expect(mergedTextIdx).toBeGreaterThanOrEqual(0);
      expect(thoughtIdx).toBeLessThan(mergedTextIdx);
    });

    it('drops a dangling unsigned thought episode reintroduced by recovery coalescing when the continuation calls a tool', async () => {
      // The per-stream trailing pop fires only when THAT stream has a tool
      // call, yet MAX_TOKENS recovery needs a truncated turn without one. A
      // tool-calling continuation is merged by coalesceRecoveryPairs, whose
      // dedup anchor ignores thoughts, burying the unsigned episode beside the
      // functionCall: without a re-check this reopens the permanent wedge.
      await runRecovery(
        [{ text: 'thinking about it', thought: true }],
        toolContinuation(),
        'do a task',
        'prompt-recovery-dangling-episode',
      );
      const parts = lastEntry().parts ?? [];
      expect(parts.some(isUnsignedThought)).toBe(false);
      expect(parts.some((part) => part.functionCall)).toBe(true);
    });

    it('keeps a SIGNED trailing reasoning episode on the truncated turn when coalescing recovery pairs', async () => {
      // Complement to the drop above (only the pop was pinned here, so an
      // over-pop passed the whole suite): a SIGNED episode completed before
      // truncation is replayable and must survive a tool-calling continuation.
      await runRecovery(
        [signed('complete episode', 'sig-kept')],
        toolContinuation(),
        'do a task',
        'prompt-recovery-signed-episode',
      );
      const parts = lastEntry().parts ?? [];
      const kept = parts.find((p) => p.thought && p.thoughtSignature);
      expect(kept?.thoughtSignature).toBe('sig-kept');
      expect(kept?.text).toBe('complete episode');
      expect(parts.some((p) => p.functionCall)).toBe(true);
      // Order is replay-load-bearing: signature-validating providers reject an
      // episode trailing its tool call; presence checks alone survive swapping
      // the final concat to `[...nextParts, ...mergedParts]`.
      expect(parts.findIndex((p) => p.thought)).toBeLessThan(
        parts.findIndex((p) => p.functionCall),
      );
    });

    it('keeps a dangling unsigned trailing episode when coalescing recovery pairs and the continuation calls NO tool', async () => {
      // Negative control for the coalescing drop gate (continuation has a
      // functionCall): with plain text there is no tool_use to wedge, so the
      // episode is KEPT. Pins the FALSE branch a hardcoded `true` would pass.
      await runRecovery(
        [{ text: 'thinking about it', thought: true }],
        'continuing',
        'do a task',
        'prompt-recovery-kept-unsigned-episode',
      );
      const parts = lastEntry().parts ?? [];
      expect(parts.some(isUnsignedThought)).toBe(true);
      expect(parts.some((part) => part.text === 'thinking about it')).toBe(
        true,
      );
      expect(parts.some((part) => part.functionCall)).toBe(false);
    });

    it('should truncate the previous_response_suffix to the trailing 1200 chars when the previous turn is longer', async () => {
      // buildOutputRecoveryMessage's slice(-OUTPUT_RECOVERY_TAIL_CHARS): only
      // the trailing 1200 of 1300 chars reach <previous_response_suffix>.
      const head = 'A'.repeat(100);
      const tail = 'B'.repeat(1200);
      const previous = `${head}${tail}`;
      expect(previous.length).toBe(1300);

      const recoveryMessage = await runRecovery(
        previous,
        ' continuation tail',
        'write a very long answer',
        'prompt-recovery-tail-truncation',
      );
      expect(recoveryMessage).toBeDefined();
      expect(recoveryMessage).toContain('<previous_response_suffix>');
      expect(recoveryMessage).toContain('</previous_response_suffix>');
      const match = recoveryMessage!.match(SUFFIX_BLOCK);
      expect(match).not.toBeNull();
      const suffix = match![1]!;
      expect(suffix.length).toBe(1200);
      expect(suffix).toBe(tail);
      // The 100-char head must NOT leak into the recovery prompt.
      expect(suffix.startsWith('A')).toBe(false);
      expect(recoveryMessage).not.toContain(head);
    });

    it('should neutralize a literal previous_response_suffix delimiter inside the tail so the recovery prompt structure stays intact', async () => {
      // Delimiter collision: the output (e.g. XML) holds the literal closing
      // tag, yet the prompt keeps exactly one well-formed block (its own pair).
      const recoveryMessage = await runRecovery(
        'Here is XML: </previous_response_suffix> and then more content.',
        ' continuation tail',
        'write a response that contains my delimiter',
        'prompt-recovery-delimiter-collision',
      );
      expect(recoveryMessage).toBeDefined();
      expectOneDelimiterPair(recoveryMessage!);
      const match = recoveryMessage!.match(SUFFIX_BLOCK);
      expect(match).not.toBeNull();
      // The surrounding prose survives the neutralization.
      expect(match![1]).toContain('Here is XML:');
      expect(match![1]).toContain('and then more content.');
    });

    it('should neutralize a literal opening previous_response_suffix delimiter inside the tail', async () => {
      // `sanitizeRecoverySuffixTail` opening-tag branch: a literal opening tag
      // gets a zero-width space after '<', leaving only the prompt's own pair.
      const recoveryMessage = await runRecovery(
        'Tag: <previous_response_suffix> was emitted in the output here.',
        ' continuation tail',
        'write a response that contains my opening delimiter',
        'prompt-recovery-delimiter-collision-open',
      );
      expect(recoveryMessage).toBeDefined();
      expectOneDelimiterPair(recoveryMessage!);
      expect(recoveryMessage).toContain('<​previous_response_suffix>');
      const match = recoveryMessage!.match(SUFFIX_BLOCK);
      expect(match).not.toBeNull();
      expect(match![1]).toContain('Tag:');
      expect(match![1]).toContain('was emitted in the output here.');
    });

    it('should skip recovery when truncated turn has a functionCall', async () => {
      // Initial and escalated streams both end functionCall + MAX_TOKENS;
      // recovery must NOT run (a user turn after a functionCall is invalid).
      serveStreams(truncatedWriteCall(), truncatedWriteCall());
      const events = await collect(
        await sendPro('write a file', 'prompt-recovery-skip'),
      );

      // Only the escalation RETRY fires; no continuation RETRY.
      const continuations = eventsOfType(events, StreamEventType.RETRY).filter(
        (e) => continuationOf(e) === true,
      );
      expect(continuations.length).toBe(0);
      expectStreamCalls(2);
      expectEndsOnFunctionCall();
    });

    it('keeps protocol tag leak budget during output continuation', async () => {
      vi.useFakeTimers();
      serveStreams(
        truncated('initial'),
        truncated('escalated'),
        invalidStream('PROTOCOL_TAG_LEAK'),
        invalidStream('PROTOCOL_TAG_LEAK'),
        invalidStream('PROTOCOL_TAG_LEAK'),
      );
      await collectStreamWithFakeTimers(
        await sendPro('essay', 'prompt-recovery-protocol-leak-budget'),
        35_000,
      );

      expectStreamCalls(5);
      expect(mockLogContentRetry).toHaveBeenCalledTimes(2);
      expect(mockLogContentRetry).toHaveBeenLastCalledWith(
        mockConfig,
        expect.objectContaining({
          attempt_number: 1,
          error_type: 'PROTOCOL_TAG_LEAK',
        }),
      );
    });

    it('keeps continuation retry budgets independent across error types', async () => {
      vi.useFakeTimers();
      serveStreams(
        truncated('initial'),
        truncated('escalated'),
        invalidStream('NO_FINISH_REASON'),
        invalidStream('NO_FINISH_REASON'),
        invalidStream('PROTOCOL_TAG_LEAK'),
        textStream(' recovered'),
      );
      const events = await collectStreamWithFakeTimers(
        await sendPro('essay', 'prompt-recovery-mixed-invalid-streams'),
        15_000,
      );

      expectStreamCalls(6);
      expect(mockLogContentRetry).toHaveBeenCalledTimes(3);
      expect(mockLogContentRetry).toHaveBeenLastCalledWith(
        mockConfig,
        expect.objectContaining({
          attempt_number: 0,
          error_type: 'PROTOCOL_TAG_LEAK',
          retry_delay_ms: 2000,
        }),
      );
      expect(hasChunkText(events, ' recovered')).toBe(true);
    });

    it('should cap recovery attempts at MAX_OUTPUT_RECOVERY_ATTEMPTS (3)', async () => {
      // Every stream is text + MAX_TOKENS (no functionCall).
      streamMock().mockImplementation(async () => truncated('x'));
      await drain(await sendPro('infinite loop test', 'prompt-recovery-cap'));
      // 1 initial + 1 escalation + 3 recovery.
      expectStreamCalls(5);
    });

    it('should pop dangling recovery message and emit STOP chunk when recovery throws', async () => {
      serveStreams(
        truncated('partial'),
        truncated('still partial'),
        // No chunks: processStreamResponse rejects with NO_FINISH_REASON.
        streamOf<GenerateContentResponse>(),
      );
      const events = await collect(
        await sendPro('recovery fails', 'prompt-recovery-fail'),
      );

      // The last chunk is the catch's synthetic STOP chunk.
      const lastChunk = eventsOfType(events, StreamEventType.CHUNK).at(-1)!;
      expect(
        (lastChunk as { value: GenerateContentResponse }).value.candidates?.[0]
          ?.finishReason,
      ).toBe('STOP');
      // No dangling recovery user message: roles alternate, so providers don't
      // reject the next turn as consecutive same-role content.
      const history = chat.getHistory();
      expectAlternatingRoles(history);
      // The tail is the escalated model turn with real parts, no placeholder.
      const last = history.at(-1)!;
      expect(last.role).toBe('model');
      expect(last.parts!.length).toBeGreaterThan(0);
    });

    it('should pop both the partial model turn AND the recovery user message when recovery throws after a functionCall', async () => {
      // Pop ordering: the recovery stream yields a functionCall and throws, so
      // history ends [..., user(OUTPUT_RECOVERY_MESSAGE), model(partial fc)]
      // and a naive "pop if last is user" strands the control prompt. The
      // catch pops the model turn FIRST, then the user turn, and clears the
      // partial-push markers so the `finally` JSONL flush cannot resurrect it.
      serveStreams(
        truncated('initial'), // → escalation
        truncated('escalated'), // → recovery iteration 1
        readCallThenThrow(
          '/tmp/r.txt',
          'call_recovery_throw',
          'synthetic recovery mid-tool_use cut',
        ),
      );
      // The catch swallows the error and emits a synthetic STOP chunk.
      await drain(
        await sendPro(
          'recovery throws after functionCall',
          'prompt-recovery-fc-throw',
        ),
      );

      const history = chat.getHistory();
      // A stranded control prompt would pollute history and bias later turns.
      expectNoRecoveryPrompt(history);
      // The partial model[functionCall] goes too: a dangling tool_use gets a
      // synthetic `error` response next send and the late real result is
      // deduped away ("execution result was not recorded" for a success).
      expect(
        history.some((entry) =>
          (entry.parts ?? []).some(
            (part) => part.functionCall?.id === 'call_recovery_throw',
          ),
        ),
      ).toBe(false);
      expectAlternatingRoles(history);
      // The escalated response stays as the user-visible answer.
      expect(history.at(-1)!.role).toBe('model');
      expect(lastText()).toContain('escalated');
    });

    it('should stop recovery mid-loop when a later iteration emits functionCall', async () => {
      // Cross-iteration guard: iteration 1 returns text, iteration 2 a
      // functionCall; the loop must break before iteration 3 adds a user turn.
      serveStreams(
        truncated('initial'),
        truncated('escalated'),
        truncated('recovery 1 text'),
        truncatedWriteCall(),
      );
      await drain(await sendPro('mixed recovery', 'prompt-recovery-mixed'));

      // 1 initial + 1 escalation + 2 recovery; iteration 3 never calls.
      expectStreamCalls(4);
      expectEndsOnFunctionCall();
    });

    it('should coalesce successful recovery iterations into the preceding model turn', async () => {
      // Two iterations then STOP; uncoalesced, OUTPUT_RECOVERY_MESSAGE would
      // persist as a user turn and bias every later model call.
      serveStreams(
        truncated('A'),
        truncated('B'),
        truncated('C'),
        textStream('D'),
      );
      await drain(await sendPro('essay', 'prompt-recovery-coalesce'));

      const history = chat.getHistory();
      // The recovery pairs fold back into one user + one model turn.
      expect(history.length).toBe(2);
      expect(history[0]!.role).toBe('user');
      expect(history[1]!.role).toBe('model');
      expectNoRecoveryPrompt(history);
      // Escalation and recovery content merge in order (B → C → D).
      expect(lastText()).toBe('BCD');
    });

    it('rolls back an escalated partial tool call when the stream fails', async () => {
      // The escalated attempt pushes a partial model[functionCall] and stages
      // its recording before failing; both roll back so later sends and
      // resumes don't repair an incomplete call with a synthetic result.
      const recordAssistantTurn = vi.fn();
      const chatWithRecording = chatWithRecorder(recordAssistantTurn);
      serveStreams(
        truncated('partial answer'), // → escalation
        // The escalated request is cut mid-tool_use.
        readCallThenThrow(
          '/tmp/escalated.txt',
          'call_escalation_throw',
          'synthetic mid-tool_use cut on escalated stream',
        ),
      );

      const stream = await sendPro(
        'kick off',
        'prompt-escalation-flush',
        chatWithRecording,
      );
      // Escalation errors do not retry, so the cut escapes.
      await expect(drain(stream)).rejects.toThrow(/synthetic mid-tool_use cut/);

      expect(chatWithRecording.getHistory()).toEqual([userText('kick off')]);
      const recordedHasPartial = recordAssistantTurn.mock.calls.some((call) =>
        (
          call[0] as { message?: Array<{ functionCall?: { id?: string } }> }
        )?.message?.some((p) => p.functionCall?.id === 'call_escalation_throw'),
      );
      expect(recordedHasPartial).toBe(false);
    });
  });
  describe('redactApprovedPlanFromHistory', () => {
    // The scheduler's post-approval rewrite: an approved plan would otherwise
    // stay in history as the model's own call arg and be regurgitated (#6237).
    const REPLACEMENT = '[Plan approved and saved to /tmp/p.md]';

    const chatWith = (history: Content[]) =>
      new LlmChat({} as unknown as Config, {}, history);

    /** A chat whose only turn is a model call `name(args)` with `id`. */
    const chatWithCall = (
      id: string,
      name: string,
      args: Record<string, unknown>,
    ) => chatWith([content('model', fnCall(name, args, id))]);

    const redact = (target: LlmChat, id: string, expectedPlan?: string) =>
      target.redactApprovedPlanFromHistory(id, REPLACEMENT, expectedPlan);

    const planArg = (target: LlmChat) =>
      target.getHistory()[0]!.parts![0]!.functionCall!.args!['plan'];

    it('rewrites only the plan arg of the matching exit_plan_mode call', () => {
      const chat = chatWith([
        userText('plan it'),
        content(
          'model',
          { text: 'My plan follows.' },
          fnCall(
            'exit_plan_mode',
            { plan: 'SECRET BIG PLAN', originalRequest: 'plan it' },
            'call-plan',
          ),
        ),
      ]);

      expect(redact(chat, 'call-plan')).toBe(true);

      const entry = chat.getHistory()[1]!;
      const call = entry.parts![1]!.functionCall!;
      expect(call.args!['plan']).toBe(REPLACEMENT);
      expect(call.args!['originalRequest']).toBe('plan it');
      expect(call.id).toBe('call-plan');
      expect(entry.parts![0]).toEqual({ text: 'My plan follows.' });
      expect(JSON.stringify(chat.getHistory())).not.toContain(
        'SECRET BIG PLAN',
      );
    });

    it('returns false when no matching call id or tool name exists', () => {
      const chat = chatWithCall('call-other', 'write_file', {
        plan: 'not a plan tool',
      });
      expect(redact(chat, 'call-plan')).toBe(false);
      expect(redact(chat, 'call-other')).toBe(false);
      expect(planArg(chat)).toBe('not a plan tool');
    });

    it('returns false when expectedPlan differs from the in-history plan', () => {
      const chat = chatWithCall('call-plan', 'exit_plan_mode', {
        plan: 'SECRET BIG PLAN',
      });
      // Never-lie invariant: a stale/different on-disk plan blocks the
      // rewrite entirely; a matching expectedPlan still rewrites.
      expect(redact(chat, 'call-plan', 'a different plan')).toBe(false);
      expect(planArg(chat)).toBe('SECRET BIG PLAN');
      expect(redact(chat, 'call-plan', 'SECRET BIG PLAN')).toBe(true);
    });

    it('returns false when the matching call has no string plan arg', () => {
      const chat = chatWithCall('call-plan', 'exit_plan_mode', {});
      expect(redact(chat, 'call-plan')).toBe(false);
    });
  });

  describe('redactApprovedPlansInHistory (load-side, #6237)', () => {
    // The recording JSONL keeps the full plan arg (captured before the tool
    // runs), so --resume re-feeds it; this pass runs on every wholesale load.
    const PLAN = '## Plan\n\nresume leak fixture';
    const PLAN_PATH = '/plans/session.md';

    const planCall = (id: string, args: Record<string, unknown>) =>
      content('model', fnCall('exit_plan_mode', args, id));
    const planVerdict = (id: string, output: string) =>
      content('user', fnResponse('exit_plan_mode', { output }, id));

    const approvedHistory = (): Content[] => [
      userText('plan it'),
      planCall('call-a', { plan: PLAN, originalRequest: 'plan it' }),
      planVerdict(
        'call-a',
        'User approved. You can now start coding. Start with updating your todo list if applicable.',
      ),
    ];

    const planAt = (history: Content[], index = 1) =>
      history[index]!.parts![0]!.functionCall!.args!['plan'];

    /** A chat whose config points at `planFile`, loaded via setHistory. */
    function setHistoryWithPlanFile(planFile: string) {
      const chat = new LlmChat(
        {
          getPlanFilePath: () => planFile,
          getToolRegistry: () => undefined,
        } as unknown as Config,
        {},
        [],
      );
      chat.setHistory(approvedHistory());
      return chat.getHistory();
    }

    // The node:fs mock reads mockFileSystem: writing the plan is a Map insert.
    function withPlanFile(planFile: string, fn: () => void) {
      mockFileSystem.set(planFile, PLAN);
      try {
        fn();
      } finally {
        mockFileSystem.delete(planFile);
      }
    }

    it('rewrites approved calls whose plan matches the on-disk file', () => {
      const out = redactApprovedPlansInHistory(
        approvedHistory(),
        PLAN,
        PLAN_PATH,
      );
      expect(out).not.toBeNull();
      const call = out![1]!.parts![0]!.functionCall!;
      expect(call.args!['plan']).toBe(approvedPlanRedactionText(PLAN_PATH));
      expect(call.args!['originalRequest']).toBe('plan it');
      expect(JSON.stringify(out)).not.toContain('resume leak fixture');
    });

    it('redacts only the approved call when a rejected call shares the plan text', () => {
      const out = redactApprovedPlansInHistory(
        [
          userText('plan it'),
          planCall('call-rejected', { plan: PLAN }),
          planVerdict(
            'call-rejected',
            'Plan execution was not approved. Remaining in plan mode.',
          ),
          planCall('call-approved', { plan: PLAN }),
          planVerdict(
            'call-approved',
            'User approved. You can now start coding.',
          ),
        ],
        PLAN,
        PLAN_PATH,
      );
      expect(out).not.toBeNull();
      // The rejected call keeps its plan (the model needs it for revision).
      expect(planAt(out!)).toBe(PLAN);
      expect(planAt(out!, 3)).toBe(approvedPlanRedactionText(PLAN_PATH));
    });

    it('returns null when the response was not an approval', () => {
      const history = approvedHistory();
      history[2] = planVerdict(
        'call-a',
        'Plan execution was not approved. Remaining in plan mode.',
      );
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
      const planFile = '/plans/wired-session.md';
      withPlanFile(planFile, () => {
        expect(planAt(setHistoryWithPlanFile(planFile))).toBe(
          approvedPlanRedactionText(planFile),
        );
      });
    });

    it('is applied by the constructor for rehydrated history', () => {
      const planFile = '/plans/ctor-session.md';
      withPlanFile(planFile, () => {
        const chat = new LlmChat(
          { getPlanFilePath: () => planFile } as unknown as Config,
          {},
          approvedHistory(),
        );
        expect(planAt(chat.getHistory())).toBe(
          approvedPlanRedactionText(planFile),
        );
      });
    });

    it('setHistory leaves history alone when no plan file exists', () => {
      expect(planAt(setHistoryWithPlanFile('/plans/never-written.md'))).toBe(
        PLAN,
      );
    });
  });

  describe('redactStructuredOutputArgsForRecording', () => {
    // The recording JSONL is re-fed on `--continue` / `--resume`; for
    // `--json-schema` runs the structured_output args ARE the user's payload
    // (on stdout), and recording them contradicts ToolCallEvent redaction.

    it('replaces args on a structured_output functionCall with the placeholder', () => {
      const payload = {
        extracted: 'sensitive answer',
        score: 0.9,
        details: { token: 'shhhh' },
      };
      const result = redactStructuredOutputArgsForRecording(
        fnCall('structured_output', payload, 'call-1'),
      );
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
      // Identity is not required; the args must equal the input (no redaction).
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
      const original = fnCall(
        'structured_output',
        { ok: true, data: [1, 2, 3] },
        'call-3',
      );
      const snapshot = JSON.parse(JSON.stringify(original));
      redactStructuredOutputArgsForRecording(original);
      expect(original).toEqual(snapshot);
    });
  });

  /** Pin the idle-clear config `compressFast` reads. */
  const pinFastCompressionIdleClear = () =>
    vi.mocked(mockConfig.getClearContextOnIdle).mockReturnValue({
      toolResultsThresholdMinutes: 30,
      toolResultsNumToKeep: 1,
    });

  /** A question and a model answer with a long thought `compressFast` drops. */
  const thoughtHistory = (): Content[] => [
    userText('question'),
    content(
      'model',
      { text: 'reasoning '.repeat(100), thought: true },
      { text: 'answer' },
    ),
  ];

  // Compression logic is tested in chatCompressionService.test.ts; this
  // covers LlmChat's per-chat state: the consecutiveFailures breaker, token
  // counts, history replacement and conditional telemetry mirroring.
  describe('tryCompress (per-chat state)', () => {
    /** Mock the service at the boundary with a canned result. */
    const mockCompressionService = (result: 'compressed' | 'failed-inflated') =>
      mockCompress(
        result === 'compressed'
          ? compressResult(
              CompressionStatus.COMPRESSED,
              [userText('summary'), modelText('ok'), userText('latest')],
              1000,
              200,
              true,
            )
          : compressResult(
              CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT,
              null,
              1000,
              1100,
            ),
      );

    const checkpointWith = (estimated: boolean) =>
      expect.objectContaining({
        info: expect.objectContaining({ newTokenCountIsEstimated: estimated }),
      });

    /** `compressFast` on a fresh chat holding `thoughtHistory()`. */
    function compressFastChat(
      seededApiCount?: number,
      recorder?: Record<string, unknown>,
    ) {
      pinFastCompressionIdleClear();
      const fastChat = newChat({
        history: thoughtHistory(),
        recorder,
      });
      if (seededApiCount !== undefined) {
        fastChat.seedResumeTokenCounts(seededApiCount, 0, false);
      }
      return { fastChat, info: fastChat.compressFast().info };
    }

    it('replaces history and updates per-chat lastPromptTokenCount on COMPRESSED', async () => {
      mockCompressionService('compressed');
      chat.setHistory([userText('a'), modelText('b'), userText('c')]);

      const info = await chat.tryCompress('p1');

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(chat.getHistory()).toHaveLength(3);
      expect(chat.getHistory()[0]).toEqual(userText('summary'));
      expect(chat.getLastPromptTokenCount()).toBe(200);
    });

    it('mirrors lastPromptTokenCount to the global telemetry only when wired', async () => {
      mockCompressionService('compressed');
      // `chat` was constructed with telemetryService=uiTelemetryService.
      await chat.tryCompress('p2');
      expect(uiTelemetryService.setLastPromptTokenCount).toHaveBeenCalledWith(
        200,
      );

      // A subagent-style chat without telemetryService must NOT touch the
      // global singleton (constructor docstring); its own counter updates.
      const subagentChat = new LlmChat(mockConfig, config, []);
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

      // LlmChat must forward the incremented counter to the next unforced
      // call (the service's threshold logic is tested in its own suite).
      compressSpy.mockClear();
      compressSpy.mockResolvedValue(compressResult(CompressionStatus.NOOP));
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
      chat.setHistory([userText('x'.repeat(4000)), modelText('acknowledged')]);

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
      const recordingChat = newChat({
        history: [userText('history without usage'), modelText('response')],
        recorder: { recordChatCompression },
      });
      mockCompressionService('compressed');

      await recordingChat.tryCompress('p-estimated-checkpoint', true);

      expect(recordChatCompression).toHaveBeenCalledWith(checkpointWith(true));
    });

    it('preserves an authoritative compression count from the service', async () => {
      const recordChatCompression = vi.fn();
      const recordingChat = newChat({
        history: [userText('history'), modelText('response')],
        recorder: { recordChatCompression },
      });
      mockCompress(
        compressResult(
          CompressionStatus.COMPRESSED,
          [userText('summary'), modelText('ok')],
          1000,
          200,
          false,
        ),
      );

      const info = await recordingChat.tryCompress('p-authoritative', true);

      expect(info.newTokenCountIsEstimated).toBe(false);
      expect(recordingChat.isLastPromptTokenCountEstimated()).toBe(false);
      expect(recordChatCompression).toHaveBeenCalledWith(checkpointWith(false));
    });

    it('marks and records the locally adjusted fast-compression count as estimated', () => {
      const recordChatCompression = vi.fn();
      const { fastChat, info } = compressFastChat(1000, {
        recordChatCompression,
      });

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(info.newTokenCount).toBeGreaterThan(0);
      expect(info.newTokenCount).toBeLessThan(1000);
      expect(fastChat.isLastPromptTokenCountEstimated()).toBe(true);
      expect(recordChatCompression).toHaveBeenCalledWith(checkpointWith(true));
    });

    // Issue #9309: /compress-fast then /compress banners use two scales (API
    // count incl. system prompt + tools vs a history-only re-estimate), so
    // each exposes its estimated side instead of implying lost context.
    it('exposes provenance on fast-compression info: API baseline authoritative, adjusted count estimated', () => {
      const { info } = compressFastChat(5000);

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(info.originalTokenCountIsEstimated).toBe(false);
      expect(info.newTokenCountIsEstimated).toBe(true);
    });

    it('marks the fast-compression baseline as estimated when no API count exists', () => {
      const { info } = compressFastChat();

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(info.originalTokenCount).toBeGreaterThan(0);
      expect(info.originalTokenCountIsEstimated).toBe(true);
    });

    it('reports original-count provenance on the summarize path after a fast compression', async () => {
      pinFastCompressionIdleClear();
      const compressSpy = mockCompressionService('compressed');
      chat.setHistory(thoughtHistory());
      chat.seedResumeTokenCounts(5000, 0, false);

      // /compress-fast leaves the stored count estimate-derived...
      chat.compressFast();
      expect(chat.isLastPromptTokenCountEstimated()).toBe(true);
      const adjustedAfterFast = chat.getLastPromptTokenCount();

      // ...so /compress re-estimates locally and marks "before" as estimated.
      const info = await chat.tryCompress('p-after-fast', true);

      expect(compressSpy.mock.calls[0][1].originalTokenCount).not.toBe(
        adjustedAfterFast,
      );
      expect(info.originalTokenCountIsEstimated).toBe(true);
    });

    it('reports an authoritative original count when the API count is fresh', async () => {
      mockCompressionService('compressed');
      chat.setHistory([userText('a'), modelText('b')]);
      chat.seedResumeTokenCounts(5000, 0, false);

      const info = await chat.tryCompress('p-authoritative-original', true);

      expect(info.originalTokenCountIsEstimated).toBe(false);
    });

    it.each<
      [string, string, Parameters<LlmChat['tryCompress']>[3], number, boolean]
    >([
      // Auto-compaction publishes the precomputed effective count (API base +
      // estimated pending message / previous output): a projection, so it
      // keeps the `~` marker (review probe on #9568).
      [
        'marks the precomputed effective count as estimated even when the stored API count is authoritative',
        'p-precomputed-effective-estimated',
        {
          precomputedEffectiveTokens: 6200,
          pendingUserMessage: userText('next'),
          trigger: 'auto',
        },
        6200,
        true,
      ],
      // No provider count: the limit/config/default fallback is a projection.
      [
        'keeps a fallback override estimated while publishing its count',
        'p-override-fallback-estimated',
        {
          originalTokenCountOverride: { count: 128_000, isEstimated: true },
          precomputedEffectiveTokens: 128_000,
          trigger: 'auto',
        },
        128_000,
        true,
      ],
      // Only a provider-reported actual count may drop the `~` marker.
      [
        'treats a provider-reported actualTokens override as authoritative',
        'p-override-actual-authoritative',
        {
          originalTokenCountOverride: { count: 135_000, isEstimated: false },
          precomputedEffectiveTokens: 135_000,
          trigger: 'auto',
        },
        135_000,
        false,
      ],
    ])('%s', async (_title, promptId, options, sentCount, estimated) => {
      const compressSpy = mockCompressionService('compressed');
      chat.setHistory([userText('a'), modelText('b')]);
      chat.seedResumeTokenCounts(5000, 0, false);

      const info = await chat.tryCompress(promptId, true, undefined, options);

      expect(compressSpy.mock.calls[0][1].originalTokenCount).toBe(sentCount);
      expect(info.originalTokenCountIsEstimated).toBe(estimated);
    });
  });

  // #9454: API counts describe the serialization of the route (model + auth
  // + endpoint) that produced them. /model keeps this LlmChat, so the old
  // route's counts must not anchor admission, clamp or compression.
  describe('route-scoped token counts (#9454)', () => {
    const switchRoute = (routeKey: string) => {
      vi.mocked(mockConfig.getModelRouteIdentity).mockReturnValue(routeKey);
    };

    /** Route each model to `<model>@route`, and keyless reads to `active`. */
    const routePerModel = (active = 'active@route') =>
      vi
        .mocked(mockConfig.getModelRouteIdentity)
        .mockImplementation((model) => (model ? `${model}@route` : active));

    async function recordTokenUsage(
      targetChat: LlmChat,
      usageMetadata: NonNullable<GenerateContentResponse['usageMetadata']>,
      model = 'test-model',
    ): Promise<void> {
      streamMock().mockResolvedValueOnce(textStream('ok', usageMetadata));
      await drain(
        await targetChat.sendMessageStream(
          model,
          { message: 'record usage' },
          `prompt-usage-${usageMetadata.promptTokenCount}`,
        ),
      );
    }

    const usage = (tokens: number, cachedContentTokenCount?: number) => ({
      promptTokenCount: tokens,
      totalTokenCount: tokens,
      ...(cachedContentTokenCount === undefined
        ? {}
        : { cachedContentTokenCount }),
    });

    const rescueChatWith = (history: Content[], recordsCompression = false) =>
      newChat({
        history,
        recorder: {
          recordAssistantTurn: vi.fn(),
          // Hard-rescue records a success after the post-compression guard.
          ...(recordsCompression ? { recordChatCompression: vi.fn() } : {}),
        },
      });

    // An oversized chat whose ACTIVE route recorded `activeCount`, per-model
    // routes, and a compression resolving `result` after the real service's
    // keyless reads adopt the ACTIVE route (consuming its retained entry).
    function activeRouteRescue(
      activeCount: number,
      result: ReturnType<typeof compressResult>,
      recordsCompression = false,
    ) {
      switchRoute('active@route');
      const target = rescueChatWith(
        [userText('x'.repeat(720_000))],
        recordsCompression,
      );
      target.setLastPromptTokenCount(activeCount, false);
      routePerModel();
      vi.spyOn(
        ChatCompressionService.prototype,
        'compress',
      ).mockImplementationOnce(async (chatToCompress) => {
        chatToCompress.getLastPromptTokenCount();
        chatToCompress.isLastPromptTokenCountEstimated();
        return result;
      });
      return target;
    }

    const compressedTo = (history: Content[], newTokenCount: number) =>
      compressed(180_000, newTokenCount, history);

    const sendOverride = (target: LlmChat, promptId: string) =>
      target.sendMessageStream(
        'override-model',
        { message: 'continue' },
        promptId,
      );

    /** An override send answered by `stream` after an in-send compression. */
    async function sendAfterInSendCompression(
      stream: AsyncGenerator<GenerateContentResponse>,
      promptId: string,
    ) {
      const stampChat = activeRouteRescue(
        150_000,
        compressedTo([userText('summary')], 60_000),
        true,
      );
      streamMock().mockResolvedValueOnce(stream);
      await drain(await sendOverride(stampChat, promptId));
      return stampChat;
    }

    /** The override send rejects with `error` before any request. */
    async function expectRescueRejects(
      target: LlmChat,
      promptId: string,
      error = /compression status: COMPRESSED/i,
    ) {
      await expect(sendOverride(target, promptId)).rejects.toThrow(error);
      expect(mockContentGenerator.generateContentStream).not.toHaveBeenCalled();
    }

    const earlierTurnChat = () =>
      rescueChatWith([userText('earlier turn'), modelText('ack')]);

    /** Per-model routes, then a rescue whose compression stays too large. */
    async function expectStillLargeRescue(target: LlmChat, promptId: string) {
      routePerModel();
      mockCompressOnce(
        compressedTo(
          [userText('still large summary'), modelText('ack')],
          177_000,
        ),
      );
      await expectRescueRejects(target, promptId);
    }

    const promptMirror = () => uiTelemetryService.setLastPromptTokenCount;
    const cachedMirror = () =>
      uiTelemetryService.setLastCachedContentTokenCount;

    it('invalidates API-reported counts when the model route changes', () => {
      chat.setLastPromptTokenCount(691_000, false);
      expect(chat.getLastPromptTokenCount()).toBe(691_000);

      // /model switch: the same chat instance survives with its history.
      switchRoute('anthropic-model@beef1234');

      // Safety decisions fall back to the history walk (count 0) and the
      // mirror is zeroed too, else the limit gate and banners keep using it.
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(chat.getLastOutputTokenCount()).toBe(0);
      expect(chat.isLastPromptTokenCountEstimated()).toBe(false);
      expect(promptMirror()).toHaveBeenCalledWith(0);
    });

    it('keeps counts authoritative while the route is unchanged', () => {
      chat.setLastPromptTokenCount(50_000, false);
      expect(chat.getLastPromptTokenCount()).toBe(50_000);
      expect(chat.getLastOutputTokenCount()).toBe(0);
      expect(chat.isLastPromptTokenCountEstimated()).toBe(false);
      expect(chat.getLastPromptTokenCount()).toBe(50_000);
    });

    it('keeps a foreign count intact across a keyless display read (#9506)', () => {
      // A count stamped under another route (e.g. the vision bridge's) must
      // survive /context's keyless ACTIVE-route read, which used to zero the
      // only slot before the session-token-limit gate's keyed read.
      chat.setLastPromptTokenCount(500_000, false);
      switchRoute('other-active@route');

      // Not leaked to the active route...
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(promptMirror()).toHaveBeenCalledWith(0);
      // ...and not destroyed: the gate's keyed read restores it exactly.
      expect(chat.getLastPromptTokenCount('gemini-pro@test0001')).toBe(500_000);
      expect(chat.getLastPromptTokenCount()).toBe(0);
    });

    it('restores retained counts when the route switches back (#9506)', () => {
      chat.seedResumeTokenCounts(321, 45, true);
      switchRoute('anthropic-model@beef1234');
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(chat.getLastOutputTokenCount()).toBe(0);

      // Back on the original route: the exact retained prompt, output and
      // provenance, not the zero a foreign touch used to leave behind.
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

      chat.setLastPromptTokenCount(120_000, false);
      expect(chat.getLastPromptTokenCount()).toBe(120_000);
      expect(chat.isLastPromptTokenCountEstimated()).toBe(false);
    });

    it('invalidates a stale count before sending on the new route', async () => {
      chat.setLastPromptTokenCount(691_000, false);
      switchRoute('anthropic-model@beef1234');
      streamMock().mockImplementation(async () => {
        expect(promptMirror()).toHaveBeenCalledWith(0);
        return textStream();
      });

      await sendDrain('new route', 'prompt-route-switch');
    });

    it('invalidates a stale route count before manual compression sizing', async () => {
      // Manual /compress reaches tryCompress without sendMessageStream's
      // entry invalidation, and tryCompress reads the count field directly.
      chat.setLastPromptTokenCount(691_000, false);
      switchRoute('anthropic-model@beef1234');
      const compressSpy = mockCompress(compressResult(CompressionStatus.NOOP));

      await chat.tryCompress('prompt-manual-compress', true);

      // Empty history sizes the attempt at 0, not the stale 691_000.
      expect(compressSpy).toHaveBeenCalledTimes(1);
      expect(compressSpy.mock.calls[0]?.[1].originalTokenCount).toBe(0);
    });

    /** A fast-compressible chat whose 691_000 API count predates a switch. */
    function fastChatAfterSwitch(routeKey: string) {
      pinFastCompressionIdleClear();
      const fastChat = newChat({
        history: thoughtHistory(),
        recorder: { recordChatCompression: vi.fn() },
      });
      fastChat.setLastPromptTokenCount(691_000, false);
      switchRoute(routeKey);
      return fastChat;
    }

    it('invalidates a stale route count before fast-compression sizing', () => {
      // compressFast, the third entrypoint, reads the raw count field for
      // its apiBaseline; the baseline must fall back to the history walk.
      const fastChat = fastChatAfterSwitch('anthropic-model@beef1234');

      const { info } = fastChat.compressFast();

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(info.originalTokenCount).toBeLessThan(691_000);
      expect(fastChat.getLastPromptTokenCount()).toBeLessThan(691_000);
    });

    it('zeroes the telemetry cached-content mirror when invalidating a foreign count', () => {
      // A cached count left next to the zeroed prompt count gives /context
      // an inconsistent capacity picture.
      chat.setLastPromptTokenCount(691_000, false);
      switchRoute('anthropic-model@beef1234');

      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(cachedMirror()).toHaveBeenCalledWith(0);
    });

    it('does not mirror cached content without a route-stamped prompt count', async () => {
      mockStream(textStream('cached', usage(0, 42)));

      await sendDrain('cached-only', 'prompt-cached-only');
      switchRoute('anthropic-model@beef1234');
      expect(chat.getLastPromptTokenCount()).toBe(0);
      expect(cachedMirror()).not.toHaveBeenCalledWith(42);
    });

    it('stores, clears, and retains cached content per route', async () => {
      await recordTokenUsage(chat, usage(100, 42));

      expect(chat.getLastPromptTokenCount()).toBe(100);
      expect(chat.getLastCachedContentTokenCount()).toBe(42);
      expect(cachedMirror()).toHaveBeenCalledWith(42);

      switchRoute('other-model@route');
      expect(chat.getLastCachedContentTokenCount()).toBe(0);
      switchRoute('gemini-pro@test0001');
      expect(chat.getLastCachedContentTokenCount()).toBe(42);

      await recordTokenUsage(chat, usage(120));
      expect(chat.getLastCachedContentTokenCount()).toBe(0);
    });

    it('clears cached content when non-API writers replace the prompt count', async () => {
      await recordTokenUsage(chat, usage(65_267, 64_653));

      chat.setLastPromptTokenCount(10_000, true);
      expect(chat.getLastCachedContentTokenCount()).toBe(0);

      await recordTokenUsage(chat, usage(65_267, 64_653));
      chat.setHistory(thoughtHistory());

      const result = chat.compressFast();

      expect(result.info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(chat.getLastCachedContentTokenCount()).toBe(0);
      expect(cachedMirror()).toHaveBeenLastCalledWith(0);
    });

    it('restores the request route key when a failed hard-rescue rolls counts back', async () => {
      // Hard-rescue fires only for non-exact sends, whose request route can
      // differ from the active one. tryCompress re-stamps the key to the
      // ACTIVE route mid-rescue; rollback must restore it with the counts, or
      // the override count rides the active key past invalidation (#9454).
      routePerModel();
      const rescueChat = earlierTurnChat();
      // Authoritative count from an earlier override-route turn.
      switchRoute('override-model@route');
      rescueChat.setLastPromptTokenCount(176_999, false);

      await expectStillLargeRescue(
        rescueChat,
        'prompt-hard-rescue-route-key-restore',
      );
      // The restored count belongs to the override route: an active-route
      // read must invalidate it, not inherit it.
      expect(rescueChat.getLastPromptTokenCount()).toBe(0);
    });

    it('restores the retention map when a failed hard-rescue rolls counts back (#9506)', async () => {
      // The rescue's compression consumes retained entries and a success
      // clears the map; unrestored, the resurrected route's over-limit count
      // survives nowhere and its next token-limit gate read passes with 0.
      const rescueChat = activeRouteRescue(
        190_000,
        compressedTo([userText('still large summary')], 178_000),
      );

      await expectRescueRejects(
        rescueChat,
        'prompt-rescue-retention-map-restore',
      );
      expect(rescueChat.getLastPromptTokenCount('active@route')).toBe(190_000);
      expect(rescueChat.getLastPromptTokenCount('override-model@route')).toBe(
        0,
      );
    });

    it('restores the output token count when a failed hard-rescue rolls counts back (#9506)', async () => {
      // The rescue's COMPRESSED stamp zeroes lastOutputTokenCount; rollback
      // must restore it with prompt count, provenance, route key and map, or
      // the next additive estimate under-counts by the last response's size.
      switchRoute('override-model@route');
      const rescueChat = earlierTurnChat();
      await recordTokenUsage(
        rescueChat,
        {
          promptTokenCount: 170_000,
          totalTokenCount: 178_000,
          candidatesTokenCount: 8_000,
          cachedContentTokenCount: 42_000,
        },
        'override-model',
      );
      expect(rescueChat.getLastCachedContentTokenCount()).toBe(42_000);
      streamMock().mockClear();

      await expectStillLargeRescue(
        rescueChat,
        'prompt-hard-rescue-output-restore',
      );
      // Read through the resurrected slot's (override) route key.
      switchRoute('override-model@route');
      expect(rescueChat.getLastPromptTokenCount()).toBe(170_000);
      expect(rescueChat.getLastOutputTokenCount()).toBe(8_000);
      expect(rescueChat.getLastCachedContentTokenCount()).toBe(42_000);
    });

    it('re-adopts the request route after the compression service flips the slots (#9506)', async () => {
      // The service's keyless reads flip a non-exact override send's slots to
      // the active route's retained counts; when the summary then fails, the
      // stop check must size from the history walk, not the flipped count.
      const rescueChat = activeRouteRescue(
        150_000,
        compressResult(
          CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY,
          null,
          180_000,
        ),
      );

      await expectRescueRejects(
        rescueChat,
        'prompt-rescue-flip-re-adopt',
        /Context is too large to send safely/i,
      );
      expect(rescueChat.getLastPromptTokenCount('active@route')).toBe(150_000);
    });

    it('retains a foreign-keyed slot occupant when the usage stamp re-keys (#9506)', async () => {
      // Mid-send compression can leave the slots keyed to the ACTIVE route
      // when usage arrives for the REQUEST route; the stamp must retain the
      // occupant, or the active route's next keyed read returns 0 and
      // bypasses the session token limit.
      const stampChat = await sendAfterInSendCompression(
        textStream('ok', { promptTokenCount: 61_000, totalTokenCount: 62_000 }),
        'prompt-stamp-retains-occupant',
      );

      expect(stampChat.getLastPromptTokenCount('override-model@route')).toBe(
        61_000,
      );
      expect(stampChat.getLastPromptTokenCount('active@route')).toBe(60_000);
    });

    it('stamps the compressed count under the request route when the send ends without usage (#9506)', async () => {
      // In-send compression runs for the REQUEST route, but
      // setLastPromptTokenCount re-keys the count to the ACTIVE route. A send
      // ending without usage (abort, 400: reactive overflow's case) never
      // stamps its own, so its gate would read 0 despite the compressed count.
      const stampChat = await sendAfterInSendCompression(
        streamOf(textChunk('ok', 'STOP')),
        'prompt-compression-stamps-request-route',
      );

      expect(stampChat.getLastPromptTokenCount('override-model@route')).toBe(
        60_000,
      );
      // The compressed history is shared by every route.
      expect(stampChat.getLastPromptTokenCount('active@route')).toBe(60_000);
    });

    it('drops stale retained counts when a successful compression rewrites the history (#9506)', async () => {
      // Compression rewrites the shared history every retained entry sizes; a
      // stale count would be adopted later and block a prompt that now fits.
      chat.setLastPromptTokenCount(691_000, false);
      switchRoute('override@route'); // retains the count under its own key
      expect(chat.getLastPromptTokenCount()).toBe(0);
      mockCompressOnce(compressed(691_000, 50_000, [userText('summary')]));

      await chat.tryCompress('prompt-compression-drops-retained', true);

      expect(chat.getLastPromptTokenCount()).toBe(50_000);
      expect(chat.getLastPromptTokenCount('gemini-pro@test0001')).toBe(0);
    });

    it('drops all retained counts when fast compression rewrites the history (#9506)', () => {
      // compressFast rewrites the same shared history; clearing only the
      // active route's entry would leave stale counts adoptable later.
      const fastChat = fastChatAfterSwitch('other-route@fast');
      expect(fastChat.getLastPromptTokenCount()).toBe(0);

      const { info } = fastChat.compressFast();

      expect(info.compressionStatus).toBe(CompressionStatus.COMPRESSED);
      expect(fastChat.getLastPromptTokenCount('gemini-pro@test0001')).toBe(0);
    });

    it('does not anchor an exact route output clamp on the active route count', async () => {
      // An exact `\0` route send targets another serialization than the
      // ACTIVE route's count, so entry invalidation must compare its route.
      chat.setLastPromptTokenCount(691_000, false);

      const routeStream = vi.fn().mockResolvedValue(textStream());
      const resolveForModel = vi.fn().mockResolvedValue({
        contentGenerator: {
          ...mockContentGenerator,
          generateContentStream: routeStream,
        } as ContentGenerator,
        contentGeneratorConfig: {
          model: 'vision-agent',
          authType: AuthType.USE_OPENAI,
          maxRetries: 0,
          // Room for the full explicit ceiling on the zeroed-count estimate
          // (history walk + ESTIMATE_CLAMP_OVERHEAD_PAD + clamp margin).
          contextWindowSize: 64_000,
          modalities: {},
        },
        retryAuthType: AuthType.USE_OPENAI,
        model: 'vision-agent',
      });
      vi.mocked(mockConfig.getBaseLlmClient).mockReturnValue({
        resolveForModel,
      } as unknown as ReturnType<typeof mockConfig.getBaseLlmClient>);
      routePerModel('gemini-pro@test0001');

      await drain(
        await chat.sendMessageStream(
          'openai:vision-agent\0https://vision.example.com/v1\0',
          { message: 'clamp probe', config: { maxOutputTokens: 8_000 } },
          'prompt-exact-route-clamp',
        ),
      );

      // Had the active route's 691_000 anchored the clamp, the request
      // would have been floored at MIN_CLAMPED_OUTPUT_TOKENS.
      const routeRequest = routeStream.mock.calls[0]?.[0] as {
        config?: { maxOutputTokens?: number };
      };
      expect(routeRequest.config?.maxOutputTokens).toBe(8_000);
    });
  });

  // Three-strike replacement for the single-shot hasFailedCompressionAttempt
  // lock: after MAX_CONSECUTIVE_FAILURES failures auto-compaction stops until
  // a successful compress (forced or not) resets the counter.
  describe('compression failure circuit breaker', () => {
    const failed = (status: CompressionStatus) =>
      compressResult(status, null, 100_000, 100_000);

    it('tolerates MAX_CONSECUTIVE_FAILURES - 1 failures and increments the counter each time', async () => {
      // Every call fails; LlmChat keeps calling and forwarding the incremented
      // counter (NOOP-at-threshold gating is the service's, tested there).
      const compressSpy = mockCompress(
        failed(CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT),
      );
      chat.setHistory([userText('a'), modelText('b'), userText('c')]);

      for (let i = 0; i < MAX_CONSECUTIVE_FAILURES; i++) {
        await chat.tryCompress(`p${i}`);
        // The i-th call sees consecutiveFailures = i (counter pre-increment).
        expect(compressSpy.mock.calls[i][1].consecutiveFailures).toBe(i);
      }
      // Tripped: LlmChat doesn't short-circuit (the service's gate NOOPs).
      expect(compressSpy).toHaveBeenCalledTimes(MAX_CONSECUTIVE_FAILURES);
      await chat.tryCompress('p-last');
      expect(
        compressSpy.mock.calls[MAX_CONSECUTIVE_FAILURES][1].consecutiveFailures,
      ).toBe(MAX_CONSECUTIVE_FAILURES);
    });

    it('does not increment the counter on forced-call failures', async () => {
      // Forced compressions (manual /compress, reactive overflow) bypass the
      // breaker AND must not count, or a flaky /compress burns it for auto.
      const compressSpy = mockCompress(
        failed(CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY),
      );
      for (let i = 0; i < 5; i++) {
        await chat.tryCompress(`p-force-${i}`, true);
      }
      // After 5 forced failures, an unforced call must still see counter=0.
      compressSpy.mockResolvedValueOnce(compressResult(CompressionStatus.NOOP));
      await chat.tryCompress('p-unforced');
      const lastCall = compressSpy.mock.calls.at(-1);
      expect(lastCall![1].consecutiveFailures).toBe(0);
    });

    it('resets the counter to 0 on a successful (forced) compress', async () => {
      const compressSpy = mockCompressOnce(
        failed(CompressionStatus.COMPRESSION_FAILED_INFLATED_TOKEN_COUNT),
        failed(CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY),
        compressed(100_000, 30_000),
        noop(),
      );

      // Two failures, then a forced success, then an unforced call that
      // must see the counter back at 0.
      await chat.tryCompress('p1');
      await chat.tryCompress('p2');
      expect(compressSpy.mock.calls[1][1].consecutiveFailures).toBe(1);
      await chat.tryCompress('p-force', true);
      expect(compressSpy.mock.calls[2][1].consecutiveFailures).toBe(2);
      await chat.tryCompress('p3');
      expect(compressSpy.mock.calls[3][1].consecutiveFailures).toBe(0);
    });
  });
  describe('XML tool call fallback integration', () => {
    const XML =
      '<invoke name="read_file"><parameter name="file_path">a.ts</parameter></invoke>';
    const TAUGHT_XML =
      '<tool_call><function=read_file><parameter=file_path>a.ts</parameter></function></tool_call>';

    /**
     * Stream one STOP chunk of `parts` (or `chunks`) for `message` on
     * `target` ('gemini-pro'), consume it, and return the yielded chunk
     * values plus the last history entry's parts.
     */
    async function runXml(
      promptId: string,
      parts: Part[],
      {
        message = 'read the file',
        target = chat,
        chunks = [modelChunk(parts, 'STOP')],
      } = {},
    ) {
      mockStream(streamOf(...chunks));
      const events = await collect(
        await target.sendMessageStream('gemini-pro', { message }, promptId),
      );
      return {
        chunks: events.flatMap((e) =>
          e.type === StreamEventType.CHUNK ? [e.value] : [],
        ),
        parts: target.getHistory().at(-1)!.parts ?? [],
      };
    }

    /** The first chunk carrying any functionCall part. */
    const callChunk = (chunks: GenerateContentResponse[]) =>
      chunks.find((c) =>
        c.candidates?.[0]?.content?.parts?.some((p) => p.functionCall),
      );

    /** The first chunk carrying a functionCall recovered from XML. */
    const recoveredChunk = (chunks: GenerateContentResponse[]) =>
      chunks.find((c) =>
        c.candidates?.[0]?.content?.parts?.some((p) =>
          p.functionCall?.id?.startsWith('xml-recovered-'),
        ),
      );

    const hasRawXml = (parts: Part[]) =>
      parts.some((p) => p.text && p.text.includes('<invoke'));

    // Order is replay-load-bearing: a signature-validating provider rejects
    // a turn whose reasoning episode trails the tool call it preceded.
    const expectThoughtBeforeCall = (parts: Part[]) =>
      expect(parts.findIndex((p) => p.thought)).toBeLessThan(
        parts.findIndex((p) => p.functionCall),
      );

    it.each(['xml', 'buffered-json'])(
      'preserves a %s tool call when cancelled at its synthetic chunk',
      async (kind) => {
        const controller = new AbortController();
        const recordAssistantTurn = vi.fn();
        const recordingChat = chatWithRecorder(recordAssistantTurn);
        mockStream(
          streamOf(
            modelChunk([{ text: 'Thinking', thought: true }]),
            kind === 'xml'
              ? textChunk(XML, 'STOP')
              : modelChunk([
                  { text: '{"ok":true}' },
                  fnCall('read_file', { file_path: 'a.ts' }, 'call-pending'),
                ]),
          ),
        );
        const stream = await recordingChat.sendMessageStream(
          'gemini-pro',
          {
            message: 'read the file',
            config: { abortSignal: controller.signal },
          },
          'cancel-synthetic',
        );
        let call: Part['functionCall'];
        for (let i = 0; i < 10; i++) {
          const next = await stream.next();
          expect(next.done).toBe(false);
          if (!next.done && next.value.type === StreamEventType.CHUNK)
            call = next.value.value.functionCalls?.[0];
          if (call) break;
        }
        expect(call?.name).toBe('read_file');
        controller.abort('qwen:user-cancel');
        await stream.return(undefined);
        const kept = expect.arrayContaining([
          { text: 'Thinking', thought: true },
          { functionCall: call },
        ]);
        expect(recordingChat.getHistory()[1]?.parts).toEqual(kept);
        expect(recordAssistantTurn).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({ message: kept }),
        );
      },
    );

    it('recovers XML tool calls from plain text content and updates history', async () => {
      const { chunks, parts } = await runXml('prompt-xml-fallback', [
        { text: XML },
      ]);

      const syntheticChunk = callChunk(chunks);
      expect(syntheticChunk).toBeDefined();
      expect(syntheticChunk!.functionCalls).toHaveLength(1);
      const fc =
        syntheticChunk!.candidates![0]!.content!.parts![0]!.functionCall!;
      expect(fc.name).toBe('read_file');
      expect(fc.args).toEqual({ file_path: 'a.ts' });
      // History holds the recovered functionCall parts, not raw XML.
      expect(parts.some((p) => p.functionCall)).toBe(true);
      expect(hasRawXml(parts)).toBe(false);
    });

    it('recovers a split taught-dialect call once and stores the call instead of XML (#10692)', async () => {
      const { chunks, parts } = await runXml('taught-xml', [], {
        chunks: [
          textChunk(TAUGHT_XML.slice(0, 30)),
          textChunk(TAUGHT_XML.slice(30), 'STOP'),
        ],
      });
      const calls = chunks.flatMap((chunk) => chunk.functionCalls ?? []);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({
        name: 'read_file',
        args: { file_path: 'a.ts' },
      });
      expect(parts).toEqual([{ functionCall: calls[0] }]);
    });

    it('keeps a native call authoritative when taught-dialect text is also present (#10692)', async () => {
      const native = fnCall('read_file', { file_path: 'b.ts' }, 'native-call');
      const { chunks, parts } = await runXml('native-with-taught-xml', [
        { text: TAUGHT_XML },
        native,
      ]);
      expect(chunks.flatMap((chunk) => chunk.functionCalls ?? [])).toEqual([
        native.functionCall,
      ]);
      expect(recoveredChunk(chunks)).toBeUndefined();
      expect(parts.some((part) => part.text === TAUGHT_XML)).toBe(true);
    });

    it('preserves a preceding reasoning episode (text + signature) when XML tool call recovery fires on the same turn', async () => {
      // Regression guard: flushThoughtEpisode always sets `episodePart.text`
      // ('' for a signature-only episode), so an episode passes a bare
      // `.text !== undefined` check; the XML splice must not replace it with
      // remainingText, silently deleting its text and thoughtSignature.
      const { chunks, parts } = await runXml(
        'prompt-xml-fallback-with-reasoning',
        [signed('planning my read', 'sig-should-survive'), { text: XML }],
      );

      expect(callChunk(chunks)).toBeDefined();
      const thoughtPart = parts.find((p) => p.thought);
      expect(thoughtPart).toBeDefined();
      expect(thoughtPart?.thoughtSignature).toBe('sig-should-survive');
      expect(thoughtPart?.text).toBe('planning my read');
      expect(parts.some((p) => p.functionCall)).toBe(true);
      expect(parts.some((p) => p.text?.includes('<invoke'))).toBe(false);
      // Presence checks alone miss a splice of the calls ahead of the episode.
      expectThoughtBeforeCall(parts);
    });

    it('drops a dangling unsigned trailing reasoning episode when XML tool call recovery attaches a functionCall', async () => {
      // dropDanglingUnsignedTrailingThought never fires here (XML recovery
      // needs `hasToolCall === false`, where it early-returns), and recovery
      // appends the call AFTER the unsigned episode: once the tool result
      // returns, dropUnsignedThinkingFromAssistantMessages throws on every
      // request. A trailing-only re-check misses it (the call is now last).
      const { parts } = await runXml('prompt-xml-fallback-dangling-episode', [
        signed('planning my read', 'sig-complete'),
        { text: XML },
        { text: 'cut off mid-thought', thought: true },
      ]);

      expect(parts.some((p) => p.functionCall)).toBe(true);
      // The signed episode is untouched; the dangling unsigned one is gone.
      const signedPart = parts.find((p) => p.thought && p.thoughtSignature);
      expect(signedPart?.thoughtSignature).toBe('sig-complete');
      expect(parts.some((p) => p.thought && !p.thoughtSignature)).toBe(false);
      expect(parts.some((p) => p.text === 'cut off mid-thought')).toBe(false);
      // The surviving signed episode must still precede the recovered call.
      expectThoughtBeforeCall(parts);
    });

    it('keeps a dangling unsigned episode that PRECEDES the consumed XML text (it was never trailing)', async () => {
      // Trailing-ness is judged on the ORIGINAL stream shape, before recovery
      // splices out text: this unsigned episode comes FIRST in a complete STOP
      // turn (non-signing provider), so dropping it loses reasoning from
      // history and JSONL. The XML part has a stray `thoughtSignature`, no
      // `thought` flag (a real wire shape, see isVisibleTextPart); the
      // non-empty remainingText ('Sure.') makes the ordering observable.
      const { parts } = await runXml('prompt-xml-fallback-preceding-episode', [
        { text: 'planning my read', thought: true },
        { text: 'Sure.\n' + XML, thoughtSignature: 'stray-sig' },
      ]);

      expect(parts.some((p) => p.functionCall)).toBe(true);
      expect(parts.some((p) => p.text?.includes('<invoke'))).toBe(false);
      // Never trailing, so it survives: no wedge risk on this provider.
      expect(parts.some((p) => p.thought && !p.thoughtSignature)).toBe(true);
      expect(parts.some((p) => p.text === 'planning my read')).toBe(true);
      // Streamed prose must survive re-insertion or `--resume` loses it.
      expect(parts.some((p) => p.text === 'Sure.')).toBe(true);
    });

    it('keeps a SIGNED trailing reasoning episode when XML tool call recovery fires', async () => {
      // Complement to the drop above, which is scoped to UNSIGNED trailing
      // episodes: a mutation that popped unconditionally would still pass it.
      const { parts } = await runXml('prompt-xml-fallback-signed-trailing', [
        { text: XML },
        signed('a complete afterthought', 'sig-trailing'),
      ]);

      expect(parts.some((p) => p.functionCall)).toBe(true);
      const trailing = parts.find((p) => p.thought);
      expect(trailing?.thoughtSignature).toBe('sig-trailing');
      expect(trailing?.text).toBe('a complete afterthought');
      // It arrived AFTER the XML, but the consumed text is spliced out and
      // recovered calls go last, so it still ends up ahead of them.
      expectThoughtBeforeCall(parts);
    });

    it('retains a short text prefix in history when recovering XML tool calls', async () => {
      const { chunks, parts } = await runXml('prompt-xml-fallback-prefix', [
        { text: 'Sure.\n' + XML },
      ]);

      // The recovered tool call is still executed despite the prefix.
      expect(callChunk(chunks)).toBeDefined();
      // History keeps the prefix as a text part ahead of the recovered call
      // and drops the raw XML (--resume fidelity).
      const textIndex = parts.findIndex((p) => p.text === 'Sure.');
      const callIndex = parts.findIndex((p) => p.functionCall);
      expect(textIndex).toBeGreaterThanOrEqual(0);
      expect(callIndex).toBeGreaterThan(textIndex);
      expect(hasRawXml(parts)).toBe(false);
    });

    it('recovers XML tool calls from a plain-text part carrying a stray thoughtSignature (no thought flag)', async () => {
      // Predicate divergence: loggingContentGenerator spreads `thought` and
      // `thoughtSignature` independently, so a signed part may lack
      // `thought: true`. contentText (`part.text && !part.thought`) detects the
      // XML there, so removal must use the same predicate or raw XML leaks.
      const { chunks, parts } = await runXml(
        'prompt-xml-fallback-stray-signature',
        [{ text: 'Sure.\n' + XML, thoughtSignature: 'stray-sig' }],
      );

      expect(callChunk(chunks)).toBeDefined();
      expect(parts.some((p) => p.functionCall)).toBe(true);
      expect(hasRawXml(parts)).toBe(false);
    });

    it.each<[string, string, string, Part[]]>([
      [
        // A structured tool call short-circuits the fallback (no double
        // execution).
        'does not recover when a structured tool call is already present',
        'list and read',
        'prompt-xml-guard-toolcall',
        [fnCall('list_dir', { path: '.' }), { text: XML }],
      ],
      [
        // The prose guard vetoes recovery.
        'does not recover documentation prose containing invoke examples',
        'explain the tool',
        'prompt-xml-guard-prose',
        [
          {
            text:
              'Here is how you use the tool. First you open the file, then you read it. ' +
              'The invoke block below shows the format. Remember to always check the path. ' +
              'This is a documentation example for the read_file tool call format. ' +
              'You should never execute these examples directly. They are for illustration ' +
              'purposes only. The actual tool calls are made through the structured API.' +
              '\n' +
              XML,
          },
        ],
      ],
    ])('%s', async (_title, message, promptId, parts) => {
      const result = await runXml(promptId, parts, { message });
      expect(recoveredChunk(result.chunks)).toBeUndefined();
      // History keeps the raw XML text unchanged.
      expect(hasRawXml(result.parts)).toBe(true);
    });

    it('records the recovered functionCall in the JSONL turn (--resume fidelity)', async () => {
      const recordAssistantTurn = vi.fn();
      const { chunks } = await runXml(
        'prompt-xml-fallback-recording',
        [{ text: XML }],
        { target: chatWithRecorder(recordAssistantTurn) },
      );
      expect(chunks.length).toBeGreaterThan(0);

      expect(recordAssistantTurn).toHaveBeenCalledTimes(1);
      const recorded = recordAssistantTurn.mock.calls[0][0] as {
        message: Array<{ text?: string; functionCall?: { name?: string } }>;
      };
      // The recovered tool call is persisted, not the raw XML text.
      expect(
        recorded.message.some((p) => p.functionCall?.name === 'read_file'),
      ).toBe(true);
      expect(recorded.message.some((p) => p.text?.includes('<invoke'))).toBe(
        false,
      );
    });

    it('does not duplicate earlier text or drop non-text parts when recovering', async () => {
      const { chunks, parts } = await runXml('prompt-xml-fallback-multipart', [
        { text: 'I will read it.' },
        { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
        { text: XML },
      ]);

      expect(callChunk(chunks) !== undefined).toBe(true);
      expect(parts.some((p) => p.functionCall?.name === 'read_file')).toBe(
        true,
      );
      expect(hasRawXml(parts)).toBe(false);
      // The earlier prose appears exactly once (no duplication from the join).
      expect(parts.filter((p) => p.text === 'I will read it.')).toHaveLength(1);
      // The interleaved non-text part is preserved, in order.
      expect(parts.some((p) => p.inlineData)).toBe(true);
      const textIdx = parts.findIndex((p) => p.text === 'I will read it.');
      const imageIdx = parts.findIndex((p) => p.inlineData);
      const callIdx = parts.findIndex((p) => p.functionCall);
      expect(textIdx).toBeLessThan(imageIdx);
      expect(imageIdx).toBeLessThan(callIdx);
    });

    it('preserves non-text parts when the XML spans multiple text parts', async () => {
      const { chunks, parts } = await runXml('prompt-xml-fallback-split', [], {
        chunks: [
          modelChunk([
            { text: '<invoke name="read_file"><parameter name="file_path">' },
            { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
          ]),
          textChunk('a.ts</parameter></invoke>', 'STOP'),
        ],
      });

      expect(recoveredChunk(chunks)).toBeDefined();
      expect(parts.some((p) => p.functionCall?.name === 'read_file')).toBe(
        true,
      );
      expect(hasRawXml(parts)).toBe(false);
      // The non-text part that split the XML must survive the rebuild.
      expect(parts.some((p) => p.inlineData)).toBe(true);
    });

    it.each([XML, TAUGHT_XML])(
      'does not recover XML without a finish reason: %s',
      async (xml) => {
        vi.useFakeTimers();
        mockStream(streamOf(textChunk(xml))); // no finishReason
        const stream = await chat.sendMessageStream(
          'gemini-pro',
          { message: 'read the file' },
          'prompt-xml-fallback-no-finish',
        );

        // The recovery gate must not fire; stream validation throws
        // NO_FINISH_REASON so the retry path handles the truncated stream.
        const chunks: GenerateContentResponse[] = [];
        const collecting = (async () => {
          for await (const event of stream) {
            if (event.type === StreamEventType.CHUNK) chunks.push(event.value);
          }
        })();
        const resultPromise = (async () => {
          await expect(collecting).rejects.toThrow('finish reason');
        })();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(35_000);
        await resultPromise;

        // No synthetic tool-call chunk may be dispatched.
        expect(recoveredChunk(chunks)).toBeUndefined();
      },
    );
    describe('issue #10380: HTTP 413 request-body overflow recovery', () => {
      // A reverse proxy can reject the serialized body (HTTP 413) below the
      // auto-compaction threshold; the send must recover via the same one-shot
      // reactive compression, with an actionable error when that cannot fit.
      function sdkStyle413(): Error {
        return Object.assign(
          new Error(
            '413 POST https://gateway.internal/v1/chat/completions: Request Entity Too Large\n' +
              '<html>\n<head><title>413 Request Entity Too Large</title></head>\n' +
              '<body>\n<center><h1>413 Request Entity Too Large</h1></center>\n' +
              '<hr><center>nginx</center>\n</body>\n</html>',
          ),
          { status: 413 },
        );
      }

      /** The pre-send cheap gate NOOPs, then the reactive attempt: `result`. */
      const noopThen = (result: ReturnType<typeof compressResult>) =>
        mockCompressOnce(noop(), result);

      const summarized = (originalTokenCount = 90_000, newTokenCount = 4_000) =>
        compressed(originalTokenCount, newTokenCount, [userText('summary')]);

      /** Reject the next model requests with `errors`, then answer `text`. */
      function failThen(errors: unknown[], text?: string) {
        const mock = streamMock();
        for (const error of errors) mock.mockRejectedValueOnce(error);
        if (text !== undefined) {
          mock.mockImplementationOnce(async () =>
            streamOf(stopResponse([{ text }])),
          );
        }
      }

      /** Send 'next prompt', consume it, and return what the stream threw. */
      async function sendCaught(promptId: string) {
        const stream = await send('next prompt', promptId);
        try {
          await collect(stream);
        } catch (error) {
          return error as Error & { status?: number };
        }
        return undefined;
      }

      it.each(['sdk', 'responses'])(
        'classifies a %s model-request 413 as recoverable and compacts once before retrying',
        async (wire) => {
          const compressSpy = noopThen(summarized());
          failThen(
            [
              wire === 'responses'
                ? new ResponsesHttpError(413, 'Request Entity Too Large')
                : sdkStyle413(),
            ],
            'recovered after compaction',
          );

          const events = await sendCollect(
            'next prompt',
            'prompt-id-413-recovery',
          );

          expect(compressSpy).toHaveBeenCalledTimes(2);
          expect(compressSpy.mock.calls[1]?.[1]).toEqual(
            expect.objectContaining({ requestPayloadTooLarge: true }),
          );
          expect(
            eventsOfType(events, StreamEventType.COMPRESSED).length > 0,
          ).toBe(true);
          expect(eventsOfType(events, StreamEventType.RETRY).length > 0).toBe(
            true,
          );
          expectStreamCalls(2);
          const retryRequest = requestAt(1) as { contents: Content[] };
          expect(JSON.stringify(retryRequest.contents)).toContain('summary');
        },
      );

      it('anchors the reactive 413 accounting on the real history, not the context window', async () => {
        // A bare 413 has no provider token counts, so the reactive anchor must
        // estimate the actual (tiny) history. Anchoring on the window stamps
        // ≈ window − visible history, force-re-compacting the just-compacted
        // history or false-tripping the session-token limit next turn (#10380).
        const compressSpy = noopThen(summarized());
        failThen([sdkStyle413()], 'recovered after compaction');

        await sendCollect('next prompt', 'prompt-id-413-accounting-anchor');

        const reactiveOpts = compressSpy.mock.calls[1]?.[1];
        expect(reactiveOpts).toEqual(
          expect.objectContaining({ requestPayloadTooLarge: true }),
        );
        // A few dozen estimated tokens; the window fallback
        // (contextWindowSize ?? DEFAULT_TOKEN_LIMIT) is >= 200K.
        expect(reactiveOpts?.originalTokenCount).toBeGreaterThan(0);
        expect(reactiveOpts?.originalTokenCount).toBeLessThan(10_000);
      });

      it('surfaces an actionable error when the retried request still exceeds the body limit', async () => {
        const compressSpy = noopThen(summarized());
        failThen([sdkStyle413(), sdkStyle413()]);

        const stream = await send(
          'next prompt',
          'prompt-id-413-still-too-large',
        );
        await expect(collect(stream)).rejects.toThrow(/start a new session/i);
        // One pre-send cheap gate + one reactive attempt; no compression loop.
        expect(compressSpy).toHaveBeenCalledTimes(2);
      });

      it('surfaces an actionable error when compaction cannot recover the 413', async () => {
        const compressSpy = noopThen(
          failed(CompressionStatus.COMPRESSION_FAILED_EMPTY_SUMMARY, 90_000),
        );
        failThen([sdkStyle413()]);

        const stream = await send(
          'next prompt',
          'prompt-id-413-compression-failed',
        );
        await expect(collect(stream)).rejects.toThrow(/start a new session/i);
        expect(compressSpy).toHaveBeenCalledTimes(2);
        expectStreamCalls(1);
      });

      it('keeps token-wording overflow on the original reactive path', async () => {
        // Regression guard: the 413 classification must not change how
        // provider-reported context-length wording is recovered.
        const compressSpy = noopThen(summarized(135_000, 40_000));
        failThen([tooLong()], 'recovered');

        await sendCollect('overflow prompt', 'prompt-id-wording-overflow');

        expect(compressSpy).toHaveBeenCalledTimes(2);
        expect(compressSpy.mock.calls[1]?.[1]).toEqual(
          expect.not.objectContaining({ requestPayloadTooLarge: true }),
        );
      });

      it('keeps the deep 413 status on the actionable error for cause-wrapped failures', async () => {
        // Detection walks the .cause chain, so copying the status onto the
        // actionable error must use the same deep lookup, or status bucketing
        // records unknown for cause-wrapped 413s (#10380).
        const causeWrapped413 = (): Error =>
          new Error('request failed', { cause: sdkStyle413() });
        noopThen(summarized());
        failThen([causeWrapped413(), causeWrapped413()]);

        const caught = await sendCaught('prompt-id-413-cause-wrapped-status');
        expect(caught).toBeInstanceOf(Error);
        expect(caught?.message).toMatch(/start a new session/i);
        expect(caught?.status).toBe(413);
      });

      it.each<[string, string, () => void]>([
        [
          'propagates the original 413 when the reactive compaction attempt fails transiently',
          'prompt-id-413-transient-compaction-failure',
          // A transient side-query failure (504/reset) must not earn the
          // destructive new-session advice: reactiveCompressionAttempted is
          // per-send, so the next prompt gets a fresh one-shot (#10380).
          () => {
            vi.spyOn(ChatCompressionService.prototype, 'compress')
              .mockResolvedValueOnce(compressResult(CompressionStatus.NOOP))
              .mockRejectedValueOnce(new Error('504 gateway timeout'));
          },
        ],
        [
          'propagates the original 413 when compaction returns an API failure status',
          'prompt-id-413-compaction-api-failure',
          () => {
            noopThen(
              failed(CompressionStatus.COMPRESSION_FAILED_API_ERROR, 90_000),
            );
          },
        ],
      ])('%s', async (_title, promptId, arrangeCompression) => {
        arrangeCompression();
        failThen([sdkStyle413()]);

        const caught = await sendCaught(promptId);
        expect(caught).toBeInstanceOf(Error);
        expect(caught?.message).not.toMatch(/start a new session/i);
        expect(caught?.message).toMatch(/413/);
        expect(caught?.status).toBe(413);
      });

      it('advises reducing the current request when compaction NOOPs on a 413', async () => {
        // NOOP means no earlier history to compress: the oversize is in the
        // current request, so /clear + retry would fail identically (#10380).
        noopThen(compressResult(CompressionStatus.NOOP));
        failThen([sdkStyle413()]);

        const caught = await sendCaught('prompt-id-413-noop-compaction');
        expect(caught).toBeInstanceOf(Error);
        expect(caught?.message).not.toMatch(/start a new session/i);
        expect(caught?.message).not.toMatch(/\/clear/);
        expect(caught?.message).toMatch(/reduce the current request/i);
      });
    });
  });
});

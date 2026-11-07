/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  fireSessionPermissionDeniedForAutoMode,
  resolveHomeLoopResolverRoots,
  Session,
} from './Session.js';
import { FinishReason } from '@qwen-code/qwen-code-core/core/genai-compat.js';
import { ManagedRuntimeOutcomeUnknownError } from '@qwen-code/qwen-code-core/services/execution-environment.js';
import {
  getApiHistoryPromptId,
  markApiHistoryPrompt,
} from '@qwen-code/qwen-code-core/services/session-api-history.js';
import type {
  Content,
  FunctionCall,
  GenerateContentResponse,
  Part,
} from '@google/genai';
import type {
  ChatRecord,
  Config,
  Extension,
  LlmChat,
} from '@qwen-code/qwen-code-core';
import {
  ApprovalMode,
  AuthType,
  GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT,
  GOAL_PAUSE_REASON_SESSION_DISPOSED,
  GOAL_PAUSE_REASON_STOP_HOOK_CAP,
  GOAL_PAUSE_REASON_USER_INTERRUPT,
  goalPauseReasonForFailure,
} from '@qwen-code/qwen-code-core';
import * as core from '@qwen-code/qwen-code-core';
import { createUserPromptSubmitContextPart } from '@qwen-code/qwen-code-core/hooks/user-prompt-submit-context.js';
import { SettingScope } from '../../config/settings.js';
import type {
  AgentSideConnection,
  PermissionOption,
  PromptRequest,
  SessionUpdate,
} from '@agentclientprotocol/sdk';
import type { LoadedSettings } from '../../config/settings.js';
import * as nonInteractiveCliCommands from '../../nonInteractiveCliCommands.js';
import { CommandKind } from '../../ui/commands/types.js';
import { CHANNEL_PROMPT_META_KEY } from '@qwen-code/channel-base';
import { DAEMON_INPUT_ANNOTATIONS_META_KEY } from '@qwen-code/acp-bridge/bridgeTypes';
import { CAPTURE_SCREEN_CONTEXT_TOOL_NAME } from '../live/capture-screen-context.js';
import type { DaemonTodoStopGuard } from './daemon-todo-stop-guard.js';

const debugLoggerWarnSpy = vi.hoisted(() => vi.fn());
const debugLoggerDebugSpy = vi.hoisted(() => vi.fn());
const runVisionBridgeSpy = vi.hoisted(() => vi.fn());
const bridgeToolResultImagesSpy = vi.hoisted(() => vi.fn());
const refreshMemoryAfterManagedWriteSpy = vi.hoisted(() => vi.fn());
const refreshMemoryInstructionSpy = vi.hoisted(() => vi.fn());
const transcribeVoiceAudioSpy = vi.hoisted(() => vi.fn());
const startToolSpanSpy = vi.hoisted(() => vi.fn());
const addToolArgumentsAttributesSpy = vi.hoisted(() => vi.fn());
const addToolCallResultAttributesSpy = vi.hoisted(() => vi.fn());
const logLoopDetectedSpy = vi.hoisted(() => vi.fn());
const logRepeatedToolFailureGuardSpy = vi.hoisted(() => vi.fn());
const logLoopProtectionSpy = vi.hoisted(() => vi.fn());
const deleteWorkflowSnapshotSpy = vi.hoisted(() => vi.fn());
const listWorkflowSnapshotsSpy = vi.hoisted(() => vi.fn());
const agentTelemetry = vi.hoisted(() => ({
  span: {},
  getActiveInteractionSpan: vi.fn(),
  addAgentInputMessageAttributes: vi.fn(),
  captures: [] as Array<{
    beginResponse: ReturnType<typeof vi.fn>;
    appendText: ReturnType<typeof vi.fn>;
    observeFinishReason: ReturnType<typeof vi.fn>;
    restartAttempt: ReturnType<typeof vi.fn>;
    commitResponse: ReturnType<typeof vi.fn>;
    writeToSpan: ReturnType<typeof vi.fn>;
  }>,
}));
const TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD =
  'craft/claimTodoStopGuardContinuation';
// Records every LoopTickResolver construction's deps so a test can assert what
// Session computed (e.g. the home confinement root) without a private-field peek.
const loopTickResolverDepsSpy = vi.hoisted(() => vi.fn());
const structuredErrorCauses = vi.hoisted(() => new WeakMap<object, unknown>());
const runAcpToolBatchSpy = vi.hoisted(() => vi.fn());

// The shared tool batch has its own tests; here it runs each call's tool.
vi.mock('./acp-tool-batch.js', () => ({
  runAcpToolBatch: (...args: unknown[]) => runAcpToolBatchSpy(...args),
}));

// Session imports getStructuredErrorCause from the turn module, not the barrel.
vi.mock('@qwen-code/qwen-code-core/core/turn.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@qwen-code/qwen-code-core/core/turn.js')
    >();
  return {
    ...actual,
    getStructuredErrorCause: (error: core.StructuredError) =>
      structuredErrorCauses.get(error) ?? actual.getStructuredErrorCause(error),
  };
});

// Session imports logLoopProtection from the loggers module, not the barrel.
vi.mock(
  '@qwen-code/qwen-code-core/telemetry/loggers.js',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@qwen-code/qwen-code-core/telemetry/loggers.js')
      >();
    return {
      ...actual,
      logLoopProtection: (
        ...args: Parameters<typeof actual.logLoopProtection>
      ) => {
        logLoopProtectionSpy(...args);
        return actual.logLoopProtection(...args);
      },
    };
  },
);

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    createDebugLogger: () => ({
      debug: debugLoggerDebugSpy,
      info: vi.fn(),
      warn: debugLoggerWarnSpy,
      error: vi.fn(),
    }),
    generatePromptSuggestion: vi.fn(),
    logPromptSuggestion: vi.fn(),
    runVisionBridge: runVisionBridgeSpy,
    bridgeToolResultImages: bridgeToolResultImagesSpy,
    refreshMemoryAfterManagedWrite: refreshMemoryAfterManagedWriteSpy,
    refreshMemoryInstruction: refreshMemoryInstructionSpy,
    getActiveInteractionSpan: agentTelemetry.getActiveInteractionSpan,
    addAgentInputMessageAttributes:
      agentTelemetry.addAgentInputMessageAttributes,
    AgentOutputMessageCapture: class {
      beginResponse = vi.fn();
      appendText = vi.fn();
      observeFinishReason = vi.fn();
      restartAttempt = vi.fn();
      commitResponse = vi.fn();
      writeToSpan = vi.fn();

      constructor(_config?: unknown) {
        agentTelemetry.captures.push(this);
      }
    },
    startToolSpan: (...args: Parameters<typeof actual.startToolSpan>) => {
      startToolSpanSpy(...args);
      return actual.startToolSpan(...args);
    },
    addToolArgumentsAttributes: (
      ...args: Parameters<typeof actual.addToolArgumentsAttributes>
    ) => {
      addToolArgumentsAttributesSpy(...args);
      return actual.addToolArgumentsAttributes(...args);
    },
    addToolCallResultAttributes: (
      ...args: Parameters<typeof actual.addToolCallResultAttributes>
    ) => {
      addToolCallResultAttributesSpy(...args);
      return actual.addToolCallResultAttributes(...args);
    },
    logLoopDetected: (...args: Parameters<typeof actual.logLoopDetected>) => {
      logLoopDetectedSpy(...args);
      return actual.logLoopDetected(...args);
    },
    logRepeatedToolFailureGuard: (
      ...args: Parameters<typeof actual.logRepeatedToolFailureGuard>
    ) => {
      logRepeatedToolFailureGuardSpy(...args);
      return actual.logRepeatedToolFailureGuard(...args);
    },
    deleteWorkflowSnapshot: deleteWorkflowSnapshotSpy,
    listWorkflowSnapshots: listWorkflowSnapshotsSpy,
    // Transparent recording wrapper: records the constructor deps, then behaves
    // exactly like the real resolver (subclass → instanceof + methods preserved).
    LoopTickResolver: class extends actual.LoopTickResolver {
      constructor(
        ...args: ConstructorParameters<typeof actual.LoopTickResolver>
      ) {
        loopTickResolverDepsSpy(args[0]);
        super(...args);
      }
    },
  };
});

vi.mock('../../nonInteractiveCliCommands.js', () => ({
  ALLOWED_BUILTIN_COMMANDS_NON_INTERACTIVE: [
    'init',
    'summary',
    'compress',
    'bug',
  ],
  getAvailableCommands: vi.fn(),
  handleSlashCommand: vi.fn(),
}));

vi.mock('../../services/voice-transcriber.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../services/voice-transcriber.js')
    >();
  return {
    ...actual,
    transcribeVoiceAudio: transcribeVoiceAudioSpy,
  };
});

function chatRecord(overrides: Record<string, unknown>): ChatRecord {
  return {
    uuid: 'record',
    parentUuid: null,
    sessionId: 'test-session-id',
    timestamp: '2026-05-17T07:27:15.251Z',
    type: 'user',
    cwd: process.cwd(),
    version: '0.15.11',
    ...overrides,
  } as ChatRecord;
}

// Helper to create empty async generator (avoids memory leak from inline generators)
function createEmptyStream() {
  return (async function* () {})();
}

/**
 * Points os.homedir() at `home` for a test by overriding the env vars libuv
 * reads — the module export itself can't be spied under ESM. Returns a restore
 * function.
 */
function setFakeHome(home: string): () => void {
  const keys = [
    'HOME',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'HOMESHARE',
  ] as const;
  const prev = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  ) as Record<(typeof keys)[number], string | undefined>;
  for (const key of keys) {
    process.env[key] = home;
  }
  return () => {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  };
}

// Helper to create async generator with chunks (avoids memory leak).
// COMPRESSED events carry `info` instead of `value`.
function createStreamWithChunks(
  chunks: Array<{ type: unknown; value?: unknown; info?: unknown }>,
) {
  return (async function* () {
    for (const chunk of chunks) {
      yield chunk;
    }
  })();
}

/** Builds provider preparation metadata that arrives before complete arguments. */
function createPreparationResponse(
  callId: string,
  toolName: string,
): GenerateContentResponse {
  const response = {} as GenerateContentResponse;
  core.setToolCallPreparations(response, [{ callId, toolName }]);
  return response;
}

/**
 * A response that yields `chunks`, reports it is still streaming, then stays
 * open until `release` resolves or `signal` aborts — ending like LlmChat does
 * on an abort, by throwing the abort reason.
 */
function createOpenStream(
  chunks: Array<{ type: unknown; value?: unknown }>,
  signal: AbortSignal,
  release: Promise<void>,
  onStreaming: () => void,
) {
  return (async function* () {
    yield* chunks;
    onStreaming();
    await Promise.race([
      release,
      new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      ),
    ]);
    signal.throwIfAborted();
  })();
}

function createFailingStream(message: string, beforeThrow?: () => void) {
  return (async function* () {
    beforeThrow?.();
    yield* [];
    throw new Error(message);
  })();
}

function expectCompressBeforeSend(
  compressMock: ReturnType<typeof vi.fn>,
  sendMock: ReturnType<typeof vi.fn>,
  callIndex: number,
) {
  expect(compressMock.mock.invocationCallOrder.length).toBeGreaterThan(
    callIndex,
  );
  expect(sendMock.mock.invocationCallOrder.length).toBeGreaterThan(callIndex);
  expect(compressMock.mock.invocationCallOrder[callIndex]).toBeLessThan(
    sendMock.mock.invocationCallOrder[callIndex],
  );
}

describe('Session', () => {
  let mockChat: LlmChat;
  let mockConfig: Config;
  let mockClient: AgentSideConnection;
  let mockSettings: LoadedSettings;
  let session: Session;
  let currentModel: string;
  let currentAuthType: AuthType;
  let goalProposalTurnKey: string | undefined;
  let originalProcessGuardMode: string | undefined;
  let originalServeStamp: string | undefined;
  let switchModelSpy: ReturnType<typeof vi.fn>;
  let getAvailableCommandsSpy: ReturnType<typeof vi.fn>;
  let unsubscribeApprovalModeChange: ReturnType<typeof vi.fn>;
  let mockChatRecordingService: {
    supportsMessageGroupDeletion: ReturnType<typeof vi.fn>;
    deleteMessageGroups: ReturnType<typeof vi.fn>;
    readActiveTranscriptChain: ReturnType<typeof vi.fn>;
    recordTurnAttempt: ReturnType<typeof vi.fn>;
    recordTurnResult: ReturnType<typeof vi.fn>;
    recordUserMessage: ReturnType<typeof vi.fn>;
    recordCronPrompt: ReturnType<typeof vi.fn>;
    recordGoalRuntimeMessage: ReturnType<typeof vi.fn>;
    recordGoalTurnEnd: ReturnType<typeof vi.fn>;
    recordMidTurnUserMessage: ReturnType<typeof vi.fn>;
    recordUiTelemetryEvent: ReturnType<typeof vi.fn>;
    recordToolResult: ReturnType<typeof vi.fn>;
    recordSlashCommand: ReturnType<typeof vi.fn>;
    recordNotification: ReturnType<typeof vi.fn>;
    recordNotificationStrict: ReturnType<typeof vi.fn>;
    recordExternalAgentRecordStrict: ReturnType<typeof vi.fn>;
    findExternalAgentRecord: ReturnType<typeof vi.fn>;
    recordRealtimeConversation: ReturnType<typeof vi.fn>;
    recordFileHistorySnapshot: ReturnType<typeof vi.fn>;
    getRewindTurnIndex: ReturnType<typeof vi.fn>;
    getRewindDaemonPromptId: ReturnType<typeof vi.fn>;
    rewindRecording: ReturnType<typeof vi.fn>;
    setTitleRecordedCallback: ReturnType<typeof vi.fn>;
    getBranchCheckpointCursor: ReturnType<typeof vi.fn>;
    recordBranchCheckpointTransaction: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    recordSessionModel: ReturnType<typeof vi.fn>;
    recordSessionApprovalMode: ReturnType<typeof vi.fn>;
  };
  let mockFileHistoryService: {
    makeSnapshot: ReturnType<typeof vi.fn>;
    getSnapshots: ReturnType<typeof vi.fn>;
    restoreFromSnapshots: ReturnType<typeof vi.fn>;
    rewind: ReturnType<typeof vi.fn>;
  };
  let mockLlmClient: {
    getChat: ReturnType<typeof vi.fn>;
    getHistoryTail: ReturnType<typeof vi.fn>;
    getTrustedUserAnswers: ReturnType<typeof vi.fn>;
    recordTrustedUserAnswers: ReturnType<typeof vi.fn>;
    setHistory: ReturnType<typeof vi.fn>;
    stripOrphanedUserEntriesFromHistory: ReturnType<typeof vi.fn>;
    truncateHistory: ReturnType<typeof vi.fn>;
    isInitialized: ReturnType<typeof vi.fn>;
    refreshSystemInstruction: ReturnType<typeof vi.fn>;
    setTools: ReturnType<typeof vi.fn>;
    tryCompressChat: ReturnType<typeof vi.fn>;
    activatePreparedMemoryRecallTransition: ReturnType<typeof vi.fn>;
    beginManagedAutoMemoryRecall: ReturnType<typeof vi.fn>;
    consumeManagedAutoMemoryRecall: ReturnType<typeof vi.fn>;
    commitManagedAutoMemoryRecallDelivery: ReturnType<typeof vi.fn>;
    discardManagedAutoMemoryRecallDelivery: ReturnType<typeof vi.fn>;
    finishManagedAutoMemoryRecall: ReturnType<typeof vi.fn>;
    runManagedAutoMemoryBackgroundTasks: ReturnType<typeof vi.fn>;
    consumePendingMemoryTaskPromises: ReturnType<typeof vi.fn>;
    captureCacheSafeParams: ReturnType<typeof vi.fn>;
    recordCompletedToolCall: ReturnType<typeof vi.fn>;
    resetManagedAutoMemoryAfterCompression: ReturnType<typeof vi.fn>;
  };
  let mockMemoryManager: {
    scheduleMetadataMigration: ReturnType<typeof vi.fn>;
    scheduleExtract: ReturnType<typeof vi.fn>;
    scheduleDream: ReturnType<typeof vi.fn>;
    resetExhaustedBodyRefsForCurrentTurn: ReturnType<typeof vi.fn>;
  };
  let mockBackgroundTaskRegistry: {
    abortAll: ReturnType<typeof vi.fn>;
    setNotificationCallback: ReturnType<typeof vi.fn>;
    setStatusChangeCallback: ReturnType<typeof vi.fn>;
    clearStatusChangeCallback: ReturnType<typeof vi.fn>;
    hasUnfinalizedTasks: ReturnType<typeof vi.fn>;
    hasRunningTasks: ReturnType<typeof vi.fn>;
    listUnfinalizedBackgroundAgentIds: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  let mockMonitorRegistry: {
    setStatusChangeCallback: ReturnType<typeof vi.fn>;
    clearStatusChangeCallback: ReturnType<typeof vi.fn>;
    setNotificationCallback: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  let mockBackgroundShellRegistry: {
    setNotificationCallback: ReturnType<typeof vi.fn>;
    setStatusChangeCallback: ReturnType<typeof vi.fn>;
    clearStatusChangeCallback: ReturnType<typeof vi.fn>;
    hasRunningEntries: ReturnType<typeof vi.fn>;
    getAll: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
  };
  let mockToolRegistry: {
    getAllToolNames: ReturnType<typeof vi.fn>;
    getTool: ReturnType<typeof vi.fn>;
    ensureTool: ReturnType<typeof vi.fn>;
    isDeferredAndHidden: ReturnType<typeof vi.fn>;
    registerTool: ReturnType<typeof vi.fn>;
    registerPermissionDeferredFactory: ReturnType<typeof vi.fn>;
    revealDeferredTool: ReturnType<typeof vi.fn>;
    unrevealDeferredTool: ReturnType<typeof vi.fn>;
    pinDeferredToolReveal: ReturnType<typeof vi.fn>;
    warmAll: ReturnType<typeof vi.fn>;
    getFunctionDeclarationsFiltered: ReturnType<typeof vi.fn>;
    // Unset by default so the bridge gate stays off; tests that exercise it
    // assign a review lookup.
    getReviewedDeclaration?: ReturnType<typeof vi.fn>;
  };
  let mockWorkflowRunRegistry: {
    hasRunningEntries: ReturnType<typeof vi.fn>;
    setCompletionCallback: ReturnType<typeof vi.fn>;
    setStatusChangeCallback: ReturnType<typeof vi.fn>;
    setSnapshotPersistedCallback: ReturnType<typeof vi.fn>;
    clearStatusChangeCallback: ReturnType<typeof vi.fn>;
    setApprovalRequestCallback: ReturnType<typeof vi.fn>;
    resolvePendingApproval: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    getHandle: ReturnType<typeof vi.fn>;
    isStarting: ReturnType<typeof vi.fn>;
    listStartingRunIds: ReturnType<typeof vi.fn>;
    removeTerminal: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    abortAll: ReturnType<typeof vi.fn>;
  };
  let mockGoalRuntime: {
    getSnapshot: ReturnType<typeof vi.fn>;
    getRecoveryCause: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    beginTurn: ReturnType<typeof vi.fn>;
    releaseTurn: ReturnType<typeof vi.fn>;
    markTurnDelivered: ReturnType<typeof vi.fn>;
    permitForTurn: ReturnType<typeof vi.fn>;
    getVerifierFeedback: ReturnType<typeof vi.fn>;
    finishTurn: ReturnType<typeof vi.fn>;
    dispatch: ReturnType<typeof vi.fn>;
  };
  let boundGoalHost: core.GoalTurnHost | undefined;

  function mockConfirmingTool(
    name: string,
    execute: ReturnType<typeof vi.fn>,
    type: core.ToolCallConfirmationDetails['type'] = 'ask_user_question',
    onConfirm: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined),
  ) {
    return {
      name,
      kind: core.Kind.Other,
      displayName: name,
      description: name,
      build: vi.fn().mockReturnValue({
        params: {},
        execute,
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type,
          title: name,
          questions:
            type === 'ask_user_question'
              ? [{ header: 'Continue?', question: 'Continue?' }]
              : undefined,
          onConfirm,
        }),
        getDescription: vi.fn().mockReturnValue(name),
        toolLocations: vi.fn().mockReturnValue([]),
      }),
      canUpdateOutput: false,
      isOutputMarkdown: true,
    };
  }

  function makeExtension(overrides: Partial<Extension> = {}): Extension {
    return {
      id: 'browser',
      name: 'browser',
      displayName: 'Browser',
      version: '1.0.0',
      isActive: true,
      path: process.cwd(),
      config: {
        name: 'browser',
        version: '1.0.0',
        description: 'Browser automation',
      },
      mcpServers: {
        'browser-mcp': {
          command: 'node',
        },
      },
      contextFiles: [],
      skills: [
        {
          name: 'browser-skill',
          description: 'Use browser tools',
          path: 'skills/browser/SKILL.md',
        },
      ],
      ...overrides,
    } as Extension;
  }

  function firstSentMessage(): Part[] {
    const call = vi.mocked(mockChat.sendMessageStream).mock.calls[0];
    const request = call?.[1] as { message?: Part[] } | undefined;
    return request?.message ?? [];
  }

  function textParts(parts: Part[]): string[] {
    return parts.flatMap((part) =>
      typeof part.text === 'string' ? [part.text] : [],
    );
  }

  function agentMessageChunks(): string[] {
    return vi
      .mocked(mockClient.sessionUpdate)
      .mock.calls.flatMap(([params]) =>
        params.update.sessionUpdate === 'agent_message_chunk' &&
        params.update.content.type === 'text'
          ? [params.update.content.text]
          : [],
      );
  }

  beforeEach(() => {
    // Self-hosted CI runners export QWEN_RUNTIME_DIR; it outranks
    // Storage.setRuntimeBaseDir, breaking the runtime-pinning assertions.
    vi.stubEnv('QWEN_RUNTIME_DIR', '');
    originalProcessGuardMode =
      process.env['QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD'];
    process.env['QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD'] = 'shadow';
    // Sessions under test are daemon sessions: the sub-session spawner (and
    // with it the create_sub_session tool) is wired only when the daemon's
    // env stamp is present.
    originalServeStamp = process.env['QWEN_CODE_SERVE'];
    process.env['QWEN_CODE_SERVE'] = '1';
    startToolSpanSpy.mockClear();
    addToolArgumentsAttributesSpy.mockClear();
    addToolCallResultAttributesSpy.mockClear();
    logLoopDetectedSpy.mockReset();
    logRepeatedToolFailureGuardSpy.mockReset();
    logLoopProtectionSpy.mockReset();
    deleteWorkflowSnapshotSpy.mockReset();
    deleteWorkflowSnapshotSpy.mockResolvedValue(true);
    listWorkflowSnapshotsSpy.mockReset();
    listWorkflowSnapshotsSpy.mockResolvedValue([]);
    agentTelemetry.getActiveInteractionSpan.mockReset();
    agentTelemetry.addAgentInputMessageAttributes.mockReset();
    agentTelemetry.captures.length = 0;
    runVisionBridgeSpy.mockReset();
    bridgeToolResultImagesSpy.mockReset();
    bridgeToolResultImagesSpy.mockImplementation(
      async ({ responseParts }: { responseParts: Part[] }) => responseParts,
    );
    refreshMemoryAfterManagedWriteSpy.mockReset();
    refreshMemoryAfterManagedWriteSpy.mockResolvedValue(false);
    refreshMemoryInstructionSpy.mockReset();
    refreshMemoryInstructionSpy.mockResolvedValue(undefined);
    transcribeVoiceAudioSpy.mockReset();
    currentModel = 'qwen3-code-plus';
    currentAuthType = AuthType.USE_OPENAI;
    goalProposalTurnKey = undefined;
    switchModelSpy = vi
      .fn()
      .mockImplementation(async (authType: AuthType, modelId: string) => {
        currentAuthType = authType;
        currentModel = modelId;
      });

    const getHistoryMock = vi.fn().mockReturnValue([]);
    let completedToolCallIds: readonly string[] = [];
    mockChat = {
      sendMessageStream: vi.fn(),
      addHistory: vi.fn(),
      getHistory: getHistoryMock,
      setCompletedToolCallIds: vi.fn((ids: readonly string[]) => {
        completedToolCallIds = ids;
      }),
      getCompletedToolCallIds: vi.fn(() => completedToolCallIds),
      // continueLastTurn classifies from a bounded tail; delegate to getHistory
      // so tests that set getHistory drive detection (fixtures are small).
      getHistoryTail: vi.fn(() => getHistoryMock()),
      getHistoryTailShallow: vi.fn(() => getHistoryMock()),
      // Delegate to the LIVE getHistory property: several tests replace
      // `mockChat.getHistory` outright instead of re-mocking getHistoryMock.
      peekLastHistoryEntry: vi.fn(() =>
        (mockChat.getHistory() as Content[]).at(-1),
      ),
      findLastHistoryEntry: vi.fn((predicate: (entry: Content) => boolean) =>
        [...(mockChat.getHistory() as Content[])].reverse().find(predicate),
      ),
      getHistoryShallow: vi.fn().mockReturnValue([]),
      getHistoryToolCallFingerprints: vi
        .fn()
        .mockReturnValue(new Map<string, string>()),
      getLastModelMessageText: vi.fn().mockReturnValue(''),
      setHistory: vi.fn(),
      truncateHistory: vi.fn(),
      stripThoughtsFromHistory: vi.fn(),
      stripOrphanedUserEntriesFromHistory: vi.fn().mockReturnValue([]),
      setTools: vi.fn(),
    } as unknown as LlmChat;
    mockLlmClient = {
      getChat: vi.fn().mockReturnValue(mockChat),
      getHistoryTail: vi.fn().mockReturnValue([]),
      getTrustedUserAnswers: vi.fn().mockReturnValue([]),
      recordTrustedUserAnswers: vi.fn(),
      setHistory: vi.fn((history: Content[]) => mockChat.setHistory(history)),
      stripOrphanedUserEntriesFromHistory: vi.fn(() =>
        mockChat.stripOrphanedUserEntriesFromHistory(),
      ),
      truncateHistory: vi.fn((count: number) =>
        mockChat.truncateHistory(count),
      ),
      isInitialized: vi.fn().mockReturnValue(true),
      refreshSystemInstruction: vi.fn().mockResolvedValue(undefined),
      setTools: vi.fn().mockResolvedValue(undefined),
      tryCompressChat: vi.fn().mockResolvedValue({
        originalTokenCount: 0,
        newTokenCount: 0,
        compressionStatus: core.CompressionStatus.NOOP,
      }),
      activatePreparedMemoryRecallTransition: vi
        .fn()
        .mockResolvedValue(undefined),
      beginManagedAutoMemoryRecall: vi.fn(),
      consumeManagedAutoMemoryRecall: vi.fn().mockResolvedValue(null),
      commitManagedAutoMemoryRecallDelivery: vi.fn(),
      discardManagedAutoMemoryRecallDelivery: vi.fn(),
      finishManagedAutoMemoryRecall: vi.fn(),
      runManagedAutoMemoryBackgroundTasks: vi.fn(),
      consumePendingMemoryTaskPromises: vi.fn().mockReturnValue([]),
      captureCacheSafeParams: vi.fn(),
      recordCompletedToolCall: vi.fn(),
      resetManagedAutoMemoryAfterCompression: vi.fn(),
    };
    mockMemoryManager = {
      scheduleMetadataMigration: vi.fn().mockResolvedValue(undefined),
      scheduleExtract: vi.fn().mockResolvedValue(undefined),
      scheduleDream: vi.fn().mockResolvedValue(undefined),
      resetExhaustedBodyRefsForCurrentTurn: vi.fn(),
    };
    mockBackgroundTaskRegistry = {
      abortAll: vi.fn(),
      setNotificationCallback: vi.fn(),
      setStatusChangeCallback: vi.fn(),
      clearStatusChangeCallback: vi.fn(),
      hasUnfinalizedTasks: vi.fn().mockReturnValue(false),
      hasRunningTasks: vi.fn().mockReturnValue(false),
      listUnfinalizedBackgroundAgentIds: vi.fn().mockReturnValue([]),
      getAll: vi.fn().mockReturnValue([]),
      get: vi.fn().mockImplementation((taskId: string) =>
        (
          mockBackgroundTaskRegistry.getAll() as Array<{
            id: string;
          }>
        ).find((task) => task.id === taskId),
      ),
    };
    mockMonitorRegistry = {
      setStatusChangeCallback: vi.fn(),
      clearStatusChangeCallback: vi.fn(),
      setNotificationCallback: vi.fn(),
      getAll: vi.fn().mockReturnValue([]),
      get: vi.fn().mockImplementation((monitorId: string) =>
        (
          mockMonitorRegistry.getAll() as Array<{
            id: string;
          }>
        ).find((task) => task.id === monitorId),
      ),
    };
    mockBackgroundShellRegistry = {
      setNotificationCallback: vi.fn(),
      setStatusChangeCallback: vi.fn(),
      clearStatusChangeCallback: vi.fn(),
      hasRunningEntries: vi.fn().mockReturnValue(false),
      getAll: vi.fn().mockReturnValue([]),
      get: vi.fn().mockImplementation((shellId: string) =>
        (
          mockBackgroundShellRegistry.getAll() as Array<{
            id: string;
          }>
        ).find((task) => task.id === shellId),
      ),
    };
    mockWorkflowRunRegistry = {
      hasRunningEntries: vi.fn().mockReturnValue(false),
      setCompletionCallback: vi.fn(),
      setStatusChangeCallback: vi.fn(),
      setSnapshotPersistedCallback: vi.fn(),
      clearStatusChangeCallback: vi.fn(),
      setApprovalRequestCallback: vi.fn(),
      resolvePendingApproval: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockReturnValue(undefined),
      getHandle: vi.fn().mockReturnValue(undefined),
      isStarting: vi.fn().mockReturnValue(false),
      listStartingRunIds: vi.fn().mockReturnValue([]),
      removeTerminal: vi.fn().mockReturnValue(false),
      list: vi.fn().mockReturnValue([]),
      abortAll: vi.fn(),
    };
    unsubscribeApprovalModeChange = vi.fn();

    mockChatRecordingService = {
      supportsMessageGroupDeletion: vi.fn().mockReturnValue(true),
      deleteMessageGroups: vi.fn(),
      readActiveTranscriptChain: vi.fn().mockResolvedValue([] as ChatRecord[]),
      recordTurnAttempt: vi.fn().mockResolvedValue(undefined),
      recordTurnResult: vi.fn(),
      recordUserMessage: vi.fn(),
      recordCronPrompt: vi.fn(),
      recordGoalRuntimeMessage: vi.fn(),
      recordGoalTurnEnd: vi.fn().mockResolvedValue(undefined),
      recordMidTurnUserMessage: vi.fn(),
      recordUiTelemetryEvent: vi.fn(),
      recordToolResult: vi.fn(),
      recordSlashCommand: vi.fn(),
      recordNotification: vi.fn(),
      recordNotificationStrict: vi.fn().mockResolvedValue(undefined),
      recordExternalAgentRecordStrict: vi.fn().mockResolvedValue({
        uuid: 'record-1',
        timestamp: '2026-10-06T01:02:03.000Z',
        created: true,
      }),
      findExternalAgentRecord: vi.fn().mockResolvedValue(undefined),
      recordRealtimeConversation: vi.fn().mockResolvedValue(undefined),
      recordFileHistorySnapshot: vi.fn(),
      getRewindTurnIndex: vi.fn((promptId: string) =>
        ['p1', 'p2', 'p3'].indexOf(promptId),
      ),
      getRewindDaemonPromptId: vi.fn(),
      rewindRecording: vi.fn(),
      setTitleRecordedCallback: vi.fn(),
      getBranchCheckpointCursor: vi.fn().mockReturnValue({
        recordId: null,
        activeRecordCount: 0,
        pendingToolCalls: [],
      }),
      recordBranchCheckpointTransaction: vi.fn().mockResolvedValue(undefined),
      flush: vi.fn().mockResolvedValue(undefined),
      recordSessionModel: vi.fn().mockResolvedValue(true),
      recordSessionApprovalMode: vi.fn().mockResolvedValue(true),
    };
    mockGoalRuntime = {
      getSnapshot: vi.fn().mockReturnValue({
        v: 2,
        activity: 'idle',
        goal: null,
      }),
      getRecoveryCause: vi.fn().mockReturnValue(undefined),
      subscribe: vi.fn().mockReturnValue(() => {}),
      beginTurn: vi.fn(),
      releaseTurn: vi.fn().mockResolvedValue(false),
      markTurnDelivered: vi.fn(),
      permitForTurn: vi.fn(),
      getVerifierFeedback: vi.fn(),
      finishTurn: vi.fn().mockResolvedValue(undefined),
      // Present so settlement branches that pause the goal are assertable;
      // without it a pause throws inside #settleGoalTurn and is swallowed.
      dispatch: vi.fn().mockResolvedValue({
        snapshot: { v: 2, activity: 'idle', goal: null },
      }),
    };
    boundGoalHost = undefined;
    mockFileHistoryService = {
      makeSnapshot: vi.fn().mockResolvedValue(undefined),
      getSnapshots: vi.fn().mockReturnValue([]),
      restoreFromSnapshots: vi.fn(),
      rewind: vi.fn(),
    };

    mockToolRegistry = {
      getAllToolNames: vi.fn().mockReturnValue([]),
      getTool: vi.fn(),
      ensureTool: vi.fn().mockResolvedValue(true),
      isDeferredAndHidden: vi.fn().mockReturnValue(false),
      registerTool: vi.fn(),
      registerPermissionDeferredFactory: vi.fn(),
      revealDeferredTool: vi.fn(),
      unrevealDeferredTool: vi.fn(),
      pinDeferredToolReveal: vi.fn(),
      warmAll: vi.fn().mockResolvedValue(undefined),
      getFunctionDeclarationsFiltered: vi.fn((names: string[]) =>
        names.map((name) => ({ name })),
      ),
    };
    const fileService = {
      shouldGitIgnoreFile: vi.fn().mockReturnValue(false),
      shouldIgnoreFile: vi.fn().mockReturnValue(false),
    };

    mockConfig = {
      storage: {
        getRuntimeBaseDir: vi.fn(() => core.Storage.getRuntimeBaseDir()),
      },
      setApprovalMode: vi.fn(),
      // #buildInitialSystemReminders branches on ApprovalMode.PLAN on every
      // session.prompt(), so the default must be defined. Individual tests
      // that care override via `mockConfig.getApprovalMode = vi.fn()...`.
      getApprovalMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getPrePlanMode: vi.fn().mockReturnValue(ApprovalMode.DEFAULT),
      getPlanExecutionMode: vi.fn().mockReturnValue(undefined),
      getApprovalModeRevision: vi.fn().mockReturnValue(0),
      getShellExecutionConfig: vi.fn().mockReturnValue({
        terminalWidth: 80,
        terminalHeight: 24,
        showColor: false,
      }),
      onApprovalModeChange: vi.fn(() => unsubscribeApprovalModeChange),
      switchModel: switchModelSpy,
      getModel: vi.fn().mockImplementation(() => currentModel),
      getSessionId: vi.fn().mockReturnValue('test-session-id'),
      getSessionSourceType: vi.fn().mockReturnValue(undefined),
      isProvisionalWorkspace: vi.fn().mockReturnValue(false),
      setLiveAppendSystemPrompt: vi.fn(),
      takeActiveTodoReminder: vi.fn().mockReturnValue(undefined),
      getActiveTodoReminder: vi.fn().mockReturnValue(undefined),
      // The restore-ask_user_question prompt path is gated on this flag;
      // the restore describe block overrides to true.
      getRestoreAskUserQuestion: vi.fn().mockReturnValue(false),
      setActiveTodoReminder: vi.fn(),
      startActiveTodoWorkChain: vi.fn(),
      startAutomaticActiveTodoWorkChain: vi.fn(),
      endAutomaticActiveTodoWorkChain: vi.fn(),
      getActiveTodoWorkChainOwner: vi.fn((promptId: string) => promptId),
      getActiveTodoPlanWriterOwner: vi.fn().mockReturnValue(undefined),
      assertCanStartTurn: vi.fn().mockResolvedValue(undefined),
      getWorkingDir: vi.fn().mockReturnValue(process.cwd()),
      getProjectRoot: vi.fn().mockReturnValue('/repo'),
      // Folder trust gates the project `.qwen/loop.md`; default trusted (the
      // production default). Untrusted-folder tests override to false.
      isTrustedFolder: vi.fn().mockReturnValue(true),
      getTelemetryLogPromptsEnabled: vi.fn().mockReturnValue(false),
      getUsageStatisticsEnabled: vi.fn().mockReturnValue(false),
      getContentGeneratorConfig: vi.fn().mockReturnValue(undefined),
      getChatRecordingService: vi
        .fn()
        .mockReturnValue(mockChatRecordingService),
      getManagedRuntimeOutcomes: vi.fn().mockReturnValue(undefined),
      getSessionService: vi.fn().mockReturnValue({
        setSessionPrBoundCallback: vi.fn(),
      }),
      getToolRegistry: vi.fn().mockReturnValue(mockToolRegistry),
      getDisabledTools: vi.fn().mockReturnValue(new Set<string>()),
      getPermissionManager: vi.fn().mockReturnValue(null),
      isTodoWriteEnabled: vi.fn().mockReturnValue(false),
      getToolInvocationGuard: vi.fn().mockReturnValue(undefined),
      getFileService: vi.fn().mockReturnValue(fileService),
      getFileFilteringRespectGitIgnore: vi.fn().mockReturnValue(true),
      getFileFilteringOptions: vi.fn().mockReturnValue({
        respectGitIgnore: true,
        respectQwenIgnore: true,
      }),
      getWorkspaceContext: vi.fn().mockReturnValue({
        isPathWithinWorkspace: vi.fn().mockReturnValue(true),
      }),
      getEnableRecursiveFileSearch: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue(process.cwd()),
      getDebugMode: vi.fn().mockReturnValue(false),
      getAuthType: vi.fn().mockImplementation(() => currentAuthType),
      getAllConfiguredModels: vi.fn().mockReturnValue([]),
      reloadModelProvidersConfig: vi.fn(),
      setImageModel: vi.fn(),
      isCronEnabled: vi.fn().mockReturnValue(false),
      getSessionTokenLimit: vi.fn().mockReturnValue(0),
      getStopHookBlockingCap: vi.fn().mockReturnValue(8),
      // Mimics the resolved Config getter: always a number. The daemon-cap
      // test overrides this with a small value.
      getMaxToolCallsPerTurn: vi
        .fn()
        .mockReturnValue(core.DEFAULT_MAX_TOOL_CALLS_PER_TURN),
      isMaxToolCallsPerTurnExplicit: vi.fn().mockReturnValue(false),
      // Mirrors the resolved settings default (cli/config.ts passes
      // `skipLoopDetection ?? true`): heuristics off unless a test opts in.
      getSkipLoopDetection: vi.fn().mockReturnValue(true),
      getLoopProtection: vi.fn().mockReturnValue('stop'),
      getLlmClient: vi.fn().mockReturnValue(mockLlmClient),
      getManagedAutoMemoryEnabled: vi.fn().mockReturnValue(true),
      getMemoryManager: vi.fn().mockReturnValue(mockMemoryManager),
      getGoalRuntime: vi.fn().mockReturnValue(mockGoalRuntime),
      getGoalRuntimeReady: vi.fn().mockResolvedValue(mockGoalRuntime),
      takePendingGoalProposal: vi.fn(),
      getGoalProposalHostSupported: vi.fn().mockReturnValue(false),
      setGoalProposalTurnKey: vi.fn((turnKey: string | undefined) => {
        if (goalProposalTurnKey === turnKey) return false;
        goalProposalTurnKey = turnKey;
        return true;
      }),
      getGoalRuntimePrepared: vi.fn().mockResolvedValue(mockGoalRuntime),
      bindGoalTurnHost: vi.fn().mockImplementation((host) => {
        boundGoalHost = host;
        return () => {
          if (boundGoalHost === host) boundGoalHost = undefined;
        };
      }),
      getBackgroundTaskRegistry: vi
        .fn()
        .mockReturnValue(mockBackgroundTaskRegistry),
      getBackgroundShellRegistry: vi
        .fn()
        .mockReturnValue(mockBackgroundShellRegistry),
      getMonitorRegistry: vi.fn().mockReturnValue(mockMonitorRegistry),
      getWorkflowRunRegistry: vi.fn().mockReturnValue(mockWorkflowRunRegistry),
      getFileHistoryService: vi.fn().mockReturnValue(mockFileHistoryService),
      getFileReadCache: vi.fn().mockReturnValue({ clear: vi.fn() }),
      getDisabledSkillNames: vi.fn().mockReturnValue(new Set<string>()),
      isSkillEnabled: vi.fn(
        (skill: { name: string }) =>
          !mockConfig.getDisabledSkillNames().has(skill.name.toLowerCase()),
      ),
      setSubSessionSpawner: vi.fn(),
      getSubSessionSpawner: vi.fn(),
      setCurrentSessionScheduledTaskCreator: vi.fn(),
      getCurrentSessionScheduledTaskCreator: vi.fn(),
      getExtensions: vi.fn().mockReturnValue([]),
      // Threaded into resolveDeferredToolCall so the ACP bridge applies the
      // same depth-gated AgentTool re-admission as the terminal scheduler.
      getMaxSubagentDepth: vi.fn().mockReturnValue(5),
    } as unknown as Config;

    mockClient = {
      sessionUpdate: vi.fn().mockResolvedValue(undefined),
      requestPermission: vi.fn().mockResolvedValue({
        outcome: { outcome: 'selected', optionId: 'proceed_once' },
      }),
      extMethod: vi
        .fn()
        .mockImplementation(async (method: string) =>
          method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD
            ? { claimed: true, hasQueuedPrompt: false }
            : { messages: [], hasQueuedPrompt: false },
        ),
      extNotification: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentSideConnection;

    mockSettings = {
      merged: {},
      isTrusted: false,
      user: { settings: {} },
      workspace: { settings: {} },
      forScope: vi.fn((scope: SettingScope) =>
        scope === SettingScope.Workspace
          ? mockSettings.workspace
          : mockSettings.user,
      ),
      setValue: vi.fn(),
      reloadScopeFromDisk: vi.fn(),
      reloadScopesFromDiskAtomically: vi.fn().mockReturnValue(true),
    } as unknown as LoadedSettings;

    getAvailableCommandsSpy = vi.mocked(nonInteractiveCliCommands)
      .getAvailableCommands as unknown as ReturnType<typeof vi.fn>;
    getAvailableCommandsSpy.mockResolvedValue([]);

    session = new Session(
      'test-session-id',
      mockConfig,
      mockClient,
      mockSettings,
    );
  });

  afterEach(() => {
    session?.dispose();
    if (originalProcessGuardMode === undefined) {
      delete process.env['QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD'];
    } else {
      process.env['QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD'] =
        originalProcessGuardMode;
    }
    if (originalServeStamp === undefined) {
      delete process.env['QWEN_CODE_SERVE'];
    } else {
      process.env['QWEN_CODE_SERVE'] = originalServeStamp;
    }
    vi.unstubAllEnvs();
    // Reset global runtime base dir state to prevent state leakage between tests
    core.Storage.setRuntimeBaseDir(null);
    // Clear session reference to allow garbage collection
    session = undefined as unknown as Session;
    mockChat = undefined as unknown as LlmChat;
    mockConfig = undefined as unknown as Config;
    mockClient = undefined as unknown as AgentSideConnection;
    mockSettings = undefined as unknown as LoadedSettings;
    mockLlmClient = undefined as unknown as typeof mockLlmClient;
    mockMemoryManager = undefined as unknown as typeof mockMemoryManager;
    mockToolRegistry = undefined as unknown as typeof mockToolRegistry;
    vi.restoreAllMocks();
    vi.clearAllTimers();
  });

  // Runs a full exit_plan_mode approval turn and returns the permission
  // request the client received, so tests can assert the observable
  // `_meta.qwenTodoApproval` binding instead of poking the private
  // `activeTodoPlanRevision` field. Mirrors the it.each harness in the
  // prompt describe block.
  async function runExitPlanModeApprovalPrompt(
    onConfirm = vi.fn().mockResolvedValue(undefined),
  ): Promise<Parameters<AgentSideConnection['requestPermission']>[0]> {
    let mode = ApprovalMode.PLAN;
    const hookSpy = vi
      .spyOn(core, 'firePermissionRequestHook')
      .mockResolvedValue({
        hasDecision: true,
        shouldAllow: true,
        updatedInput: { plan: 'Hook-replaced plan' },
        denyMessage: undefined,
      });
    const invocation = {
      params: { plan: 'Original plan' },
      requiresUserInteraction: vi.fn().mockReturnValue(true),
      getDefaultPermission: vi.fn().mockResolvedValue('ask'),
      getConfirmationDetails: vi.fn().mockResolvedValue({
        type: 'plan',
        title: 'Approve plan',
        plan: 'Original plan',
        hideAlwaysAllow: true,
        onConfirm,
      }),
      getDescription: vi.fn().mockReturnValue('Plan:'),
      toolLocations: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockImplementation(async () => {
        mode = ApprovalMode.DEFAULT;
        return { llmContent: 'approved', returnDisplay: 'approved' };
      }),
    };
    const tool = {
      name: core.ToolNames.EXIT_PLAN_MODE,
      kind: core.Kind.Think,
      build: vi.fn().mockReturnValue(invocation),
    };

    mockToolRegistry.getTool.mockReturnValue(tool);
    mockConfig.getApprovalMode = vi.fn(() => mode);
    mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
    mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
    mockConfig.getMessageBus = vi.fn().mockReturnValue({});
    mockChat.sendMessageStream = vi.fn().mockResolvedValue(
      createStreamWithChunks([
        {
          type: core.StreamEventType.CHUNK,
          value: {
            functionCalls: [
              {
                id: 'call-exit-plan',
                name: core.ToolNames.EXIT_PLAN_MODE,
                args: { plan: 'Original plan' },
              },
            ],
          },
        },
      ]),
    );

    try {
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'approve the plan' }],
      });
    } finally {
      hookSpy.mockRestore();
    }

    const calls = vi.mocked(mockClient.requestPermission).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    return calls.at(-1)![0];
  }

  function enableSessionWorkflowRevisionContext(): void {
    let revision:
      | { planId: string; sourceCallId: string; todoIds: readonly string[] }
      | undefined;
    mockConfig.isSessionWorkflowEnabled = vi.fn().mockReturnValue(true);
    mockConfig.setSessionWorkflowPlanRevision = vi.fn((next) => {
      revision = next;
    });
    mockConfig.clearSessionWorkflowPlanRevision = vi.fn(() => {
      revision = undefined;
    });
    mockConfig.getSessionWorkflowPlanRevision = vi.fn(() => revision);
  }

  describe('prompt', () => {
    describe('auto-compress', () => {
      describe('queued input during a streaming response', () => {
        const interruptPrefix =
          '\n[User message received while you were responding; your response was interrupted]: ';
        const responsePrefix =
          '\n[User message received while you were responding]: ';
        const readFileTool = (execute: ReturnType<typeof vi.fn>) => ({
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
            execute,
          }),
        });
        const readFileCall = {
          type: core.StreamEventType.CHUNK,
          value: {
            functionCalls: [
              { id: 'c', name: 'read_file', args: { path: '/tmp/test.txt' } },
            ],
          },
        };
        const textChunk = {
          type: core.StreamEventType.CHUNK,
          value: { candidates: [{ content: { parts: [{ text: 'plan A' }] } }] },
        };
        const imageItem = {
          messageId: 'm-image',
          displayText: 'look at this',
          content: [
            { type: 'text', text: 'look at this' },
            { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgo=' },
          ],
        };
        const drainCalls = () =>
          vi
            .mocked(mockClient.extMethod)
            .mock.calls.filter((call) => call[0] === 'craft/drainMidTurnQueue');
        const nextTick = () =>
          new Promise<void>((resolve) => setImmediate(resolve));
        // Drives the mid-turn drain deadlines; everything else stays real.
        const useFakeDrainTimers = () =>
          vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const pastDrainTimeout = () => vi.advanceTimersByTimeAsync(2_100);

        /** Opens send number `emptyBefore + 1`; every other send is empty. */
        function openResponse(
          chunks: Array<{ type: unknown; value?: unknown }>,
          emptyBefore = 0,
        ) {
          let markStreaming!: () => void;
          const streaming = new Promise<void>((resolve) => {
            markStreaming = resolve;
          });
          let release!: () => void;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          const state: { signal?: AbortSignal } = {};
          let sends = 0;
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementation(
              async (
                _model: string,
                request: { config: { abortSignal: AbortSignal } },
              ) => {
                if (sends++ !== emptyBefore) return createEmptyStream();
                state.signal = request.config.abortSignal;
                return createOpenStream(
                  chunks,
                  request.config.abortSignal,
                  released,
                  markStreaming,
                );
              },
            );
          return { streaming, release, state };
        }

        const startPrompt = () =>
          session.prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'do it' }],
            },
            {
              version: 1,
              sessionId: 'test-session-id',
              promptId: 'rpc-steer',
            },
          );

        it('cuts the response short and answers the input in the same turn', async () => {
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValueOnce({ messages: ['use plan B instead'] })
            .mockResolvedValue({ messages: [] });
          const { streaming, state } = openResponse([textChunk]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(state.signal?.aborted).toBe(true);
          expect(drainCalls()[0]).toEqual([
            'craft/drainMidTurnQueue',
            {
              sessionId: 'test-session-id',
              promptId: 'rpc-steer',
              userInputOnly: true,
            },
          ]);
          const midTurnPart = { text: `${interruptPrefix}use plan B instead` };
          const sends = vi.mocked(mockChat.sendMessageStream).mock.calls;
          expect(sends).toHaveLength(2);
          expect(sends[1]?.[1].message).toEqual([midTurnPart]);
          expect(
            mockChatRecordingService.recordMidTurnUserMessage,
          ).toHaveBeenCalledWith([midTurnPart], 'use plan B instead');
        });

        it('answers the input when the cut response ends with an error', async () => {
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValueOnce({ messages: ['use plan B instead'] })
            .mockResolvedValue({ messages: [] });
          let markStreaming!: () => void;
          const streaming = new Promise<void>((resolve) => {
            markStreaming = resolve;
          });
          let sends = 0;
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementation(
              async (
                _model: string,
                request: { config: { abortSignal: AbortSignal } },
              ) => {
                if (sends++ > 0) return createEmptyStream();
                const signal = request.config.abortSignal;
                return (async function* () {
                  yield textChunk;
                  markStreaming();
                  await new Promise<void>((resolve) =>
                    signal.addEventListener('abort', () => resolve(), {
                      once: true,
                    }),
                  );
                  throw Object.assign(new Error('upstream 429'), {
                    status: 429,
                  });
                })();
              },
            );

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();

          // The cut response was given up; the input goes out in its place.
          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          const calls = vi.mocked(mockChat.sendMessageStream).mock.calls;
          expect(calls).toHaveLength(2);
          expect(calls[1]?.[1].message).toEqual([
            { text: `${interruptPrefix}use plan B instead` },
          ]);
        });

        describe('on the shared agent loop round', () => {
          /** Streams `plan A`, then holds the response until it is cut. */
          function openSharedResponse(endsWithError = false) {
            let markStreaming!: () => void;
            const streaming = new Promise<void>((resolve) => {
              markStreaming = resolve;
            });
            const sends: Array<
              [Part[], AbortSignal, string, Record<string, unknown>]
            > = [];
            mockConfig.isUnifiedAgentLoopEnabled = vi
              .fn()
              .mockReturnValue(true);
            Object.assign(mockLlmClient, {
              admitUserPrompt: vi.fn().mockResolvedValue({ blocked: false }),
              sendMessageStream: vi.fn(
                (
                  parts: Part[],
                  signal: AbortSignal,
                  promptId: string,
                  options: Record<string, unknown>,
                ) => {
                  sends.push([parts, signal, promptId, options]);
                  if (sends.length > 1) return createEmptyStream();
                  return (async function* () {
                    yield { type: core.LlmEventType.Content, value: 'plan A' };
                    markStreaming();
                    await new Promise<void>((resolve) =>
                      signal.addEventListener('abort', () => resolve(), {
                        once: true,
                      }),
                    );
                    if (endsWithError) {
                      throw Object.assign(new Error('upstream 429'), {
                        status: 429,
                      });
                    }
                    yield { type: core.LlmEventType.UserCancelled };
                  })();
                },
              ),
            });
            return { streaming, sends };
          }

          it.each([
            ['', false],
            [' when the cut response ends with an error', true],
          ])(
            'cuts the response short and answers the input in the same turn%s',
            async (_label, endsWithError) => {
              mockClient.extMethod = vi
                .fn()
                .mockResolvedValueOnce({ messages: ['use plan B instead'] })
                .mockResolvedValue({ messages: [] });
              const { streaming, sends } = openSharedResponse(endsWithError);

              const done = startPrompt();
              await streaming;
              session.sendMidTurnInputNow();

              await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
              expect(sends[0][1].aborted).toBe(true);
              expect(sends).toHaveLength(2);
              expect(sends[1][0]).toEqual([
                { text: `${interruptPrefix}use plan B instead` },
              ]);
              expect(sends[1][3]).toMatchObject({
                type: core.SendMessageType.Steer,
              });
              // The session runs the client's memory tasks once the turn ends.
              expect(
                mockLlmClient.runManagedAutoMemoryBackgroundTasks,
              ).toHaveBeenCalledExactlyOnceWith(core.SendMessageType.UserQuery);
            },
          );

          it('lets the Todo Stop Guard yield to input taken as the response finished', async () => {
            let markStreaming!: () => void;
            const streaming = new Promise<void>((resolve) => {
              markStreaming = resolve;
            });
            let finish!: () => void;
            const finishing = new Promise<void>((resolve) => {
              finish = resolve;
            });
            let policyResult: unknown = 'not asked';
            const sends: Array<[Part[], Record<string, unknown>]> = [];
            mockConfig.isUnifiedAgentLoopEnabled = vi
              .fn()
              .mockReturnValue(true);
            Object.assign(mockLlmClient, {
              admitUserPrompt: vi.fn().mockResolvedValue({ blocked: false }),
              sendMessageStream: vi.fn(
                (
                  parts: Part[],
                  signal: AbortSignal,
                  promptId: string,
                  options: { stopPolicies?: core.StopPolicy[] },
                ) => {
                  sends.push([parts, options]);
                  if (sends.length > 1) return createEmptyStream();
                  return (async function* () {
                    yield { type: core.LlmEventType.Content, value: 'plan A' };
                    markStreaming();
                    await finishing;
                    yield {
                      type: core.LlmEventType.Finished,
                      value: { reason: FinishReason.STOP },
                    };
                    // The client's stop point, after the window closed.
                    policyResult = await options.stopPolicies?.[0]?.continueAt({
                      promptId,
                      signal,
                    });
                  })();
                },
              ),
            });
            let answerDrain!: (value: unknown) => void;
            mockClient.extMethod = vi
              .fn()
              .mockImplementationOnce(
                () =>
                  new Promise((resolve) => {
                    answerDrain = resolve;
                  }),
              )
              .mockResolvedValue({ messages: [] });
            const decide = vi.spyOn(
              (session as unknown as { todoStopGuard: { decide: () => void } })
                .todoStopGuard,
              'decide',
            );

            const done = startPrompt();
            await streaming;
            session.sendMidTurnInputNow();
            await nextTick();
            finish();
            await nextTick();
            answerDrain({ messages: ['also check tests'] });

            await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
            // The guard neither decided nor claimed a continuation.
            expect(policyResult).toBeUndefined();
            expect(decide).not.toHaveBeenCalled();
            expect(
              vi
                .mocked(mockClient.extMethod)
                .mock.calls.some(
                  ([method]) =>
                    method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD,
                ),
            ).toBe(false);
            expect(sends).toHaveLength(2);
            expect(sends[1][0]).toEqual([
              { text: `${responsePrefix}also check tests` },
            ]);
            expect(sends[1][1]).toMatchObject({
              type: core.SendMessageType.Steer,
            });
          });

          describe('in a Goal turn', () => {
            const permit: core.GoalTurnPermit = {
              goalId: 'goal-1',
              revision: 1,
              turnId: 'turn-late-input',
            };
            const turnKey = 'goal-runtime:turn-late-input';

            /**
             * Runs a Goal continuation whose first response takes input that
             * its drain answers after the response finished. Each round ends
             * as the client ends one: its stop point, then `atStop`.
             */
            async function runWithLateInput(
              atStop: (
                options: { stopPolicies?: core.StopPolicy[] },
                signal: AbortSignal,
                promptId: string,
                first: boolean,
              ) => Promise<void>,
            ) {
              let live = true;
              mockGoalRuntime.getSnapshot.mockReturnValue({
                v: 2,
                activity: 'running',
                goal: {
                  goalId: 'goal-1',
                  revision: 1,
                  objective: 'check weather',
                  status: 'active',
                  evidenceCursor: { recordId: 'cursor-1' },
                  turnCount: 0,
                  activeTimeMs: 0,
                  tokensUsed: 0,
                  createdAt: 1234,
                  updatedAt: 1234,
                },
              });
              mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
                live && key === turnKey ? permit : undefined,
              );
              mockGoalRuntime.finishTurn.mockImplementation(async () => {
                live = false;
              });
              let pushCount = 0;
              Object.assign(mockChat, {
                getUserContentPushCount: vi.fn(() => pushCount),
              });
              let markStreaming!: () => void;
              const streaming = new Promise<void>((resolve) => {
                markStreaming = resolve;
              });
              let finish!: () => void;
              const finishing = new Promise<void>((resolve) => {
                finish = resolve;
              });
              const sends: Array<
                [Part[], AbortSignal, Record<string, unknown>]
              > = [];
              const refused: string[] = [];
              mockConfig.isUnifiedAgentLoopEnabled = vi
                .fn()
                .mockReturnValue(true);
              Object.assign(mockLlmClient, {
                admitUserPrompt: vi.fn().mockResolvedValue({ blocked: false }),
                sendMessageStream: vi.fn(
                  (
                    parts: Part[],
                    signal: AbortSignal,
                    promptId: string,
                    options: {
                      stopPolicies?: core.StopPolicy[];
                      goalPermit?: core.GoalTurnPermit;
                      goalTurnKey?: string;
                    },
                  ) => {
                    sends.push([
                      parts,
                      signal,
                      options as Record<string, unknown>,
                    ]);
                    const first = sends.length === 1;
                    return (async function* () {
                      // The client refuses a send under a permit the runtime
                      // no longer holds, before its request goes out.
                      if (
                        options.goalPermit &&
                        !mockGoalRuntime.permitForTurn(options.goalTurnKey!)
                      ) {
                        refused.push(promptId);
                        throw new Error('Goal turn permit is no longer valid');
                      }
                      pushCount++;
                      yield { type: core.LlmEventType.Content, value: 'done' };
                      if (first) {
                        markStreaming();
                        await finishing;
                      }
                      yield {
                        type: core.LlmEventType.Finished,
                        value: { reason: FinishReason.STOP },
                      };
                      await atStop(options, signal, promptId, first);
                    })();
                  },
                ),
              });
              let answerDrain: ((value: unknown) => void) | undefined;
              mockClient.extMethod = vi.fn().mockImplementation((method) => {
                if (method === 'craft/drainMidTurnQueue' && !answerDrain) {
                  return new Promise((resolve) => {
                    answerDrain = resolve;
                  });
                }
                return Promise.resolve({ messages: [] });
              });

              void boundGoalHost!.startGoalTurn({
                permit,
                continuationContext: 'check weather',
              });
              await streaming;
              session.sendMidTurnInputNow();
              await vi.waitFor(() => expect(answerDrain).toBeDefined());
              finish();
              await nextTick();
              answerDrain!({ messages: ['late steer'] });
              await vi.waitFor(() => expect(sends).toHaveLength(2));
              await vi.waitFor(() =>
                expect(mockGoalRuntime.finishTurn).toHaveBeenCalled(),
              );
              return { sends, refused };
            }

            it('keeps the turn to answer input taken as the response finished', async () => {
              const { sends, refused } = await runWithLateInput(
                async (options, signal, promptId) => {
                  // The client's stop point: a stop policy, then a natural end
                  // finishes the Goal turn unless the round's signal ended.
                  await options.stopPolicies?.[0]?.continueAt({
                    promptId,
                    signal,
                  });
                  if (!signal.aborted) await mockGoalRuntime.finishTurn(permit);
                },
              );

              expect(refused).toEqual([]);
              // The finished response was not cut; its round ended so the
              // client left the turn to the session.
              expect(sends[0][1].aborted).toBe(true);
              expect(sends[1][0]).toEqual([
                { text: `${responsePrefix}late steer` },
              ]);
              expect(sends[1][2]).toMatchObject({
                type: core.SendMessageType.Steer,
                goalPermit: permit,
                goalTurnKey: turnKey,
              });
              expect(mockGoalRuntime.finishTurn).toHaveBeenCalledOnce();
            });

            it('answers input taken as the Stop hook capped the turn outside the Goal', async () => {
              const { sends, refused } = await runWithLateInput(
                async (options, _signal, _promptId, first) => {
                  if (!first) return;
                  // The client's Stop-hook cap pauses the Goal and releases
                  // the turn's permit.
                  options.stopPolicies?.[0]?.onStopHookCap?.();
                  await mockGoalRuntime.finishTurn(permit);
                },
              );

              expect(refused).toEqual([]);
              expect(sends[1][0]).toEqual([
                { text: `${responsePrefix}late steer` },
              ]);
              expect(sends[1][2]).toMatchObject({
                type: core.SendMessageType.Steer,
              });
              expect(sends[1][2]['goalPermit']).toBeUndefined();
              expect(mockGoalRuntime.finishTurn).toHaveBeenCalledOnce();
            });
          });

          /**
           * Holds the first request before it reaches history until `push`,
           * then holds its response, after `beforeAnswer` events, until it is
           * cut or released.
           */
          function holdSharedRequest(beforeAnswer: unknown[] = []) {
            let markReached!: () => void;
            const reached = new Promise<void>((resolve) => {
              markReached = resolve;
            });
            let markPushed!: () => void;
            const pushedNow = new Promise<void>((resolve) => {
              markPushed = resolve;
            });
            let push!: () => void;
            const pushGate = new Promise<void>((resolve) => {
              push = resolve;
            });
            let release!: () => void;
            const released = new Promise<void>((resolve) => {
              release = resolve;
            });
            let pushes = 0;
            Object.assign(mockChat, {
              getUserContentPushCount: vi.fn(() => pushes),
            });
            const sends: Array<
              [Part[], AbortSignal, string, Record<string, unknown>]
            > = [];
            mockConfig.isUnifiedAgentLoopEnabled = vi
              .fn()
              .mockReturnValue(true);
            Object.assign(mockLlmClient, {
              admitUserPrompt: vi.fn().mockResolvedValue({ blocked: false }),
              sendMessageStream: vi.fn(
                (
                  parts: Part[],
                  signal: AbortSignal,
                  promptId: string,
                  options: Record<string, unknown>,
                ) => {
                  sends.push([parts, signal, promptId, options]);
                  if (sends.length > 1) {
                    pushes++;
                    return createEmptyStream();
                  }
                  return (async function* () {
                    markReached();
                    await pushGate;
                    pushes++;
                    markPushed();
                    for (const event of beforeAnswer) yield event;
                    await Promise.race([
                      released,
                      new Promise<void>((resolve) =>
                        signal.addEventListener('abort', () => resolve(), {
                          once: true,
                        }),
                      ),
                    ]);
                    if (signal.aborted) {
                      yield { type: core.LlmEventType.UserCancelled };
                    }
                  })();
                },
              ),
            });
            return { reached, pushedNow, push, release, sends };
          }

          it('cuts a response that has not answered yet', async () => {
            mockClient.extMethod = vi
              .fn()
              .mockResolvedValueOnce({ messages: ['use plan B instead'] })
              .mockResolvedValue({ messages: [] });
            const { pushedNow, push, release, sends } = holdSharedRequest();

            const done = startPrompt();
            push();
            await pushedNow;
            // The request is out and the model has not answered yet.
            session.sendMidTurnInputNow();
            try {
              await vi.waitFor(() => expect(sends[0][1].aborted).toBe(true));
            } finally {
              release();
            }

            await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
            expect(sends).toHaveLength(2);
            expect(sends[1][0]).toEqual([
              { text: `${interruptPrefix}use plan B instead` },
            ]);
            expect(sends[1][3]).toMatchObject({
              type: core.SendMessageType.Steer,
            });
          });

          it('takes input sent before the request went out once its response opens', async () => {
            mockClient.extMethod = vi
              .fn()
              .mockResolvedValueOnce({ messages: ['use plan B instead'] })
              .mockResolvedValue({ messages: [] });
            const { reached, push, release, sends } = holdSharedRequest([
              { type: core.LlmEventType.Content, value: 'plan A' },
            ]);

            const done = startPrompt();
            await reached;
            // A cut now would drop the prompt the request carries.
            session.sendMidTurnInputNow();
            await nextTick();
            expect(drainCalls()).toHaveLength(0);
            expect(sends[0][1].aborted).toBe(false);
            push();
            try {
              await vi.waitFor(() => expect(sends[0][1].aborted).toBe(true));
            } finally {
              release();
            }

            await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
            expect(sends).toHaveLength(2);
            expect(sends[1][0]).toEqual([
              { text: `${interruptPrefix}use plan B instead` },
            ]);
          });

          it('leaves a finished response alone while the round goes on', async () => {
            mockClient.extMethod = vi
              .fn()
              .mockResolvedValueOnce({ messages: ['use plan B instead'] })
              .mockResolvedValue({ messages: [] });
            let markFinished!: () => void;
            const finished = new Promise<void>((resolve) => {
              markFinished = resolve;
            });
            let release!: () => void;
            const released = new Promise<void>((resolve) => {
              release = resolve;
            });
            const signals: AbortSignal[] = [];
            mockConfig.isUnifiedAgentLoopEnabled = vi
              .fn()
              .mockReturnValue(true);
            Object.assign(mockLlmClient, {
              admitUserPrompt: vi.fn().mockResolvedValue({ blocked: false }),
              sendMessageStream: vi.fn(
                (_parts: Part[], signal: AbortSignal) => {
                  signals.push(signal);
                  if (signals.length > 1) return createEmptyStream();
                  return (async function* () {
                    yield { type: core.LlmEventType.Content, value: 'plan A' };
                    yield {
                      type: core.LlmEventType.Finished,
                      value: { reason: FinishReason.STOP },
                    };
                    markFinished();
                    // The client's own work after the response, such as a
                    // next-speaker check.
                    await released;
                  })();
                },
              ),
            });

            const done = startPrompt();
            await finished;
            session.sendMidTurnInputNow();
            await new Promise((resolve) => setImmediate(resolve));
            release();

            await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
            expect(signals[0].aborted).toBe(false);
            expect(signals).toHaveLength(1);
          });

          it.each([
            {
              type: core.LlmEventType.HookSystemMessage,
              value:
                'Stop hook blocked continuation 1 consecutive time; overriding and ending the turn.',
            },
            {
              type: core.LlmEventType.StopHookLoop,
              value: {
                iterationCount: 1,
                reasons: ['Finish the requested work'],
                stopHookCount: 1,
              },
            },
          ] as const)(
            'keeps stop-time input queued when the client emits $type',
            async (hookEvent) => {
              mockClient.extMethod = vi
                .fn()
                .mockResolvedValueOnce({ messages: ['use plan B instead'] })
                .mockResolvedValue({ messages: [] });
              let markHookStarted!: () => void;
              const hookStarted = new Promise<void>((resolve) => {
                markHookStarted = resolve;
              });
              let releaseHook!: () => void;
              const hookReleased = new Promise<void>((resolve) => {
                releaseHook = resolve;
              });
              const signals: AbortSignal[] = [];
              mockConfig.isUnifiedAgentLoopEnabled = vi
                .fn()
                .mockReturnValue(true);
              Object.assign(mockLlmClient, {
                admitUserPrompt: vi.fn().mockResolvedValue({ blocked: false }),
                sendMessageStream: vi.fn(
                  (_parts: Part[], signal: AbortSignal) => {
                    signals.push(signal);
                    if (signals.length > 1) return createEmptyStream();
                    return (async function* () {
                      yield {
                        type: core.LlmEventType.Content,
                        value: 'plan A',
                      };
                      yield {
                        type: core.LlmEventType.Finished,
                        value: { reason: FinishReason.STOP },
                      };
                      markHookStarted();
                      await hookReleased;
                      yield hookEvent;
                      await nextTick();
                    })();
                  },
                ),
              });

              const done = startPrompt();
              await hookStarted;
              session.sendMidTurnInputNow();
              releaseHook();

              await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
              expect(signals[0].aborted).toBe(false);
              expect(drainCalls()).toHaveLength(0);
              expect(signals).toHaveLength(1);
            },
          );
        });

        it('cuts a response that has not streamed anything yet', async () => {
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValueOnce({ messages: ['use plan B instead'] })
            .mockResolvedValue({ messages: [] });
          let markSent!: () => void;
          const sent = new Promise<void>((resolve) => {
            markSent = resolve;
          });
          let openResponseNow!: () => void;
          const opened = new Promise<void>((resolve) => {
            openResponseNow = resolve;
          });
          let release!: () => void;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          let signal: AbortSignal | undefined;
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementationOnce(
              async (
                _model: string,
                request: { config: { abortSignal: AbortSignal } },
              ) => {
                signal = request.config.abortSignal;
                markSent();
                await opened;
                return createOpenStream(
                  [],
                  request.config.abortSignal,
                  released,
                  () => {},
                );
              },
            )
            .mockResolvedValue(createEmptyStream());

          const done = startPrompt();
          await sent;
          // The request is out but no response is open yet: the request
          // waits for one.
          session.sendMidTurnInputNow();
          await nextTick();
          expect(drainCalls()).toHaveLength(0);
          openResponseNow();
          try {
            await vi.waitFor(() => expect(signal?.aborted).toBe(true));
          } finally {
            release();
          }

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[1]?.[1].message,
          ).toEqual([{ text: `${interruptPrefix}use plan B instead` }]);
        });

        it('cuts a Goal continuation short and answers the input in it', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-send-now',
          };
          mockGoalRuntime.getSnapshot.mockReturnValue({
            v: 2,
            activity: 'running',
            goal: {
              goalId: 'goal-1',
              revision: 1,
              objective: 'check weather',
              status: 'active',
              evidenceCursor: { recordId: 'cursor-1' },
              turnCount: 0,
              activeTimeMs: 0,
              tokensUsed: 0,
              createdAt: 1234,
              updatedAt: 1234,
            },
          });
          mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
            turnKey === 'goal-runtime:turn-send-now' ? permit : undefined,
          );
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValueOnce({ messages: ['use plan B instead'] })
            .mockResolvedValue({ messages: [] });
          const { streaming, state } = openResponse([textChunk]);

          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'check weather',
          });
          await streaming;
          session.sendMidTurnInputNow();

          await vi.waitFor(() =>
            expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit),
          );
          expect(state.signal?.aborted).toBe(true);
          // The host does not know a Goal continuation's id.
          expect(drainCalls()[0]).toEqual([
            'craft/drainMidTurnQueue',
            { sessionId: 'test-session-id', userInputOnly: true },
          ]);
          const sends = vi.mocked(mockChat.sendMessageStream).mock.calls;
          expect(sends).toHaveLength(2);
          expect(sends[1]?.[1].message).toEqual([
            { text: `${interruptPrefix}use plan B instead` },
          ]);
        });

        it('lets the response finish when the queue holds nothing', async () => {
          mockClient.extMethod = vi.fn().mockResolvedValue({ messages: [] });
          const { streaming, release, state } = openResponse([textChunk]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(drainCalls()).toHaveLength(1));
          await nextTick();
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(state.signal?.aborted).toBe(false);
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });

        it('leaves input to the tool boundary once the response called a tool', async () => {
          mockToolRegistry.getTool.mockReturnValue(
            readFileTool(
              vi
                .fn()
                .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
            ),
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValueOnce({ messages: ['also check tests'] })
            .mockResolvedValue({ messages: [] });
          const { streaming, release, state } = openResponse([readFileCall]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await nextTick();
          expect(drainCalls()).toHaveLength(0);
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(state.signal?.aborted).toBe(false);
          const nextMessage = vi.mocked(mockChat.sendMessageStream).mock
            .calls[1]?.[1].message as Part[];
          expect(
            nextMessage.some((part) => part.functionResponse !== undefined),
          ).toBe(true);
          expect(nextMessage).toContainEqual({
            text: '\n[User message received during tool execution]: also check tests',
          });
        });

        it('answers input whose drain returns after the response ended', async () => {
          let answerDrain: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerDrain = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          const { streaming, release, state } = openResponse([textChunk]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(answerDrain).toBeDefined());
          release();
          await nextTick();
          answerDrain!({ messages: ['late steer'] });

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(state.signal?.aborted).toBe(false);
          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[1]?.[1].message,
          ).toEqual([
            {
              text: '\n[User message received while you were responding]: late steer',
            },
          ]);
        });

        it('cuts a Stop-hook continuation short as well', async () => {
          let stopCalls = 0;
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getMessageBus = vi.fn().mockReturnValue({
            request: vi.fn().mockImplementation(async (request) => {
              if (request.eventName !== 'Stop') {
                return { success: true, output: {} };
              }
              stopCalls++;
              return stopCalls === 1
                ? {
                    success: true,
                    output: { decision: 'block', reason: 'Keep working' },
                  }
                : { success: true, output: {} };
            }),
          });
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((name: string) => name === 'Stop');
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValueOnce({ messages: ['stop here'] })
            .mockResolvedValue({ messages: [] });
          const { streaming, state } = openResponse([textChunk], 1);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(state.signal?.aborted).toBe(true);
          const sends = vi.mocked(mockChat.sendMessageStream).mock.calls;
          expect(sends[1]?.[1].message).toEqual([{ text: 'Keep working' }]);
          expect(sends[2]?.[1].message).toEqual([
            { text: `${interruptPrefix}stop here` },
          ]);
        });

        it('restarts the Stop-hook block count for input that cut a forced continuation', async () => {
          mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(3);
          let stopCalls = 0;
          const stopActiveFlags: unknown[] = [];
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getMessageBus = vi.fn().mockReturnValue({
            request: vi.fn().mockImplementation(async (request) => {
              if (request.eventName !== 'Stop') {
                return { success: true, output: {} };
              }
              stopCalls++;
              stopActiveFlags.push(request.input?.stop_hook_active);
              return stopCalls <= 3
                ? {
                    success: true,
                    output: { decision: 'block', reason: `block ${stopCalls}` },
                  }
                : { success: true, output: {} };
            }),
          });
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((name: string) => name === 'Stop');
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValueOnce({ messages: ['do this instead'] })
            .mockResolvedValue({ messages: [] });
          const { streaming, state } = openResponse([textChunk], 1);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(state.signal?.aborted).toBe(true);
          // The user's input replaced the hook-forced turn: the next Stop
          // check is not hook-forced, and its block starts a new run.
          expect(stopActiveFlags).toEqual([false, false, true, true]);
          const stopHookLoops = vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.map(([params]) => params.update._meta?.['stopHookLoop'])
            .filter((meta) => meta !== undefined);
          expect(stopHookLoops).toEqual([
            expect.objectContaining({
              iterationCount: 2,
              reasons: ['block 2', 'block 3'],
            }),
          ]);
          expect(agentMessageChunks()).not.toContain(
            'Stop hook blocked continuation 3 consecutive times; overriding and ending the turn.',
          );
        });

        it('restarts the Stop-hook state for input that cut a background-result continuation', async () => {
          let stopCalls = 0;
          const stopActiveFlags: unknown[] = [];
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getMessageBus = vi.fn().mockReturnValue({
            request: vi.fn().mockImplementation(async (request) => {
              if (request.eventName !== 'Stop') {
                return { success: true, output: {} };
              }
              stopCalls++;
              stopActiveFlags.push(request.input?.stop_hook_active);
              return stopCalls === 1
                ? {
                    success: true,
                    output: { decision: 'block', reason: 'Keep working' },
                  }
                : { success: true, output: {} };
            }),
          });
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((name: string) => name === 'Stop');
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValueOnce({ messages: ['look at the result'] })
            .mockResolvedValue({ messages: [] });
          const { streaming, state } = openResponse([textChunk], 2);
          const send = mockChat.sendMessageStream as (
            ...args: unknown[]
          ) => unknown;
          const notify = mockBackgroundTaskRegistry.setNotificationCallback.mock
            .calls[0]?.[0] as (
            display: string,
            model: string,
            meta: { agentId: string; status: string; sourceTurnId?: string },
          ) => void;
          let sends = 0;
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementation(async (...args: unknown[]) => {
              // A background result arrives during the hook-forced
              // continuation, so the next send answers it.
              if (++sends === 2) {
                notify('worker done', 'BACKGROUND RESULT', {
                  agentId: 'worker',
                  status: 'completed',
                  sourceTurnId: 'rpc-steer',
                });
              }
              return send(...args);
            });

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(state.signal?.aborted).toBe(true);
          expect(
            JSON.stringify(
              vi.mocked(mockChat.sendMessageStream).mock.calls[2]?.[1],
            ),
          ).toContain('BACKGROUND RESULT');
          // The user's input replaced the turn that the hook had forced.
          expect(stopActiveFlags).toEqual([false, false]);
        });
        it('leaves input with the host while a tool call is still streaming', async () => {
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValue({ messages: ['also check tests'] });
          const { streaming, release, state } = openResponse([
            {
              type: core.StreamEventType.CHUNK,
              value: createPreparationResponse('c', 'write_file'),
            },
          ]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await nextTick();
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(state.signal?.aborted).toBe(false);
          expect(drainCalls()).toHaveLength(0);
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });

        it('leaves input with the host while a Stop-hook continuation streams a tool call', async () => {
          let stopCalls = 0;
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getMessageBus = vi.fn().mockReturnValue({
            request: vi.fn().mockImplementation(async (request) => {
              if (request.eventName !== 'Stop') {
                return { success: true, output: {} };
              }
              stopCalls++;
              return stopCalls === 1
                ? {
                    success: true,
                    output: { decision: 'block', reason: 'Keep working' },
                  }
                : { success: true, output: {} };
            }),
          });
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((name: string) => name === 'Stop');
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValue({ messages: ['also check tests'] });
          const { streaming, release, state } = openResponse(
            [
              {
                type: core.StreamEventType.CHUNK,
                value: createPreparationResponse('c', 'write_file'),
              },
            ],
            1,
          );

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await nextTick();
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(state.signal?.aborted).toBe(false);
          expect(drainCalls()).toHaveLength(0);
        });

        it('does not drain when the host cannot answer drains', async () => {
          (
            session as unknown as { midTurnDrainUnavailable: boolean }
          ).midTurnDrainUnavailable = true;
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValue({ messages: ['not served'] });
          const { streaming, release, state } = openResponse([textChunk]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await nextTick();
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(drainCalls()).toHaveLength(0);
          expect(state.signal?.aborted).toBe(false);
        });

        it('leaves input with the host when the tool it waits for ends the turn', async () => {
          mockToolRegistry.getTool.mockReturnValue(
            readFileTool(
              vi.fn().mockResolvedValue({
                llmContent: 'ok',
                returnDisplay: 'ok',
                terminateTurn: true,
              }),
            ),
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValue({ messages: ['urgent: stop'] });
          const { streaming, release } = openResponse([readFileCall]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await nextTick();
          release();

          // Nothing was taken from the host, so it promotes the message when
          // the turn ends instead of the turn swallowing it.
          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(drainCalls()).toHaveLength(0);
          expect(
            mockChatRecordingService.recordMidTurnUserMessage,
          ).not.toHaveBeenCalled();
        });

        it('leaves input recovered from a timed-out drain to the tool boundary', async () => {
          mockToolRegistry.getTool.mockReturnValue(
            readFileTool(
              vi
                .fn()
                .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
            ),
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          let answerLate: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerLate = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(createStreamWithChunks([readFileCall]))
            .mockResolvedValue(createEmptyStream());
          useFakeDrainTimers();
          try {
            // The tool-boundary drain times out; its answer lands afterwards.
            const first = startPrompt();
            await vi.waitFor(() => expect(answerLate).toBeDefined());
            await pastDrainTimeout();
            await first;
            answerLate!({ messages: ['recovered late'] });
            await nextTick();
          } finally {
            vi.useRealTimers();
          }
          const drainsBefore = drainCalls().length;
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createStreamWithChunks([textChunk as never]));

          await expect(startPrompt()).resolves.toEqual({
            stopReason: 'end_turn',
          });
          expect(drainCalls()).toHaveLength(drainsBefore);
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });

        it('never interrupts a channel turn', async () => {
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValue({ messages: ['not now'] });
          const { streaming, release, state } = openResponse([textChunk]);

          const done = session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'channel task' }],
            _meta: { [CHANNEL_PROMPT_META_KEY]: true },
          });
          await streaming;
          session.sendMidTurnInputNow();
          await nextTick();
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(drainCalls()).toHaveLength(0);
          expect(state.signal?.aborted).toBe(false);
        });

        it('never interrupts a Stop-hook continuation of a channel turn', async () => {
          let stopCalls = 0;
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getMessageBus = vi.fn().mockReturnValue({
            request: vi.fn().mockImplementation(async (request) => {
              if (request.eventName !== 'Stop') {
                return { success: true, output: {} };
              }
              stopCalls++;
              return stopCalls === 1
                ? {
                    success: true,
                    output: { decision: 'block', reason: 'Keep working' },
                  }
                : { success: true, output: {} };
            }),
          });
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((name: string) => name === 'Stop');
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValue({ messages: ['not now'] });
          const { streaming, release, state } = openResponse([textChunk], 1);

          const done = session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'channel task' }],
            _meta: { [CHANNEL_PROMPT_META_KEY]: true },
          });
          await streaming;
          session.sendMidTurnInputNow();
          await nextTick();
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(drainCalls()).toHaveLength(0);
          expect(state.signal?.aborted).toBe(false);
        });

        it('never interrupts a background-notification turn', async () => {
          mockClient.extMethod = vi.fn().mockResolvedValue({ messages: [] });
          const { streaming, release, state } = openResponse([textChunk]);

          await expect(
            session.enqueueBackgroundNotification({
              displayText: 'Agent completed.',
              modelText: '<task-notification />',
              taskId: 'agent-send-now',
              status: 'completed',
              kind: 'agent',
            }),
          ).resolves.toEqual({ accepted: true });
          await streaming;
          const internals = session as unknown as {
            pullForOpenResponse?: () => void;
            midTurnSendNowFor?: AbortSignal;
          };
          // Nothing opens this response to interruption, and a send-now
          // request arms nothing while it streams.
          expect(internals.pullForOpenResponse).toBeUndefined();
          session.sendMidTurnInputNow();
          expect(internals.midTurnSendNowFor).toBeUndefined();
          await nextTick();
          release();

          await vi.waitFor(() => expect(session.isIdle()).toBe(true));
          expect(
            drainCalls().filter((call) => call[1]?.['userInputOnly']),
          ).toEqual([]);
          expect(state.signal?.aborted).toBe(false);
        });

        it('never interrupts a cron turn', async () => {
          let cronCallback: ((job: { prompt: string }) => void) | undefined;
          mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
          mockConfig.getCronScheduler = vi.fn().mockReturnValue({
            size: 1,
            hasPendingWork: true,
            start: vi.fn((callback: (job: { prompt: string }) => void) => {
              cronCallback = callback;
            }),
            stop: vi.fn(),
            getExitSummary: vi.fn().mockReturnValue(undefined),
          });
          mockClient.extMethod = vi.fn().mockResolvedValue({ messages: [] });
          const { streaming, release, state } = openResponse([textChunk], 1);
          const internals = session as unknown as {
            cronCompletion: Promise<void> | null;
            pullForOpenResponse?: () => void;
            midTurnSendNowFor?: AbortSignal;
          };

          // The first prompt starts the scheduler and settles, so the cron
          // turn can run.
          await expect(startPrompt()).resolves.toEqual({
            stopReason: 'end_turn',
          });
          cronCallback!({ prompt: 'scheduled prompt' });
          await streaming;
          expect(internals.pullForOpenResponse).toBeUndefined();
          session.sendMidTurnInputNow();
          expect(internals.midTurnSendNowFor).toBeUndefined();
          await nextTick();
          release();

          await vi.waitFor(() => expect(internals.cronCompletion).toBeNull());
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          expect(
            drainCalls().filter((call) => call[1]?.['userInputOnly']),
          ).toEqual([]);
          expect(state.signal?.aborted).toBe(false);
        });

        it('still cuts the response when a timed-out send-now drain answers late', async () => {
          let answerLate: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerLate = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          const { streaming, release, state } = openResponse([textChunk]);

          useFakeDrainTimers();
          try {
            const done = startPrompt();
            await streaming;
            session.sendMidTurnInputNow();
            await vi.waitFor(() => expect(answerLate).toBeDefined());
            // Past the drain timeout, with the answer still streaming.
            await pastDrainTimeout();
            expect(
              (session as unknown as { midTurnDrainTimeoutStrikes: number })
                .midTurnDrainTimeoutStrikes,
            ).toBe(1);
            answerLate!({ messages: ['late steer'] });
            try {
              await vi.waitFor(() => expect(state.signal?.aborted).toBe(true));
            } finally {
              release();
            }

            await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          } finally {
            vi.useRealTimers();
          }
          expect(state.signal?.aborted).toBe(true);
          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[1]?.[1].message,
          ).toEqual([{ text: `${interruptPrefix}late steer` }]);
        });

        it('leaves a late answer that lands after its turn to the tool boundary', async () => {
          mockToolRegistry.getTool.mockReturnValue(
            readFileTool(
              vi
                .fn()
                .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
            ),
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          let answerLate: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerLate = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          const { streaming, release } = openResponse([textChunk]);

          useFakeDrainTimers();
          try {
            const first = startPrompt();
            await streaming;
            session.sendMidTurnInputNow();
            await vi.waitFor(() => expect(answerLate).toBeDefined());
            release();
            // The turn ends once the drain times out; the answer lands later.
            await pastDrainTimeout();
            await expect(first).resolves.toEqual({ stopReason: 'end_turn' });
            answerLate!({ messages: ['late steer'] });
            await nextTick();
          } finally {
            vi.useRealTimers();
          }
          vi.mocked(mockChat.addHistory).mockClear();

          // A turn without a tool boundary leaves it alone...
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());
          await expect(startPrompt()).resolves.toEqual({
            stopReason: 'end_turn',
          });
          expect(
            JSON.stringify(vi.mocked(mockChat.addHistory).mock.calls),
          ).not.toContain('late steer');
          // ...and the next tool boundary delivers it.
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(createStreamWithChunks([readFileCall]))
            .mockResolvedValue(createEmptyStream());
          await expect(startPrompt()).resolves.toEqual({
            stopReason: 'end_turn',
          });
          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[1]?.[1]
              .message as Part[],
          ).toContainEqual({
            text: '\n[User message received during tool execution]: late steer',
          });
        });

        it('leaves a late answer that lands after its response to the tool boundary', async () => {
          mockToolRegistry.getTool.mockReturnValue(
            readFileTool(
              vi
                .fn()
                .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
            ),
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          let reachStop!: () => void;
          const stopReached = new Promise<void>((resolve) => {
            reachStop = resolve;
          });
          let finishStop!: () => void;
          const stopFinished = new Promise<void>((resolve) => {
            finishStop = resolve;
          });
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getMessageBus = vi.fn().mockReturnValue({
            request: vi.fn().mockImplementation(async (request) => {
              if (request.eventName === 'Stop') {
                reachStop();
                await stopFinished;
              }
              return { success: true, output: {} };
            }),
          });
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((name: string) => name === 'Stop');
          let answerLate: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerLate = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          const { streaming, release } = openResponse([textChunk]);

          useFakeDrainTimers();
          try {
            const first = startPrompt();
            await streaming;
            session.sendMidTurnInputNow();
            await vi.waitFor(() => expect(answerLate).toBeDefined());
            release();
            // The response has ended and the drain timed out; the answer
            // lands while the turn is still in its Stop hook.
            await pastDrainTimeout();
            await stopReached;
            answerLate!({ messages: ['late steer'] });
            await nextTick();
            finishStop();
            await expect(first).resolves.toEqual({ stopReason: 'end_turn' });
          } finally {
            vi.useRealTimers();
          }
          expect(
            JSON.stringify(vi.mocked(mockChat.addHistory).mock.calls),
          ).not.toContain('late steer');

          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(false);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(createStreamWithChunks([readFileCall]))
            .mockResolvedValue(createEmptyStream());
          await expect(startPrompt()).resolves.toEqual({
            stopReason: 'end_turn',
          });
          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[1]?.[1]
              .message as Part[],
          ).toContainEqual({
            text: '\n[User message received during tool execution]: late steer',
          });
        });

        it('does not cut a response whose tool call starts while the drain is out', async () => {
          let answerDrain: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerDrain = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          let markStreaming!: () => void;
          const streaming = new Promise<void>((resolve) => {
            markStreaming = resolve;
          });
          let announce!: () => void;
          const announced = new Promise<void>((resolve) => {
            announce = resolve;
          });
          let markPrepared!: () => void;
          const prepared = new Promise<void>((resolve) => {
            markPrepared = resolve;
          });
          let release!: () => void;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          let signal: AbortSignal | undefined;
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementationOnce(
              async (
                _model: string,
                request: { config: { abortSignal: AbortSignal } },
              ) => {
                signal = request.config.abortSignal;
                return (async function* () {
                  yield textChunk;
                  markStreaming();
                  await announced;
                  yield {
                    type: core.StreamEventType.CHUNK,
                    value: createPreparationResponse('c', 'write_file'),
                  };
                  markPrepared();
                  await Promise.race([
                    released,
                    new Promise<void>((resolve) =>
                      request.config.abortSignal.addEventListener(
                        'abort',
                        () => resolve(),
                        { once: true },
                      ),
                    ),
                  ]);
                  request.config.abortSignal.throwIfAborted();
                })();
              },
            )
            .mockResolvedValue(createEmptyStream());

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(answerDrain).toBeDefined());
          announce();
          await prepared;
          answerDrain!({ messages: ['also check tests'] });
          await nextTick();
          expect(signal?.aborted).toBe(false);
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[1]?.[1].message,
          ).toEqual([{ text: `${responsePrefix}also check tests` }]);
        });

        it('surfaces an error from a response its drain did not cut', async () => {
          let answerDrain: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerDrain = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          let markStreaming!: () => void;
          const streaming = new Promise<void>((resolve) => {
            markStreaming = resolve;
          });
          let announce!: () => void;
          const announced = new Promise<void>((resolve) => {
            announce = resolve;
          });
          let markPrepared!: () => void;
          const prepared = new Promise<void>((resolve) => {
            markPrepared = resolve;
          });
          let fail!: () => void;
          const failing = new Promise<void>((resolve) => {
            fail = resolve;
          });
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementationOnce(async () =>
              (async function* () {
                yield textChunk;
                markStreaming();
                await announced;
                yield {
                  type: core.StreamEventType.CHUNK,
                  value: createPreparationResponse('c', 'write_file'),
                };
                markPrepared();
                await failing;
                throw new Error('upstream 500');
              })(),
            )
            .mockResolvedValue(createEmptyStream());

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(answerDrain).toBeDefined());
          announce();
          await prepared;
          // The drain takes input, but the tool call keeps the response
          // from being cut, so its error is the turn's.
          answerDrain!({ messages: ['also check tests'] });
          await nextTick();
          fail();

          await expect(done).rejects.toThrow('upstream 500');
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });

        it('drains once at a time however often send-now arrives', async () => {
          let answerFirst: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerFirst = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          const { streaming, release } = openResponse([textChunk]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          session.sendMidTurnInputNow();
          await nextTick();
          expect(drainCalls()).toHaveLength(1);
          // The second request arrived while the first drain was out, so it
          // gets a drain of its own once that one lands.
          answerFirst!({ messages: [] });
          await vi.waitFor(() => expect(drainCalls()).toHaveLength(2));
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
        });

        it('lets the tool-boundary drain wait for an early drain still out', async () => {
          mockToolRegistry.getTool.mockReturnValue(
            readFileTool(
              vi
                .fn()
                .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
            ),
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          let answerEarly: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerEarly = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          let markStreaming!: () => void;
          const streaming = new Promise<void>((resolve) => {
            markStreaming = resolve;
          });
          let callTool!: () => void;
          const toolCalled = new Promise<void>((resolve) => {
            callTool = resolve;
          });
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementationOnce(async () =>
              (async function* () {
                yield textChunk;
                markStreaming();
                await toolCalled;
                yield readFileCall;
              })(),
            )
            .mockResolvedValue(createEmptyStream());

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(answerEarly).toBeDefined());
          // The tool call arrives while the early drain is still out.
          callTool();
          await new Promise((resolve) => setTimeout(resolve, 20));
          answerEarly!({ messages: ['also check tests'] });

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          const toolResultMessage = vi.mocked(mockChat.sendMessageStream).mock
            .calls[1]?.[1].message as Part[];
          expect(
            toolResultMessage.some(
              (part) => part.functionResponse !== undefined,
            ),
          ).toBe(true);
          expect(toolResultMessage).toContainEqual({
            text: '\n[User message received during tool execution]: also check tests',
          });
        });

        it('keeps taken input when the turn is stopped while the tool boundary resolves it', async () => {
          const execute = vi
            .fn()
            .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' });
          mockToolRegistry.getTool.mockReturnValue(readFileTool(execute));
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          let answerEarly: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerEarly = resolve;
                }),
            )
            .mockResolvedValueOnce({
              items: [
                {
                  ...imageItem,
                  messageId: 'm-boundary',
                  displayText: 'and this',
                  content: [
                    { type: 'text', text: 'and this' },
                    imageItem.content[1],
                  ],
                },
              ],
            })
            .mockResolvedValue({ messages: [] });
          let markStreaming!: () => void;
          const streaming = new Promise<void>((resolve) => {
            markStreaming = resolve;
          });
          let callTool!: () => void;
          const toolCalled = new Promise<void>((resolve) => {
            callTool = resolve;
          });
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementationOnce(async () =>
              (async function* () {
                yield textChunk;
                markStreaming();
                await toolCalled;
                yield readFileCall;
              })(),
            )
            .mockResolvedValue(createEmptyStream());
          // The turn is stopped once the boundary has built the first
          // message, while it resolves the next one.
          mockChatRecordingService.recordMidTurnUserMessage.mockImplementationOnce(
            () => {
              void session.cancelPendingPrompt();
            },
          );

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(answerEarly).toBeDefined());
          // The tool call arrives while the early drain is out, so nothing
          // is cut and the tool boundary takes the input.
          callTool();
          await vi.waitFor(() => expect(execute).toHaveBeenCalled());
          answerEarly!({
            items: [
              {
                messageId: 'm-first',
                displayText: 'first',
                content: [{ type: 'text', text: 'first' }],
              },
              imageItem,
            ],
          });

          await expect(done).resolves.toMatchObject({
            stopReason: 'cancelled',
          });
          const recorded = vi.mocked(
            mockChatRecordingService.recordMidTurnUserMessage,
          ).mock.calls;
          expect(recorded.filter((call) => call[1] === 'first')).toHaveLength(
            1,
          );
          const kept = [
            { text: `${responsePrefix}look at this` },
            { text: '[Attachment could not be processed]' },
          ];
          expect(mockChat.addHistory).toHaveBeenCalledWith({
            role: 'user',
            parts: kept,
          });
          expect(recorded.filter((call) => call[1] === 'look at this')).toEqual(
            [[kept, 'look at this']],
          );

          // Only what the early drain took is kept; the next turn's tool
          // boundary does not deliver what the boundary drain took.
          const drainsBefore = drainCalls().length;
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(createStreamWithChunks([readFileCall]))
            .mockResolvedValue(createEmptyStream());
          await startPrompt();
          expect(drainCalls().length).toBeGreaterThan(drainsBefore);
          const sent = JSON.stringify(
            vi.mocked(mockChat.sendMessageStream).mock.calls,
          );
          expect(sent).not.toContain('look at this');
          expect(sent).not.toContain('and this');
        });

        it('keeps input a cancelled response already took', async () => {
          let answerDrain: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerDrain = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          const { streaming } = openResponse([textChunk]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(answerDrain).toBeDefined());
          void session.cancelPendingPrompt();
          await nextTick();
          answerDrain!({ messages: ['use plan B instead'] });

          await expect(done).resolves.toMatchObject({
            stopReason: 'cancelled',
          });
          const kept = { text: `${responsePrefix}use plan B instead` };
          expect(mockChat.addHistory).toHaveBeenCalledWith({
            role: 'user',
            parts: [kept],
          });
          expect(
            mockChatRecordingService.recordMidTurnUserMessage,
          ).toHaveBeenCalledWith([kept], 'use plan B instead');

          // Nothing carries over into the next turn, not even at its tool
          // boundary, where recovered input would be delivered.
          mockToolRegistry.getTool.mockReturnValue(
            readFileTool(
              vi
                .fn()
                .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
            ),
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          const drainsBefore = drainCalls().length;
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(createStreamWithChunks([readFileCall]))
            .mockResolvedValue(createEmptyStream());
          await startPrompt();
          expect(drainCalls().length).toBeGreaterThan(drainsBefore);
          const sent = JSON.stringify(
            vi.mocked(mockChat.sendMessageStream).mock.calls,
          );
          expect(sent).not.toContain('use plan B instead');
        });

        it('keeps taken input with an attachment as text when the turn is cancelled', async () => {
          let answerDrain: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerDrain = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          const { streaming } = openResponse([textChunk]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(answerDrain).toBeDefined());
          void session.cancelPendingPrompt();
          await nextTick();
          answerDrain!({ items: [imageItem] });

          await expect(done).resolves.toMatchObject({
            stopReason: 'cancelled',
          });
          expect(mockChat.addHistory).toHaveBeenCalledWith({
            role: 'user',
            parts: [
              { text: `${responsePrefix}look at this` },
              { text: '[Attachment could not be processed]' },
            ],
          });
        });

        it('keeps input with an attachment it cut in for when the turn stops before sending it', async () => {
          let answerSecond: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockResolvedValueOnce({ items: [imageItem] })
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerSecond = resolve;
                }),
            )
            .mockResolvedValue({ messages: [] });
          const { streaming, state } = openResponse([textChunk]);
          const history: Content[] = [];
          vi.mocked(mockChat.getHistory).mockReturnValue(history);
          vi.mocked(mockChat.getHistoryShallow).mockReturnValue(history);
          vi.mocked(mockChat.addHistory).mockImplementation((entry) => {
            history.push(entry);
          });

          const done = startPrompt();
          await streaming;
          const firstSend = vi.mocked(mockChat.sendMessageStream).mock
            .calls[0]!;
          const promptId = firstSend[4]?.promptId;
          expect(promptId).toBeTypeOf('string');
          const original: Content = {
            role: 'user',
            parts: firstSend[1].message as Part[],
          };
          markApiHistoryPrompt(original, promptId);
          history.push(original);
          vi.mocked(
            mockChatRecordingService.getRewindTurnIndex,
          ).mockImplementation((id: string) => (id === promptId ? 0 : -1));
          session.sendMidTurnInputNow();
          // The response is cut; the turn is stopped while it drains the
          // rest of the queue.
          await vi.waitFor(() => expect(answerSecond).toBeDefined());
          void session.cancelPendingPrompt();
          await nextTick();
          answerSecond!({ messages: [] });

          await expect(done).resolves.toMatchObject({
            stopReason: 'cancelled',
          });
          expect(state.signal?.aborted).toBe(true);
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          const takeover = vi.mocked(mockChat.addHistory).mock.calls.at(-1)![0];
          expect(getApiHistoryPromptId(takeover)).toBeUndefined();
          expect(session.getRewindCutPoint(promptId!)).toBe(0);
          expect(mockChat.addHistory).toHaveBeenCalledWith(
            expect.objectContaining({
              role: 'user',
              parts: [
                { text: `${interruptPrefix}look at this` },
                { text: '[Attachment could not be processed]' },
              ],
            }),
          );
        });

        it.each(['a file read', 'a media bridge'] as const)(
          'bounds resolving the input a finished turn keeps unsent when %s hangs',
          async (hang) => {
            const tempDir = await fs.realpath(
              await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-acp-keep-')),
            );
            const imagePath = path.join(tempDir, 'shot.png');
            await fs.writeFile(imagePath, 'image');
            mockConfig.getEffectiveInputModalities = vi
              .fn()
              .mockReturnValue({});
            mockConfig.getProjectRoot = vi.fn().mockReturnValue(tempDir);
            mockConfig.getWorkspaceContext = vi.fn().mockReturnValue({
              isPathWithinWorkspace: (pathSpec: string) =>
                path
                  .resolve(tempDir, pathSpec)
                  .startsWith(`${tempDir}${path.sep}`),
            });
            mockConfig.getDefaultVisionBridgeModel = vi
              .fn()
              .mockReturnValue({ id: 'qwen3.7-plus' });
            const readManyFilesSpy = vi
              .spyOn(core, 'readManyFiles')
              .mockReturnValue(new Promise(() => {}));
            // Like the real bridge, it answers `skipped` once cancelled.
            runVisionBridgeSpy.mockImplementation(
              ({ signal }: { signal: AbortSignal }) =>
                new Promise((resolve) =>
                  signal.addEventListener(
                    'abort',
                    () =>
                      resolve({
                        applied: false,
                        status: 'skipped',
                        convertedCount: 0,
                        omittedCount: 0,
                      }),
                    { once: true },
                  ),
                ),
            );
            const started =
              hang === 'a file read' ? readManyFilesSpy : runVisionBridgeSpy;
            const content =
              hang === 'a file read'
                ? [{ type: 'text', text: `compare with @${imagePath}` }]
                : [
                    { type: 'text', text: 'compare with this' },
                    {
                      type: 'image',
                      mimeType: 'image/png',
                      data: 'iVBORw0KGgo=',
                    },
                  ];
            const kept = {
              role: 'user',
              parts: [
                { text: `${responsePrefix}compare with this` },
                ...(hang === 'a media bridge'
                  ? [{ text: '[Attachment could not be processed]' }]
                  : []),
              ],
            };
            mockToolRegistry.getTool.mockReturnValue(
              readFileTool(
                vi.fn().mockResolvedValue({
                  llmContent: 'ok',
                  returnDisplay: 'ok',
                  terminateTurn: true,
                }),
              ),
            );
            mockConfig.getApprovalMode = vi
              .fn()
              .mockReturnValue(ApprovalMode.YOLO);
            let answerEarly: ((value: unknown) => void) | undefined;
            mockClient.extMethod = vi
              .fn()
              .mockImplementationOnce(
                () =>
                  new Promise((resolve) => {
                    answerEarly = resolve;
                  }),
              )
              .mockResolvedValue({ messages: [] });
            let markStreaming!: () => void;
            const streaming = new Promise<void>((resolve) => {
              markStreaming = resolve;
            });
            let callTool!: () => void;
            const toolCalled = new Promise<void>((resolve) => {
              callTool = resolve;
            });
            mockChat.sendMessageStream = vi
              .fn()
              .mockImplementationOnce(async () =>
                (async function* () {
                  yield textChunk;
                  markStreaming();
                  await toolCalled;
                  yield readFileCall;
                })(),
              )
              .mockResolvedValue(createEmptyStream());

            useFakeDrainTimers();
            try {
              const done = startPrompt();
              await streaming;
              session.sendMidTurnInputNow();
              await vi.waitFor(() => expect(answerEarly).toBeDefined());
              // A tool that ends the turn starts while the drain is out, so
              // what the drain takes is kept but never sent.
              callTool();
              answerEarly!({
                items: [
                  {
                    messageId: 'm-keep',
                    displayText: 'compare with this',
                    content,
                  },
                ],
              });
              for (let i = 0; i < 20 && !started.mock.calls.length; i++) {
                await nextTick();
              }
              expect(started).toHaveBeenCalled();
              expect(mockChat.addHistory).not.toHaveBeenCalledWith(kept);

              // Kept once the deadline passes, not when slower bounds do.
              await vi.advanceTimersByTimeAsync(2_100);
              const isKept = () =>
                JSON.stringify(
                  vi.mocked(mockChat.addHistory).mock.calls,
                ).includes('compare with this');
              for (let i = 0; i < 20 && !isKept(); i++) await nextTick();
              expect(mockChat.addHistory).toHaveBeenCalledWith(kept);
              if (hang === 'a media bridge') {
                // The deadline cancels the bridge, so it cannot run on and
                // report after the turn.
                expect(
                  runVisionBridgeSpy.mock.calls[0]?.[0].signal.aborted,
                ).toBe(true);
              }
              await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
            } finally {
              vi.useRealTimers();
              readManyFilesSpy.mockRestore();
              await fs.rm(tempDir, { recursive: true, force: true });
            }
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          },
        );
        it('takes nothing more from the host once the turn is stopped', async () => {
          let answerEarly: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerEarly = resolve;
                }),
            )
            .mockResolvedValue({
              messages: ['typed later with plain Enter'],
            });
          const { streaming, release } = openResponse([textChunk]);

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(answerEarly).toBeDefined());
          release();
          await nextTick();
          void session.cancelPendingPrompt();
          await nextTick();
          answerEarly!({ messages: ['use plan B'] });

          await expect(done).resolves.toMatchObject({
            stopReason: 'cancelled',
          });
          // Later input stays queued for the host to promote.
          expect(drainCalls()).toHaveLength(1);
          const history = JSON.stringify(
            vi.mocked(mockChat.addHistory).mock.calls,
          );
          expect(history).toContain('use plan B');
          expect(history).not.toContain('typed later with plain Enter');
        });

        it('does not drain for a stopped turn whose response still streams', async () => {
          let answerFirst: ((value: unknown) => void) | undefined;
          mockClient.extMethod = vi
            .fn()
            .mockImplementationOnce(
              () =>
                new Promise((resolve) => {
                  answerFirst = resolve;
                }),
            )
            .mockResolvedValue({ messages: ['typed later with plain Enter'] });
          let markStreaming!: () => void;
          const streaming = new Promise<void>((resolve) => {
            markStreaming = resolve;
          });
          let release!: () => void;
          const released = new Promise<void>((resolve) => {
            release = resolve;
          });
          // A provider that keeps the response open after the turn stops.
          mockChat.sendMessageStream = vi
            .fn()
            .mockImplementationOnce(async () =>
              (async function* () {
                yield textChunk;
                markStreaming();
                await released;
              })(),
            )
            .mockResolvedValue(createEmptyStream());

          const done = startPrompt();
          await streaming;
          session.sendMidTurnInputNow();
          await vi.waitFor(() => expect(answerFirst).toBeDefined());
          // A second request waits for the first drain, which lands after
          // the turn is stopped.
          session.sendMidTurnInputNow();
          void session.cancelPendingPrompt();
          answerFirst!({ messages: [] });
          await nextTick();
          await nextTick();
          expect(drainCalls()).toHaveLength(1);
          release();

          await expect(done).resolves.toMatchObject({
            stopReason: 'cancelled',
          });
          expect(drainCalls()).toHaveLength(1);
        });

        it('keeps a send-now request from a stopped turn out of the next', async () => {
          let toolStarted!: () => void;
          const started = new Promise<void>((resolve) => {
            toolStarted = resolve;
          });
          mockToolRegistry.getTool.mockReturnValue(
            readFileTool(
              vi.fn().mockImplementation(
                (signal: AbortSignal) =>
                  new Promise((resolve) => {
                    toolStarted();
                    signal.addEventListener(
                      'abort',
                      () => resolve({ llmContent: 'x', returnDisplay: 'x' }),
                      { once: true },
                    );
                  }),
              ),
            ),
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          mockClient.extMethod = vi.fn().mockResolvedValue({ messages: [] });
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(createStreamWithChunks([readFileCall]));

          const first = startPrompt();
          await started;
          // No response is open while the tool runs, so nothing serves this
          // request before the turn is stopped.
          session.sendMidTurnInputNow();
          await session.cancelPendingPrompt();
          await expect(first).resolves.toMatchObject({
            stopReason: 'cancelled',
          });
          const drainsBefore = drainCalls().length;

          const { streaming, release, state } = openResponse([textChunk]);
          const done = startPrompt();
          await streaming;
          await nextTick();
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(drainCalls()).toHaveLength(drainsBefore);
          expect(state.signal?.aborted).toBe(false);
        });

        it('ignores a send-now request between turns', async () => {
          mockClient.extMethod = vi.fn().mockResolvedValue({ messages: [] });

          session.sendMidTurnInputNow();
          await nextTick();
          expect(drainCalls()).toHaveLength(0);

          const { streaming, release, state } = openResponse([textChunk]);
          const done = startPrompt();
          await streaming;
          await nextTick();
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(drainCalls()).toHaveLength(0);
          expect(state.signal?.aborted).toBe(false);
        });

        it('drops a send-now request that its turn never served', async () => {
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getMessageBus = vi.fn().mockReturnValue({
            request: vi.fn().mockImplementation(async (request) => {
              // Arrives after the last response ended, with nothing left in
              // the turn to drain the queue.
              if (request.eventName === 'Stop') session.sendMidTurnInputNow();
              return { success: true, output: {} };
            }),
          });
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((name: string) => name === 'Stop');
          mockClient.extMethod = vi.fn().mockResolvedValue({ messages: [] });
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());
          await expect(startPrompt()).resolves.toEqual({
            stopReason: 'end_turn',
          });
          const drainsBefore = drainCalls().length;

          const { streaming, release, state } = openResponse([textChunk]);
          const done = startPrompt();
          await streaming;
          await nextTick();
          release();

          await expect(done).resolves.toEqual({ stopReason: 'end_turn' });
          expect(drainCalls()).toHaveLength(drainsBefore);
          expect(state.signal?.aborted).toBe(false);
        });
      });

      it('wraps tool execution with the sleep inhibitor (acquire before execute, release after)', async () => {
        const releaseSpy = vi.fn();
        const acquireSpy = vi
          .spyOn(core, 'acquireSleepInhibitor')
          .mockReturnValue({ release: releaseSpy });
        try {
          const executeSpy = vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'file contents',
          });
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('Read file'),
              toolLocations: vi.fn().mockReturnValue([]),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    functionCalls: [
                      {
                        id: 'call-1',
                        name: 'read_file',
                        args: { path: '/tmp/test.txt' },
                      },
                    ],
                  },
                },
              ]),
            )
            .mockResolvedValueOnce(createEmptyStream());

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read file' }],
          });

          expect(executeSpy).toHaveBeenCalledTimes(1);
          expect(acquireSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining('read_file'),
          );
          expect(releaseSpy).toHaveBeenCalledTimes(1);
          // Ordering: acquire → execute → release.
          expect(acquireSpy.mock.invocationCallOrder[0]).toBeLessThan(
            executeSpy.mock.invocationCallOrder[0],
          );
          expect(executeSpy.mock.invocationCallOrder[0]).toBeLessThan(
            releaseSpy.mock.invocationCallOrder[0],
          );
        } finally {
          acquireSpy.mockRestore();
        }
      });

      it('stops tool response follow-up before sending when the session token limit is exceeded', async () => {
        const executeSpy = vi.fn().mockResolvedValue({
          llmContent: 'file contents',
          returnDisplay: 'file contents',
        });
        const tool = {
          name: 'read_file',
          kind: core.Kind.Read,
          build: vi.fn().mockReturnValue({
            params: { path: '/tmp/test.txt' },
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
            execute: executeSpy,
          }),
        };

        mockToolRegistry.getTool.mockReturnValue(tool);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockLlmClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockResolvedValueOnce({
            originalTokenCount: 101,
            newTokenCount: 101,
            compressionStatus: core.CompressionStatus.NOOP,
          });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read file' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(executeSpy).toHaveBeenCalledTimes(1);
        expect(mockLlmClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockLlmClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'call-1',
                name: 'read_file',
              }),
            }),
          ],
        });
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'Session token limit exceeded: 101 tokens > 100 limit. ' +
                'Please start a new session or increase the sessionTokenLimit in your settings.json.',
            },
          },
        });
      });

      it('runs automatic compression before Stop-hook continuation sends', async () => {
        const messageBus = {
          request: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after Stop hook',
              },
            })
            .mockResolvedValueOnce({
              success: true,
              output: {},
            }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'response text' }] },
          ]);
        mockChat.getLastModelMessageText = vi
          .fn()
          .mockReturnValue('response text');
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockLlmClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1_stop_hook_1',
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockLlmClient.tryCompressChat,
          sendMessageStream,
          1,
        );
      });

      it('skips automatic compression after the first Stop-hook continuation', async () => {
        const messageBus = {
          request: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after first Stop hook',
              },
            })
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after second Stop hook',
              },
            })
            .mockResolvedValueOnce({
              success: true,
              output: {},
            }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'response text' }] },
          ]);
        mockChat.getLastModelMessageText = vi
          .fn()
          .mockReturnValue('response text');
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
        expect(mockLlmClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockLlmClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1_stop_hook_1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockLlmClient.tryCompressChat).not.toHaveBeenCalledWith(
          'test-session-id########1_stop_hook_2',
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expect(sendMessageStream.mock.calls[2]?.[2]).toBe(
          'test-session-id########1_stop_hook_2',
        );
      });

      it('stops Stop-hook continuation before sending when the session token limit is exceeded', async () => {
        agentTelemetry.getActiveInteractionSpan.mockReturnValue(
          agentTelemetry.span,
        );
        const messageBus = {
          request: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after Stop hook',
              },
            })
            .mockResolvedValueOnce({
              success: true,
              output: {},
            }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockLlmClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockResolvedValueOnce({
            originalTokenCount: 101,
            newTokenCount: 101,
            compressionStatus: core.CompressionStatus.NOOP,
          });
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'response text' }] },
          ]);
        mockChat.getLastModelMessageText = vi
          .fn()
          .mockReturnValue('response text');
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  {
                    content: { parts: [{ text: 'response text' }] },
                    finishReason: 'STOP',
                  },
                ],
              },
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });

        expect(mockLlmClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(mockLlmClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          'test-session-id########1_stop_hook_1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        const capture = agentTelemetry.captures[0]!;
        expect(capture.beginResponse).toHaveBeenCalledOnce();
        expect(capture.writeToSpan).toHaveBeenCalledWith(agentTelemetry.span);
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'Session token limit exceeded: 101 tokens > 100 limit. ' +
                'Please start a new session or increase the sessionTokenLimit in your settings.json.',
            },
          },
        });
      });

      it('runs automatic compression before cron-fired ACP prompt sends', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn((callback: (job: { prompt: string }) => void) => {
            callback({ prompt: 'scheduled prompt' });
          }),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        });

        expect(scheduler.start).toHaveBeenCalledTimes(1);
        expect(mockLlmClient.tryCompressChat).toHaveBeenNthCalledWith(
          1,
          'test-session-id########1',
          false,
          expect.any(AbortSignal),
        );
        expect(mockLlmClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          expect.stringMatching(/^test-session-id########cron\d+$/),
          false,
          expect.any(AbortSignal),
        );

        const sendMessageStream = mockChat.sendMessageStream as ReturnType<
          typeof vi.fn
        >;
        expectCompressBeforeSend(
          mockLlmClient.tryCompressChat,
          sendMessageStream,
          1,
        );
      });

      it('captures a successful prompt without channel delivery metadata', async () => {
        agentTelemetry.getActiveInteractionSpan.mockReturnValue(
          agentTelemetry.span,
        );
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  {
                    content: { parts: [{ text: 'final answer' }] },
                    finishReason: 'STOP',
                  },
                ],
              },
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(
          agentTelemetry.addAgentInputMessageAttributes,
        ).toHaveBeenCalledWith(mockConfig, agentTelemetry.span, 'hello');
        const capture = agentTelemetry.captures[0]!;
        expect(capture.beginResponse).toHaveBeenCalledOnce();
        expect(capture.appendText).toHaveBeenCalledWith('final answer');
        expect(capture.observeFinishReason).toHaveBeenCalledWith('STOP');
        expect(capture.commitResponse).toHaveBeenCalledWith(false);
        expect(capture.writeToSpan).toHaveBeenCalledWith(agentTelemetry.span);
        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          'qwen/control/channel-delivery',
          expect.anything(),
        );
      });

      it('submits a successful prompt final once through the reverse delivery control', async () => {
        agentTelemetry.getActiveInteractionSpan.mockReturnValue(
          agentTelemetry.span,
        );
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'discarded attempt' }] } },
                ],
              },
            },
            { type: core.StreamEventType.RETRY, value: {} },
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  {
                    content: { parts: [{ text: 'final answer' }] },
                    finishReason: 'STOP',
                  },
                ],
              },
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'prompt-1',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            {
              sessionId: 'test-session-id',
              deliveryId: 'prompt-1',
              source: 'prompt',
              target: {
                channelName: 'dingtalk',
                type: 'user',
                id: 'user-1',
              },
              text: 'final answer',
              promptId: 'prompt-1',
            },
          );
        });
        const capture = agentTelemetry.captures[0]!;
        expect(capture.restartAttempt).toHaveBeenCalledWith(false);
        expect(capture.writeToSpan).toHaveBeenCalledWith(agentTelemetry.span);
      });

      it('does not apply the turn-result limit to channel delivery text', async () => {
        // Multi-chunk on purpose: the accumulation cap must never apply to
        // delivery turns, and a single chunk would pass even if it did (the
        // first append is always accepted).
        const chunk = 'x'.repeat(
          Math.ceil(core.TURN_RESULT_TEXT_MAX_CHARS / 2) + 50,
        );
        const answer = chunk + chunk + chunk;
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [{ content: { parts: [{ text: chunk }] } }],
              },
            },
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [{ content: { parts: [{ text: chunk }] } }],
              },
            },
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [{ content: { parts: [{ text: chunk }] } }],
              },
            },
          ]),
        );

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'long delivery' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'prompt-long-delivery',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          },
          {
            version: 1,
            sessionId: 'test-session-id',
            promptId: 'prompt-long-delivery',
          },
        );

        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            expect.objectContaining({ text: answer }),
          );
        });
        expect(
          mockChatRecordingService.recordTurnResult.mock.calls.map(
            ([payload]) => payload,
          ),
        ).toContainEqual(
          expect.objectContaining({
            resultText: answer.slice(0, core.TURN_RESULT_TEXT_MAX_CHARS),
            resultTruncated: true,
          }),
        );
      });

      it('delivers only the final tool-free response block for a prompt', async () => {
        agentTelemetry.getActiveInteractionSpan.mockReturnValue(
          agentTelemetry.span,
        );
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockToolRegistry.getTool.mockReturnValue({
          name: 'read_file',
          kind: core.Kind.Read,
          displayName: 'Read File',
          description: 'Read file',
          build: vi.fn().mockReturnValue({
            params: { file_path: 'a.ts' },
            execute: vi.fn().mockResolvedValue({
              llmContent: 'file contents',
              returnDisplay: 'file contents',
            }),
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
          }),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: 'I will inspect the file.' }],
                      },
                    },
                  ],
                  functionCalls: [
                    {
                      id: 'read-1',
                      name: 'read_file',
                      args: { file_path: 'a.ts' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: 'I found one lead; checking again.' }],
                      },
                    },
                  ],
                  functionCalls: [
                    {
                      id: 'read-2',
                      name: 'read_file',
                      args: { file_path: 'b.ts' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    {
                      content: { parts: [{ text: 'final answer' }] },
                      finishReason: 'STOP',
                    },
                  ],
                },
              },
            ]),
          );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'inspect it' }],
          _meta: {
            'qwen.daemon.channelDelivery': {
              deliveryId: 'prompt-tool-final',
              target: {
                channelName: 'dingtalk',
                type: 'user',
                id: 'user-1',
              },
            },
          },
        });

        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            expect.objectContaining({
              deliveryId: 'prompt-tool-final',
              text: 'final answer',
            }),
          );
        });
        const capture = agentTelemetry.captures[0]!;
        expect(capture.beginResponse).toHaveBeenCalledTimes(3);
        expect(capture.commitResponse).toHaveBeenNthCalledWith(1, true);
        expect(capture.commitResponse).toHaveBeenNthCalledWith(2, true);
        expect(capture.commitResponse).toHaveBeenNthCalledWith(3, false);
        expect(capture.writeToSpan).toHaveBeenCalledWith(agentTelemetry.span);
      });

      it('rejects a delivery-marked turn when loop protection stops it', async () => {
        // The delivery meta alone does not classify a turn as a channel
        // turn: the loop-detected stop rejects like any foreground prompt
        // instead of resolving end_turn, and the failed turn schedules no
        // delivery.
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockConfig.getMaxToolCallsPerTurn = vi.fn().mockReturnValue(1);
        mockConfig.isMaxToolCallsPerTurnExplicit = vi
          .fn()
          .mockReturnValue(true);
        mockChat.sendMessageStream = vi.fn().mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'channel-loop-1',
                    name: 'read_file',
                    args: { file_path: 'a.ts' },
                  },
                  {
                    id: 'channel-loop-2',
                    name: 'read_file',
                    args: { file_path: 'b.ts' },
                  },
                ],
              },
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'channel work' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'prompt-loop-channel',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          }),
        ).rejects.toMatchObject({
          data: expect.objectContaining({
            code: 'LOOP_DETECTED',
            loopType: core.LoopType.TURN_TOOL_CALL_CAP,
          }),
        });

        expect(logLoopDetectedSpy).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({
            loop_type: core.LoopType.TURN_TOOL_CALL_CAP,
            loop_reason: core.LoopReason.EXPLICIT_CAP,
          }),
          {},
        );
        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          'qwen/control/channel-delivery',
          expect.anything(),
        );
      });

      it('keeps a channel-prompt-meta turn graceful when loop protection stops it', async () => {
        // DaemonChannelBridge/AcpBridge channel tasks prompt with
        // CHANNEL_PROMPT_META_KEY; the authenticated classification must
        // resolve end_turn so the bridge emits promptComplete with the
        // collected response text instead of the rejection failing the
        // non-interactive task.
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockConfig.getMaxToolCallsPerTurn = vi.fn().mockReturnValue(1);
        mockConfig.isMaxToolCallsPerTurnExplicit = vi
          .fn()
          .mockReturnValue(true);
        mockChat.sendMessageStream = vi.fn().mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'channel-prompt-loop-1',
                    name: 'read_file',
                    args: { file_path: 'a.ts' },
                  },
                  {
                    id: 'channel-prompt-loop-2',
                    name: 'read_file',
                    args: { file_path: 'b.ts' },
                  },
                ],
              },
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'channel task' }],
            _meta: { [CHANNEL_PROMPT_META_KEY]: true },
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(logLoopDetectedSpy).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({
            loop_type: core.LoopType.TURN_TOOL_CALL_CAP,
          }),
          {},
        );
        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          'qwen/control/channel-delivery',
          expect.anything(),
        );
      });

      it('replaces the prompt candidate with a Stop-hook continuation final', async () => {
        agentTelemetry.getActiveInteractionSpan.mockReturnValue(
          agentTelemetry.span,
        );
        const messageBus = {
          request: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after Stop hook',
              },
            })
            .mockResolvedValueOnce({ success: true, output: {} }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'initial answer' }] },
          ]);
        mockChat.getLastModelMessageText = vi
          .fn()
          .mockReturnValue('initial answer');
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    { content: { parts: [{ text: 'initial answer' }] } },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    {
                      content: { parts: [{ text: 'continued final' }] },
                      finishReason: 'STOP',
                    },
                  ],
                },
              },
            ]),
          );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'finish it' }],
          _meta: {
            'qwen.daemon.channelDelivery': {
              deliveryId: 'prompt-stop-final',
              target: {
                channelName: 'dingtalk',
                type: 'user',
                id: 'user-1',
              },
            },
          },
        });

        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            expect.objectContaining({
              deliveryId: 'prompt-stop-final',
              text: 'continued final',
            }),
          );
        });
        const capture = agentTelemetry.captures[0]!;
        expect(capture.beginResponse).toHaveBeenCalledTimes(2);
        expect(capture.appendText.mock.calls).toEqual([
          ['initial answer'],
          ['continued final'],
        ]);
        expect(capture.writeToSpan).toHaveBeenCalledWith(agentTelemetry.span);
      });

      it('does not extract a fresh channel turn stopped by loop protection in a Stop continuation', async () => {
        const messageBus = {
          request: vi.fn().mockResolvedValue({
            success: true,
            output: {
              decision: 'block',
              reason: 'Continue after Stop hook',
            },
          }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockConfig.getMaxToolCallsPerTurn = vi.fn().mockReturnValue(1);
        mockConfig.isMaxToolCallsPerTurnExplicit = vi
          .fn()
          .mockReturnValue(true);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'stop-loop-1',
                      name: 'read_file',
                      args: { path: 'a' },
                    },
                    {
                      id: 'stop-loop-2',
                      name: 'read_file',
                      args: { path: 'b' },
                    },
                  ],
                },
              },
            ]),
          );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'channel task' }],
            _meta: { [CHANNEL_PROMPT_META_KEY]: true },
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(logLoopDetectedSpy).toHaveBeenCalledWith(
          mockConfig,
          expect.objectContaining({
            loop_type: core.LoopType.TURN_TOOL_CALL_CAP,
          }),
          {},
        );
        expect(mockMemoryManager.scheduleExtract).not.toHaveBeenCalled();
        expect(mockMemoryManager.scheduleDream).not.toHaveBeenCalled();
      });

      it('keeps continuation retry text in the delivered prompt final', async () => {
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [{ content: { parts: [{ text: 'first half' }] } }],
              },
            },
            {
              type: core.StreamEventType.RETRY,
              value: {},
              isContinuation: true,
            } as never,
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: ' second half' }] } },
                ],
              },
            },
          ]),
        );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
          _meta: {
            'qwen.daemon.channelDelivery': {
              deliveryId: 'prompt-continuation',
              target: {
                channelName: 'dingtalk',
                type: 'user',
                id: 'user-1',
              },
            },
          },
        });

        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            expect.objectContaining({
              deliveryId: 'prompt-continuation',
              text: 'first half second half',
            }),
          );
        });
      });

      it('submits an empty successful prompt final for skipped reporting', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'prompt-empty',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            expect.objectContaining({
              deliveryId: 'prompt-empty',
              text: '',
            }),
          );
        });
      });

      it('keeps a failed delivery result outside the completed prompt flow', async () => {
        mockClient.extMethod = vi.fn().mockResolvedValue({
          status: 'failed',
          code: 'channel_worker_unavailable',
          error: 'Channel worker is not running.',
        });
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'final answer' }] } },
                ],
              },
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'prompt-failed-delivery',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            expect.anything(),
          );
        });
      });

      it('keeps a transport failure and throwing debug logger outside the prompt flow', async () => {
        mockClient.extMethod = vi
          .fn()
          .mockRejectedValue(new Error('delivery IPC unavailable'));
        debugLoggerWarnSpy.mockImplementationOnce(() => {
          throw new Error('debug logger unavailable');
        });
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'final answer' }] } },
                ],
              },
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'prompt-transport-failure',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            expect.anything(),
          );
        });
      });

      it('does not submit delivery when the prompt hits the token limit', async () => {
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockLlmClient.tryCompressChat.mockResolvedValueOnce({
          originalTokenCount: 101,
          newTokenCount: 101,
          compressionStatus: core.CompressionStatus.NOOP,
        });

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'prompt-max-tokens',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          }),
        ).resolves.toEqual({ stopReason: 'max_tokens' });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          'qwen/control/channel-delivery',
          expect.anything(),
        );
      });

      it('does not submit delivery when the prompt is cancelled', async () => {
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          (async function* () {
            await session.cancelPendingPrompt();
            yield* createEmptyStream();
          })(),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'prompt-cancelled',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          }),
        ).resolves.toEqual({ stopReason: 'cancelled' });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          'qwen/control/channel-delivery',
          expect.anything(),
        );
      });

      it('does not submit delivery when the prompt stream fails', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createFailingStream('provider failed'));

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'prompt-error',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          }),
        ).rejects.toThrow('provider failed');
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          'qwen/control/channel-delivery',
          expect.anything(),
        );
      });

      it('does not submit a prompt without trusted delivery metadata', async () => {
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'ordinary answer' }] } },
                ],
              },
            },
          ]),
        );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });
        await new Promise((resolve) => setTimeout(resolve, 10));

        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          'qwen/control/channel-delivery',
          expect.anything(),
        );
      });

      it('submits a successful scheduled final with stable fire correlation', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          enableDurable: vi.fn().mockResolvedValue(undefined),
          start: vi.fn(
            (
              callback: (job: {
                id: string;
                prompt: string;
                cronExpr: string;
                lastFiredAt: number;
                delivery: unknown;
              }) => void,
            ) => {
              callback({
                id: 'task-1',
                prompt: 'scheduled prompt',
                cronExpr: '* * * * *',
                lastFiredAt: 1_750_000_000_000,
                delivery: {
                  kind: 'channel',
                  target: {
                    channelName: 'dingtalk',
                    type: 'chat',
                    id: 'chat-1',
                  },
                },
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: 'discarded scheduled attempt' }],
                      },
                    },
                  ],
                },
              },
              { type: core.StreamEventType.RETRY, value: {} },
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    { content: { parts: [{ text: 'scheduled answer' }] } },
                  ],
                },
              },
            ]),
          );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start scheduler' }],
        });

        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            {
              sessionId: 'test-session-id',
              deliveryId: 'task-1:1750000000000',
              source: 'scheduled',
              target: {
                channelName: 'dingtalk',
                type: 'chat',
                id: 'chat-1',
              },
              text: 'scheduled answer',
              taskId: 'task-1',
              firedAt: 1_750_000_000_000,
            },
          );
        });
      });

      it('delivers only the final tool-free response block for a scheduled prompt', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          enableDurable: vi.fn().mockResolvedValue(undefined),
          start: vi.fn(
            (
              callback: (job: {
                id: string;
                prompt: string;
                lastFiredAt: number;
                delivery: unknown;
              }) => void,
            ) => {
              callback({
                id: 'task-tool',
                prompt: 'scheduled prompt',
                lastFiredAt: 1_750_000_000_010,
                delivery: {
                  kind: 'channel',
                  target: {
                    channelName: 'dingtalk',
                    type: 'chat',
                    id: 'chat-1',
                  },
                },
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockToolRegistry.getTool.mockReturnValue({
          name: 'read_file',
          kind: core.Kind.Read,
          displayName: 'Read File',
          description: 'Read file',
          build: vi.fn().mockReturnValue({
            params: { file_path: 'a.ts' },
            execute: vi.fn().mockResolvedValue({
              llmContent: 'file contents',
              returnDisplay: 'file contents',
            }),
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: vi.fn().mockReturnValue('Read file'),
            toolLocations: vi.fn().mockReturnValue([]),
          }),
          canUpdateOutput: false,
          isOutputMarkdown: true,
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: 'I will inspect the file.' }],
                      },
                    },
                  ],
                  functionCalls: [
                    {
                      id: 'read-cron-1',
                      name: 'read_file',
                      args: { file_path: 'a.ts' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    {
                      content: {
                        parts: [{ text: 'I found one lead; checking again.' }],
                      },
                    },
                  ],
                  functionCalls: [
                    {
                      id: 'read-cron-2',
                      name: 'read_file',
                      args: { file_path: 'b.ts' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    { content: { parts: [{ text: 'scheduled final' }] } },
                  ],
                },
              },
            ]),
          );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start scheduler' }],
        });

        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            expect.objectContaining({
              deliveryId: 'task-tool:1750000000010',
              text: 'scheduled final',
            }),
          );
        });
      });

      it('submits an empty successful scheduled final for skipped reporting', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          enableDurable: vi.fn().mockResolvedValue(undefined),
          start: vi.fn(
            (
              callback: (job: {
                id: string;
                prompt: string;
                lastFiredAt: number;
                delivery: unknown;
              }) => void,
            ) => {
              callback({
                id: 'task-empty',
                prompt: 'scheduled prompt',
                lastFiredAt: 1_750_000_000_011,
                delivery: {
                  kind: 'channel',
                  target: {
                    channelName: 'dingtalk',
                    type: 'chat',
                    id: 'chat-1',
                  },
                },
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start scheduler' }],
        });

        await vi.waitFor(() => {
          expect(mockClient.extMethod).toHaveBeenCalledWith(
            'qwen/control/channel-delivery',
            expect.objectContaining({
              deliveryId: 'task-empty:1750000000011',
              text: '',
            }),
          );
        });
      });

      it('does not submit delivery when a scheduled prompt fails', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          enableDurable: vi.fn().mockResolvedValue(undefined),
          start: vi.fn(
            (
              callback: (job: {
                id: string;
                prompt: string;
                lastFiredAt: number;
                delivery: unknown;
              }) => void,
            ) => {
              callback({
                id: 'task-error',
                prompt: 'scheduled prompt',
                lastFiredAt: 1_750_000_000_001,
                delivery: {
                  kind: 'channel',
                  target: {
                    channelName: 'dingtalk',
                    type: 'chat',
                    id: 'chat-1',
                  },
                },
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createFailingStream('scheduled failed'));

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start scheduler' }],
        });
        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
              update: expect.objectContaining({
                content: expect.objectContaining({
                  text: '[cron error] scheduled failed',
                }),
              }),
            }),
          );
        });

        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          'qwen/control/channel-delivery',
          expect.anything(),
        );
      });

      it('does not submit partial delivery when a scheduled prompt is cancelled', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          enableDurable: vi.fn().mockResolvedValue(undefined),
          start: vi.fn(
            (
              callback: (job: {
                id: string;
                prompt: string;
                lastFiredAt: number;
                delivery: unknown;
              }) => void,
            ) => {
              callback({
                id: 'task-cancelled',
                prompt: 'scheduled prompt',
                lastFiredAt: 1_750_000_000_012,
                delivery: {
                  kind: 'channel',
                  target: {
                    channelName: 'dingtalk',
                    type: 'chat',
                    id: 'chat-1',
                  },
                },
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);

        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        let rejectStream!: (reason?: unknown) => void;
        const gate = new Promise<never>((_resolve, reject) => {
          rejectStream = reject;
        });
        const scheduledStream = (async function* () {
          yield {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [
                { content: { parts: [{ text: 'partial scheduled answer' }] } },
              ],
            },
          };
          markStarted();
          yield await gate;
        })();
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(scheduledStream);

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start scheduler' }],
        });
        await started;

        const internals = session as unknown as {
          cronAbortController: AbortController | null;
          cronProcessing: boolean;
        };
        internals.cronAbortController?.abort();
        const abortError = new Error('aborted');
        abortError.name = 'AbortError';
        rejectStream(abortError);

        await vi.waitFor(() => {
          expect(internals.cronProcessing).toBe(false);
        });
        expect(mockClient.extMethod).not.toHaveBeenCalledWith(
          'qwen/control/channel-delivery',
          expect.anything(),
        );
      });

      it('marks loop wakeup ACP prompts with loop source metadata', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({
                prompt: '/loop check status',
                cronExpr: '@wakeup',
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: '/loop check status' },
              _meta: { source: 'loop' },
            },
          });
        });
      });

      it('expands a loop.md sentinel into the task block and echoes a clean label', async () => {
        const tmpDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-session-'),
        );
        const loopMdPath = path.join(tmpDir, '.qwen', 'loop.md');
        await fs.mkdir(path.dirname(loopMdPath), { recursive: true });
        await fs.writeFile(loopMdPath, '- finish the migration');
        mockConfig.getWorkingDir = vi.fn().mockReturnValue(tmpDir);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({
                prompt: '<<loop.md-dynamic>>',
                cronExpr: '@wakeup',
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          // The client sees a stable RELATIVE label, never the raw sentinel or
          // the absolute path (which would leak the OS username / dir layout).
          await vi.waitFor(() => {
            expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
              sessionId: 'test-session-id',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'text',
                  text: 'Loop tick — tasks from project loop.md',
                },
                _meta: { source: 'loop' },
              },
            });
          });
          // The absolute loop.md path must not appear in any client echo.
          const echoedTexts = (
            mockClient.sessionUpdate as ReturnType<typeof vi.fn>
          ).mock.calls
            .map((call) => call[0]?.update?.content?.text)
            .filter((text): text is string => typeof text === 'string');
          for (const text of echoedTexts) {
            expect(text).not.toContain(loopMdPath);
          }

          // The model receives the expanded full task block, not the sentinel.
          let block = '';
          await vi.waitFor(() => {
            const cronCall = (
              mockChat.sendMessageStream as ReturnType<typeof vi.fn>
            ).mock.calls.find(
              (c) =>
                Array.isArray(c[1]?.message) &&
                c[1].message.some((p: { text?: string }) =>
                  p.text?.includes('finish the migration'),
                ),
            );
            expect(cronCall).toBeDefined();
            block = (cronCall![1].message as Array<{ text?: string }>)
              .map((p) => p.text ?? '')
              .join('');
          });
          expect(block).toContain('# /loop tick — loop.md tasks from');
          expect(block).toContain('- finish the migration');
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      });

      it('delivers the full block then a SHORT REMINDER on an unchanged second tick', async () => {
        // Two ticks of the same sentinel over unchanged loop.md: tick1 delivers
        // the FULL block (INTRO + task body) and commits it; tick2 sees the
        // unchanged content and delivers the one-line SHORT REMINDER (full:false)
        // — a pure pointer with neither the INTRO nor the body. The client echo
        // still names the source on the reminder (sourceLabel set), so this pins
        // the full:false/labelled-reminder path through BOTH the echo and the
        // model-message paths.
        const tmpDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-reminder-'),
        );
        const loopMdPath = path.join(tmpDir, '.qwen', 'loop.md');
        await fs.mkdir(path.dirname(loopMdPath), { recursive: true });
        await fs.writeFile(loopMdPath, '- finish the migration');
        mockConfig.getWorkingDir = vi.fn().mockReturnValue(tmpDir);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              // Drained serially against the one persistent resolver, so tick2
              // sees tick1's committed content as unchanged.
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const cronModelTexts = () =>
            (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
              .filter((c) => Array.isArray(c[1]?.message))
              .map((c) =>
                (c[1].message as Array<{ text?: string }>)
                  .map((p) => p.text ?? '')
                  .join(''),
              );

          await vi.waitFor(() => {
            const texts = cronModelTexts();
            // Exactly one FULL delivery (INTRO) and one SHORT REMINDER (preamble).
            const full = texts.filter((t) =>
              t.includes('The user configured a loop-tasks file.'),
            );
            const reminder = texts.filter((t) =>
              t.includes(
                'Work the tasks from the loop.md contents established earlier',
              ),
            );
            expect(full).toHaveLength(1);
            expect(reminder).toHaveLength(1);
            // The reminder is a pointer only: no INTRO and no task body (which
            // the full block already paid into the cached prefix).
            expect(reminder[0]).not.toContain(
              'The user configured a loop-tasks file.',
            );
            expect(reminder[0]).not.toContain('- finish the migration');
          });

          // full:false reminder still resolves a sourceLabel, so its client echo
          // names the source — identical to the full tick's echo (both ticks).
          const labelledEchoes = (
            mockClient.sessionUpdate as ReturnType<typeof vi.fn>
          ).mock.calls.filter(
            (c) =>
              c[0]?.update?.sessionUpdate === 'user_message_chunk' &&
              c[0]?.update?.content?.text ===
                'Loop tick — tasks from project loop.md',
          ).length;
          expect(labelledEchoes).toBe(2);
          await vi.waitFor(() =>
            expect(
              mockChatRecordingService.recordCronPrompt,
            ).toHaveBeenCalledTimes(2),
          );
          expect(
            mockChatRecordingService.recordCronPrompt.mock.calls[1],
          ).toEqual([
            [
              {
                text: expect.stringContaining(
                  'Work the tasks from the loop.md contents established earlier',
                ),
              },
            ],
            'Loop tick — tasks from project loop.md',
          ]);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      });

      it('rebuilds the loop.md resolver when the working dir changes between ticks', async () => {
        // /cd mid-session: the resolver is cached per project root, so a working-
        // dir change must rebuild it for the NEW root. Two ticks of the same
        // sentinel — the first resolves the OLD root's loop.md; getWorkingDir then
        // flips and the second must resolve the NEW root's loop.md (a fresh
        // resolver → full delivery), never re-serving the OLD root's content.
        // Mutation check: drop the `loopTickResolverRoot !== root` rebuild guard
        // and tick2 reuses the OLD resolver — the NEW content never reaches the
        // model (the unchanged OLD content is re-served as a short reminder).
        const oldDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-md-old-'));
        const newDir = await fs.mkdtemp(path.join(os.tmpdir(), 'loop-md-new-'));
        await fs.mkdir(path.join(oldDir, '.qwen'), { recursive: true });
        await fs.mkdir(path.join(newDir, '.qwen'), { recursive: true });
        await fs.writeFile(
          path.join(oldDir, '.qwen', 'loop.md'),
          '- task from OLD root',
        );
        await fs.writeFile(
          path.join(newDir, '.qwen', 'loop.md'),
          '- task from NEW root',
        );

        let currentRoot = oldDir;
        mockConfig.getWorkingDir = vi.fn(() => currentRoot);

        let fire:
          | ((job: { prompt: string; cronExpr?: string }) => void)
          | undefined;
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          enableDurable: vi.fn().mockResolvedValue(undefined),
          // Capture the fire callback so the test can drive ticks one at a time,
          // flipping the working dir in between.
          start: vi.fn(
            (cb: (job: { prompt: string; cronExpr?: string }) => void) => {
              fire = cb;
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          // Bootstraps the scheduler and captures `fire`; no tick fires yet.
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });
          await vi.waitFor(() => expect(fire).toBeDefined());

          const cronModelTexts = () =>
            (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
              .filter((c) => Array.isArray(c[1]?.message))
              .map((c) =>
                (c[1].message as Array<{ text?: string }>)
                  .map((p) => p.text ?? '')
                  .join(''),
              );

          // Tick 1 resolves against the OLD root. Waiting for its content in the
          // model proves the resolve consumed oldDir before we flip (race-free:
          // the model send is downstream of the resolve).
          fire!({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
          await vi.waitFor(() => {
            expect(
              cronModelTexts().some((t) => t.includes('task from OLD root')),
            ).toBe(true);
          });

          // /cd: the resolver must rebuild for the new root on the next tick.
          currentRoot = newDir;

          // Tick 2 must resolve the NEW root's loop.md (fresh resolver → full).
          fire!({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
          await vi.waitFor(() => {
            expect(
              cronModelTexts().some((t) => t.includes('task from NEW root')),
            ).toBe(true);
          });

          // The NEW-root tick carries ONLY the new root's tasks — the old root's
          // content is not re-resolved after the dir change.
          const newMsg = cronModelTexts().find((t) =>
            t.includes('task from NEW root'),
          )!;
          expect(newMsg).not.toContain('task from OLD root');
        } finally {
          await fs.rm(oldDir, { recursive: true, force: true });
          await fs.rm(newDir, { recursive: true, force: true });
        }
      });

      it('does not expand the project loop.md sentinel in an untrusted folder', async () => {
        // An untrusted folder's repo-controlled .qwen/loop.md must not be read
        // and fed to the model. With no user-owned ~/.qwen/loop.md the tick is
        // absent, which converges on the autonomous preamble — and the repo task
        // block still never reaches the model.
        const tmpDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-untrusted-'),
        );
        const fakeHome = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-home-'),
        );
        const loopMdPath = path.join(tmpDir, '.qwen', 'loop.md');
        await fs.mkdir(path.dirname(loopMdPath), { recursive: true });
        await fs.writeFile(loopMdPath, '- finish the migration');
        mockConfig.getWorkingDir = vi.fn().mockReturnValue(tmpDir);
        mockConfig.isTrustedFolder = vi.fn().mockReturnValue(false);
        // Point os.homedir() at an empty fake home (libuv reads HOME/USERPROFILE)
        // so there is no user-owned loop.md and the tick is deterministically
        // absent — the module export can't be spied under ESM.
        const restoreHome = setFakeHome(fakeHome);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({
                prompt: '<<loop.md-dynamic>>',
                cronExpr: '@wakeup',
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          // The client sees the autonomous label, never the repo file's path.
          await vi.waitFor(() => {
            expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
              sessionId: 'test-session-id',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'text',
                  text: 'Autonomous loop tick',
                },
                _meta: { source: 'loop' },
              },
            });
          });

          const sentToModel = () =>
            (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
              .flatMap((c) =>
                Array.isArray(c[1]?.message) ? c[1].message : [],
              )
              .map((p: { text?: string }) => p.text ?? '')
              .join('');
          await vi.waitFor(() => {
            expect(sentToModel()).toContain('# /loop tick — loop.md absent');
          });
          // Absent converged on the autonomous preamble; the repo-controlled task
          // block still never reaches the model.
          expect(sentToModel()).toContain('# Autonomous loop check');
          expect(sentToModel()).not.toContain('finish the migration');
        } finally {
          restoreHome();
          await fs.rm(tmpDir, { recursive: true, force: true });
          await fs.rm(fakeHome, { recursive: true, force: true });
        }
      });

      it('expands a bare-/loop autonomous sentinel into the preamble with an Autonomous loop tick echo', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({
                prompt: '<<autonomous-loop-dynamic>>',
                cronExpr: '@wakeup',
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        // The client sees a stable autonomous label, never the raw sentinel.
        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'Autonomous loop tick' },
              _meta: { source: 'loop' },
            },
          });
        });

        // The model receives the full autonomous preamble + the dynamic tick.
        const sentToModel = () =>
          (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
            .flatMap((c) => (Array.isArray(c[1]?.message) ? c[1].message : []))
            .map((p: { text?: string }) => p.text ?? '')
            .join('');
        await vi.waitFor(() => {
          expect(sentToModel()).toContain('# Autonomous loop check');
        });
        expect(sentToModel()).toContain(
          '# Autonomous loop tick (dynamic pacing)',
        );
      });

      it('skips missed bare-/loop autonomous sentinels', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: {
                prompt: string;
                cronExpr?: string;
                missed?: boolean;
              }) => void,
            ) => {
              callback({
                prompt: '<<autonomous-loop-dynamic>>',
                cronExpr: '@wakeup',
                missed: true,
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
        const sentToModel = (
          mockChat.sendMessageStream as ReturnType<typeof vi.fn>
        ).mock.calls
          .flatMap((c) => (Array.isArray(c[1]?.message) ? c[1].message : []))
          .map((p: { text?: string }) => p.text ?? '')
          .join('');
        expect(sentToModel).not.toContain('# Autonomous loop check');
        expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'Autonomous loop tick' },
            _meta: { source: 'loop' },
          },
        });
      });

      it('keeps the home confinement root non-empty when os.homedir() is empty (no QWEN_HOME)', () => {
        // Minimal containers with no HOME make os.homedir() === ''. With QWEN_HOME
        // unset the home confinement root must NOT collapse to '': isWithin('',
        // anyPath) is trivially true, so an empty root lets a home
        // `~/.qwen/loop.md` symlink resolve anywhere and bypass the confinement.
        // The guard falls back to the parent of the global qwen dir
        // (Storage.getGlobalQwenDir(), itself empty-home-safe), which is the
        // homeQwenDir Session passes to the resolver.
        const homeQwenDir = path.join(os.tmpdir(), '.qwen');

        const roots = resolveHomeLoopResolverRoots({
          homeDir: '',
          homeQwenDir,
          qwenHome: '',
        });

        // Without the `|| path.dirname(homeQwenDir)` guard this would be ''
        // (os.homedir()); the guard makes it the non-empty parent of the
        // empty-home-safe global qwen dir.
        expect(roots.homeConfineRoot).not.toBe('');
        expect(roots.homeConfineRoot).toBe(path.dirname(homeQwenDir));
        expect(roots.homeQwenDir).toBe(homeQwenDir);
      });

      it('confines the home loop resolver within QWEN_HOME when set', () => {
        const homeQwenDir = path.join(os.tmpdir(), '.qwen-home');

        const roots = resolveHomeLoopResolverRoots({
          homeDir: path.join(os.tmpdir(), 'real-home'),
          homeQwenDir,
          qwenHome: homeQwenDir,
        });

        expect(roots.homeConfineRoot).toBe(homeQwenDir);
        expect(roots.homeQwenDir).toBe(homeQwenDir);
      });

      it('reads the home loop.md from QWEN_HOME, not the real ~/.qwen', async () => {
        // The home/global candidate must honor QWEN_HOME (the relocated global
        // dir) instead of always reading the real OS home. Point QWEN_HOME at a
        // dir holding loop.md, leave the project dir and fake $HOME empty, and
        // confirm the relocated file's block reaches the model.
        const tmpDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-qwenhome-proj-'),
        );
        const fakeHome = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-qwenhome-home-'),
        );
        const qwenHome = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-qwenhome-dir-'),
        );
        await fs.writeFile(
          path.join(qwenHome, 'loop.md'),
          '- relocated home task',
        );
        mockConfig.getWorkingDir = vi.fn().mockReturnValue(tmpDir);
        const restoreHome = setFakeHome(fakeHome);
        const prevQwenHome = process.env['QWEN_HOME'];
        process.env['QWEN_HOME'] = qwenHome;

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          // Echo names the home source (sourceLabel='home loop.md'), proving the
          // home candidate resolved from QWEN_HOME rather than the empty $HOME.
          await vi.waitFor(() => {
            expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
              sessionId: 'test-session-id',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'text',
                  text: 'Loop tick — tasks from home loop.md',
                },
                // `*/5 * * * *` is a recurring cron (not an @wakeup), so the
                // echo carries source 'cron' (see job.cronExpr mapping).
                _meta: { source: 'cron' },
              },
            });
          });

          const sentToModel = () =>
            (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
              .flatMap((c) =>
                Array.isArray(c[1]?.message) ? c[1].message : [],
              )
              .map((p: { text?: string }) => p.text ?? '')
              .join('');
          await vi.waitFor(() => {
            expect(sentToModel()).toContain('- relocated home task');
          });
        } finally {
          restoreHome();
          if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
          else process.env['QWEN_HOME'] = prevQwenHome;
          await fs.rm(tmpDir, { recursive: true, force: true });
          await fs.rm(fakeHome, { recursive: true, force: true });
          await fs.rm(qwenHome, { recursive: true, force: true });
        }
      });

      it('propagates a sentinel resolve() error (EACCES) without leaking the absolute path to the client', async () => {
        // #executeCronPrompt: when resolve() throws (e.g. EACCES on
        // .qwen/loop.md) it logs a loop.md-specific warn and RE-THROWS into the
        // cron catch. Regression guard: the failure must PROPAGATE (surface as a
        // cron error, never degrade to a default/normal tick sent to the model)
        // and the loop.md-tagged warn must fire so a resolution failure stays
        // distinguishable from a model-call failure in logs.
        //
        // Security guard: the raw fs error message embeds the ABSOLUTE loop.md
        // path (OS username + dir layout). The cron catch forwards error.message
        // verbatim to the client via emitAgentMessage, so the re-thrown error's
        // message must be SANITIZED — relative label + errno code only, never the
        // absolute path. The full detail stays in the LOCAL debug warn.
        debugLoggerWarnSpy.mockClear();
        const absoluteLoopMdPath = '/home/alice/project/.qwen/loop.md';
        const eacces = Object.assign(
          new Error(`EACCES: permission denied, open '${absoluteLoopMdPath}'`),
          { code: 'EACCES' },
        );
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(eacces);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          // The loop.md-specific warn fired, tagged with the sentinel mode and
          // the EACCES code (proving the failure was logged as a resolution
          // failure, not a generic model error). The raw error — whose message
          // carries the absolute path — is passed as the second arg so the full
          // detail is kept in this LOCAL log (debug logs are never sent to the
          // client).
          await vi.waitFor(() => {
            expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
              'loop.md sentinel resolution failed (mode=cron, code=EACCES) — check .qwen/loop.md permissions/IO',
              eacces,
            );
          });

          // The error PROPAGATED to the cron catch and surfaced to the client,
          // but SANITIZED: the emitted message names the relative candidate
          // labels + errno code and NEVER the raw absolute loop.md path.
          const sessionUpdateMock = mockClient.sessionUpdate as ReturnType<
            typeof vi.fn
          >;
          const cronErrorTexts = () =>
            sessionUpdateMock.mock.calls
              .map(
                (call) =>
                  (
                    call[0] as {
                      update?: {
                        sessionUpdate?: string;
                        content?: { text?: string };
                      };
                    }
                  ).update,
              )
              .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
              .map((u) => u?.content?.text ?? '')
              .filter((text) => text.includes('[cron error]'));
          await vi.waitFor(() =>
            expect(cronErrorTexts().length).toBeGreaterThan(0),
          );
          for (const text of cronErrorTexts()) {
            // Relative label + errno code present...
            expect(text).toContain('EACCES');
            expect(text).toContain('.qwen/loop.md (project)');
            // ...and NO absolute path leaked to the client/API.
            expect(text).not.toContain(absoluteLoopMdPath);
            expect(text).not.toContain('/home/alice');
          }

          // It was NOT swallowed into a normal tick: resolve() threw before any
          // model send, so neither an expanded `# /loop tick` block nor the raw
          // sentinel ever reached the model (the model is only sent the user
          // prompt, never a degraded default tick).
          const sentToModel = () =>
            (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
              .flatMap((c) =>
                Array.isArray(c[1]?.message) ? c[1].message : [],
              )
              .map((p: { text?: string }) => p.text ?? '')
              .join('');
          expect(sentToModel()).not.toContain('# /loop tick');
          expect(sentToModel()).not.toContain('<<loop.md>>');
        } finally {
          resolveSpy.mockRestore();
        }
      });

      it('names the QWEN_HOME-aware home path in the sanitized resolve error, not a hardcoded ~/.qwen', async () => {
        // Regression: the sanitized resolve-error hardcoded `~/.qwen/loop.md
        // (home)`, but the resolver's home candidate is QWEN_HOME-aware. With
        // QWEN_HOME relocated OUTSIDE $HOME, the error reuses homeLoopLabel(),
        // which names it via the literal `$QWEN_HOME/loop.md` — leak-safe (never
        // the resolved absolute global dir, nor the absolute project path).
        debugLoggerWarnSpy.mockClear();
        const tmpDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-err-proj-'),
        );
        const fakeHome = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-err-home-'),
        );
        const qwenHome = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-err-qwenhome-'),
        );
        mockConfig.getWorkingDir = vi.fn().mockReturnValue(tmpDir);
        const restoreHome = setFakeHome(fakeHome);
        const prevQwenHome = process.env['QWEN_HOME'];
        process.env['QWEN_HOME'] = qwenHome;
        // qwenHome is under os.tmpdir() (not the OS home), so tildeifyPath is a
        // no-op there. The label is MODEL/client-facing, so it must read as the
        // literal `$QWEN_HOME/loop.md`, never the resolved absolute path.
        const expectedHomeLabel = `$QWEN_HOME/loop.md (home)`;

        const eacces = Object.assign(
          new Error(
            `EACCES: permission denied, open '${path.join(tmpDir, '.qwen', 'loop.md')}'`,
          ),
          { code: 'EACCES' },
        );
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(eacces);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const sessionUpdateMock = mockClient.sessionUpdate as ReturnType<
            typeof vi.fn
          >;
          const cronErrorTexts = () =>
            sessionUpdateMock.mock.calls
              .map(
                (call) =>
                  (
                    call[0] as {
                      update?: {
                        sessionUpdate?: string;
                        content?: { text?: string };
                      };
                    }
                  ).update,
              )
              .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
              .map((u) => u?.content?.text ?? '')
              .filter((text) => text.includes('[cron error]'));
          await vi.waitFor(() =>
            expect(cronErrorTexts().length).toBeGreaterThan(0),
          );
          for (const text of cronErrorTexts()) {
            // The QWEN_HOME-aware home path is named...
            expect(text).toContain(expectedHomeLabel);
            expect(text).toContain('.qwen/loop.md (project)');
            // ...and the old hardcoded label is gone.
            expect(text).not.toContain('~/.qwen/loop.md');
            // Still leak-safe: neither the absolute project path nor the
            // resolved $QWEN_HOME global dir reaches the client/API.
            expect(text).not.toContain(path.join(tmpDir, '.qwen', 'loop.md'));
            expect(text).not.toContain(path.join(qwenHome, 'loop.md'));
          }
        } finally {
          resolveSpy.mockRestore();
          restoreHome();
          if (prevQwenHome === undefined) delete process.env['QWEN_HOME'];
          else process.env['QWEN_HOME'] = prevQwenHome;
          await fs.rm(tmpDir, { recursive: true, force: true });
          await fs.rm(fakeHome, { recursive: true, force: true });
          await fs.rm(qwenHome, { recursive: true, force: true });
        }
      });

      it('omits the project candidate from the sanitized resolve error in an untrusted folder', async () => {
        // An untrusted folder never reads `.qwen/loop.md` (the resolver gets
        // allowProjectFile=false), so the sanitized error must NOT claim the
        // project candidate was checked — it would be a lie. It still names the
        // QWEN_HOME-aware home candidate (the only one actually probed) and the
        // errno code, and stays leak-safe. Mutation guard: hardcoding
        // `.qwen/loop.md (project)` back into the throw re-introduces the false
        // claim and fails this test.
        debugLoggerWarnSpy.mockClear();
        const tmpDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-untrusted-err-'),
        );
        const fakeHome = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-untrusted-home-'),
        );
        mockConfig.getWorkingDir = vi.fn().mockReturnValue(tmpDir);
        mockConfig.isTrustedFolder = vi.fn().mockReturnValue(false);
        const restoreHome = setFakeHome(fakeHome);

        const absoluteLoopMdPath = path.join(tmpDir, '.qwen', 'loop.md');
        const eacces = Object.assign(
          new Error(`EACCES: permission denied, open '${absoluteLoopMdPath}'`),
          { code: 'EACCES' },
        );
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(eacces);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const sessionUpdateMock = mockClient.sessionUpdate as ReturnType<
            typeof vi.fn
          >;
          const cronErrorTexts = () =>
            sessionUpdateMock.mock.calls
              .map(
                (call) =>
                  (
                    call[0] as {
                      update?: {
                        sessionUpdate?: string;
                        content?: { text?: string };
                      };
                    }
                  ).update,
              )
              .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
              .map((u) => u?.content?.text ?? '')
              .filter((text) => text.includes('[cron error]'));
          await vi.waitFor(() =>
            expect(cronErrorTexts().length).toBeGreaterThan(0),
          );
          for (const text of cronErrorTexts()) {
            // The home candidate and errno code are named...
            expect(text).toContain('EACCES');
            expect(text).toContain('(home)');
            // ...but the never-read project candidate is omitted entirely.
            expect(text).not.toContain('(project)');
            // ...and the absolute path is still never leaked to the client/API.
            expect(text).not.toContain(absoluteLoopMdPath);
          }
        } finally {
          resolveSpy.mockRestore();
          restoreHome();
          await fs.rm(tmpDir, { recursive: true, force: true });
          await fs.rm(fakeHome, { recursive: true, force: true });
        }
      });

      it('threads one captured folder-trust into both the resolve probe and the sanitized error', async () => {
        // FIX 3: isTrustedFolder() can flip mid-tick (IDE workspace-trust
        // update). Capturing it ONCE and threading it to BOTH resolve() and the
        // error's absentLocations() keeps the sanitized error naming the SAME
        // candidate set that was probed. Assert the trust handed to resolve() is
        // identical to the one handed to absentLocations(). Mutation guard:
        // reverting to two separate isTrustedFolder() reads drops the resolve()
        // trust arg (undefined), so the two no longer match.
        debugLoggerWarnSpy.mockClear();
        const eacces = Object.assign(
          new Error("EACCES: permission denied, open '/home/x/.qwen/loop.md'"),
          { code: 'EACCES' },
        );
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(eacces);
        const absentSpy = vi.spyOn(
          core.LoopTickResolver.prototype,
          'absentLocations',
        );
        mockConfig.isTrustedFolder = vi.fn().mockReturnValue(true);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          await vi.waitFor(() => expect(resolveSpy).toHaveBeenCalled());
          await vi.waitFor(() => expect(absentSpy).toHaveBeenCalled());
          // resolve() was probed with the captured trust as its 2nd arg, and the
          // error's absentLocations() got the SAME value — one capture, both
          // paths agree.
          const probedTrust = resolveSpy.mock.calls[0][1];
          const erroredTrust = absentSpy.mock.calls[0][0];
          expect(probedTrust).toBe(true);
          expect(erroredTrust).toBe(true);
          expect(probedTrust).toBe(erroredTrust);
        } finally {
          resolveSpy.mockRestore();
          absentSpy.mockRestore();
        }
      });

      it('keeps a dynamic loop alive on a transient resolve error (no throw, re-arm tick)', async () => {
        // FIX 4: a `dynamic` loop is re-armed only by the model at end-of-turn,
        // and the firing wakeup was already consumed. A transient, non-whitelisted
        // resolve error (EIO) must NOT throw (no turn → no re-arm → silent death)
        // — it degrades to a no-op tick that mirrors the absent path AND carries
        // the dynamic re-arm instruction, so the model re-arms and the loop
        // survives. Mutation guard: drop the `dynamic` branch (always throw) and a
        // `[loop error]` surfaces while no tick reaches the model.
        debugLoggerDebugSpy.mockClear();
        debugLoggerWarnSpy.mockClear();
        const eio = Object.assign(new Error('EIO: i/o error, read'), {
          code: 'EIO',
        });
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(eio);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md-dynamic>>', cronExpr: '@wakeup' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        const sentToModel = () =>
          (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
            .flatMap((c) => (Array.isArray(c[1]?.message) ? c[1].message : []))
            .map((p: { text?: string }) => p.text ?? '')
            .join('');
        const errorEchoes = () =>
          (mockClient.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls
            .map((call) => call[0]?.update)
            .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
            .map((u) => u?.content?.text ?? '')
            .filter((text: string) => text.includes('error]'));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          // The degraded no-op tick reached the model (the turn ran → no throw).
          await vi.waitFor(() => {
            expect(sentToModel()).toContain(
              '# /loop tick — loop.md unavailable (dynamic pacing)',
            );
          });
          // It carries the dynamic re-arm instruction (the literal sentinel) and
          // the errno note, so the loop continues.
          expect(sentToModel()).toContain('<<loop.md-dynamic>>');
          expect(sentToModel()).toContain('could not be read this tick (EIO)');
          // The CLIENT echo distinguishes a transient read failure (file present,
          // unreadable this tick) from a genuinely-absent file: it must say
          // "temporarily unavailable", never the misleading "not present".
          // Mutation guard: drop the transientError flag/echo branch and the echo
          // regresses to "not present", failing both assertions below.
          const loopEchoes = (
            mockClient.sessionUpdate as ReturnType<typeof vi.fn>
          ).mock.calls
            .map((call) => call[0]?.update)
            .filter((u) => u?.sessionUpdate === 'user_message_chunk')
            .map((u) => u?.content?.text ?? '');
          expect(loopEchoes).toContain(
            'Loop tick — loop.md temporarily unavailable',
          );
          expect(loopEchoes).not.toContain('Loop tick — loop.md not present');
          // It did NOT surface as a loop/cron error (the loop did not die).
          expect(errorEchoes()).toHaveLength(0);
          // The real errno is still recorded in the LOCAL debug warn.
          expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
            'loop.md sentinel resolution failed (mode=dynamic, code=EIO) — check .qwen/loop.md permissions/IO',
            eio,
          );
          expect(debugLoggerDebugSpy).toHaveBeenCalledWith(
            expect.stringContaining('delivery=transient-error'),
          );
        } finally {
          resolveSpy.mockRestore();
        }
      });

      it('still throws on a transient resolve error for a cron loop (no degraded tick)', async () => {
        // The cron counterpart to the dynamic-survival path: cron re-fires on its
        // own next interval, so a transient resolve error STILL propagates
        // (sanitized) rather than degrading to a model tick. Mutation guard:
        // widening the dynamic no-throw branch to cron would send a `# /loop tick`
        // block instead of surfacing the error.
        debugLoggerWarnSpy.mockClear();
        const eio = Object.assign(new Error('EIO: i/o error, read'), {
          code: 'EIO',
        });
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(eio);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const cronErrorTexts = () =>
            (mockClient.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls
              .map((call) => call[0]?.update)
              .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
              .map((u) => u?.content?.text ?? '')
              .filter((text: string) => text.includes('[cron error]'));
          await vi.waitFor(() =>
            expect(cronErrorTexts().length).toBeGreaterThan(0),
          );
          // Sanitized error carries the errno; no degraded loop tick was sent.
          for (const text of cronErrorTexts()) {
            expect(text).toContain('EIO');
          }
          const sentToModel = () =>
            (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
              .flatMap((c) =>
                Array.isArray(c[1]?.message) ? c[1].message : [],
              )
              .map((p: { text?: string }) => p.text ?? '')
              .join('');
          expect(sentToModel()).not.toContain('# /loop tick');
        } finally {
          resolveSpy.mockRestore();
        }
      });

      it('keeps a dynamic loop alive on a transient EACCES resolve error', async () => {
        // EACCES is in TRANSIENT_FS_CODES, so a `dynamic` loop degrades to a
        // no-op re-arm tick (same survival as the EIO case) rather than dying.
        debugLoggerWarnSpy.mockClear();
        const eacces = Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        });
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(eacces);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md-dynamic>>', cronExpr: '@wakeup' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        const sentToModel = () =>
          (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
            .flatMap((c) => (Array.isArray(c[1]?.message) ? c[1].message : []))
            .map((p: { text?: string }) => p.text ?? '')
            .join('');
        const errorEchoes = () =>
          (mockClient.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls
            .map((call) => call[0]?.update)
            .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
            .map((u) => u?.content?.text ?? '')
            .filter((text: string) => text.includes('error]'));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          // The degraded no-op tick reached the model (the turn ran → no throw),
          // carrying the dynamic re-arm sentinel and the EACCES errno note.
          await vi.waitFor(() => {
            expect(sentToModel()).toContain(
              '# /loop tick — loop.md unavailable (dynamic pacing)',
            );
          });
          expect(sentToModel()).toContain('<<loop.md-dynamic>>');
          expect(sentToModel()).toContain(
            'could not be read this tick (EACCES)',
          );
          // The loop did NOT surface an error (it survived).
          expect(errorEchoes()).toHaveLength(0);
          expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
            'loop.md sentinel resolution failed (mode=dynamic, code=EACCES) — check .qwen/loop.md permissions/IO',
            eacces,
          );
        } finally {
          resolveSpy.mockRestore();
        }
      });

      it('keeps a dynamic loop alive on a transient EISDIR resolve error', async () => {
        // EISDIR is in TRANSIENT_FS_CODES (the lstat→open TOCTOU race: the path is
        // swapped to a directory between the pre-open lstat and fs.open). A
        // `dynamic` loop must degrade to a no-op re-arm tick — same survival as the
        // EACCES/EIO cases — instead of dying. Mutation guard: drop EISDIR from the
        // set and this throw falls through to the sanitized `[loop error]` re-throw.
        debugLoggerWarnSpy.mockClear();
        const eisdir = Object.assign(
          new Error('EISDIR: illegal operation on a directory, read'),
          { code: 'EISDIR' },
        );
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(eisdir);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md-dynamic>>', cronExpr: '@wakeup' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        const sentToModel = () =>
          (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
            .flatMap((c) => (Array.isArray(c[1]?.message) ? c[1].message : []))
            .map((p: { text?: string }) => p.text ?? '')
            .join('');
        const errorEchoes = () =>
          (mockClient.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls
            .map((call) => call[0]?.update)
            .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
            .map((u) => u?.content?.text ?? '')
            .filter((text: string) => text.includes('error]'));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          // The degraded no-op tick reached the model (the turn ran → no throw),
          // carrying the dynamic re-arm sentinel and the EISDIR errno note.
          await vi.waitFor(() => {
            expect(sentToModel()).toContain(
              '# /loop tick — loop.md unavailable (dynamic pacing)',
            );
          });
          expect(sentToModel()).toContain('<<loop.md-dynamic>>');
          expect(sentToModel()).toContain(
            'could not be read this tick (EISDIR)',
          );
          // The loop did NOT surface an error (it survived).
          expect(errorEchoes()).toHaveLength(0);
          expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
            'loop.md sentinel resolution failed (mode=dynamic, code=EISDIR) — check .qwen/loop.md permissions/IO',
            eisdir,
          );
        } finally {
          resolveSpy.mockRestore();
        }
      });

      it('keeps a dynamic loop alive on a transient ENOTDIR resolve error', async () => {
        // ENOTDIR is the sibling TOCTOU code (a path component swapped to a
        // non-directory between the lstat and fs.open). Like EISDIR it must degrade
        // a `dynamic` loop to a no-op re-arm tick rather than killing it.
        debugLoggerWarnSpy.mockClear();
        const enotdir = Object.assign(
          new Error('ENOTDIR: not a directory, open'),
          { code: 'ENOTDIR' },
        );
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(enotdir);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md-dynamic>>', cronExpr: '@wakeup' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        const sentToModel = () =>
          (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
            .flatMap((c) => (Array.isArray(c[1]?.message) ? c[1].message : []))
            .map((p: { text?: string }) => p.text ?? '')
            .join('');
        const errorEchoes = () =>
          (mockClient.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls
            .map((call) => call[0]?.update)
            .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
            .map((u) => u?.content?.text ?? '')
            .filter((text: string) => text.includes('error]'));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          await vi.waitFor(() => {
            expect(sentToModel()).toContain(
              '# /loop tick — loop.md unavailable (dynamic pacing)',
            );
          });
          expect(sentToModel()).toContain('<<loop.md-dynamic>>');
          expect(sentToModel()).toContain(
            'could not be read this tick (ENOTDIR)',
          );
          expect(errorEchoes()).toHaveLength(0);
          expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
            'loop.md sentinel resolution failed (mode=dynamic, code=ENOTDIR) — check .qwen/loop.md permissions/IO',
            enotdir,
          );
        } finally {
          resolveSpy.mockRestore();
        }
      });

      it('re-throws (does NOT degrade) a dynamic loop on a NON-fs resolve error', async () => {
        // The gate's reason for existing: a non-transient error (a TypeError /
        // programming bug → code 'unknown') is NOT in TRANSIENT_FS_CODES, so the
        // `dynamic` branch must NOT degrade to an infinite silent no-op cycle. It
        // falls through to the sanitized throw so the real bug surfaces.
        // Mutation guard: drop the `&& TRANSIENT_FS_CODES.includes(code)` gate and
        // 'unknown' degrades — a `# /loop tick` reaches the model and no
        // `[loop error]` surfaces, failing both assertions below.
        debugLoggerWarnSpy.mockClear();
        const bug = new TypeError(
          "Cannot read properties of undefined (reading 'x')",
        );
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(bug);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md-dynamic>>', cronExpr: '@wakeup' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        const loopErrorTexts = () =>
          (mockClient.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls
            .map((call) => call[0]?.update)
            .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
            .map((u) => u?.content?.text ?? '')
            .filter((text: string) => text.includes('[loop error]'));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          // The unexpected error surfaced (the loop did NOT silently degrade).
          await vi.waitFor(() =>
            expect(loopErrorTexts().length).toBeGreaterThan(0),
          );
          for (const text of loopErrorTexts()) {
            // Sanitized: carries the 'unknown' errno, not the raw TypeError text.
            expect(text).toContain('loop.md resolution failed (unknown)');
            expect(text).not.toContain('Cannot read properties');
          }
          // No degraded tick was ever sent to the model.
          const sentToModel = () =>
            (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
              .flatMap((c) =>
                Array.isArray(c[1]?.message) ? c[1].message : [],
              )
              .map((p: { text?: string }) => p.text ?? '')
              .join('');
          expect(sentToModel()).not.toContain('# /loop tick');
          // The real (unsanitized) bug is still recorded in the LOCAL debug warn.
          expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
            'loop.md sentinel resolution failed (mode=dynamic, code=unknown) — check .qwen/loop.md permissions/IO',
            bug,
          );
        } finally {
          resolveSpy.mockRestore();
        }
      });

      it('still throws on a transient EACCES resolve error for a cron loop', async () => {
        // The cron counterpart: cron re-fires on its own next interval, so even a
        // known-transient EACCES STILL propagates (sanitized) rather than degrading.
        debugLoggerWarnSpy.mockClear();
        const eacces = Object.assign(new Error('EACCES: permission denied'), {
          code: 'EACCES',
        });
        const resolveSpy = vi
          .spyOn(core.LoopTickResolver.prototype, 'resolve')
          .mockRejectedValue(eacces);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const cronErrorTexts = () =>
            (mockClient.sessionUpdate as ReturnType<typeof vi.fn>).mock.calls
              .map((call) => call[0]?.update)
              .filter((u) => u?.sessionUpdate === 'agent_message_chunk')
              .map((u) => u?.content?.text ?? '')
              .filter((text: string) => text.includes('[cron error]'));
          await vi.waitFor(() =>
            expect(cronErrorTexts().length).toBeGreaterThan(0),
          );
          for (const text of cronErrorTexts()) {
            expect(text).toContain('EACCES');
          }
          const sentToModel = () =>
            (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
              .flatMap((c) =>
                Array.isArray(c[1]?.message) ? c[1].message : [],
              )
              .map((p: { text?: string }) => p.text ?? '')
              .join('');
          expect(sentToModel()).not.toContain('# /loop tick');
        } finally {
          resolveSpy.mockRestore();
        }
      });

      it('echoes the autonomous label when a sentinel fires with no loop.md present', async () => {
        // A sentinel fires but no project or home loop.md exists, so the absent
        // tick converges on the autonomous preamble with an autonomous echo.
        const tmpDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-absent-'),
        );
        const fakeHome = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-home-'),
        );
        mockConfig.getWorkingDir = vi.fn().mockReturnValue(tmpDir);
        const restoreHome = setFakeHome(fakeHome);

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          await vi.waitFor(() => {
            expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
              sessionId: 'test-session-id',
              update: {
                sessionUpdate: 'user_message_chunk',
                content: {
                  type: 'text',
                  text: 'Autonomous loop tick',
                },
                _meta: { source: 'cron' },
              },
            });
          });
          await vi.waitFor(() => {
            expect(
              mockChatRecordingService.recordCronPrompt,
            ).toHaveBeenCalledWith(
              [
                {
                  text: expect.stringContaining('# Autonomous loop check'),
                },
              ],
              'Autonomous loop tick',
            );
          });
        } finally {
          restoreHome();
          await fs.rm(tmpDir, { recursive: true, force: true });
          await fs.rm(fakeHome, { recursive: true, force: true });
        }
      });

      it('persists a non-sentinel cron prompt and keeps the session interactive', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({
                prompt: 'do the normal cron thing',
                cronExpr: '0 * * * *',
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: {
              sessionUpdate: 'user_message_chunk',
              content: { type: 'text', text: 'do the normal cron thing' },
              _meta: { source: 'cron' },
            },
          });
        });

        const sentToModel = () =>
          (mockChat.sendMessageStream as ReturnType<typeof vi.fn>).mock.calls
            .flatMap((c) => (Array.isArray(c[1]?.message) ? c[1].message : []))
            .map((p: { text?: string }) => p.text ?? '')
            .join('');
        await vi.waitFor(() => {
          expect(sentToModel()).toContain('do the normal cron thing');
        });
        expect(sentToModel()).not.toContain('# /loop tick');
        expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalledWith(
          [{ text: 'do the normal cron thing' }],
          'do the normal cron thing',
        );
        expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalledTimes(
          1,
        );
        expect(
          mockChatRecordingService.recordUserMessage,
        ).not.toHaveBeenCalledWith('do the normal cron thing');
        await vi.waitFor(() =>
          expect(
            (session as unknown as { cronProcessing: boolean }).cronProcessing,
          ).toBe(false),
        );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'follow-up' }],
        });

        expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
          'follow-up',
          undefined,
          undefined,
          expect.stringContaining('test-session-id########'),
          undefined,
        );
        expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalledTimes(
          1,
        );
      });

      it('re-expands the full loop.md block after an auto-compaction resets the resolver cache', async () => {
        // LoopTickResolver.resetCache() is unit-tested in isolation; this pins
        // the Session-level wiring: an auto-compaction in the send path
        // (#sendMessageStreamWithAutoCompression) must reset the resolver so the
        // next unchanged tick re-delivers the FULL block (a short reminder would
        // point back to a task block compaction just evicted from context).
        //
        // Three unchanged ticks: tick1 full (committed), tick2 would normally be
        // a short reminder but COMPACTS mid-send, tick3 re-expands FULL purely
        // because tick2's compaction reset the cache. The INTRO line therefore
        // appears in exactly the two full deliveries (tick1 + tick3); without
        // the reset it would appear only once.
        const tmpDir = await fs.mkdtemp(
          path.join(os.tmpdir(), 'loop-md-compact-'),
        );
        const loopMdPath = path.join(tmpDir, '.qwen', 'loop.md');
        await fs.mkdir(path.dirname(loopMdPath), { recursive: true });
        await fs.writeFile(loopMdPath, '- stable task list');
        mockConfig.getWorkingDir = vi.fn().mockReturnValue(tmpDir);

        // Compress on the SECOND cron tick only — keyed on the cron promptId so
        // the user 'hello' prompt's compression check stays a no-op.
        let cronCompressions = 0;
        mockLlmClient.tryCompressChat = vi
          .fn()
          .mockImplementation(async (promptId: string) => {
            const isCron = String(promptId).includes('cron');
            if (isCron) cronCompressions++;
            const compressed = isCron && cronCompressions === 2;
            return {
              originalTokenCount: 100,
              newTokenCount: 50,
              compressionStatus: compressed
                ? core.CompressionStatus.COMPRESSED
                : core.CompressionStatus.NOOP,
            };
          });

        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              // Three ticks of the same sentinel; the cron queue drains them
              // serially against the one persistent resolver.
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
              callback({ prompt: '<<loop.md>>', cronExpr: '*/5 * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(() => Promise.resolve(createEmptyStream()));

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const fullDeliveries = () =>
            (
              mockChat.sendMessageStream as ReturnType<typeof vi.fn>
            ).mock.calls.filter((c) =>
              (Array.isArray(c[1]?.message) ? c[1].message : [])
                .map((p: { text?: string }) => p.text ?? '')
                .join('')
                .includes('The user configured a loop-tasks file.'),
            ).length;

          // tick1 + tick3 re-expand; tick2 is the (compacting) short reminder.
          await vi.waitFor(() => {
            expect(fullDeliveries()).toBe(2);
          });
          // The compaction actually fired on a cron tick (sanity-check the setup).
          expect(cronCompressions).toBeGreaterThanOrEqual(2);
        } finally {
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      });

      it('stops cron-fired ACP prompt before sending when the session token limit is exceeded', async () => {
        let cronCallback: ((job: { prompt: string }) => void) | undefined;
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn((callback: (job: { prompt: string }) => void) => {
            cronCallback = callback;
            callback({ prompt: 'scheduled prompt' });
          }),
          stop: vi.fn(),
          disable: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockLlmClient.tryCompressChat
          .mockResolvedValueOnce({
            originalTokenCount: 50,
            newTokenCount: 50,
            compressionStatus: core.CompressionStatus.NOOP,
          })
          .mockResolvedValueOnce({
            originalTokenCount: 101,
            newTokenCount: 101,
            compressionStatus: core.CompressionStatus.NOOP,
          });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        await vi.waitFor(() => {
          expect(mockLlmClient.tryCompressChat).toHaveBeenCalledTimes(2);
        });

        expect(scheduler.start).toHaveBeenCalledTimes(1);
        expect(mockLlmClient.tryCompressChat).toHaveBeenNthCalledWith(
          2,
          expect.stringMatching(/^test-session-id########cron\d+$/),
          false,
          expect.any(AbortSignal),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(
          mockChatRecordingService.recordCronPrompt,
        ).not.toHaveBeenCalled();
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text:
                'Session token limit exceeded: 101 tokens > 100 limit. ' +
                'Please start a new session or increase the sessionTokenLimit in your settings.json.',
            },
          },
        });
        // Token limit disables the scheduler (permanent for the session, so
        // a later LoopWakeup is rejected), not just stops it.
        expect(scheduler.disable).toHaveBeenCalledTimes(1);
        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Cron jobs and loop wakeups disabled for the rest of this session due to token limit. Restart the session to re-enable.',
              },
            },
          });
        });

        const sessionUpdateMock = mockClient.sessionUpdate as ReturnType<
          typeof vi.fn
        >;
        const tokenLimitDiagnosticCount = () =>
          sessionUpdateMock.mock.calls.filter((call) => {
            const notification = call[0] as {
              update?: {
                sessionUpdate?: string;
                content?: { type?: string; text?: string };
              };
            };
            return (
              notification.update?.sessionUpdate === 'agent_message_chunk' &&
              notification.update.content?.type === 'text' &&
              notification.update.content.text?.includes(
                'Session token limit exceeded',
              )
            );
          }).length;
        const diagnosticCountBefore = tokenLimitDiagnosticCount();

        cronCallback?.({ prompt: 'scheduled prompt again' });
        await Promise.resolve();

        expect(mockLlmClient.tryCompressChat).toHaveBeenCalledTimes(2);
        expect(tokenLimitDiagnosticCount()).toBe(diagnosticCountBefore);
      });

      it('persists a cron prompt preserved after send preparation is cancelled', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({
                prompt: 'scheduled prompt',
                cronExpr: '0 * * * *',
              });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        const noCompression = {
          originalTokenCount: 50,
          newTokenCount: 50,
          compressionStatus: core.CompressionStatus.NOOP,
        };
        let cronCompressionStarted!: () => void;
        const cronCompressionStartedPromise = new Promise<void>((resolve) => {
          cronCompressionStarted = resolve;
        });
        mockLlmClient.tryCompressChat
          .mockResolvedValueOnce(noCompression)
          .mockImplementationOnce(
            async (_promptId: string, _force: boolean, signal: AbortSignal) =>
              new Promise((_, reject) => {
                cronCompressionStarted();
                signal.addEventListener('abort', () => {
                  const abortError = new Error('aborted');
                  abortError.name = 'AbortError';
                  reject(abortError);
                });
              }),
          );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });
        await cronCompressionStartedPromise;
        vi.mocked(mockChat.addHistory).mockClear();

        await session.cancelPendingPrompt();
        await vi.waitFor(() =>
          expect(
            mockChatRecordingService.recordCronPrompt,
          ).toHaveBeenCalledTimes(1),
        );

        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: expect.arrayContaining([{ text: 'scheduled prompt' }]),
        });
        expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalledWith(
          [{ text: 'scheduled prompt' }],
          'scheduled prompt',
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
      });

      it('does not auto-compress slash commands handled without a model send', async () => {
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'message',
          messageType: 'info',
          content: 'Already compressed.',
        });
        mockChat.sendMessageStream = vi.fn();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/compress' }],
        });

        expect(mockLlmClient.tryCompressChat).not.toHaveBeenCalled();
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockConfig.startActiveTodoWorkChain).not.toHaveBeenCalled();
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Already compressed.' },
            _meta: { source: 'slash_command' },
          },
        });
        expect(
          mockChatRecordingService.recordSlashCommand,
        ).toHaveBeenCalledWith(
          expect.objectContaining({ rawCommand: '/compress' }),
        );
      });

      it('forwards export artifacts to live output and persisted command history', async () => {
        const artifacts = [
          {
            kind: 'file' as const,
            storage: 'workspace' as const,
            title: 'export.md',
            workspacePath: 'export.md',
            mimeType: 'text/markdown; charset=utf-8',
            sizeBytes: 42,
          },
        ];
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'message',
          messageType: 'info',
          content: 'Exported.',
          artifacts,
        });
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/export md' }],
        });
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Exported.' },
            _meta: { source: 'slash_command', sessionArtifacts: artifacts },
          },
        });
        expect(
          mockChatRecordingService.recordSlashCommand,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            phase: 'result',
            rawCommand: '/export md',
            outputHistoryItems: [
              {
                type: 'assistant',
                text: 'Exported.',
                sessionArtifacts: artifacts,
              },
            ],
          }),
        );
      });

      it('returns a structured standalone-policy error for a blocked slash command', async () => {
        session.dispose();
        vi.mocked(mockConfig.getSessionSourceType).mockReturnValue(
          'standalone',
        );
        vi.mocked(mockConfig.getTargetDir).mockReturnValue('/managed/child');
        session = new Session(
          'test-session-id',
          mockConfig,
          mockClient,
          mockSettings,
        );
        const expectation = {
          canonicalSessionId: 'test-session-id',
          root: { canonicalPath: '/managed', device: 1, inode: 2 },
          child: {
            name: 'child',
            canonicalPath: '/managed/child',
            device: 1,
            inode: 3,
          },
        };
        session.installPendingManagedConversationBinding(
          expectation,
          vi.fn().mockResolvedValue(undefined),
        );
        await session.commitManagedConversationBinding(expectation);
        await session.releaseManagedConversationBinding(expectation);
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'unsupported',
          reason: 'The command "/export" is not available here.',
          originalType: 'unsupported_action',
        });
        mockChat.sendMessageStream = vi.fn();

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: '/export' }],
          }),
        ).rejects.toMatchObject({
          data: { errorKind: 'unsupported_action' },
        });

        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(
          nonInteractiveCliCommands.handleSlashCommand,
        ).toHaveBeenCalledWith(
          '/export',
          expect.anything(),
          mockConfig,
          mockSettings,
          expect.anything(),
          expect.objectContaining({
            allowSessionReset: false,
            allowWorkspaceSettingsWrite: false,
            persistModelSelection: false,
            blockedBuiltinCommandNames: expect.arrayContaining(['export']),
          }),
        );
      });

      it('does not record /advisor in the ACP transcript', async () => {
        const finishedSpy = vi
          .spyOn(core, 'logConversationFinishedEvent')
          .mockImplementation(() => {});
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'message',
          messageType: 'info',
          content: 'Review complete.',
          resolvedCommand: {
            name: 'advisor',
            kind: CommandKind.BUILT_IN,
          },
        });
        mockChatRecordingService.recordUserMessage.mockClear();
        mockChatRecordingService.recordSlashCommand.mockClear();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/advisor' }],
        });

        expect(
          mockChatRecordingService.recordUserMessage,
        ).not.toHaveBeenCalled();
        expect(
          mockChatRecordingService.recordSlashCommand,
        ).not.toHaveBeenCalled();
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Review complete.' },
            _meta: { source: 'slash_command' },
          },
        });
        expect(finishedSpy).toHaveBeenCalledTimes(1);
      });

      it('keeps replay records for other ACP slash-command messages', async () => {
        const finishedSpy = vi
          .spyOn(core, 'logConversationFinishedEvent')
          .mockImplementation(() => {});
        let finish!: () => void;
        const delayed = new Promise<void>((resolve) => {
          finish = resolve;
        });
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockImplementationOnce(async () => {
          markStarted();
          await delayed;
          return {
            type: 'message',
            messageType: 'info',
            content: 'Side answer.',
          };
        });
        mockChatRecordingService.recordUserMessage.mockClear();
        mockChatRecordingService.recordSlashCommand.mockClear();

        const prompt = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/btw question' }],
        });
        await started;
        await session.cancelPendingPrompt();
        finish();

        await expect(prompt).resolves.toEqual({ stopReason: 'end_turn' });

        expect(finishedSpy).toHaveBeenCalledTimes(1);
        expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
          '/btw question',
          undefined,
          undefined,
          expect.stringContaining('test-session-id########'),
          undefined,
        );
        expect(
          mockChatRecordingService.recordSlashCommand,
        ).toHaveBeenCalledWith(
          expect.objectContaining({ rawCommand: '/btw question' }),
        );
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Side answer.' },
            _meta: { source: 'slash_command' },
          },
        });
      });

      it('returns cancelled when /advisor finishes after cancellation', async () => {
        const finishedSpy = vi
          .spyOn(core, 'logConversationFinishedEvent')
          .mockImplementation(() => {});
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockImplementationOnce(async (_input, abortController) => {
          markStarted();
          await new Promise<void>((resolve) => {
            abortController.signal.addEventListener('abort', () => resolve(), {
              once: true,
            });
          });
          return {
            type: 'message',
            messageType: 'error',
            content: 'Advisor review failed: aborted',
            resolvedCommand: {
              name: 'advisor',
              kind: CommandKind.BUILT_IN,
            },
          };
        });

        const prompt = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/advisor' }],
        });
        await started;
        await session.cancelPendingPrompt();

        await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
        expect(finishedSpy).toHaveBeenCalledTimes(1);
      });

      it('records completion when /advisor returns an error message', async () => {
        const finishedSpy = vi
          .spyOn(core, 'logConversationFinishedEvent')
          .mockImplementation(() => {});
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'message',
          messageType: 'error',
          content: 'Advisor review failed: provider rejected schema',
          resolvedCommand: {
            name: 'advisor',
            kind: CommandKind.BUILT_IN,
          },
        });

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: '/advisor' }],
          }),
        ).rejects.toThrow('Advisor review failed: provider rejected schema');

        expect(finishedSpy).toHaveBeenCalledTimes(1);
      });

      it('records a custom command shadowing the advisor name', async () => {
        // R18-6: the recording gate must classify by the RESOLVED command,
        // not the raw token — a user-defined `advisor` command keeps its
        // user-turn record while the built-in advisor's is skipped.
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'submit_prompt',
          content: [{ text: 'Shadowed advisor prompt' }],
          resolvedCommand: {
            name: 'advisor',
            kind: CommandKind.FILE,
          },
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockReturnValue(createEmptyStream());
        mockChatRecordingService.recordUserMessage.mockClear();

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: '/advisor check my work' }],
          },
          {
            version: 1,
            sessionId: 'test-session-id',
            promptId: 'daemon-advisor',
          },
        );

        // No display projection and no annotations ⇒ no `systemPayload`:
        // pins the deferred branch's no-payload arm so a regression to
        // unconditional payload recording fails here.
        expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
          '/advisor check my work',
          undefined,
          undefined,
          expect.stringContaining('test-session-id########'),
          'daemon-advisor',
        );
      });

      it('records input annotations for a deferred custom advisor command', async () => {
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'submit_prompt',
          content: [{ text: 'Shadowed advisor prompt' }],
          resolvedCommand: {
            name: 'advisor',
            kind: CommandKind.FILE,
          },
        });
        mockChatRecordingService.recordUserMessage.mockClear();

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: '/advisor check my work' }],
            _meta: {
              [DAEMON_INPUT_ANNOTATIONS_META_KEY]: [
                {
                  type: 'reference',
                  start: 15,
                  end: 22,
                  text: 'my work',
                  reference: { id: 'work', kind: 'file', value: 'work' },
                },
              ],
            },
          },
          {
            version: 1,
            sessionId: 'test-session-id',
            promptId: 'daemon-advisor',
          },
        );

        expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
          '/advisor check my work',
          undefined,
          {
            displayText: '/advisor check my work',
            hookContext: '',
            inputAnnotations: [
              {
                type: 'reference',
                start: 15,
                end: 22,
                text: 'my work',
                reference: { id: 'work', kind: 'file', value: 'work' },
              },
            ],
          },
          expect.stringContaining('test-session-id########'),
          'daemon-advisor',
        );
      });

      it.each([
        ['skill', CommandKind.SKILL],
        ['custom command', CommandKind.FILE],
      ])(
        'keeps attachments when a %s expands into a model prompt',
        async (_, kind) => {
          vi.mocked(
            nonInteractiveCliCommands.handleSlashCommand,
          ).mockResolvedValueOnce({
            type: 'submit_prompt',
            content: [{ text: 'Expanded skill prompt' }],
            resolvedCommand: {
              name: 'price-sheet',
              kind,
            },
          });

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [
              { type: 'text', text: '/price-sheet update these prices' },
              { type: 'image', mimeType: 'image/png', data: 'QUJD' },
              {
                type: 'resource',
                resource: {
                  uri: 'attachment:///notes.txt',
                  mimeType: 'text/plain',
                  text: 'hello',
                },
              },
            ],
          });

          expect(firstSentMessage()).toEqual([
            { text: '@attachment:///notes.txt' },
            { inlineData: { mimeType: 'image/png', data: 'QUJD' } },
            { text: 'File: attachment:///notes.txt\nhello' },
            { text: 'Expanded skill prompt' },
          ]);
        },
      );

      it('does not forward attachments from built-in commands', async () => {
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'submit_prompt',
          content: [{ text: 'Expanded built-in prompt' }],
          resolvedCommand: {
            name: 'remember',
            kind: CommandKind.BUILT_IN,
          },
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [
            { type: 'text', text: '/remember this' },
            { type: 'image', mimeType: 'image/png', data: 'QUJD' },
          ],
        });

        expect(firstSentMessage()).toEqual([
          { text: 'Expanded built-in prompt' },
        ]);
      });

      it('preserves an expanded slash prompt cancelled before model send', async () => {
        const finishedSpy = vi
          .spyOn(core, 'logConversationFinishedEvent')
          .mockImplementation(() => {});
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockImplementationOnce(async (_input, abortController) => {
          abortController.abort();
          return {
            type: 'submit_prompt',
            content: [{ text: 'Expanded prompt' }],
          };
        });

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: '/custom' }],
          }),
        ).resolves.toEqual({ stopReason: 'cancelled' });

        expect(mockChat.addHistory).toHaveBeenCalledWith(
          expect.objectContaining({
            role: 'user',
            parts: [{ text: 'Expanded prompt' }],
          }),
        );
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(finishedSpy).toHaveBeenCalledTimes(1);
      });

      it('marks streamed slash-command messages with their source', async () => {
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'stream_messages',
          messages: (async function* () {
            yield {
              messageType: 'info' as const,
              content: 'Compressing context...',
            };
            yield {
              messageType: 'info' as const,
              content: 'Context compressed.',
            };
          })(),
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/compress' }],
        });

        expect(mockClient.sessionUpdate).toHaveBeenNthCalledWith(1, {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Compressing context...' },
            _meta: { source: 'slash_command' },
          },
        });
        expect(mockClient.sessionUpdate).toHaveBeenNthCalledWith(2, {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Context compressed.' },
            _meta: { source: 'slash_command' },
          },
        });
      });

      it('tags the stacked-skill overflow notice for channel replies', async () => {
        const notice =
          'Only the first 5 skills were loaded. Additional /skill tokens were treated as prompt text.';
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'submit_prompt',
          content: [{ text: 'Expanded prompt' }],
          stackedSkillOverflow: notice,
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/skill a /skill b' }],
        });

        expect(mockClient.sessionUpdate).toHaveBeenNthCalledWith(1, {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: notice },
            _meta: { source: 'slash_command', turnNotice: true },
          },
        });
      });

      it('forwards the structured compression result and records it for replay', async () => {
        const compression = {
          phase: 'done' as const,
          originalTokenCount: 200,
          newTokenCount: 100,
          originalTokenCountIsEstimated: false,
          newTokenCountIsEstimated: true,
        };
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'stream_messages',
          messages: (async function* () {
            yield {
              messageType: 'info' as const,
              content: 'Compressing context...',
              contextCompression: { phase: 'progress' as const },
            };
            yield {
              messageType: 'info' as const,
              content: 'Context compressed (200 -> ~100).',
              contextCompression: compression,
            };
          })(),
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/compress' }],
        });

        // The English sentence still reaches text-only ACP hosts; the payload
        // rides alongside it for hosts that render the result themselves.
        expect(mockClient.sessionUpdate).toHaveBeenNthCalledWith(2, {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Context compressed (200 -> ~100).',
            },
            _meta: { source: 'slash_command', contextCompression: compression },
          },
        });
        // Replay rebuilds the structured line from the record, so it travels
        // with the joined text rather than replacing it.
        expect(
          mockChatRecordingService.recordSlashCommand,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            outputHistoryItems: [
              {
                type: 'assistant',
                text: 'Compressing context...\nContext compressed (200 -> ~100).',
                contextCompression: compression,
              },
            ],
          }),
        );
      });

      it('carries a compression notice on its own meta key and record item', async () => {
        const notice = { phase: 'notice' as const, instructionsLimit: 2000 };
        const compression = {
          phase: 'done' as const,
          originalTokenCount: 200,
          newTokenCount: 100,
          originalTokenCountIsEstimated: false,
          newTokenCountIsEstimated: false,
        };
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'stream_messages',
          messages: (async function* () {
            yield {
              messageType: 'info' as const,
              content: 'Compression instructions were truncated to 2000 chars.',
              contextCompressionNotice: notice,
            };
            yield {
              messageType: 'info' as const,
              content: 'Compressing context...',
              contextCompression: { phase: 'progress' as const },
            };
            yield {
              messageType: 'info' as const,
              content: 'Context compressed (200 -> 100).',
              contextCompression: compression,
            };
          })(),
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/compress' }],
        });

        // The notice rides its own `_meta` key: the reducer folds this turn into
        // one block and spreads `_meta` key by key, so a shared key would hide
        // the note behind the compression payload that follows.
        expect(mockClient.sessionUpdate).toHaveBeenNthCalledWith(1, {
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: 'Compression instructions were truncated to 2000 chars.',
            },
            _meta: {
              source: 'slash_command',
              contextCompressionNotice: notice,
            },
          },
        });
        expect(
          mockChatRecordingService.recordSlashCommand,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            outputHistoryItems: [
              {
                type: 'assistant',
                // Newline kept so the folded block still reads as two lines.
                text: 'Compression instructions were truncated to 2000 chars.\n',
                contextCompressionNotice: notice,
              },
              {
                type: 'assistant',
                text: 'Compressing context...\nContext compressed (200 -> 100).',
                contextCompression: compression,
              },
            ],
          }),
        );
      });

      it('records a terminal no-op result for replay', async () => {
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'stream_messages',
          messages: (async function* () {
            yield {
              messageType: 'info' as const,
              content: 'Compressing context (fast)...',
              contextCompression: { phase: 'progress' as const },
            };
            yield {
              messageType: 'info' as const,
              content: 'No compression needed.',
              contextCompression: { phase: 'noop' as const },
            };
          })(),
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/compress-fast' }],
        });

        // The no-op is terminal, so it is recorded like the result: replay
        // rebuilds the row in the client's language instead of leaving the
        // joined English sentences.
        expect(
          mockChatRecordingService.recordSlashCommand,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            outputHistoryItems: [
              {
                type: 'assistant',
                text: 'Compressing context (fast)...\nNo compression needed.',
                contextCompression: { phase: 'noop' },
              },
            ],
          }),
        );
      });

      it('emits canonical Goal state for an ACP /goal status query', async () => {
        const snapshot: core.GoalSnapshotV2 = {
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        };
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockResolvedValueOnce({
          type: 'goal_control',
          operation: { kind: 'status' },
          response: { snapshot },
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/goal' }],
        });

        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '' },
            _meta: {
              goalState: snapshot,
            },
          },
        });
      });

      it('publishes a mutating ACP /goal result only through the runtime subscription', async () => {
        const snapshot: core.GoalSnapshotV2 = {
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        };
        const listener = mockGoalRuntime.subscribe.mock.calls[0]?.[0] as (
          snapshot: core.GoalSnapshotV2,
          cause?: core.GoalStateCause,
        ) => void;
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockImplementationOnce(async () => {
          listener(snapshot, 'create');
          return {
            type: 'goal_control',
            operation: { kind: 'set', objective: 'check weather' },
            response: { snapshot },
            cause: 'create',
          };
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/goal check weather' }],
        });
        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
        });
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '' },
            _meta: {
              goalState: snapshot,
              goalStatus: {
                kind: 'set',
                condition: 'check weather',
                iterations: 0,
                setAt: 1234,
                durationMs: 0,
              },
            },
          },
        });
      });

      // Goal recovery runs from the Config constructor, before this Session
      // exists to subscribe, and replay streams the pre-migration records —
      // so the client's newest goal card is the legacy `set` one and it
      // shows a phantom running goal. Republishing after replay is what
      // delivers the `migrated -> paused` projection.
      it('republishes the recovered Goal state after replay with its recovery cause', async () => {
        const snapshot: core.GoalSnapshotV2 = {
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'goal-migrated',
            revision: 1,
            objective: 'ship the thing',
            status: 'paused',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        };
        mockGoalRuntime.getSnapshot.mockReturnValue(snapshot);
        mockGoalRuntime.getRecoveryCause.mockReturnValue('migrated');

        await session.publishRecoveredGoalState([]);

        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '' },
            _meta: expect.objectContaining({
              goalState: snapshot,
              goalStatus: expect.objectContaining({
                kind: 'paused',
                condition: 'ship the thing',
              }),
            }),
          },
        });
      });

      it('publishes nothing when no Goal was recovered', async () => {
        mockGoalRuntime.getRecoveryCause.mockReturnValue(undefined);
        await session.publishRecoveredGoalState([]);
        expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
      });

      // A transcript from before Goal state was journaled restores with no
      // Goal and no cause, and nothing corrects the legacy `set` card the
      // replay ended on. The trailing `cleared` card says nothing drives it.
      it('supersedes a replayed legacy goal card when the runtime recovered no Goal', async () => {
        mockGoalRuntime.getRecoveryCause.mockReturnValue(undefined);

        await session.publishRecoveredGoalState([
          {
            uuid: 'legacy-goal',
            parentUuid: null,
            sessionId: 'test-session-id',
            timestamp: new Date(0).toISOString(),
            type: 'system',
            subtype: 'slash_command',
            cwd: '/tmp',
            version: 'test',
            systemPayload: {
              phase: 'result',
              outputHistoryItems: [
                {
                  type: 'goal_status',
                  kind: 'set',
                  condition: 'ship the thing',
                  iterations: 2,
                  setAt: 1234,
                },
              ],
            },
          } as unknown as core.ChatRecord,
        ]);

        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '' },
            _meta: {
              goalStatus: expect.objectContaining({
                kind: 'cleared',
                condition: 'ship the thing',
                lastReason: expect.stringContaining(
                  'recorded by an earlier version of Qwen Code',
                ),
              }),
            },
          },
        });
      });

      // The live-restore path appends the same card from the runtime as it
      // stands, without waiting for readiness, and only while the session
      // drives no Goal.
      it('renders the legacy supersession for a live replay only while no Goal is live', () => {
        const legacyCard = {
          uuid: 'legacy-goal',
          parentUuid: null,
          sessionId: 'test-session-id',
          timestamp: new Date(0).toISOString(),
          type: 'system',
          subtype: 'slash_command',
          cwd: '/tmp',
          version: 'test',
          systemPayload: {
            phase: 'result',
            outputHistoryItems: [
              {
                type: 'goal_status',
                kind: 'checking',
                condition: 'ship the thing',
                iterations: 3,
              },
            ],
          },
        } as unknown as core.ChatRecord;

        expect(session.renderLegacyGoalSupersession([legacyCard])).toEqual([
          {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '' },
            _meta: {
              goalStatus: expect.objectContaining({
                kind: 'cleared',
                condition: 'ship the thing',
                iterations: 3,
              }),
            },
          },
        ]);
        expect(
          (
            mockConfig as unknown as {
              getGoalRuntimeReady: ReturnType<typeof vi.fn>;
            }
          ).getGoalRuntimeReady,
        ).not.toHaveBeenCalled();

        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'live-goal',
            revision: 1,
            objective: 'set after the resume',
            status: 'active',
            evidenceCursor: { recordId: null },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        });
        expect(session.renderLegacyGoalSupersession([legacyCard])).toEqual([]);
      });

      // R3-6's second trigger: `recoverGoalFromRecords` returns
      // `'unsupported'`, `restore()` latches `recoveryError`, and the replay
      // still emitted the active legacy `set` card. Nothing in-session
      // corrects that — a degraded `/goal` answers without a cause, so no
      // client card-derivation reads it. The trailing `cleared` card the
      // removed `supersedeUnrestorableGoal` emitted is what does.
      it('supersedes an active legacy goal card when recovery is unavailable', async () => {
        vi.mocked(mockConfig.getGoalRuntimeReady).mockRejectedValueOnce(
          new core.GoalPersistenceUnavailableError('unsupported record'),
        );

        await session.publishRecoveredGoalState([
          {
            uuid: 'legacy-goal',
            parentUuid: null,
            sessionId: 'test-session-id',
            timestamp: new Date(0).toISOString(),
            type: 'system',
            subtype: 'slash_command',
            cwd: '/tmp',
            version: 'test',
            systemPayload: {
              phase: 'result',
              outputHistoryItems: [
                {
                  type: 'goal_status',
                  kind: 'set',
                  condition: 'ship the thing',
                  iterations: 2,
                  setAt: 1234,
                },
              ],
            },
          } as unknown as core.ChatRecord,
        ]);

        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: '' },
            _meta: {
              goalStatus: expect.objectContaining({
                kind: 'cleared',
                condition: 'ship the thing',
              }),
            },
          },
        });
      });

      it('stays quiet when recovery is unavailable and no goal was active', async () => {
        vi.mocked(mockConfig.getGoalRuntimeReady).mockRejectedValueOnce(
          new core.GoalPersistenceUnavailableError('unsupported record'),
        );
        await session.publishRecoveredGoalState([]);
        expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
      });

      // The bulk load-replay path collects its page into the `LOAD_REPLAY`
      // envelope and the bridge seeds it onto the event bus only after
      // `session/load` returns. Streaming the recovered card from inside
      // that call would put it *before* the replayed legacy `set` card —
      // the wrong end — so this path renders instead of sending.
      describe('renderRecoveredGoalUpdates', () => {
        const migratedSnapshot: core.GoalSnapshotV2 = {
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'goal-migrated',
            revision: 1,
            objective: 'ship the thing',
            status: 'paused',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        };

        it('returns the recovered Goal card instead of streaming it', async () => {
          mockGoalRuntime.getSnapshot.mockReturnValue(migratedSnapshot);
          mockGoalRuntime.getRecoveryCause.mockReturnValue('migrated');

          const updates = await session.renderRecoveredGoalUpdates([]);

          expect(updates).toEqual([
            {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '' },
              _meta: expect.objectContaining({
                goalState: migratedSnapshot,
                goalStatus: expect.objectContaining({
                  kind: 'paused',
                  condition: 'ship the thing',
                }),
              }),
            },
          ]);
          // The whole point: nothing may reach the client early.
          expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
        });

        // Without this the runtime subscription re-publishes the same
        // (cause, snapshot) once the session goes live and the client
        // renders the recovered card twice — once from the envelope, once
        // from the stream.
        it('marks the rendered card as delivered so a live publish cannot duplicate it', async () => {
          mockGoalRuntime.getSnapshot.mockReturnValue(migratedSnapshot);
          mockGoalRuntime.getRecoveryCause.mockReturnValue('migrated');

          const updates = await session.renderRecoveredGoalUpdates([]);
          expect(updates).toHaveLength(1);

          await session.publishRecoveredGoalState([]);
          expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
        });

        it('suppresses a hidden recovered Goal until a different Goal replaces it', async () => {
          const listener = mockGoalRuntime.subscribe.mock.calls[0]?.[0] as (
            snapshot: core.GoalSnapshotV2,
            cause?: core.GoalStateCause,
          ) => void;
          session.primeRecoveredGoalPublication(undefined, 'goal-hidden');
          const hidden: core.GoalSnapshotV2 = {
            v: 2,
            activity: 'idle',
            goal: {
              ...migratedSnapshot.goal!,
              goalId: 'goal-hidden',
              revision: 1,
              objective: 'hidden inherited goal',
              status: 'active',
            },
          };

          listener(hidden, 'create');
          listener({ ...hidden, activity: 'running' });
          await new Promise((resolve) => setTimeout(resolve, 0));

          expect(mockClient.sessionUpdate).not.toHaveBeenCalled();

          const progressed = {
            ...hidden,
            activity: 'idle' as const,
            goal: {
              ...hidden.goal!,
              revision: 2,
              objective: 'still hidden',
            },
          };
          listener(progressed, 'edit');
          await new Promise((resolve) => setTimeout(resolve, 0));
          expect(mockClient.sessionUpdate).not.toHaveBeenCalled();

          const replacement = {
            ...progressed,
            goal: {
              ...progressed.goal!,
              goalId: 'goal-visible',
              revision: 1,
              objective: 'visible replacement',
            },
          };
          listener(replacement, 'replace');
          await vi.waitFor(() =>
            expect(mockClient.sessionUpdate).toHaveBeenCalledOnce(),
          );
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: expect.objectContaining({
              _meta: expect.objectContaining({ goalState: replacement }),
            }),
          });
        });

        it('returns nothing when no Goal was recovered', async () => {
          mockGoalRuntime.getRecoveryCause.mockReturnValue(undefined);
          expect(await session.renderRecoveredGoalUpdates([])).toEqual([]);
          expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
        });

        it('returns the superseding cleared card when recovery is unavailable', async () => {
          vi.mocked(mockConfig.getGoalRuntimeReady).mockRejectedValueOnce(
            new core.GoalPersistenceUnavailableError('unsupported record'),
          );

          const updates = await session.renderRecoveredGoalUpdates([
            {
              uuid: 'legacy-goal',
              parentUuid: null,
              sessionId: 'test-session-id',
              timestamp: new Date(0).toISOString(),
              type: 'system',
              subtype: 'slash_command',
              cwd: '/tmp',
              version: 'test',
              systemPayload: {
                phase: 'result',
                outputHistoryItems: [
                  {
                    type: 'goal_status',
                    kind: 'set',
                    condition: 'ship the thing',
                    iterations: 2,
                    setAt: 1234,
                  },
                ],
              },
            } as unknown as core.ChatRecord,
          ]);

          expect(updates).toEqual([
            {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: '' },
              _meta: {
                goalStatus: expect.objectContaining({
                  kind: 'cleared',
                  condition: 'ship the thing',
                }),
              },
            },
          ]);
          expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
        });

        it('returns nothing when recovery is unavailable and no goal was active', async () => {
          vi.mocked(mockConfig.getGoalRuntimeReady).mockRejectedValueOnce(
            new core.GoalPersistenceUnavailableError('unsupported record'),
          );
          expect(await session.renderRecoveredGoalUpdates([])).toEqual([]);
          expect(mockClient.sessionUpdate).not.toHaveBeenCalled();
        });
      });

      // `/clear` makes Config dispose the Goal runtime and build a new one
      // under this same long-lived Session, so the constructor's subscription
      // is left on the abandoned instance and no `_meta.goalState` update
      // would ever be delivered again.
      it('re-subscribes to the replacement Goal runtime after a session switch', async () => {
        const replacementRuntime = {
          ...mockGoalRuntime,
          subscribe: vi.fn().mockReturnValue(() => {}),
        };
        let capturedHooks:
          | { startNewSession?: (sessionId: string) => void }
          | undefined;
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockImplementationOnce(
          async (_query, _abort, _config, _settings, hooks) => {
            capturedHooks = hooks;
            vi.mocked(mockConfig.getGoalRuntime).mockReturnValue(
              replacementRuntime as unknown as core.GoalRuntime,
            );
            hooks?.startNewSession?.('new-session-id');
            return {
              type: 'message',
              messageType: 'info',
              content: 'Conversation cleared.',
            };
          },
        );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/clear' }],
        });

        expect(capturedHooks?.startNewSession).toBeInstanceOf(Function);
        expect(replacementRuntime.subscribe).toHaveBeenCalledTimes(1);

        const goal = {
          goalId: 'goal-2',
          revision: 1,
          objective: 'check weather',
          status: 'active' as const,
          evidenceCursor: { recordId: 'cursor-1' },
          turnCount: 0,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1234,
          updatedAt: 1234,
        };
        const listener = replacementRuntime.subscribe.mock.calls[0]?.[0] as (
          snapshot: core.GoalSnapshotV2,
          cause?: core.GoalStateCause,
        ) => void;
        vi.mocked(mockClient.sessionUpdate).mockClear();
        listener({ v: 2, activity: 'running', goal }, 'create');

        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
        });
        expect(
          vi.mocked(mockClient.sessionUpdate).mock.calls[0]?.[0].update._meta?.[
            'goalState'
          ],
        ).toMatchObject({ goal: { goalId: 'goal-2' } });
      });

      // R20-9: `/clear` swaps in a fresh recorder inside its action, so its
      // user-turn record must land BEFORE the action runs — otherwise the
      // deferred record is written into the NEW session's transcript.
      it('records /clear user-turn before the session switch', async () => {
        mockChatRecordingService.recordUserMessage.mockClear();
        const callOrder: string[] = [];
        mockChatRecordingService.recordSessionApprovalMode.mockImplementationOnce(
          async () => {
            callOrder.push('recordSessionApprovalMode');
            return true;
          },
        );
        mockChatRecordingService.recordUserMessage.mockImplementationOnce(
          () => {
            callOrder.push('recordUserMessage');
          },
        );
        vi.mocked(
          nonInteractiveCliCommands.handleSlashCommand,
        ).mockImplementationOnce(
          async (_query, _abort, _config, _settings, hooks) => {
            callOrder.push('action-start');
            hooks?.startNewSession?.('new-session-id');
            callOrder.push('action-end');
            return {
              type: 'message',
              messageType: 'info',
              content: 'Conversation cleared.',
            };
          },
        );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '/clear' }],
        });

        expect(callOrder).toEqual([
          'recordSessionApprovalMode',
          'recordUserMessage',
          'action-start',
          'action-end',
        ]);
      });

      it('preserves canonical Goal state publication order', async () => {
        const listener = mockGoalRuntime.subscribe.mock.calls[0]?.[0] as (
          snapshot: core.GoalSnapshotV2,
          cause?: core.GoalStateCause,
        ) => void;
        let releaseFirst!: () => void;
        const publishedActivities: string[] = [];
        vi.mocked(mockClient.sessionUpdate).mockImplementation(
          async (params) => {
            publishedActivities.push(
              params.update._meta?.['goalState']?.activity ?? 'missing',
            );
            if (publishedActivities.length === 1) {
              await new Promise<void>((resolve) => {
                releaseFirst = resolve;
              });
            }
          },
        );
        const goal = {
          goalId: 'goal-1',
          revision: 1,
          objective: 'check weather',
          status: 'active' as const,
          evidenceCursor: { recordId: 'cursor-1' },
          turnCount: 0,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1234,
          updatedAt: 1234,
        };

        listener({ v: 2, activity: 'idle', goal }, 'create');
        listener({ v: 2, activity: 'running', goal }, 'turn_finished');

        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(1);
        });
        releaseFirst();
        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledTimes(2);
        });
        expect(publishedActivities).toEqual(['idle', 'running']);
      });

      it('stamps a Goal turn’s tool results with the permit, and its own reads as bookkeeping', async () => {
        // The evidence catalog derives provenance from this stamp: an
        // unstamped tool result yields no catalog entry at all, so an ACP
        // Goal could never cite an external_fact and could never prove a
        // completion with anything but the model's own words.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-stamp',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
          turnKey === 'goal-runtime:turn-stamp' ? permit : undefined,
        );
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockToolRegistry.getTool.mockImplementation((name: string) => ({
          name,
          displayName: name,
          kind: core.Kind.Read,
          schema: { name, description: name, parameters: {} },
          validateToolParams: vi.fn().mockReturnValue(null),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue(name),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: vi.fn().mockResolvedValue(
            name === 'run_shell_command'
              ? {
                  llmContent: 'command failed',
                  returnDisplay: 'command failed',
                  error: {
                    message: 'command failed',
                    type: core.ToolErrorType.EXECUTION_FAILED,
                  },
                }
              : { llmContent: 'ok', returnDisplay: 'ok' },
          ),
        }));
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    { id: 'call-read', name: 'read_file', args: {} },
                    { id: 'call-goal', name: 'get_goal', args: {} },
                    { id: 'call-failed', name: 'run_shell_command', args: {} },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValue(createEmptyStream());

        expect(boundGoalHost).toBeDefined();
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
        });

        // A turn that ends with no pausing cause must not pause at all. This
        // is what keeps the pause decision and the pause reason one list: a
        // future cause that pauses without being named would land on the
        // failure arm, and nothing else in the suite would see it.
        expect(mockGoalRuntime.dispatch).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: 'pause' }),
        );

        const optionsFor = (callId: string) =>
          mockChatRecordingService.recordToolResult.mock.calls.find(
            (call: unknown[]) =>
              (call[1] as { callId?: string } | undefined)?.callId === callId,
          )?.[2];
        expect(optionsFor('call-read')).toEqual({ goalContext: permit });
        expect(optionsFor('call-goal')).toEqual({
          goalContext: permit,
          provenance: 'goal_runtime',
        });
        // A failed command is evidence too -- it is exactly what an
        // `infeasible` completion cites -- so the stamp must not depend on
        // the tool succeeding.
        expect(
          mockChatRecordingService.recordToolResult.mock.calls.find(
            (call: unknown[]) =>
              (call[1] as { callId?: string } | undefined)?.callId ===
              'call-failed',
          )?.[1],
        ).toMatchObject({ status: 'error' });
        expect(optionsFor('call-failed')).toEqual({ goalContext: permit });
      });

      it('does not stamp a background-notification turn with a permit inherited by lineage', async () => {
        // A notification fires from async resources created inside the turn
        // that spawned the task, so the Goal store is inherited into it long
        // after that turn ended. The notification turn is not a Goal turn:
        // its tool results must record unstamped, or they would become
        // external_fact evidence for a turn that never made those calls.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-stale',
        };
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockToolRegistry.getTool.mockImplementation((name: string) => ({
          name,
          displayName: name,
          kind: core.Kind.Read,
          schema: { name, description: name, parameters: {} },
          validateToolParams: vi.fn().mockReturnValue(null),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue(name),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: vi
            .fn()
            .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
        }));
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    { id: 'call-notified', name: 'read_file', args: {} },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValue(createEmptyStream());

        // Enqueue from inside a Goal turn's store, as a task completion
        // handler created during that turn would.
        const notification = core.goalTurnContext.run(permit, () =>
          session.enqueueBackgroundNotification({
            displayText: 'Background agent completed.',
            modelText: '<task-notification />',
            taskId: 'agent-stale',
            status: 'completed',
            kind: 'agent',
          }),
        );
        await expect(notification).resolves.toEqual({ accepted: true });
        await vi.waitFor(() => {
          expect(
            mockChatRecordingService.recordToolResult.mock.calls.some(
              (call: unknown[]) =>
                (call[1] as { callId?: string } | undefined)?.callId ===
                'call-notified',
            ),
          ).toBe(true);
        });

        const call = mockChatRecordingService.recordToolResult.mock.calls.find(
          (call: unknown[]) =>
            (call[1] as { callId?: string } | undefined)?.callId ===
            'call-notified',
        )!;
        expect(call[2]).toBeUndefined();
      });

      it('does not stamp a cron turn with a permit inherited by lineage', async () => {
        // `#drainCronQueue()` is fired from inside Goal-turn code paths (the
        // turn settle's `finally`, among others), so a cron item can drain
        // while a Goal permit is live in the store. A cron turn is never a
        // Goal turn: its tool results must record unstamped, exactly like
        // the notification turn above.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-stale-cron',
        };
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockToolRegistry.getTool.mockImplementation((name: string) => ({
          name,
          displayName: name,
          kind: core.Kind.Read,
          schema: { name, description: name, parameters: {} },
          validateToolParams: vi.fn().mockReturnValue(null),
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getDescription: vi.fn().mockReturnValue(name),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: vi
            .fn()
            .mockResolvedValue({ llmContent: 'ok', returnDisplay: 'ok' }),
        }));
        let fireCron!: (job: { prompt: string; cronExpr: string }) => void;
        const scheduler = {
          hasPendingWork: true,
          enableDurable: vi.fn().mockResolvedValue(undefined),
          start: vi.fn(
            (callback: (job: { prompt: string; cronExpr: string }) => void) => {
              fireCron = callback;
            },
          ),
          stop: vi.fn(),
          list: vi.fn().mockReturnValue([]),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        session.startCronScheduler();
        await vi.waitFor(() => expect(scheduler.start).toHaveBeenCalled());
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    { id: 'call-cron', name: 'read_file', args: {} },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValue(createEmptyStream());

        // Fire from inside a Goal turn's store, as a drain triggered from a
        // Goal-turn code path would be.
        core.goalTurnContext.run(permit, () =>
          fireCron({ prompt: 'cron work', cronExpr: '* * * * *' }),
        );
        await vi.waitFor(() => {
          expect(
            mockChatRecordingService.recordToolResult.mock.calls.some(
              (call: unknown[]) =>
                (call[1] as { callId?: string } | undefined)?.callId ===
                'call-cron',
            ),
          ).toBe(true);
        });

        const call = mockChatRecordingService.recordToolResult.mock.calls.find(
          (call: unknown[]) =>
            (call[1] as { callId?: string } | undefined)?.callId ===
            'call-cron',
        )!;
        expect(call[2]).toBeUndefined();
      });

      it('runs a host-scheduled Goal turn with the canonical permit', async () => {
        const recordOrder: string[] = [];
        mockChatRecordingService.recordSessionApprovalMode.mockImplementationOnce(
          async () => {
            recordOrder.push('approval');
            return true;
          },
        );
        mockChatRecordingService.recordGoalRuntimeMessage.mockImplementationOnce(
          () => {
            recordOrder.push('goal');
          },
        );
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-1',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
          turnKey === 'goal-runtime:turn-1' ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        expect(boundGoalHost).toBeDefined();
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
          objectiveUpdated: true,
          windDown: true,
          verifierFeedback: 'Need independent evidence',
        });

        await vi.waitFor(() => {
          expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
        });
        expect(mockChat.sendMessageStream).toHaveBeenCalledWith(
          currentModel,
          expect.objectContaining({
            message: expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining(
                  'Continue working on the active Goal.',
                ),
              }),
              expect.objectContaining({
                text: expect.stringContaining(
                  '<goal_runtime_data>\n{"goalId":"goal-1","revision":1,"objective":"check weather"}\n</goal_runtime_data>',
                ),
              }),
              expect.objectContaining({
                text: expect.stringContaining(
                  'contains no new real user input',
                ),
              }),
              expect.objectContaining({
                text: expect.stringContaining(
                  'not evidence that the user supplied it',
                ),
              }),
              expect.objectContaining({
                text: expect.stringContaining(
                  'The Goal objective changed since your last turn',
                ),
              }),
              expect.objectContaining({
                text: expect.stringContaining(
                  'An autonomous budget for this Goal window is spent',
                ),
              }),
              expect.objectContaining({
                text: expect.stringContaining(
                  'Verifier feedback: Need independent evidence',
                ),
              }),
            ]),
          }),
          expect.any(String),
          permit,
          undefined,
        );
        expect(mockGoalRuntime.markTurnDelivered).toHaveBeenCalledWith(
          'goal-runtime:turn-1',
        );
        expect(
          mockChatRecordingService.recordGoalRuntimeMessage,
        ).toHaveBeenCalledWith(expect.any(Array), permit);
        expect(recordOrder.slice(0, 2)).toEqual(['approval', 'goal']);
        expect(
          mockChatRecordingService.recordUserMessage,
        ).not.toHaveBeenCalled();
        expect(
          mockChatRecordingService.recordBranchCheckpointTransaction,
        ).not.toHaveBeenCalled();
      });

      it('notifies the bridge that the Goal turn ended', async () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-end-signal',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
          turnKey === 'goal-runtime:turn-end-signal' ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        expect(boundGoalHost).toBeDefined();
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(mockClient.extNotification).toHaveBeenCalledWith(
            '_qwencode/end_turn',
            {
              sessionId: 'test-session-id',
              reason: 'end_turn',
              source: 'goal',
              promptId: expect.stringMatching(
                /^test-session-id########\d+$/,
              ) as unknown as string,
            },
          );
        });
        expect(mockClient.extNotification).toHaveBeenCalledWith(
          '_qwencode/start_turn',
          {
            sessionId: 'test-session-id',
            source: 'goal',
          },
        );
      });

      it('carries the spend figures into the continuation prompt', async () => {
        // `usage` is optional on both sides of the host hop, so a dropped
        // copy typechecks and shows up only as a prompt that lost its budget
        // line on this host.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-usage',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 4,
            activeTimeMs: 0,
            tokensUsed: 1_234,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
          turnKey === 'goal-runtime:turn-usage' ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        expect(boundGoalHost).toBeDefined();
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
          usage: { tokensUsed: 1_234, tokenBudget: 30_000_000, turnCount: 4 },
        });

        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalled();
        });
        const request = (mockChat.sendMessageStream as ReturnType<typeof vi.fn>)
          .mock.calls[0]?.[1] as { message: Array<Record<string, unknown>> };
        expect(
          request.message.some(
            (part) =>
              typeof part['text'] === 'string' &&
              (part['text'] as string).includes(
                'Budget: 1,234 of 30,000,000 tokens used, 29,998,766 remaining; 4 Goal turns finished.',
              ),
          ),
        ).toBe(true);
      });

      it('settles a Goal turn whose prompt rejects before the turn body runs', async () => {
        // `prompt()` rejects ahead of the try whose finally settles the turn
        // when `assertCanStartTurn` throws — a session that began closing
        // mid-await, or a writer lease that went away. The turn is already
        // shifted off `goalQueue` by then, so unless the drain's own catch
        // settles it the runtime keeps `currentPermit` and stays 'running'
        // forever: no continuation is ever scheduled again, and every later
        // prompt hangs in `claimGoalTurn` behind the leaked permit.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-admission-rejects',
        };
        const turnKey = 'goal-runtime:turn-admission-rejects';
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key === turnKey ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());
        vi.mocked(mockConfig.assertCanStartTurn).mockRejectedValueOnce(
          new Error('Session write ownership could not be verified.'),
        );

        expect(boundGoalHost).toBeDefined();
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        // `releaseTurn`, not `finishTurn`: the turn never reached the model,
        // so it is not an iteration the Goal made progress on.
        await vi.waitFor(() => {
          expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(turnKey);
        });
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
      });

      describe('on the shared agent loop round', () => {
        const activeGoalSnapshot = (activity: 'idle' | 'running') => ({
          v: 2,
          activity,
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });

        let admitUserPrompt = vi.fn();

        /** Runs each round on the mocked client; a round pushes its request unless told not to. */
        function sharedRounds(
          events: (index: number) => unknown[] = () => [],
          pushes = true,
        ) {
          const sends: Array<
            [Part[], AbortSignal, string, Record<string, unknown>]
          > = [];
          let pushCount = 0;
          mockConfig.isUnifiedAgentLoopEnabled = vi.fn().mockReturnValue(true);
          Object.assign(mockChat, {
            getUserContentPushCount: vi.fn(() => pushCount),
          });
          admitUserPrompt = vi.fn().mockResolvedValue({ blocked: false });
          Object.assign(mockLlmClient, {
            admitUserPrompt,
            sendMessageStream: vi.fn(
              (
                parts: Part[],
                signal: AbortSignal,
                promptId: string,
                options: Record<string, unknown>,
              ) => {
                sends.push([parts, signal, promptId, options]);
                const index = sends.length - 1;
                return (async function* () {
                  if (pushes) pushCount++;
                  for (const event of events(index)) {
                    if (event instanceof Error) throw event;
                    yield event;
                  }
                })();
              },
            ),
          });
          mockChat.sendMessageStream = vi.fn();
          return sends;
        }

        it('runs a runtime continuation as a Goal round under its permit', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-shared',
          };
          const turnKey = 'goal-runtime:turn-shared';
          mockGoalRuntime.getSnapshot.mockReturnValue(
            activeGoalSnapshot('running'),
          );
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          const sends = sharedRounds(() => [
            { type: core.LlmEventType.Content, value: 'checked' },
          ]);

          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'check weather',
          });

          await vi.waitFor(() => {
            expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
          });
          expect(sends).toHaveLength(1);
          expect(sends[0][0]).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining(
                  'Continue working on the active Goal.',
                ),
              }),
            ]),
          );
          expect(sends[0][3]).toMatchObject({
            type: core.SendMessageType.Goal,
            goalPermit: permit,
            goalTurnKey: turnKey,
            goalOrigin: 'runtime',
            userTurnRecordedByHost: true,
          });
          // The round's own signal: a cut or a cancel is left to the session.
          expect(sends[0][3]['goalSignal']).toBe(sends[0][1]);
          expect(admitUserPrompt).not.toHaveBeenCalled();
          expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
          expect(
            mockChatRecordingService.recordGoalRuntimeMessage,
          ).toHaveBeenCalledExactlyOnceWith(expect.any(Array), permit);
          expect(mockGoalRuntime.markTurnDelivered).toHaveBeenCalledWith(
            turnKey,
          );
          expect(mockGoalRuntime.releaseTurn).not.toHaveBeenCalled();
        });

        it('runs a user prompt in a Goal turn as a UserQuery under its permit', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'user-turn-shared',
          };
          mockGoalRuntime.getSnapshot.mockReturnValue(
            activeGoalSnapshot('idle'),
          );
          mockGoalRuntime.beginTurn.mockReturnValue(permit);
          mockGoalRuntime.permitForTurn.mockReturnValue(permit);
          const sends = sharedRounds();

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(admitUserPrompt).toHaveBeenCalledOnce();
          expect(sends).toHaveLength(1);
          expect(sends[0][3]).toMatchObject({
            type: core.SendMessageType.UserQuery,
            goalPermit: permit,
            goalTurnKey: expect.stringMatching(/^goal-user:/),
            goalOrigin: 'user',
            userTurnRecordedByHost: true,
          });
          expect(
            mockChatRecordingService.recordUserMessage,
          ).toHaveBeenCalledWith(
            'hello',
            permit,
            undefined,
            expect.stringContaining('test-session-id########'),
            undefined,
          );
          expect(mockGoalRuntime.markTurnDelivered).not.toHaveBeenCalled();
          expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
        });

        it('runs the memory tasks the client skips when it finishes a user Goal turn', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'user-turn-memory',
          };
          mockGoalRuntime.getSnapshot.mockReturnValue(
            activeGoalSnapshot('idle'),
          );
          mockGoalRuntime.beginTurn.mockReturnValue(permit);
          mockGoalRuntime.permitForTurn.mockReturnValue(permit);
          sharedRounds(() => [
            { type: core.LlmEventType.Content, value: 'done' },
          ]);

          await expect(
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'hello' }],
            }),
          ).resolves.toEqual({ stopReason: 'end_turn' });

          expect(mockLlmClient.captureCacheSafeParams).toHaveBeenCalled();
          expect(
            mockLlmClient.runManagedAutoMemoryBackgroundTasks,
          ).toHaveBeenCalledExactlyOnceWith(core.SendMessageType.UserQuery);
        });

        it('marks a continuation delivered at its stop when no model event follows the request', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-silent',
          };
          const turnKey = 'goal-runtime:turn-silent';
          mockGoalRuntime.getSnapshot.mockReturnValue(
            activeGoalSnapshot('running'),
          );
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          const sends = sharedRounds();
          let deliveredAtStop: number | undefined;
          const send = (
            mockLlmClient as unknown as {
              sendMessageStream: ReturnType<typeof vi.fn>;
            }
          ).sendMessageStream;
          const pushOnly = send.getMockImplementation()!;
          send.mockImplementation(
            (
              parts: Part[],
              signal: AbortSignal,
              promptId: string,
              options: Record<string, unknown>,
            ) => {
              const inner = pushOnly(parts, signal, promptId, options);
              return (async function* () {
                yield* inner;
                // The client runs its stop policies, then finishes the turn.
                const [policy] = options['stopPolicies'] as Array<{
                  continueAt: (stop: {
                    promptId: string;
                    signal: AbortSignal;
                  }) => Promise<unknown>;
                }>;
                await policy.continueAt({ promptId, signal });
                deliveredAtStop =
                  mockGoalRuntime.markTurnDelivered.mock.calls.length;
              })();
            },
          );

          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'check weather',
          });

          await vi.waitFor(() => {
            expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
          });
          expect(sends).toHaveLength(1);
          expect(deliveredAtStop).toBe(1);
          expect(
            mockGoalRuntime.markTurnDelivered,
          ).toHaveBeenCalledExactlyOnceWith(turnKey);
        });

        it('names the pause the client takes when a Goal round fails or hits the Stop hook cap', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'user-turn-reasons',
          };
          mockGoalRuntime.getSnapshot.mockReturnValue(
            activeGoalSnapshot('idle'),
          );
          mockGoalRuntime.beginTurn.mockReturnValue(permit);
          mockGoalRuntime.permitForTurn.mockReturnValue(permit);
          const sends = sharedRounds();

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const reason = sends[0][3][
            'getInterruptedGoalPauseReason'
          ] as (interruption?: {
            failure?: string;
            cause?: 'stop-hook-cap';
          }) => string;
          expect(reason({ cause: 'stop-hook-cap' })).toBe(
            core.GOAL_PAUSE_REASON_STOP_HOOK_CAP,
          );
          expect(reason({ failure: 'upstream 500' })).toBe(
            core.goalPauseReasonForFailure('upstream 500'),
          );
          mockConfig.getManagedSessionBlock = vi
            .fn()
            .mockReturnValue({ reason: 'blocked' });
          expect(reason({ failure: 'upstream 500' })).toBe(
            core.GOAL_PAUSE_REASON_MANAGED_SESSION_BLOCKED,
          );
        });

        it('pauses the Goal when loop protection ends its turn', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-loop',
          };
          const turnKey = 'goal-runtime:turn-loop';
          mockGoalRuntime.getSnapshot.mockReturnValue(
            activeGoalSnapshot('running'),
          );
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          sharedRounds(() => [{ type: core.LlmEventType.LoopDetected }]);

          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'check weather',
          });

          await vi.waitFor(() => {
            expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
              action: 'pause',
              expectedGoalId: 'goal-1',
              expectedRevision: 1,
              reason: core.goalPauseReasonForFailure('loop detected'),
            });
          });
          expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
        });

        it('hands back a runtime continuation whose request never went out', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-unsent',
          };
          const turnKey = 'goal-runtime:turn-unsent';
          mockGoalRuntime.getSnapshot.mockReturnValue(
            activeGoalSnapshot('running'),
          );
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          sharedRounds(() => [new Error('request setup failed')], false);

          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'check weather',
          });

          await vi.waitFor(() => {
            expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(turnKey);
          });
          expect(mockGoalRuntime.markTurnDelivered).not.toHaveBeenCalled();
          expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
        });
      });

      describe('in a blocked Managed session', () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-blocked',
        };
        const turnKey = 'goal-runtime:turn-blocked';
        const block = new ManagedRuntimeOutcomeUnknownError(
          'A cancelled Runtime tool call did not settle.',
        );

        beforeEach(() => {
          mockConfig.getManagedSessionBlock = vi.fn().mockReturnValue(block);
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          mockChat.sendMessageStream = vi.fn();
        });

        function goalSnapshot(status: 'active' | 'paused') {
          return {
            v: 2,
            activity: 'running',
            goal: {
              goalId: 'goal-1',
              revision: 1,
              objective: 'check weather',
              status,
              evidenceCursor: { recordId: 'cursor-1' },
              turnCount: 0,
              activeTimeMs: 0,
              tokensUsed: 0,
              createdAt: 1234,
              updatedAt: 1234,
            },
          };
        }

        // Every continuation is refused before the model, so handing the
        // permit back for another one would loop without end.
        it('pauses the Goal instead of queueing another continuation', async () => {
          mockGoalRuntime.getSnapshot.mockReturnValue(goalSnapshot('active'));

          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'check weather',
          });

          await vi.waitFor(() =>
            expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
              action: 'pause',
              expectedGoalId: 'goal-1',
              expectedRevision: 1,
              reason: core.GOAL_PAUSE_REASON_MANAGED_SESSION_BLOCKED,
            }),
          );
          expect(mockGoalRuntime.releaseTurn).not.toHaveBeenCalled();
          expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        });

        it('names the block when the turn that met it pauses the Goal', async () => {
          // The turn reached the model before the session was blocked.
          mockConfig.getManagedSessionBlock = vi
            .fn()
            .mockReturnValueOnce(undefined)
            .mockReturnValue(block);
          mockGoalRuntime.getSnapshot.mockReturnValue(goalSnapshot('active'));
          mockChat.sendMessageStream = vi
            .fn()
            .mockRejectedValue(new Error(block.message));

          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'check weather',
          });

          await vi.waitFor(() =>
            expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
              action: 'pause',
              expectedGoalId: 'goal-1',
              expectedRevision: 1,
              reason: core.GOAL_PAUSE_REASON_MANAGED_SESSION_BLOCKED,
            }),
          );
          expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
        });

        it.each([
          [
            'a pause it could not record',
            () => {
              mockGoalRuntime.getSnapshot.mockReturnValue(
                goalSnapshot('active'),
              );
              mockGoalRuntime.dispatch.mockRejectedValueOnce(
                new Error('write failed'),
              );
            },
          ],
          [
            'a Goal no longer active',
            () =>
              mockGoalRuntime.getSnapshot.mockReturnValue(
                goalSnapshot('paused'),
              ),
          ],
        ])('queues no continuation after %s', async (_case, arrange) => {
          arrange();

          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'check weather',
          });

          await vi.waitFor(() =>
            expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(turnKey, {
              requeue: false,
            }),
          );
          expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledOnce();
          expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        });
      });

      it('keeps a Goal turn graceful when loop protection stops it', async () => {
        // Goal continuations are non-interactive and bypass the bridge: a
        // rejection would settle the turn as failed and pause the goal
        // with no turn_error ever published. They resolve end_turn like
        // cron and channel turns, settling the iteration normally.
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockConfig.getMaxToolCallsPerTurn = vi.fn().mockReturnValue(1);
        mockConfig.isMaxToolCallsPerTurnExplicit = vi
          .fn()
          .mockReturnValue(true);
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-loop-cap',
        };
        const turnKey = 'goal-runtime:turn-loop-cap';
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key === turnKey ? permit : undefined,
        );
        mockChat.sendMessageStream = vi.fn().mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'goal-loop-1',
                    name: 'read_file',
                    args: { file_path: 'a.ts' },
                  },
                  {
                    id: 'goal-loop-2',
                    name: 'read_file',
                    args: { file_path: 'b.ts' },
                  },
                ],
              },
            },
          ]),
        );

        expect(boundGoalHost).toBeDefined();
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(logLoopDetectedSpy).toHaveBeenCalledWith(
            mockConfig,
            expect.objectContaining({
              loop_type: core.LoopType.TURN_TOOL_CALL_CAP,
            }),
            {},
          );
        });
        // Graceful end_turn settles the iteration; the goal is not paused.
        await vi.waitFor(() => {
          expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
        });
        expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      });

      it('keeps a Goal turn graceful when the repeated-failure guard stops it', async () => {
        // Goal turns keep the configured guard mode (they are not channel
        // turns) but get rejectOnLoopDetected=false, so an enforce-mode
        // failure streak stops them through the graceful branch: end_turn
        // settlement plus the transcript stop message, never a rejection
        // that would pause the goal without a published turn_error.
        const guardModeEnv = 'QWEN_CODE_ACP_REPEATED_TOOL_FAILURE_GUARD';
        const previousGuardMode = process.env[guardModeEnv];
        process.env[guardModeEnv] = 'enforce';
        try {
          session = new Session(
            'test-session-id',
            mockConfig,
            mockClient,
            mockSettings,
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
          const execute = vi.fn().mockResolvedValue({
            llmContent: 'failed',
            returnDisplay: 'failed',
            error: {
              message: 'execution failed',
              type: core.ToolErrorType.EXECUTION_FAILED,
            },
          });
          mockToolRegistry.getTool.mockReturnValue({
            name: 'failing_tool',
            kind: core.Kind.Execute,
            displayName: 'Failing Tool',
            description: 'Fails during execution',
            build: vi.fn().mockReturnValue({
              params: {},
              execute,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue('Failing Tool'),
              toolLocations: vi.fn().mockReturnValue([]),
            }),
            canUpdateOutput: false,
            isOutputMarkdown: true,
          });
          const streamForBatch = (batch: number, count: number) =>
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: Array.from({ length: count }, (_, index) => ({
                    id: `goal_failure_${batch}_${index}`,
                    name: 'failing_tool',
                    args: { attempt: `${batch}_${index}` },
                  })),
                },
              },
            ]);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(streamForBatch(1, 4))
            .mockResolvedValueOnce(streamForBatch(2, 4))
            .mockResolvedValueOnce(streamForBatch(3, 1))
            .mockResolvedValueOnce(createEmptyStream());

          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-guard-stop',
          };
          const turnKey = 'goal-runtime:turn-guard-stop';
          mockGoalRuntime.getSnapshot.mockReturnValue({
            v: 2,
            activity: 'running',
            goal: {
              goalId: 'goal-1',
              revision: 1,
              objective: 'check weather',
              status: 'active',
              evidenceCursor: { recordId: 'cursor-1' },
              turnCount: 0,
              activeTimeMs: 0,
              tokensUsed: 0,
              createdAt: 1234,
              updatedAt: 1234,
            },
          });
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );

          expect(boundGoalHost).toBeDefined();
          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'check weather',
          });

          await vi.waitFor(() => {
            expect(logLoopDetectedSpy).toHaveBeenCalledWith(
              mockConfig,
              expect.objectContaining({
                loop_type: core.LoopType.REPEATED_TOOL_EXECUTION_FAILURE,
              }),
              { recordToQwenLogger: false },
            );
          });
          // Graceful end_turn settles the iteration; the goal is not paused.
          await vi.waitFor(() => {
            expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
          });
          expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
          // The graceful stop keeps the user-visible stop message: it is
          // the only explanation of a silently stopped autonomous turn.
          expect(
            vi.mocked(mockClient.sessionUpdate).mock.calls.some(([params]) => {
              const update = params.update;
              return (
                update.sessionUpdate === 'agent_message_chunk' &&
                update.content.type === 'text' &&
                update.content.text.includes('Automatic continuation stopped')
              );
            }),
          ).toBe(true);
        } finally {
          if (previousGuardMode === undefined) {
            delete process.env[guardModeEnv];
          } else {
            process.env[guardModeEnv] = previousGuardMode;
          }
        }
      });

      describe('a tool that ends the turn', () => {
        const activeGoalSnapshot = {
          v: 2 as const,
          activity: 'running' as const,
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'write a poem',
            status: 'active' as const,
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        };

        /**
         * Mocks every tool as an allowed read, with `update_goal` alone
         * reporting that it wants the turn to end -- the shape
         * `UpdateGoalTool` returns when verification or checkpointing needs a
         * turn boundary.
         */
        const mockToolsWithTerminatingUpdateGoal = (
          updateGoalTerminates = true,
          missingToolNames: readonly string[] = [],
        ) => {
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          mockToolRegistry.getTool.mockImplementation((name: string) =>
            missingToolNames.includes(name)
              ? undefined
              : {
                  name,
                  displayName: name,
                  kind: core.Kind.Read,
                  build: vi.fn().mockReturnValue({
                    params: {},
                    getDefaultPermission: vi.fn().mockResolvedValue('allow'),
                    getDescription: vi.fn().mockReturnValue(name),
                    toolLocations: vi.fn().mockReturnValue([]),
                    execute: vi.fn().mockResolvedValue(
                      name === 'update_goal'
                        ? {
                            llmContent: '{"proposalRecorded":true}',
                            returnDisplay: 'Proposal queued for verification',
                            ...(updateGoalTerminates
                              ? { terminateTurn: true }
                              : {}),
                          }
                        : { llmContent: 'ok', returnDisplay: 'ok' },
                    ),
                  }),
                },
          );
        };

        const streamCalling = (...calls: Array<{ id: string; name: string }>) =>
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: calls.map((call) => ({ ...call, args: {} })),
              },
            },
          ]);

        it.each([false, true])(
          'ends a Goal turn without another model request (recording fails: %s)',
          async (recordingFails) => {
            // The proposal only reaches the verifier at a turn boundary, so a
            // continuation that keeps the turn alive parks it indefinitely:
            // the objective is already met, and the runtime refuses every
            // later proposal for the same turn.
            const permit: core.GoalTurnPermit = {
              goalId: 'goal-1',
              revision: 1,
              turnId: 'turn-terminating-tool',
            };
            const turnKey = 'goal-runtime:turn-terminating-tool';
            mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
            mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
              key === turnKey ? permit : undefined,
            );
            agentTelemetry.getActiveInteractionSpan.mockReturnValue(
              agentTelemetry.span,
            );
            mockToolsWithTerminatingUpdateGoal();
            if (recordingFails) {
              let writeFailed = false;
              mockChatRecordingService.recordGoalTurnEnd.mockImplementation(
                async () => {
                  writeFailed = true;
                  throw new Error('writer failed');
                },
              );
              mockGoalRuntime.finishTurn.mockImplementation(async () => {
                if (writeFailed) throw new Error('writer failed');
              });
            }
            mockChat.sendMessageStream = vi
              .fn()
              .mockResolvedValueOnce(
                streamCalling({ id: 'call-update', name: 'update_goal' }),
              )
              .mockResolvedValue(createEmptyStream());

            expect(boundGoalHost).toBeDefined();
            await boundGoalHost!.startGoalTurn({
              permit,
              continuationContext: 'write a poem',
            });

            await vi.waitFor(() => {
              expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
            });
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
            // Settled as a completed iteration, not paused as a failure.
            expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
            expect(mockGoalRuntime.releaseTurn).not.toHaveBeenCalled();
            // The turn ends, but its own tool response still has to reach the
            // transcript, or the next request carries a call with no result.
            expect(mockChat.addHistory).toHaveBeenCalledWith({
              role: 'user',
              parts: expect.arrayContaining([
                expect.objectContaining({
                  functionResponse: expect.objectContaining({
                    id: 'call-update',
                  }) as unknown,
                }),
              ]) as unknown,
            });
            expect(mockClient.extNotification).toHaveBeenCalledWith(
              '_qwencode/end_turn',
              expect.objectContaining({ reason: 'end_turn', source: 'goal' }),
            );
            expect(
              agentTelemetry.captures[0]?.writeToSpan,
            ).toHaveBeenCalledWith(agentTelemetry.span);
            expect(
              mockChatRecordingService.recordGoalTurnEnd,
            ).toHaveBeenCalledWith('call-update', permit);
            const history = vi
              .mocked(mockChat.addHistory)
              .mock.calls.map(([entry]) => entry);
            vi.mocked(mockChat.getHistory).mockReturnValue(history);
            expect(session.getRecoveryStatus()).toEqual({
              kind: recordingFails ? 'interrupted_prompt' : 'clean',
              canContinue: recordingFails,
            });
            expect(
              mockChatRecordingService.recordGoalRuntimeMessage,
            ).toHaveBeenCalledTimes(1);
            history.push({
              role: 'user',
              parts: [{ text: 'new unanswered request' }],
            });
            expect(session.getRecoveryStatus()).toEqual({
              kind: 'interrupted_prompt',
              canContinue: true,
            });
          },
        );

        it('does not record a clean boundary when cancellation arrives during tool-result rewriting', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'cancelled-tool-end',
          };
          const turnKey = `goal-runtime:${permit.turnId}`;
          mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          mockToolsWithTerminatingUpdateGoal();
          let releaseRewrite!: () => void;
          const waitForPendingRewrites = vi.fn(
            () =>
              new Promise<void>((resolve) => {
                releaseRewrite = resolve;
              }),
          );
          session.messageRewriter = {
            interceptUpdate: vi.fn().mockResolvedValue(undefined),
            flushTurn: vi.fn().mockResolvedValue(undefined),
            waitForPendingRewrites,
          } as unknown as Session['messageRewriter'];
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              streamCalling({ id: 'call-update', name: 'update_goal' }),
            );
          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'finish the goal',
          });
          await vi.waitFor(() =>
            expect(waitForPendingRewrites).toHaveBeenCalled(),
          );
          await session.cancelPendingPrompt();
          releaseRewrite();
          await vi.waitFor(() =>
            expect(mockClient.extNotification).toHaveBeenCalledWith(
              '_qwencode/end_turn',
              expect.objectContaining({ reason: 'cancelled', source: 'goal' }),
            ),
          );
          expect(
            mockChatRecordingService.recordGoalTurnEnd,
          ).not.toHaveBeenCalled();
          expect(mockChat.setCompletedToolCallIds).not.toHaveBeenCalled();
          expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
          vi.mocked(mockChat.getHistory).mockReturnValue(
            vi.mocked(mockChat.addHistory).mock.calls.map(([entry]) => entry),
          );
          expect(session.getRecoveryStatus()).toEqual({
            kind: 'interrupted_prompt',
            canContinue: true,
          });
        });

        it('does not record a clean boundary when cancellation arrives during settlement flush', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'cancelled-during-flush',
          };
          const turnKey = `goal-runtime:${permit.turnId}`;
          mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          mockToolsWithTerminatingUpdateGoal();
          const settlement = session as unknown as {
            pendingPrompt: AbortController | null;
            activeGoalTurn?: {
              controller: AbortController;
              endingToolCallId?: string;
            };
          };
          let releaseFlush: (() => void) | undefined;
          mockChatRecordingService.flush.mockImplementation(async () => {
            if (
              settlement.activeGoalTurn?.endingToolCallId &&
              !settlement.pendingPrompt
            ) {
              await new Promise<void>((resolve) => {
                releaseFlush = resolve;
              });
            }
          });
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              streamCalling({ id: 'call-update', name: 'update_goal' }),
            );

          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'finish the goal',
          });
          await vi.waitFor(() => expect(releaseFlush).toBeDefined());
          settlement.activeGoalTurn!.controller.abort('qwen:user-cancel');
          releaseFlush!();
          await vi.waitFor(() =>
            expect(mockClient.extNotification).toHaveBeenCalledWith(
              '_qwencode/end_turn',
              expect.objectContaining({ reason: 'end_turn', source: 'goal' }),
            ),
          );
          expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
          expect(
            mockChatRecordingService.recordGoalTurnEnd,
          ).not.toHaveBeenCalled();
          expect(mockChat.setCompletedToolCallIds).not.toHaveBeenCalled();
        });

        it('runs managed memory effects after an early Goal turn end', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-user-terminating-tool',
          };
          mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
          mockGoalRuntime.beginTurn.mockReturnValue(permit);
          mockGoalRuntime.permitForTurn.mockReturnValue(permit);
          mockToolsWithTerminatingUpdateGoal();
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              streamCalling({ id: 'call-update', name: 'update_goal' }),
            );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'finish the goal' }],
          });

          expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
          expect(mockMemoryManager.scheduleExtract).toHaveBeenCalledOnce();
          expect(mockMemoryManager.scheduleDream).toHaveBeenCalledOnce();
        });

        it('waits for a requested delivery final without a channel marker', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-channel-terminating-tool',
          };
          mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
          mockGoalRuntime.beginTurn.mockReturnValue(permit);
          mockGoalRuntime.permitForTurn.mockReturnValue(permit);
          mockToolsWithTerminatingUpdateGoal();
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              streamCalling({ id: 'call-update', name: 'update_goal' }),
            )
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    candidates: [
                      {
                        content: { parts: [{ text: 'final answer' }] },
                        finishReason: 'STOP',
                      },
                    ],
                  },
                },
              ]),
            );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'finish the goal' }],
            _meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'goal-channel-final',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
          });

          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          await vi.waitFor(() => {
            expect(mockClient.extMethod).toHaveBeenCalledWith(
              'qwen/control/channel-delivery',
              expect.objectContaining({
                deliveryId: 'goal-channel-final',
                text: 'final answer',
              }),
            );
          });
        });

        it('waits for a channel final without delivery metadata', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-channel-prompt-terminating-tool',
          };
          mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
          mockGoalRuntime.beginTurn.mockReturnValue(permit);
          mockGoalRuntime.permitForTurn.mockReturnValue(permit);
          mockToolsWithTerminatingUpdateGoal();
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              streamCalling({ id: 'call-update', name: 'update_goal' }),
            )
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    candidates: [
                      {
                        content: { parts: [{ text: 'channel final' }] },
                        finishReason: 'STOP',
                      },
                    ],
                  },
                },
              ]),
            );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'finish the goal' }],
            _meta: { 'qwen.channel.prompt': true },
          });

          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
            expect.objectContaining({
              update: expect.objectContaining({
                content: expect.objectContaining({ text: 'channel final' }),
              }) as unknown,
            }),
          );
        });

        it('lets loop protection override a terminating Goal tool', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-terminating-tool-loop',
          };
          const turnKey = 'goal-runtime:turn-terminating-tool-loop';
          mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          mockToolsWithTerminatingUpdateGoal(true, ['missing_tool']);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              streamCalling(
                { id: 'call-update', name: 'update_goal' },
                { id: 'call-missing-1', name: 'missing_tool' },
                { id: 'call-missing-2', name: 'missing_tool' },
                { id: 'call-missing-3', name: 'missing_tool' },
              ),
            );

          expect(boundGoalHost).toBeDefined();
          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'write a poem',
          });

          await vi.waitFor(() => {
            expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
          });
          const preservedText = vi
            .mocked(mockChat.addHistory)
            .mock.calls.flatMap(([message]) => message.parts ?? [])
            .flatMap((part) => (part.text ? [part.text] : []));
          expect(preservedText).toContain(
            'System: this turn was terminated because the model exceeded tool-call safety limits. Try a different approach on the next turn.',
          );
        });

        it('keeps a Goal turn running when no tool asked to end it', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-open-proposal',
          };
          const turnKey = 'goal-runtime:turn-open-proposal';
          mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          mockToolsWithTerminatingUpdateGoal(false);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              streamCalling({ id: 'call-update', name: 'update_goal' }),
            )
            .mockResolvedValue(createEmptyStream());

          expect(boundGoalHost).toBeDefined();
          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'write a poem',
          });

          await vi.waitFor(() => {
            expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
          });
          // An audit-only proposal keeps the turn going: the model is meant
          // to carry on until it stops on its own.
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        });

        it('ends a Goal turn on the last call of a multi-call batch', async () => {
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-terminating-batch',
          };
          const turnKey = 'goal-runtime:turn-terminating-batch';
          mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          mockToolsWithTerminatingUpdateGoal();
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              streamCalling(
                { id: 'call-read', name: 'read_file' },
                { id: 'call-update', name: 'update_goal' },
              ),
            )
            .mockResolvedValue(createEmptyStream());

          expect(boundGoalHost).toBeDefined();
          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'write a poem',
          });

          await vi.waitFor(() => {
            expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
          });
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          // Every call in the batch keeps its response, not just the one
          // that ended the turn: a preserved batch missing a response
          // leaves the transcript unusable for the next request.
          const preserved = vi
            .mocked(mockChat.addHistory)
            .mock.calls.map(([message]) => message)
            .find((message) =>
              (message as Content)?.parts?.some(
                (part) =>
                  (part as { functionResponse?: { id?: string } })
                    .functionResponse?.id === 'call-update',
              ),
            ) as Content;
          expect(preserved).toBeDefined();
          expect(
            preserved.parts?.map(
              (part) =>
                (part as { functionResponse?: { id?: string } })
                  .functionResponse?.id,
            ),
          ).toEqual(expect.arrayContaining(['call-read', 'call-update']));
        });

        it('ends a Goal turn from inside a Stop hook continuation', async () => {
          // A blocking Stop hook runs its continuation on a second loop that
          // executes tools of its own, so the Goal tools are reachable from
          // there too -- and a turn parked there is parked just as hard.
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 1,
            turnId: 'turn-stop-hook',
          };
          const turnKey = 'goal-runtime:turn-stop-hook';
          mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
          mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
            key === turnKey ? permit : undefined,
          );
          mockToolsWithTerminatingUpdateGoal();
          let stopCalls = 0;
          mockConfig.getMessageBus = vi.fn().mockReturnValue({
            request: vi.fn().mockImplementation(async (request) => {
              if (request.eventName !== 'Stop') {
                return { success: true, output: {} };
              }
              stopCalls++;
              return stopCalls === 1
                ? {
                    success: true,
                    output: { decision: 'block', reason: 'keep going' },
                  }
                : { success: true, output: {} };
            }),
          });
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((name: string) => name === 'Stop');
          mockChat.sendMessageStream = vi
            .fn()
            // The turn itself ends quietly, which is what fires the hook.
            .mockResolvedValueOnce(createEmptyStream())
            .mockResolvedValueOnce(
              streamCalling({ id: 'call-update', name: 'update_goal' }),
            )
            .mockResolvedValue(createEmptyStream());

          expect(boundGoalHost).toBeDefined();
          await boundGoalHost!.startGoalTurn({
            permit,
            continuationContext: 'write a poem',
          });

          await vi.waitFor(() => {
            expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
          });
          // The turn's own request plus the hook's continuation, and no
          // third request carrying the Goal tool's result back.
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
        });

        it.each([
          {
            route: 'channel prompt',
            meta: { 'qwen.channel.prompt': true },
          },
          {
            route: 'requested delivery',
            meta: {
              'qwen.daemon.channelDelivery': {
                deliveryId: 'goal-channel-stop-hook',
                target: {
                  channelName: 'dingtalk',
                  type: 'user',
                  id: 'user-1',
                },
              },
            },
            deliveryId: 'goal-channel-stop-hook',
          },
        ])(
          'publishes a $route final after a Stop hook continuation ends a Goal turn',
          async ({ meta, deliveryId }) => {
            const permit: core.GoalTurnPermit = {
              goalId: 'goal-1',
              revision: 1,
              turnId: `turn-channel-stop-hook-${deliveryId ?? 'prompt'}`,
            };
            mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
            mockGoalRuntime.beginTurn.mockReturnValue(permit);
            mockGoalRuntime.permitForTurn.mockReturnValue(permit);
            mockToolsWithTerminatingUpdateGoal();
            let stopCalls = 0;
            mockConfig.getMessageBus = vi.fn().mockReturnValue({
              request: vi.fn().mockImplementation(async (request) => {
                if (request.eventName !== 'Stop') {
                  return { success: true, output: {} };
                }
                stopCalls++;
                return stopCalls === 1
                  ? {
                      success: true,
                      output: { decision: 'block', reason: 'keep going' },
                    }
                  : { success: true, output: {} };
              }),
            });
            mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
            mockConfig.hasHooksForEvent = vi
              .fn()
              .mockImplementation((name: string) => name === 'Stop');
            mockChat.sendMessageStream = vi
              .fn()
              .mockResolvedValueOnce(createEmptyStream())
              .mockResolvedValueOnce(
                streamCalling({ id: 'call-update', name: 'update_goal' }),
              )
              .mockResolvedValueOnce(
                createStreamWithChunks([
                  {
                    type: core.StreamEventType.CHUNK,
                    value: {
                      candidates: [
                        {
                          content: { parts: [{ text: 'channel final' }] },
                          finishReason: 'STOP',
                        },
                      ],
                    },
                  },
                ]),
              );

            await session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'finish the goal' }],
              _meta: meta,
            });

            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
            if (deliveryId) {
              await vi.waitFor(() => {
                expect(mockClient.extMethod).toHaveBeenCalledWith(
                  'qwen/control/channel-delivery',
                  expect.objectContaining({
                    deliveryId,
                    text: 'channel final',
                  }),
                );
              });
            } else {
              expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
                expect.objectContaining({
                  update: expect.objectContaining({
                    content: expect.objectContaining({ text: 'channel final' }),
                  }) as unknown,
                }),
              );
            }
          },
        );

        it.each([
          ['before the Stop hook', false],
          ['after the Stop hook', true],
        ])(
          'ends a Goal turn from mid-turn input drained %s',
          async (_route, armAfterStopHook) => {
            session.dispose();
            (
              mockSettings as unknown as {
                merged: Record<string, unknown>;
              }
            ).merged = {
              experimental: { todoStopGuard: true },
              tools: { todoWrite: { enabled: true } },
            };
            mockConfig.getBareMode = vi.fn().mockReturnValue(false);
            mockConfig.isSafeMode = vi.fn().mockReturnValue(false);
            session = new Session(
              'test-session-id',
              mockConfig,
              mockClient,
              mockSettings,
            );

            const permit: core.GoalTurnPermit = {
              goalId: 'goal-1',
              revision: 1,
              turnId: `turn-mid-turn-drain-${armAfterStopHook ? 'after' : 'before'}`,
            };
            const turnKey = `goal-runtime:${permit.turnId}`;
            mockGoalRuntime.getSnapshot.mockReturnValue(activeGoalSnapshot);
            mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
              key === turnKey ? permit : undefined,
            );
            mockToolsWithTerminatingUpdateGoal();

            const internals = session as unknown as {
              todoStopGuard: {
                observeTodoWrite(
                  resultDisplay: unknown,
                  allowArm: boolean,
                ): boolean;
              };
            };
            const armGuard = () =>
              internals.todoStopGuard.observeTodoWrite(
                {
                  type: 'todo_list',
                  todos: [
                    {
                      id: 'task-1',
                      content: 'finish task',
                      status: 'pending',
                    },
                  ],
                },
                true,
              );

            if (armAfterStopHook) {
              mockConfig.getMessageBus = vi.fn().mockReturnValue({
                request: vi.fn().mockImplementation(async (request) => {
                  if (request.eventName === 'Stop') armGuard();
                  return { success: true, output: {} };
                }),
              });
              mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
              mockConfig.hasHooksForEvent = vi
                .fn()
                .mockImplementation((name: string) => name === 'Stop');
            } else {
              mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
            }

            mockClient.extMethod = vi.fn().mockImplementation(async () => ({
              messages: ['finish the goal'],
              hasQueuedPrompt: false,
            }));
            const firstStream = armAfterStopHook
              ? async () => createEmptyStream()
              : async () => {
                  armGuard();
                  return createEmptyStream();
                };
            mockChat.sendMessageStream = vi
              .fn()
              .mockImplementationOnce(firstStream)
              .mockResolvedValueOnce(
                streamCalling({ id: 'call-update', name: 'update_goal' }),
              )
              .mockRejectedValue(new Error('unexpected extra model request'));

            expect(boundGoalHost).toBeDefined();
            await boundGoalHost!.startGoalTurn({
              permit,
              continuationContext: 'write a poem',
            });

            await vi.waitFor(() => {
              expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
            });
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
            expect(mockClient.extMethod).toHaveBeenCalledWith(
              'craft/drainMidTurnQueue',
              {
                sessionId: 'test-session-id',
                todoStopGuardWatchQueuedPrompt: true,
              },
            );
          },
        );

        it('honours the flag outside a Goal turn too', async () => {
          // It was Goal-only when only `update_goal` set it. The workspace-Agent
          // closing tools set it as well now, and a hand-off makes later work in
          // the same physical turn stale for the same reason a Goal checkpoint
          // does — so `#endTurnAfterToolRun` no longer asks whether a Goal turn
          // is in flight. A flagged tool ends the turn wherever it runs; a tool
          // that does not set it keeps the ordinary loop, which the cases above
          // cover.
          mockGoalRuntime.getSnapshot.mockReturnValue({
            v: 2,
            activity: 'idle',
            goal: null,
          });
          mockToolsWithTerminatingUpdateGoal();
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              streamCalling({ id: 'call-update', name: 'update_goal' }),
            )
            .mockResolvedValue(createEmptyStream());

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'go' }],
          });

          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });
      });

      it('pauses without counting a Goal turn cancelled before the model request', async () => {
        // `modelStarted` decides whether settlement records an iteration.
        // A user cancel still pauses the Goal before that point; releasing
        // the permit would mint another continuation and ignore the cancel.
        // Flagging it at the top of the turn made everything between there
        // and the send — prompt assembly, transcript writes, the abort check
        // itself — count as model work, so a cancel landing in that window
        // paused the Goal and charged it a turn it never took.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-cancelled-early',
        };
        const turnKey = 'goal-runtime:turn-cancelled-early';
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key === turnKey ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());
        // The runtime transcript write is the last awaited step before the
        // turn reaches the model, which makes it the exact window this
        // finding is about.
        mockChatRecordingService.recordGoalRuntimeMessage.mockImplementation(
          () => {
            void session.cancelPendingPrompt();
          },
        );

        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
            action: 'pause',
            expectedGoalId: permit.goalId,
            expectedRevision: permit.revision,
            reason: GOAL_PAUSE_REASON_USER_INTERRUPT,
          });
        });
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
        expect(mockGoalRuntime.releaseTurn).not.toHaveBeenCalledWith(turnKey);
      });

      it('releases a pre-model Goal permit when recording its pause fails', async () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-close-write-failure',
        };
        const turnKey = 'goal-runtime:turn-close-write-failure';
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: permit.goalId,
            revision: permit.revision,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key === turnKey ? permit : undefined,
        );
        mockGoalRuntime.dispatch.mockRejectedValueOnce(
          new Error('write failed'),
        );
        let cancelClose: (() => void) | undefined;
        mockChatRecordingService.recordGoalRuntimeMessage.mockImplementation(
          () => {
            cancelClose = session.beginClose();
            void session.cancelPendingPrompt();
          },
        );

        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(turnKey, {
            requeue: false,
          });
        });
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
        cancelClose?.();
      });

      it('does not restart a failed Goal when recording its pause fails', async () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-provider-failure',
        };
        const turnKey = 'goal-runtime:turn-provider-failure';
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: permit.goalId,
            revision: permit.revision,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key === turnKey ? permit : undefined,
        );
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          (async function* () {
            yield* [];
            throw new Error('provider stream failed');
          })(),
        );
        mockGoalRuntime.dispatch.mockRejectedValueOnce(
          new Error('write failed'),
        );

        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
            action: 'pause',
            expectedGoalId: permit.goalId,
            expectedRevision: permit.revision,
            reason: goalPauseReasonForFailure('provider stream failed'),
          });
        });
        expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(turnKey, {
          requeue: false,
        });
        expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
      });

      it('does not restart a Goal when recording its session-token-limit pause fails', async () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-output-limit',
        };
        const turnKey = 'goal-runtime:turn-output-limit';
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: permit.goalId,
            revision: permit.revision,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key === turnKey ? permit : undefined,
        );
        mockConfig.getSessionTokenLimit = vi.fn().mockReturnValue(100);
        mockLlmClient.tryCompressChat.mockResolvedValue({
          originalTokenCount: 999,
          newTokenCount: 999,
          compressionStatus: core.CompressionStatus.NOOP,
        });
        mockGoalRuntime.dispatch.mockRejectedValueOnce(
          new Error('write failed'),
        );

        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
            action: 'pause',
            expectedGoalId: permit.goalId,
            expectedRevision: permit.revision,
            reason: GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT,
          });
        });
        expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(turnKey, {
          requeue: false,
        });
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      });

      it('does not restart a model-started Goal when recording session closure fails', async () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-session-close',
        };
        const turnKey = 'goal-runtime:turn-session-close';
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: permit.goalId,
            revision: permit.revision,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key === turnKey ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(
            async (
              _model: string,
              request: { config: { abortSignal: AbortSignal } },
            ) =>
              (async function* () {
                if (!request.config.abortSignal.aborted) {
                  await new Promise<void>((resolve) =>
                    request.config.abortSignal.addEventListener(
                      'abort',
                      () => resolve(),
                      { once: true },
                    ),
                  );
                }
                yield* [];
              })(),
          );
        mockGoalRuntime.dispatch.mockRejectedValueOnce(
          new Error('write failed'),
        );

        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
        });
        const cancelClose = session.beginClose();
        await session.cancelPendingPrompt();

        await vi.waitFor(() => {
          expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
            action: 'pause',
            expectedGoalId: permit.goalId,
            expectedRevision: permit.revision,
            reason: GOAL_PAUSE_REASON_SESSION_DISPOSED,
          });
        });
        expect(mockGoalRuntime.dispatch).not.toHaveBeenCalledWith(
          expect.objectContaining({
            reason: GOAL_PAUSE_REASON_USER_INTERRUPT,
          }),
        );
        expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(turnKey, {
          requeue: false,
        });
        cancelClose();
      });

      it('does not claim the session closed when a started close is abandoned', async () => {
        // A close can be abandoned -- a drain timeout or a failed flush
        // releases the gate and the session keeps serving -- so the reason
        // this stop records has to stay true in that outcome too.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-close-abandoned',
        };
        const turnKey = 'goal-runtime:turn-close-abandoned';
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: permit.goalId,
            revision: permit.revision,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key === turnKey ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(
            async (
              _model: string,
              request: { config: { abortSignal: AbortSignal } },
            ) =>
              (async function* () {
                if (!request.config.abortSignal.aborted) {
                  await new Promise<void>((resolve) =>
                    request.config.abortSignal.addEventListener(
                      'abort',
                      () => resolve(),
                      { once: true },
                    ),
                  );
                }
                yield* [];
              })(),
          );

        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
        });
        const cancelClose = session.beginClose();
        await session.cancelPendingPrompt();
        await vi.waitFor(() => {
          expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ action: 'pause' }),
          );
        });

        // The close is abandoned; the session is serving again.
        cancelClose();
        const reopen = session.beginClose();
        reopen();

        const pauseCall = mockGoalRuntime.dispatch.mock.calls.find(
          (call) => call[0].action === 'pause',
        ) as [{ reason?: string }];
        expect(pauseCall[0].reason).toBe(GOAL_PAUSE_REASON_SESSION_DISPOSED);
        // The session did not close, so the record must not say it did.
        expect(pauseCall[0].reason).not.toMatch(/^The session closed/);
      });

      it('records session closure for a Goal turn still waiting in the queue', async () => {
        // `beginClose` stops the queue draining but leaves what is already
        // queued, so this arm settles a turn that never reached the model.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-queued-close',
        };
        const turnKey = 'goal-runtime:turn-queued-close';
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: permit.goalId,
            revision: permit.revision,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key === turnKey ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        const cancelClose = session.beginClose();
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });
        await session.cancelPendingPrompt();

        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
        await vi.waitFor(() => {
          expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
            action: 'pause',
            expectedGoalId: permit.goalId,
            expectedRevision: permit.revision,
            reason: GOAL_PAUSE_REASON_SESSION_DISPOSED,
          });
        });
        expect(mockGoalRuntime.dispatch).not.toHaveBeenCalledWith(
          expect.objectContaining({
            reason: GOAL_PAUSE_REASON_USER_INTERRUPT,
          }),
        );
        cancelClose();
      });

      it('releases a claimed Goal permit when the prompt is cancelled in the claim window', async () => {
        // `claimGoalTurn` refuses an already-aborted signal, but the abort
        // can land in the microtask gap between it resolving with a permit
        // and the aborted check below it. The release there used to be
        // gated on `!goalTurn`, so on exactly that path the permit stayed
        // with a turn that returns `cancelled` without running — the runtime
        // never leaves `running` and every later Goal turn blocks on it.
        const userPermit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'user-turn-claimed',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((key: string) =>
          key.startsWith('goal-user:') ? userPermit : undefined,
        );
        // Called synchronously with the freshly claimed permit — the one
        // seam that lands inside the window rather than around it.
        mockGoalRuntime.getVerifierFeedback.mockImplementation(() => {
          void session.cancelPendingPrompt();
          return undefined;
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        const result = await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'user input' }],
        });

        expect(result.stopReason).toBe('cancelled');
        expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(
          expect.stringMatching(/^goal-user:/),
        );
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      });

      it('cleans up prompt admission when claiming a Goal permit fails', async () => {
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation(() => {
          throw new Error('goal runtime disposed');
        });
        mockGoalRuntime.releaseTurn.mockRejectedValueOnce(
          new Error('goal runtime disposed'),
        );
        const admission = new AbortController();
        const removeEventListener = vi.spyOn(
          admission.signal,
          'removeEventListener',
        );

        await expect(
          session.prompt(
            {
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'user input' }],
            },
            undefined,
            admission.signal,
          ),
        ).rejects.toThrow('goal runtime disposed');

        expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(
          expect.stringMatching(/^goal-user:/),
        );
        expect(removeEventListener).toHaveBeenCalledWith(
          'abort',
          expect.any(Function),
        );
        await expect(session.cancelPendingPrompt()).rejects.toThrow(
          'Not currently generating',
        );
      });

      it('settles a completed Goal turn even when the transcript flush fails', async () => {
        // `ChatRecordingService` latches a write failure permanently — a
        // taken-over transcript lease, for one — so every later `flush()`
        // re-throws it. Letting that abort settlement leaks the runtime's
        // current permit: `activity` stays 'running', `queueContinuation`
        // never flushes, and every later prompt hangs in `claimGoalTurn`.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-flush-fails',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
          turnKey === 'goal-runtime:turn-flush-fails' ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());
        mockChatRecordingService.flush.mockRejectedValue(
          new Error('session writer lost'),
        );

        expect(boundGoalHost).toBeDefined();
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
        });
        expect(mockChatRecordingService.flush).toHaveBeenCalled();
      });

      it('releases the permit when the prompt rejects before the model starts', async () => {
        // `prompt()` can reject before reaching the try whose finally settles
        // the turn. The turn is already off `goalQueue` by then, so failing to
        // settle here would strand the runtime's permit: `activity` stays
        // 'running' forever and every later goal prompt hangs behind it.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-rejected',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
          turnKey === 'goal-runtime:turn-rejected' ? permit : undefined,
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());
        vi.mocked(mockConfig.assertCanStartTurn).mockRejectedValueOnce(
          new Error('Session is closing'),
        );

        expect(boundGoalHost).toBeDefined();
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(
            'goal-runtime:turn-rejected',
          );
        });
        // The model never ran, so this is a release, not a completed turn.
        expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
        expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
      });

      it('drains a queued Goal turn after a background notification settles', async () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-after-notification',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockReturnValue(permit);
        let releaseNotification!: () => void;
        const notificationGate = new Promise<void>((resolve) => {
          releaseNotification = resolve;
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            (async function* () {
              await notificationGate;
              yield* [];
            })(),
          )
          .mockResolvedValueOnce(createEmptyStream());
        const notificationCallback = mockBackgroundTaskRegistry
          .setNotificationCallback.mock.calls[0]?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;

        notificationCallback(
          'Background task completed.',
          'background result',
          { agentId: 'agent-1', status: 'completed' },
        );
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });
        await Promise.resolve();
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);

        releaseNotification();
        await vi.waitFor(() => {
          expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
        });
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockChat.sendMessageStream).toHaveBeenNthCalledWith(
          2,
          currentModel,
          expect.any(Object),
          expect.any(String),
          permit,
          undefined,
        );
      });

      it('pauses a Goal turn queued behind a cancelled notification', async () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-cancelled-behind-notification',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockReturnValue(permit);
        let releaseNotification!: () => void;
        const notificationGate = new Promise<void>((resolve) => {
          releaseNotification = resolve;
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            (async function* () {
              await notificationGate;
              yield* [];
            })(),
          )
          .mockResolvedValueOnce(createEmptyStream());
        const notificationCallback = mockBackgroundTaskRegistry
          .setNotificationCallback.mock.calls[0]?.[0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;

        notificationCallback(
          'Background task completed.',
          'background result',
          { agentId: 'agent-1', status: 'completed' },
        );
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });
        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });
        await Promise.resolve();

        await session.cancelPendingPrompt();
        releaseNotification();
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));

        expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
          action: 'pause',
          expectedGoalId: permit.goalId,
          expectedRevision: permit.revision,
          reason: GOAL_PAUSE_REASON_USER_INTERRUPT,
        });
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
      });

      it('admits an ordinary ACP prompt into the active Goal turn', async () => {
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'user-turn-1',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'idle',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.beginTurn.mockReturnValue(permit);
        mockGoalRuntime.permitForTurn.mockReturnValue(permit);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        expect(mockGoalRuntime.beginTurn).toHaveBeenCalledWith(
          expect.stringMatching(/^goal-user:/),
        );
        expect(mockChat.sendMessageStream).toHaveBeenCalledWith(
          currentModel,
          expect.any(Object),
          expect.any(String),
          permit,
          { promptId: 'test-session-id########1' },
        );
        expect(mockChatRecordingService.recordUserMessage).toHaveBeenCalledWith(
          'hello',
          permit,
          undefined,
          expect.stringContaining('test-session-id########'),
          undefined,
        );
        expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
      });

      it('gives a new user prompt priority over an automatic Goal turn', async () => {
        session.dispose();
        const automaticPermit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'automatic-turn',
        };
        const userPermit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'user-turn',
        };
        let currentTurnKey = 'goal-runtime:automatic-turn';
        let queuedTurnKey: string | undefined;
        const listeners: Array<() => void> = [];
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.subscribe.mockImplementation((listener: () => void) => {
          listeners.push(listener);
          return () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          };
        });
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
          turnKey === currentTurnKey
            ? currentTurnKey.startsWith('goal-runtime:')
              ? automaticPermit
              : userPermit
            : undefined,
        );
        mockGoalRuntime.beginTurn.mockImplementation((turnKey: string) => {
          queuedTurnKey = turnKey;
          return undefined;
        });
        mockGoalRuntime.finishTurn.mockImplementation(async (permit) => {
          if (permit.turnId === automaticPermit.turnId) {
            currentTurnKey = queuedTurnKey!;
            queuedTurnKey = undefined;
            for (const listener of [...listeners]) listener();
          }
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementationOnce(
            async (_model, request: { config: { abortSignal: AbortSignal } }) =>
              (async function* () {
                if (!request.config.abortSignal.aborted) {
                  await new Promise<void>((resolve) =>
                    request.config.abortSignal.addEventListener(
                      'abort',
                      () => resolve(),
                      { once: true },
                    ),
                  );
                }
                yield* createEmptyStream();
              })(),
          )
          .mockResolvedValueOnce(createEmptyStream());
        session = new Session(
          'test-session-id',
          mockConfig,
          mockClient,
          mockSettings,
        );

        await boundGoalHost!.startGoalTurn({
          permit: automaticPermit,
          continuationContext: 'check weather',
        });
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'user input' }],
        });

        expect(mockGoalRuntime.beginTurn).toHaveBeenCalledWith(
          expect.stringMatching(/^goal-user:/),
        );
        expect(mockChat.sendMessageStream).toHaveBeenNthCalledWith(
          2,
          currentModel,
          expect.any(Object),
          expect.any(String),
          userPermit,
          { promptId: 'test-session-id########2' },
        );
        expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(
          automaticPermit,
        );
        expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(userPermit);
      });

      it('hands off a preempted Goal turn whose stream throws on abort', async () => {
        // Same user action as the test above, but the preempted stream
        // rejects out of the model network await instead of ending cleanly --
        // which is what llmChat actually does. Where the abort lands is
        // pure timing, so both spellings have to settle the same way: a
        // handoff via finishTurn, never a pause. Pausing here would persist
        // the goal as paused and silently stop the autonomous loop.
        session.dispose();
        const automaticPermit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'automatic-turn',
        };
        const userPermit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'user-turn',
        };
        let currentTurnKey = 'goal-runtime:automatic-turn';
        let queuedTurnKey: string | undefined;
        const listeners: Array<() => void> = [];
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.subscribe.mockImplementation((listener: () => void) => {
          listeners.push(listener);
          return () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          };
        });
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
          turnKey === currentTurnKey
            ? currentTurnKey.startsWith('goal-runtime:')
              ? automaticPermit
              : userPermit
            : undefined,
        );
        mockGoalRuntime.beginTurn.mockImplementation((turnKey: string) => {
          queuedTurnKey = turnKey;
          return undefined;
        });
        mockGoalRuntime.finishTurn.mockImplementation(async (permit) => {
          if (permit.turnId === automaticPermit.turnId) {
            currentTurnKey = queuedTurnKey!;
            queuedTurnKey = undefined;
            for (const listener of [...listeners]) listener();
          }
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementationOnce(
            async (
              _model,
              request: { config: { abortSignal: AbortSignal } },
            ) => {
              if (!request.config.abortSignal.aborted) {
                await new Promise<void>((resolve) =>
                  request.config.abortSignal.addEventListener(
                    'abort',
                    () => resolve(),
                    { once: true },
                  ),
                );
              }
              // The one difference from the sibling test: the abort lands
              // inside the model network await, so llmChat rejects instead
              // of handing back a stream that ends cleanly.
              throw Object.assign(new Error('The operation was aborted'), {
                name: 'AbortError',
              });
            },
          )
          .mockResolvedValueOnce(createEmptyStream());
        session = new Session(
          'test-session-id',
          mockConfig,
          mockClient,
          mockSettings,
        );

        await boundGoalHost!.startGoalTurn({
          permit: automaticPermit,
          continuationContext: 'check weather',
        });
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'user input' }],
        });

        expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(
          automaticPermit,
        );
        expect(mockGoalRuntime.dispatch).not.toHaveBeenCalledWith(
          expect.objectContaining({ action: 'pause' }),
        );
      });

      it('does not strand a prompt behind a Goal continuation the drain cannot start', async () => {
        // `/goal set` activates the goal midway through its own prompt, so
        // the runtime mints a continuation while `#drainGoalQueue` is still
        // gated on that prompt. A second prompt arriving before the first
        // unwinds reserves a turn key behind the continuation's permit --
        // and the drain cannot start the continuation until this prompt
        // finishes, while this prompt cannot start until the continuation
        // gives the permit back. Neither side moves without dropping the
        // un-started continuation.
        session.dispose();
        const continuationPermit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'continuation-turn',
        };
        const userPermit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'user-turn',
        };
        const activeGoal = {
          goalId: 'goal-1',
          revision: 1,
          objective: 'check weather',
          status: 'active',
          evidenceCursor: { recordId: 'cursor-1' },
          turnCount: 0,
          activeTimeMs: 0,
          tokensUsed: 0,
          createdAt: 1234,
          updatedAt: 1234,
        };
        let goalActive = false;
        let currentTurnKey: string | undefined;
        let queuedTurnKey: string | undefined;
        mockGoalRuntime.getSnapshot.mockImplementation(() => ({
          v: 2,
          activity: currentTurnKey ? 'running' : 'idle',
          goal: goalActive ? activeGoal : null,
        }));
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) => {
          if (turnKey !== currentTurnKey) return undefined;
          return turnKey.startsWith('goal-runtime:')
            ? continuationPermit
            : userPermit;
        });
        mockGoalRuntime.beginTurn.mockImplementation((turnKey: string) => {
          if (!goalActive) return undefined;
          if (currentTurnKey) {
            queuedTurnKey ??= turnKey;
            return undefined;
          }
          currentTurnKey = turnKey;
          return turnKey.startsWith('goal-runtime:')
            ? continuationPermit
            : userPermit;
        });
        // Releasing promotes the waiting reservation rather than minting a
        // fresh continuation -- the runtime behaviour this fix relies on.
        mockGoalRuntime.releaseTurn.mockImplementation(
          async (turnKey: string) => {
            if (turnKey !== currentTurnKey) return false;
            currentTurnKey = queuedTurnKey;
            queuedTurnKey = undefined;
            return true;
          },
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementationOnce(
            async (_model, request: { config: { abortSignal: AbortSignal } }) =>
              (async function* () {
                if (!request.config.abortSignal.aborted) {
                  await new Promise<void>((resolve) =>
                    request.config.abortSignal.addEventListener(
                      'abort',
                      () => resolve(),
                      { once: true },
                    ),
                  );
                }
                yield* createEmptyStream();
              })(),
          )
          .mockResolvedValueOnce(createEmptyStream());
        session = new Session(
          'test-session-id',
          mockConfig,
          mockClient,
          mockSettings,
        );

        const activating = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'set a goal to check weather' }],
        });
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
        });

        // The dispatch commits mid-prompt: the goal goes active and the
        // runtime hands the session a continuation it cannot drain yet.
        goalActive = true;
        currentTurnKey = 'goal-runtime:continuation-turn';
        await boundGoalHost!.startGoalTurn({
          permit: continuationPermit,
          continuationContext: 'check weather',
        });
        await Promise.resolve();
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);

        const second = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'user input' }],
        });
        await vi.waitFor(() => {
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        });
        await Promise.all([activating, second]);

        expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(
          'goal-runtime:continuation-turn',
        );
        expect(mockChat.sendMessageStream).toHaveBeenNthCalledWith(
          2,
          currentModel,
          expect.any(Object),
          expect.any(String),
          userPermit,
          { promptId: 'test-session-id########2' },
        );
        expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(userPermit);
      });

      it('releases a Goal turn whose settlement cannot be persisted', async () => {
        // `ChatRecordingService` latches a write failure permanently, so the
        // journal writes inside `finishTurn` re-throw it forever. Letting
        // that escape would leave the runtime's permit set and `running`, so
        // no continuation is ever scheduled again and every later prompt
        // hangs in `claimGoalTurn`.
        const permit: core.GoalTurnPermit = {
          goalId: 'goal-1',
          revision: 1,
          turnId: 'turn-latched',
        };
        mockGoalRuntime.getSnapshot.mockReturnValue({
          v: 2,
          activity: 'running',
          goal: {
            goalId: 'goal-1',
            revision: 1,
            objective: 'check weather',
            status: 'active',
            evidenceCursor: { recordId: 'cursor-1' },
            turnCount: 0,
            activeTimeMs: 0,
            tokensUsed: 0,
            createdAt: 1234,
            updatedAt: 1234,
          },
        });
        mockGoalRuntime.permitForTurn.mockImplementation((turnKey: string) =>
          turnKey === 'goal-runtime:turn-latched' ? permit : undefined,
        );
        mockGoalRuntime.finishTurn.mockRejectedValue(
          new Error('transcript write failed'),
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await boundGoalHost!.startGoalTurn({
          permit,
          continuationContext: 'check weather',
        });

        await vi.waitFor(() => {
          expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(
            'goal-runtime:turn-latched',
          );
        });
        expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit);
      });
    });

    describe('tool preparation stream lifecycle', () => {
      function registerAllowedTool(
        name: string,
        execute: ReturnType<typeof vi.fn>,
      ) {
        mockToolRegistry.getTool.mockImplementation((toolName: string) =>
          toolName === name
            ? {
                name,
                kind: core.Kind.Read,
                displayName: name,
                build: vi
                  .fn()
                  .mockImplementation((args: Record<string, unknown>) => ({
                    params: args,
                    execute,
                    getDefaultPermission: vi.fn().mockResolvedValue('allow'),
                    getDescription: vi.fn().mockReturnValue(name),
                    toolLocations: vi.fn().mockReturnValue([]),
                  })),
              }
            : undefined,
        );
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      }

      it('emits preparing before execution and keeps resolved preparations out of finally discard', async () => {
        const execute = vi.fn().mockResolvedValue({
          llmContent: 'file contents',
          returnDisplay: 'file contents',
        });
        registerAllowedTool('read_file', execute);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: createPreparationResponse('call-1', 'read_file'),
              },
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { file_path: 'a.sql' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'read the file' }],
        });

        const updates = vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update);
        const preparingIndex = updates.findIndex(
          (update) =>
            update.sessionUpdate === 'tool_call' &&
            update.toolCallId === 'call-1' &&
            update.status === 'pending' &&
            update._meta?.['phase'] === 'preparing',
        );
        const inProgressIndex = updates.findIndex(
          (update) =>
            update.sessionUpdate === 'tool_call_update' &&
            update.toolCallId === 'call-1' &&
            update.status === 'in_progress' &&
            'rawInput' in update &&
            update.rawInput?.['file_path'] === 'a.sql',
        );

        expect(preparingIndex).toBeGreaterThanOrEqual(0);
        expect(inProgressIndex).toBeGreaterThan(preparingIndex);
        expect(execute).toHaveBeenCalledOnce();
        expect(updates).not.toContainEqual(
          expect.objectContaining({
            toolCallId: 'call-1',
            _meta: expect.objectContaining({ preparationDiscarded: true }),
          }),
        );
      });

      it('suppresses TodoWrite preparation updates at the Session boundary', async () => {
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: createPreparationResponse(
                'call-todo',
                core.ToolNames.TODO_WRITE,
              ),
            },
          ]),
        );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'update the plan' }],
        });

        const updates = vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.map(([params]) => params.update);
        expect(
          updates.some(
            (update) =>
              (update.sessionUpdate === 'tool_call' ||
                update.sessionUpdate === 'tool_call_update') &&
              update.toolCallId === 'call-todo',
          ),
        ).toBe(false);
      });

      it('discards a resolved preparation when the stream fails before tool execution', async () => {
        const execute = vi.fn();
        registerAllowedTool('read_file', execute);
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          (async function* () {
            yield {
              type: core.StreamEventType.CHUNK,
              value: createPreparationResponse(
                'call-stream-error',
                'read_file',
              ),
            };
            yield {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'call-stream-error',
                    name: 'read_file',
                    args: { file_path: 'a.sql' },
                  },
                ],
              },
            };
            throw new Error('stream failed after function call');
          })(),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          }),
        ).rejects.toThrow('stream failed after function call');

        expect(execute).not.toHaveBeenCalled();
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-stream-error',
            status: 'failed',
            _meta: expect.objectContaining({
              phase: 'preparing',
              preparationDiscarded: true,
            }),
          }),
        });
      });

      it.each([
        core.StreamEventType.RETRY,
        core.StreamEventType.MODEL_FALLBACK,
      ])(
        'discards preparation and stale function calls on %s before accepting the next attempt',
        async (resetEvent) => {
          const staleExecute = vi.fn();
          const currentExecute = vi.fn().mockResolvedValue({
            llmContent: 'current result',
            returnDisplay: 'current result',
          });
          mockToolRegistry.getTool.mockImplementation((toolName: string) => {
            const execute =
              toolName === 'stale_tool'
                ? staleExecute
                : toolName === 'current_tool'
                  ? currentExecute
                  : undefined;
            if (!execute) return undefined;
            return {
              name: toolName,
              kind: core.Kind.Read,
              displayName: toolName,
              build: vi.fn().mockImplementation((args) => ({
                params: args,
                execute,
                getDefaultPermission: vi.fn().mockResolvedValue('allow'),
                getDescription: vi.fn().mockReturnValue(toolName),
                toolLocations: vi.fn().mockReturnValue([]),
              })),
            };
          });
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: createPreparationResponse(
                    'preparing-stale',
                    'read_file',
                  ),
                },
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    functionCalls: [
                      { id: 'stale-call', name: 'stale_tool', args: {} },
                    ],
                  },
                },
                { type: resetEvent, value: {} },
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    functionCalls: [
                      { id: 'current-call', name: 'current_tool', args: {} },
                    ],
                  },
                },
              ]),
            )
            .mockResolvedValueOnce(createEmptyStream());

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'retry the tool call' }],
          });

          expect(staleExecute).not.toHaveBeenCalled();
          expect(currentExecute).toHaveBeenCalledOnce();
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'preparing-stale',
              status: 'failed',
              _meta: expect.objectContaining({
                phase: 'preparing',
                preparationDiscarded: true,
              }),
            }),
          });
        },
      );

      it.each([
        core.StreamEventType.RETRY,
        core.StreamEventType.MODEL_FALLBACK,
      ])(
        'continues after preparation cleanup fails during %s',
        async (resetEvent) => {
          debugLoggerWarnSpy.mockClear();
          const execute = vi.fn().mockResolvedValue({
            llmContent: 'current result',
            returnDisplay: 'current result',
          });
          registerAllowedTool('current_tool', execute);
          vi.mocked(mockClient.sessionUpdate).mockImplementation(
            async ({ update }) => {
              if (update._meta?.['preparationDiscarded'] === true) {
                throw new Error('cleanup failed');
              }
            },
          );
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: createPreparationResponse(
                    'preparing-stale',
                    'read_file',
                  ),
                },
                { type: resetEvent, value: {} },
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    functionCalls: [
                      { id: 'current-call', name: 'current_tool', args: {} },
                    ],
                  },
                },
              ]),
            )
            .mockResolvedValueOnce(createEmptyStream());

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'retry the tool call' }],
          });

          expect(execute).toHaveBeenCalledOnce();
          expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
            expect.stringContaining('cleanup failed'),
          );
        },
      );

      it('preserves the stream error when discarding its unresolved preparation also fails', async () => {
        debugLoggerWarnSpy.mockClear();
        vi.mocked(mockClient.sessionUpdate).mockImplementation(
          async ({ update }) => {
            if (update._meta?.['preparationDiscarded'] === true) {
              throw new Error('cleanup failed');
            }
          },
        );
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          (async function* () {
            yield {
              type: core.StreamEventType.CHUNK,
              value: createPreparationResponse('call-error', 'read_file'),
            };
            throw new Error('stream failed');
          })(),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'trigger a stream error' }],
          }),
        ).rejects.toThrow('stream failed');
        expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('cleanup failed'),
        );
      });

      it('preserves a cancelled return when discarding its unresolved preparation fails', async () => {
        debugLoggerWarnSpy.mockClear();
        vi.mocked(mockClient.sessionUpdate).mockImplementation(
          async ({ update }) => {
            if (update._meta?.['preparationDiscarded'] === true) {
              throw new Error('cleanup failed');
            }
          },
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockImplementation(
            async (_model, request: { config: { abortSignal: AbortSignal } }) =>
              (async function* (signal: AbortSignal) {
                yield {
                  type: core.StreamEventType.CHUNK,
                  value: createPreparationResponse('call-cancel', 'read_file'),
                };
                await new Promise<void>((resolve) => {
                  signal.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
                });
                yield { type: core.StreamEventType.CHUNK, value: {} };
              })(request.config.abortSignal),
          );

        const promptPromise = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'cancel this stream' }],
        });
        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: expect.objectContaining({
              sessionUpdate: 'tool_call',
              toolCallId: 'call-cancel',
            }),
          });
        });

        await session.cancelPendingPrompt();

        await expect(promptPromise).resolves.toEqual({
          stopReason: 'cancelled',
        });
        expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('cleanup failed'),
        );
      });

      it('preserves a normally completed stream when preparation cleanup fails', async () => {
        debugLoggerWarnSpy.mockClear();
        vi.mocked(mockClient.sessionUpdate).mockImplementation(
          async ({ update }) => {
            if (update._meta?.['preparationDiscarded'] === true) {
              throw new Error('cleanup failed');
            }
          },
        );
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: createPreparationResponse('call-normal', 'read_file'),
            },
          ]),
        );

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'finish normally' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });
        expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('cleanup failed'),
        );
      });

      it('tracks unresolved preparation in a Stop Hook continuation stream', async () => {
        const messageBus = {
          request: vi.fn().mockImplementation(async (request) => ({
            success: true,
            output:
              request.eventName === 'Stop'
                ? {
                    decision: 'block',
                    reason: 'Continue after Stop hook',
                  }
                : {},
          })),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(2);
        mockChat.getLastModelMessageText = vi
          .fn()
          .mockReturnValue('response text');
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: createPreparationResponse('call-stop-hook', 'read_file'),
              },
            ]),
          );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'run stop hook' }],
        });

        expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
          sessionId: 'test-session-id',
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-stop-hook',
            _meta: expect.objectContaining({ preparationDiscarded: true }),
          }),
        });
      });

      it('tracks unresolved preparation in a cron stream', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: 'scheduled work', cronExpr: '* * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: createPreparationResponse('call-cron', 'read_file'),
              },
            ]),
          );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start cron' }],
        });

        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call-cron',
              _meta: expect.objectContaining({ preparationDiscarded: true }),
            }),
          });
        });
      });

      it('records a tool-using cron fire only once', async () => {
        const execute = vi.fn().mockResolvedValue({
          llmContent: 'file contents',
          returnDisplay: 'file contents',
        });
        registerAllowedTool('read_file', execute);
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: 'scheduled work', cronExpr: '* * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-cron',
                      name: 'read_file',
                      args: { file_path: 'a.sql' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start cron' }],
        });

        await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3);
        expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalledTimes(
          1,
        );
      });

      it('does not record a tool-using cron fire again when turn two is cancelled', async () => {
        const execute = vi.fn().mockResolvedValue({
          llmContent: 'file contents',
          returnDisplay: 'file contents',
        });
        registerAllowedTool('read_file', execute);
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn(
            (
              callback: (job: { prompt: string; cronExpr?: string }) => void,
            ) => {
              callback({ prompt: 'scheduled work', cronExpr: '* * * * *' });
            },
          ),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        const noCompression = {
          originalTokenCount: 50,
          newTokenCount: 50,
          compressionStatus: core.CompressionStatus.NOOP,
        };
        let turnTwoCompressionStarted!: () => void;
        const turnTwoCompressionStartedPromise = new Promise<void>(
          (resolve) => {
            turnTwoCompressionStarted = resolve;
          },
        );
        mockLlmClient.tryCompressChat
          .mockResolvedValueOnce(noCompression)
          .mockResolvedValueOnce(noCompression)
          .mockImplementationOnce(
            async (_promptId: string, _force: boolean, signal: AbortSignal) =>
              new Promise((_, reject) => {
                turnTwoCompressionStarted();
                signal.addEventListener('abort', () => {
                  const abortError = new Error('aborted');
                  abortError.name = 'AbortError';
                  reject(abortError);
                });
              }),
          );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-cron-cancel',
                      name: 'read_file',
                      args: { file_path: 'a.sql' },
                    },
                  ],
                },
              },
            ]),
          );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start cron' }],
        });
        await turnTwoCompressionStartedPromise;
        vi.mocked(mockChat.addHistory).mockClear();

        await session.cancelPendingPrompt();
        await vi.waitFor(() => expect(mockChat.addHistory).toHaveBeenCalled());

        expect(execute).toHaveBeenCalledOnce();
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalledTimes(
          1,
        );
      });

      it('tracks unresolved preparation in a background notification stream', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: createPreparationResponse(
                  'call-notification',
                  'read_file',
                ),
              },
            ]),
          );
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start background work' }],
        });
        const callback = mockBackgroundTaskRegistry.setNotificationCallback.mock
          .calls[0][0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string },
        ) => void;

        callback('done', '<task-notification />', {
          agentId: 'agent-1',
          status: 'completed',
        });

        await vi.waitFor(() => {
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: expect.objectContaining({
              sessionUpdate: 'tool_call_update',
              toolCallId: 'call-notification',
              _meta: expect.objectContaining({ preparationDiscarded: true }),
            }),
          });
        });
      });
    });

    it('passes resolved paths to read_many_files tool', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-acp-session-'),
      );
      const fileName = 'README.md';
      const filePath = path.join(tempDir, fileName);

      const readManyFilesSpy = vi
        .spyOn(core, 'readManyFiles')
        .mockResolvedValue({
          contentParts: 'file content',
          files: [],
        });

      try {
        await fs.writeFile(filePath, '# Test\n', 'utf8');
        const canonicalFilePath = await fs.realpath(filePath);

        mockConfig.getTargetDir = vi.fn().mockReturnValue(tempDir);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        const promptRequest: PromptRequest = {
          sessionId: 'test-session-id',
          prompt: [
            { type: 'text', text: 'Check this file' },
            {
              type: 'resource_link',
              name: fileName,
              uri: `file://${fileName}`,
            },
          ],
        };

        await session.prompt(promptRequest);

        expect(readManyFilesSpy).toHaveBeenCalledWith(mockConfig, {
          paths: [canonicalFilePath],
          signal: expect.any(AbortSignal),
          validatedPathIdentities: expect.any(Map),
          displayPaths: new Map([[canonicalFilePath, fileName]]),
        });
      } finally {
        readManyFilesSpy.mockRestore();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('drops resource links that fail workspace revalidation', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-acp-session-'),
      );
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-acp-outside-'),
      );
      const outsidePath = path.join(outsideDir, 'secret.png');
      const readManyFilesSpy = vi.spyOn(core, 'readManyFiles');

      try {
        await fs.writeFile(outsidePath, 'secret', 'utf8');
        mockConfig.getTargetDir = vi.fn().mockReturnValue(tempDir);
        mockConfig.getWorkspaceContext = vi.fn().mockReturnValue({
          isPathWithinWorkspace: (pathSpec: string) =>
            pathSpec.startsWith(`${tempDir}${path.sep}`),
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [
            { type: 'text', text: 'Check this file' },
            {
              type: 'resource_link',
              name: 'secret.png',
              uri: `file://${outsidePath}`,
            },
          ],
        });

        expect(readManyFilesSpy).not.toHaveBeenCalled();
        expect(firstSentMessage()).toEqual([{ text: 'Check this file' }]);
      } finally {
        readManyFilesSpy.mockRestore();
        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('injects active extension context for @ext mentions', async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-acp-ext-'));
      const contextFile = path.join(tempDir, 'context.md');

      try {
        await fs.writeFile(contextFile, 'extension context file', 'utf8');
        const extension = makeExtension({
          path: tempDir,
          contextFiles: [contextFile],
        });
        mockConfig.getActiveExtensions = vi.fn().mockReturnValue([extension]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'Use @ext:browser now' }],
        });

        const message = firstSentMessage();
        expect(message[0]).toEqual({ text: 'Use @ext:browser now' });
        const sentText = textParts(message).join('\n');
        expect(sentText).toContain(
          '--- Extension: Browser (untrusted third-party content) ---',
        );
        expect(sentText).toContain('Browser automation');
        expect(sentText).toContain(
          '- Skills: browser:browser-skill (invoke via /<skill-name>)',
        );
        expect(sentText).toContain('- MCP Servers: browser-mcp');
        expect(sentText).toContain('extension context file');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    });

    it('injects MCP server context for @mcp mentions', async () => {
      mockConfig.getMcpServers = vi.fn().mockReturnValue({ demo: {} });
      mockConfig.getPromptRegistry = vi.fn().mockReturnValue({
        getPromptsByServer: (name: string) => (name === 'demo' ? ['p'] : []),
      });
      mockConfig.getResourceRegistry = vi.fn().mockReturnValue({
        getResourcesByServer: (name: string) =>
          name === 'demo' ? [{ uri: 'res://1' }] : [],
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Use @mcp:demo now' }],
      });

      const message = firstSentMessage();
      expect(message[0]).toEqual({ text: 'Use @mcp:demo now' });
      const sentText = textParts(message).join('\n');
      expect(sentText).toContain('--- MCP Server: demo ---');
      expect(sentText).toContain('- Resources: 1');
      expect(sentText).toContain('- Prompts: 1');
    });

    it('dedupes repeated extension mentions and skips unknown mentions', async () => {
      const extension = makeExtension();
      mockConfig.getActiveExtensions = vi.fn().mockReturnValue([extension]);
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValue(createEmptyStream());

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [
          {
            type: 'text',
            text: 'Use @ext:browser and @ext:browser and @ext:missing',
          },
        ],
      });

      const sentText = textParts(firstSentMessage()).join('\n');
      expect(sentText.match(/--- Extension: Browser/g)).toHaveLength(1);
      expect(sentText).not.toContain('Extension: missing');
    });

    it('caps extension context files and skips files outside the extension', async () => {
      const tempDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-acp-ext-cap-'),
      );
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'qwen-acp-ext-outside-'),
      );
      const bigFile = path.join(tempDir, 'big.md');
      const outsideFile = path.join(outsideDir, 'secret.md');

      try {
        await fs.writeFile(bigFile, 'x'.repeat(60_000), 'utf8');
        await fs.writeFile(outsideFile, 'do not inject this secret', 'utf8');
        const extension = makeExtension({
          path: tempDir,
          contextFiles: [bigFile, outsideFile],
        });
        mockConfig.getActiveExtensions = vi.fn().mockReturnValue([extension]);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '@ext:browser' }],
        });

        const sentText = textParts(firstSentMessage()).join('\n');
        expect(sentText).toContain('... (truncated)');
        expect(sentText).not.toContain('do not inject this secret');
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    });

    it('runs prompt inside runtime output dir context', async () => {
      const runtimeDir = path.resolve('runtime', 'from-settings');
      core.Storage.setRuntimeBaseDir(runtimeDir);
      session = new Session(
        'test-session-id',
        mockConfig,
        mockClient,
        mockSettings,
      );
      const runWithRuntimeBaseDirSpy = vi.spyOn(
        core.Storage,
        'runWithRuntimeBaseDir',
      );

      try {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValue(createEmptyStream());

        const promptRequest: PromptRequest = {
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        };

        await session.prompt(promptRequest);

        expect(runWithRuntimeBaseDirSpy).toHaveBeenCalledWith(
          runtimeDir,
          process.cwd(),
          expect.any(Function),
        );
      } finally {
        runWithRuntimeBaseDirSpy.mockRestore();
      }
    });

    it('hides allow-always options when confirmation already forbids them', async () => {
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const invocation = {
        params: { path: '/tmp/file.txt' },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'info',
          title: 'Need permission',
          prompt: 'Allow?',
          hideAlwaysAllow: true,
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue('Inspect file'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-1',
                  name: 'read_file',
                  args: { path: '/tmp/file.txt' },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run tool' }],
      });

      expect(mockClient.requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          options: [
            expect.objectContaining({ kind: 'allow_once' }),
            expect.objectContaining({ kind: 'reject_once' }),
          ],
        }),
      );
      const options = (mockClient.requestPermission as ReturnType<typeof vi.fn>)
        .mock.calls[0][0].options as Array<{ kind: string }>;
      expect(options.some((option) => option.kind === 'allow_always')).toBe(
        false,
      );
    });

    it('never requests ACP permission for the trusted Live Appshot tool', async () => {
      const directory = path.join(os.tmpdir(), 'qwen-live-appshot');
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const screenshotPath = path.join(directory, `${randomUUID()}.png`);
      await fs.writeFile(
        screenshotPath,
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
      );
      const registered = new Map<string, core.AnyDeclarativeTool>();
      mockToolRegistry.registerTool = vi.fn((tool) => {
        registered.set(tool.name, tool);
      });
      mockToolRegistry.getTool = vi.fn((name: string) => registered.get(name));
      mockClient.extMethod = vi.fn().mockResolvedValue({
        appName: 'Safari',
        accessibilityText: 'AXWindow',
        screenshotPath,
      });
      await session.enableLiveScreenContext();
      const permissionManager = {
        isToolEnabled: vi.fn().mockResolvedValue(false),
        hasRelevantRules: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockResolvedValue('ask'),
        hasMatchingAskRule: vi.fn().mockReturnValue(true),
        findMatchingDenyRule: vi.fn(),
      };
      mockConfig.getPermissionManager = vi
        .fn()
        .mockReturnValue(permissionManager);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-live-appshot',
                  name: CAPTURE_SCREEN_CONTEXT_TOOL_NAME,
                  args: {},
                },
              ],
            },
          },
        ]),
      );

      try {
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: '看看当前页面' }],
        });

        expect(permissionManager.isToolEnabled).not.toHaveBeenCalled();
        expect(permissionManager.evaluate).not.toHaveBeenCalled();
        expect(mockClient.requestPermission).not.toHaveBeenCalled();
        expect(mockClient.extMethod).toHaveBeenCalledWith(
          'qwen/control/live/capture-screen-context',
          { callerSessionId: 'test-session-id' },
        );
      } finally {
        await fs.unlink(screenshotPath).catch(() => undefined);
      }
    });

    it('keeps ordinary Live tools on the normal ACP permission path', async () => {
      const registered = new Map<string, core.AnyDeclarativeTool>();
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'file contents',
        returnDisplay: 'file contents',
      });
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const ordinaryTool = {
        name: 'read_file',
        kind: core.Kind.Read,
        displayName: 'Read file',
        description: 'Read a file',
        build: vi.fn().mockReturnValue({
          params: { path: '/tmp/private' },
          execute,
          getDefaultPermission: vi.fn().mockResolvedValue('ask'),
          getConfirmationDetails: vi.fn().mockResolvedValue({
            type: 'info',
            title: 'Read file',
            prompt: 'Allow reading this file?',
            onConfirm,
          }),
          getDescription: vi.fn().mockReturnValue('Read /tmp/private'),
          toolLocations: vi.fn().mockReturnValue([]),
        }),
      } as unknown as core.AnyDeclarativeTool;
      registered.set(ordinaryTool.name, ordinaryTool);
      mockToolRegistry.registerTool = vi.fn((tool) => {
        registered.set(tool.name, tool);
      });
      mockToolRegistry.getTool = vi.fn((name: string) => registered.get(name));
      await session.enableLiveScreenContext();
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-live-read-file',
                  name: 'read_file',
                  args: { path: '/tmp/private' },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: '读取文件' }],
      });

      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
      expect(onConfirm).toHaveBeenCalledOnce();
      expect(execute).toHaveBeenCalledOnce();
    });

    it('emits terminalSequence returned by permission notification hooks over ACP', async () => {
      const notificationHookSpy = vi
        .spyOn(core, 'fireNotificationHook')
        .mockResolvedValue({ terminalSequence: '\x07' });
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const invocation = {
        params: { path: '/tmp/file.txt' },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'info',
          title: 'Need permission',
          prompt: 'Allow?',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue('Inspect file'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({});
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-terminal-sequence',
                  name: 'read_file',
                  args: { path: '/tmp/file.txt' },
                },
              ],
            },
          },
        ]),
      );

      try {
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'run tool' }],
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
      } finally {
        notificationHookSpy.mockRestore();
      }

      expect(mockClient.extNotification).toHaveBeenCalledWith(
        'qwen/notify/session/terminal-sequence',
        {
          v: 1,
          sessionId: 'test-session-id',
          terminalSequence: '\x07',
        },
      );
    });

    it('allows info confirmation tools in plan mode', async () => {
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const invocation = {
        params: {
          url: 'https://example.com/docs',
          prompt: 'Summarize the docs',
        },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'info',
          title: 'Confirm Web Fetch',
          prompt: 'Allow fetching docs?',
          urls: ['https://example.com/docs'],
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue('Fetch docs'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: 'web_fetch',
        kind: core.Kind.Fetch,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-info-plan',
                  name: 'web_fetch',
                  args: {
                    url: 'https://example.com/docs',
                    prompt: 'Summarize the docs',
                  },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'research the docs first' }],
      });

      expect(mockClient.requestPermission).toHaveBeenCalled();
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.ProceedOnce,
        { answers: undefined },
      );
      expect(executeSpy).toHaveBeenCalled();
    });

    it('blocks known Plan shell writes before requesting ACP permission', async () => {
      const executeSpy = vi.fn();
      const getConfirmationDetails = vi.fn();
      const invocation = {
        params: { command: 'touch changed.txt' },
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails,
        getDescription: vi.fn().mockReturnValue('touch changed.txt'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn().mockReturnValue(1);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-write',
                  name: core.ToolNames.SHELL,
                  args: { command: 'touch changed.txt' },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run write' }],
      });

      expect(getConfirmationDetails).not.toHaveBeenCalled();
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('classified as state-modifying'),
          }),
        }),
      );
    });

    it('routes unknown resolved shell aliases to exact one-off ACP approval', async () => {
      const rawCommand = "python -c 'print(1)'";
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const invocation = {
        params: { command: rawCommand },
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell',
          command: rawCommand,
          rootCommand: 'python',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue(rawCommand),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn().mockReturnValue(2);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-unknown',
                  name: 'Shell',
                  args: { command: rawCommand },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'inspect through wrapper' }],
      });

      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
      const permissionRequest = vi.mocked(mockClient.requestPermission).mock
        .calls[0][0];
      expect(
        (permissionRequest.options as PermissionOption[]).map(
          (option) => option.optionId,
        ),
      ).toEqual([
        core.ToolConfirmationOutcome.ProceedOnce,
        core.ToolConfirmationOutcome.Cancel,
      ]);
      expect(permissionRequest.toolCall.content[0]).toMatchObject({
        content: {
          text: expect.stringContaining('exact invocation once'),
        },
      });
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.ProceedOnce,
        undefined,
      );
      expect(executeSpy).toHaveBeenCalledOnce();
      expect(addToolArgumentsAttributesSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.anything(),
        invocation.params,
      );
      expect(invocation.params).toMatchObject({
        command: rawCommand,
        directory: expect.any(String),
      });
    });

    it('reports ACP Plan shell approval request failures accurately', async () => {
      const rawCommand = "python -c 'print(1)'";
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const executeSpy = vi.fn();
      const invocation = {
        params: { command: rawCommand },
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell',
          command: rawCommand,
          rootCommand: 'python',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue(rawCommand),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn().mockReturnValue(2);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      vi.mocked(mockClient.requestPermission).mockRejectedValueOnce(
        new Error('ACP host disconnected'),
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-approval-failed',
                  name: core.ToolNames.SHELL,
                  args: { command: rawCommand },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'inspect through wrapper' }],
      });

      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
      );
      expect(executeSpy).not.toHaveBeenCalled();
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          error: expect.objectContaining({
            message:
              'Plan mode could not complete approval for this shell command: ACP host disconnected. The command was not run; Plan mode remains active.',
          }),
        }),
      );
    });

    it('preserves parent cancellation while unknown Plan shell approval is pending', async () => {
      const rawCommand = "python -c 'print(1)'";
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const executeSpy = vi.fn();
      const internals = session as unknown as {
        midTurnRecoveredMessages: Array<
          | { kind: 'text'; message: string }
          | {
              kind: 'structured';
              content: Array<{
                type: 'image';
                mimeType: string;
                data: string;
              }>;
              displayText: string;
            }
        >;
      };
      internals.midTurnRecoveredMessages.push({
        kind: 'text',
        message: 'recovered before cancellation',
      });
      internals.midTurnRecoveredMessages.push({
        kind: 'structured',
        content: [
          {
            type: 'image',
            mimeType: 'image/png',
            data: 'iVBORw0KGgo=',
          },
        ],
        displayText: 'recovered image before cancellation',
      });
      const invocation = {
        params: { command: rawCommand },
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell',
          command: rawCommand,
          rootCommand: 'python',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue(rawCommand),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn().mockReturnValue(2);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      vi.mocked(mockClient.requestPermission).mockImplementationOnce(
        () => new Promise(() => {}),
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-approval-cancelled',
                  name: core.ToolNames.SHELL,
                  args: { command: rawCommand },
                },
              ],
            },
          },
        ]),
      );

      const prompt = session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'inspect through wrapper' }],
      });
      await vi.waitFor(() => {
        expect(mockClient.requestPermission).toHaveBeenCalledOnce();
      });
      await session.cancelPendingPrompt();

      await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
      );
      expect(mockClient.extMethod).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(internals.midTurnRecoveredMessages).toHaveLength(0);
      expect(mockChat.addHistory).toHaveBeenCalledWith({
        role: 'user',
        parts: [
          expect.objectContaining({
            functionResponse: expect.objectContaining({
              id: 'call-plan-approval-cancelled',
              name: core.ToolNames.SHELL,
            }),
          }),
          {
            text: '\n[User message received during tool execution]: recovered before cancellation',
          },
          {
            text: '\n[User message received during tool execution]: recovered image before cancellation',
          },
          { text: '[Attachment could not be processed]' },
        ],
      });
      expect(
        mockChatRecordingService.recordMidTurnUserMessage,
      ).toHaveBeenCalledWith(
        [
          {
            text: '\n[User message received during tool execution]: recovered before cancellation',
          },
        ],
        'recovered before cancellation',
      );
      expect(
        mockChatRecordingService.recordMidTurnUserMessage,
      ).toHaveBeenCalledWith(
        [
          {
            text: '\n[User message received during tool execution]: recovered image before cancellation',
          },
          { text: '[Attachment could not be processed]' },
        ],
        'recovered image before cancellation',
      );
    });

    it('rejects permission-hook rewrites of unknown Plan shell commands', async () => {
      const rawCommand = "python -c 'print(1)'";
      const hookSpy = vi
        .spyOn(core, 'firePermissionRequestHook')
        .mockResolvedValue({
          hasDecision: true,
          shouldAllow: true,
          updatedInput: { command: 'touch changed.txt' },
        });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const executeSpy = vi.fn();
      const invocation = {
        params: { command: rawCommand },
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell',
          command: rawCommand,
          rootCommand: 'python',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue(rawCommand),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn().mockReturnValue(2);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({});
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-hook-rewrite',
                  name: core.ToolNames.SHELL,
                  args: { command: rawCommand },
                },
              ],
            },
          },
        ]),
      );

      try {
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'inspect through wrapper' }],
        });
      } finally {
        hookSpy.mockRestore();
      }

      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
        expect.objectContaining({
          cancelMessage: expect.stringContaining('exact invocation changed'),
        }),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('rejects ACP shell args mutated while building the invocation', async () => {
      const rawCommand = "python -c 'print(1)'";
      const executeSpy = vi.fn();
      const getConfirmationDetails = vi.fn();
      const build = vi.fn((input: Record<string, unknown>) => {
        input['command'] = 'touch changed.txt';
        return {
          params: input,
          getDefaultPermission: vi.fn().mockResolvedValue('allow'),
          getConfirmationDetails,
          getDescription: vi.fn().mockReturnValue('touch changed.txt'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: executeSpy,
        };
      });
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build,
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn().mockReturnValue(2);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-build-mutation',
                  name: core.ToolNames.SHELL,
                  args: { command: rawCommand },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run wrapper' }],
      });

      expect(build).toHaveBeenCalledOnce();
      expect(getConfirmationDetails).not.toHaveBeenCalled();
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('exact invocation changed'),
          }),
        }),
      );
    });

    it('cancels forged ACP outcomes that were not offered', async () => {
      const rawCommand = "python -c 'print(1)'";
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const executeSpy = vi.fn();
      const invocation = {
        params: { command: rawCommand },
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell',
          command: rawCommand,
          rootCommand: 'python',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue(rawCommand),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn().mockReturnValue(3);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      vi.mocked(mockClient.requestPermission).mockImplementation(
        async (params) => {
          params.options.push({
            optionId: core.ToolConfirmationOutcome.ProceedAlwaysProject,
            name: 'Injected persistent approval',
            kind: 'allow_always',
          });
          return {
            outcome: {
              outcome: 'selected',
              optionId: core.ToolConfirmationOutcome.ProceedAlwaysProject,
            },
          };
        },
      );
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-forged',
                  name: core.ToolNames.SHELL,
                  args: { command: rawCommand },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run wrapper' }],
      });

      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('keeps ambient Shell cwd fixed after ACP approval is consumed', async () => {
      const rawCommand = "python -c 'print(1)'";
      const modelArgs = { command: rawCommand };
      let targetDir = '/workspace/one';
      const onConfirmSpy = vi.fn().mockImplementation(async () => {
        targetDir = '/workspace/two';
        modelArgs.command = 'touch changed.txt';
      });
      const executeSpy = vi.fn();
      const invocation = {
        params: modelArgs,
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell',
          command: rawCommand,
          rootCommand: 'python',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue(rawCommand),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn().mockReturnValue(4);
      mockConfig.getTargetDir = vi.fn(() => targetDir);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-cwd-consumed',
                  name: core.ToolNames.SHELL,
                  args: modelArgs,
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'inspect through wrapper' }],
      });

      expect(invocation.params).toEqual({
        command: rawCommand,
        directory: '/workspace/one',
      });
      expect(targetDir).toBe('/workspace/two');
      expect(modelArgs.command).toBe('touch changed.txt');
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.ProceedOnce,
        undefined,
      );
      expect(executeSpy).toHaveBeenCalledOnce();
    });

    it('invalidates ACP approval when ambient Shell cwd moves while pending', async () => {
      const rawCommand = "python -c 'print(1)'";
      let targetDir = '/workspace/one';
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const executeSpy = vi.fn();
      const invocation = {
        params: { command: rawCommand },
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell',
          command: rawCommand,
          rootCommand: 'python',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue(rawCommand),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn().mockReturnValue(4);
      mockConfig.getTargetDir = vi.fn(() => targetDir);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      vi.mocked(mockClient.requestPermission).mockImplementation(async () => {
        targetDir = '/workspace/two';
        return {
          outcome: {
            outcome: 'selected',
            optionId: core.ToolConfirmationOutcome.ProceedOnce,
          },
        };
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-cwd-stale',
                  name: core.ToolNames.SHELL,
                  args: { command: rawCommand },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'inspect through wrapper' }],
      });

      expect(invocation.params).toEqual({
        command: rawCommand,
        directory: '/workspace/one',
      });
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.Cancel,
        expect.objectContaining({
          cancelMessage: expect.stringContaining('no longer valid'),
        }),
      );
      expect(executeSpy).not.toHaveBeenCalled();
    });

    it('revalidates Plan shell context after a pending permission hook', async () => {
      const rawCommand = "python -c 'print(1)'";
      let revision = 4;
      const hookSpy = vi
        .spyOn(core, 'firePermissionRequestHook')
        .mockImplementation(async () => {
          revision++;
          return { hasDecision: false };
        });
      const executeSpy = vi.fn();
      const invocation = {
        params: { command: rawCommand },
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell',
          command: rawCommand,
          rootCommand: 'python',
          onConfirm: vi.fn().mockResolvedValue(undefined),
        }),
        getDescription: vi.fn().mockReturnValue(rawCommand),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      mockConfig.getApprovalModeRevision = vi.fn(() => revision);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({});
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-plan-hook-stale',
                  name: core.ToolNames.SHELL,
                  args: { command: rawCommand },
                },
              ],
            },
          },
        ]),
      );

      try {
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'inspect through wrapper' }],
        });
      } finally {
        hookSpy.mockRestore();
      }

      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          error: expect.objectContaining({
            message: expect.stringContaining('no longer valid'),
          }),
        }),
      );
    });

    it('returns permission error for disabled tools (L1 isToolEnabled check)', async () => {
      const executeSpy = vi.fn();
      const invocation = {
        params: { path: '/tmp/file.txt' },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'info',
          title: 'Need permission',
          prompt: 'Allow?',
          onConfirm: vi.fn(),
        }),
        getDescription: vi.fn().mockReturnValue('Write file'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: 'write_file',
        kind: core.Kind.Edit,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      // Mock a PermissionManager that denies the tool
      mockConfig.getPermissionManager = vi.fn().mockReturnValue({
        isToolEnabled: vi.fn().mockResolvedValue(false),
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-denied',
                  name: 'write_file',
                  args: { path: '/tmp/file.txt' },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'write something' }],
      });

      // Tool should NOT have been executed
      expect(executeSpy).not.toHaveBeenCalled();
      // No permission dialog should have been opened
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(addToolArgumentsAttributesSpy).not.toHaveBeenCalled();
      expect(addToolCallResultAttributesSpy).not.toHaveBeenCalled();
    });

    it('threads MCP permission aliases into the L1 isToolEnabled gate', async () => {
      // A legacy-spelled MCP deny can only name the registered provider-safe
      // tool through the tool's advertised permissionAliases. The ACP L1 gate
      // must resolve the same channel the scheduler's gate does (#10199);
      // the invocation (and its L4 alias channel) is only built AFTER this
      // check, so the aliases have to come from the tool itself.
      const mcpTool = new core.DiscoveredMCPTool(
        {} as never,
        'foo.bar',
        'search',
        'description',
        {},
      );
      expect(mcpTool.permissionAliases).toEqual(['mcp__foo.bar__search']);
      const buildSpy = vi.spyOn(mcpTool, 'build');

      mockToolRegistry.getTool.mockReturnValue(mcpTool);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      const isToolEnabled = vi.fn().mockResolvedValue(false);
      mockConfig.getPermissionManager = vi
        .fn()
        .mockReturnValue({ isToolEnabled });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-mcp-disabled',
                  name: mcpTool.name,
                  args: {},
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'call the mcp tool' }],
      });

      expect(isToolEnabled).toHaveBeenCalledWith(
        mcpTool.name,
        mcpTool.permissionAliases,
        { serverName: 'foo.bar', serverToolName: 'search' },
      );
      // The L1 gate refused up front: the invocation was never built.
      expect(buildSpy).not.toHaveBeenCalled();
    });

    it('respects permission-request hook allow decisions without opening ACP permission dialog', async () => {
      const hookSpy = vi
        .spyOn(core, 'firePermissionRequestHook')
        .mockResolvedValue({
          hasDecision: true,
          shouldAllow: true,
          updatedInput: { path: '/tmp/updated.txt' },
          denyMessage: undefined,
        });
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const invocation = {
        params: { path: '/tmp/original.txt' },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'info',
          title: 'Need permission',
          prompt: 'Allow?',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue('Inspect file'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: 'read_file',
        kind: core.Kind.Read,
        build: vi.fn((params: Record<string, unknown>) => ({
          ...invocation,
          params,
        })),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockReturnValue(ApprovalMode.DEFAULT);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({});
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-2',
                  name: 'read_file',
                  args: { path: '/tmp/original.txt' },
                },
              ],
            },
          },
        ]),
      );

      try {
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'run tool' }],
        });
      } finally {
        hookSpy.mockRestore();
      }

      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.ProceedOnce,
      );
      // Rebuilt from the replacement rather than patched in place.
      expect(tool.build).toHaveBeenCalledWith({ path: '/tmp/updated.txt' });
      expect(invocation.params).toEqual({ path: '/tmp/original.txt' });
      expect(executeSpy).toHaveBeenCalled();
      expect(addToolArgumentsAttributesSpy).toHaveBeenCalledWith(
        mockConfig,
        expect.anything(),
        { path: '/tmp/updated.txt' },
      );
    });

    it.each([
      ['live update', 'live', true],
      ['history replay', 'replay', false],
      ['failed replacement', 'failed', true],
      ['mode transition', 'cleared', false],
      ['empty plan update', 'empty-entries', false],
      ['plan update without identity', 'missing-meta', false],
    ] as const)(
      'keeps exit_plan_mode approval revision correct after %s',
      async (_label, revisionSource, expectsRevision) => {
        enableSessionWorkflowRevisionContext();
        let mode = ApprovalMode.PLAN;
        const hookSpy = vi
          .spyOn(core, 'firePermissionRequestHook')
          .mockResolvedValue({
            hasDecision: true,
            shouldAllow: true,
            updatedInput: { plan: 'Hook-replaced plan' },
            denyMessage: undefined,
          });
        const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
        const executeSpy = vi.fn().mockImplementation(async () => {
          const updatesBeforeExecute = vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.filter(
              ([params]) =>
                params.update.sessionUpdate === 'current_mode_update',
            );
          expect(mode).toBe(ApprovalMode.PLAN);
          expect(updatesBeforeExecute).toHaveLength(0);
          mode = ApprovalMode.DEFAULT;
          return { llmContent: 'approved', returnDisplay: 'approved' };
        });
        const invocation = {
          params: { plan: 'Original plan' },
          requiresUserInteraction: vi.fn().mockReturnValue(true),
          getDefaultPermission: vi.fn().mockResolvedValue('ask'),
          getConfirmationDetails: vi.fn().mockResolvedValue({
            type: 'plan',
            title: 'Approve plan',
            plan: 'Original plan',
            hideAlwaysAllow: true,
            onConfirm: onConfirmSpy,
          }),
          getDescription: vi.fn().mockReturnValue('Plan:'),
          toolLocations: vi.fn().mockReturnValue([]),
          execute: executeSpy,
        };
        const tool = {
          name: core.ToolNames.EXIT_PLAN_MODE,
          kind: core.Kind.Think,
          build: vi.fn().mockReturnValue(invocation),
        };

        mockToolRegistry.getTool.mockReturnValue(tool);
        mockConfig.getApprovalMode = vi.fn(() => mode);
        mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.getMessageBus = vi.fn().mockReturnValue({});
        mockChat.sendMessageStream = vi.fn().mockResolvedValue(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'call-exit-plan',
                    name: core.ToolNames.EXIT_PLAN_MODE,
                    args: { plan: 'Original plan' },
                  },
                ],
              },
            },
          ]),
        );
        const planUpdate: SessionUpdate = {
          sessionUpdate: 'plan',
          entries: [
            {
              content: 'Ship',
              priority: 'medium',
              status: 'pending',
              _meta: { qwenTodo: { id: 'ship' } },
            },
          ],
          _meta: {
            qwenSessionWorkflow: true,
            qwenTodoPlan: { id: 'plan-1' },
            qwenTranscript: { planToolCallId: 'todo-call-1' },
          },
        };
        if (revisionSource === 'replay') {
          // A reloaded session replays the previous cycle's todo_write result;
          // the replayed plan update must not bind the next approval.
          await session.replayHistory([
            chatRecord({
              uuid: 'todo-exec-1',
              type: 'tool_result',
              message: {
                parts: [
                  {
                    functionResponse: {
                      name: core.ToolNames.TODO_WRITE,
                      id: 'stale-call',
                      response: {},
                    },
                  },
                ],
              },
              toolCallResult: {
                callId: 'stale-call',
                resultDisplay: {
                  type: 'todo_list',
                  planId: 'stale-plan',
                  todos: [
                    { id: '1', content: 'Done task', status: 'completed' },
                  ],
                },
              },
            }),
          ]);
        } else if (revisionSource === 'empty-entries') {
          await session.sendUpdate({ ...planUpdate, entries: [] });
        } else if (revisionSource === 'missing-meta') {
          await session.sendUpdate({
            sessionUpdate: 'plan',
            entries: planUpdate.entries,
          });
        } else {
          await session.sendUpdate(planUpdate);
        }
        if (revisionSource === 'failed') {
          vi.mocked(mockClient.sessionUpdate).mockRejectedValueOnce(
            new Error('connection lost'),
          );
          await expect(
            session.sendUpdate({
              ...planUpdate,
              _meta: {
                qwenTodoPlan: { id: 'plan-2' },
                qwenTranscript: { planToolCallId: 'todo-call-2' },
              },
            }),
          ).rejects.toThrow('connection lost');
        }
        if (revisionSource === 'cleared') {
          session.clearActiveTodoPlanRevision();
        }

        try {
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'approve the plan' }],
          });
        } finally {
          hookSpy.mockRestore();
        }

        expect(mockClient.requestPermission).toHaveBeenCalledWith(
          expect.objectContaining({
            options: [
              expect.objectContaining({
                kind: 'allow_once',
                optionId: core.ToolConfirmationOutcome.RestorePrevious,
              }),
              expect.objectContaining({
                kind: 'allow_always',
                optionId: core.ToolConfirmationOutcome.ProceedAlways,
              }),
              expect.objectContaining({
                kind: 'allow_once',
                optionId: core.ToolConfirmationOutcome.ProceedOnce,
              }),
              expect.objectContaining({
                kind: 'reject_once',
                optionId: core.ToolConfirmationOutcome.Cancel,
              }),
            ],
            toolCall: expect.objectContaining({
              kind: 'switch_mode',
              rawInput: { plan: 'Original plan' },
              _meta: expectsRevision
                ? expect.objectContaining({
                    qwenTodoApproval: {
                      planId: 'plan-1',
                      sourceCallId: 'todo-call-1',
                    },
                  })
                : expect.not.objectContaining({
                    qwenTodoApproval: expect.anything(),
                  }),
            }),
          }),
        );
        expect(onConfirmSpy).toHaveBeenCalledWith(
          core.ToolConfirmationOutcome.ProceedOnce,
          { answers: undefined },
        );
        expect(invocation.params).toEqual({ plan: 'Original plan' });
        const modeUpdates = vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.filter(
            ([params]) => params.update.sessionUpdate === 'current_mode_update',
          );
        expect(modeUpdates).toHaveLength(1);
        expect(modeUpdates[0]?.[0].update).toMatchObject({
          currentModeId: ApprovalMode.DEFAULT,
        });
      },
    );

    it.each([
      [
        'Session revision is cleared',
        async () => session.clearActiveTodoPlanRevision(),
      ],
      [
        'Config revision is cleared',
        async () => mockConfig.clearSessionWorkflowPlanRevision?.(),
      ],
      [
        'revision identity is replaced',
        async () =>
          session.sendUpdate({
            sessionUpdate: 'plan',
            entries: [
              {
                content: 'Ship',
                priority: 'medium',
                status: 'pending',
                _meta: { qwenTodo: { id: 'ship' } },
              },
            ],
            _meta: {
              qwenSessionWorkflow: true,
              qwenTodoPlan: { id: 'plan-1' },
              qwenTranscript: { planToolCallId: 'todo-call-2' },
            },
          }),
      ],
    ] as const)(
      'cancels a revision-bound plan exit when the %s',
      async (_label, invalidateRevision) => {
        enableSessionWorkflowRevisionContext();
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
        let resolvePermission!: (
          response: Awaited<
            ReturnType<AgentSideConnection['requestPermission']>
          >,
        ) => void;
        vi.mocked(mockClient.requestPermission).mockReturnValue(
          new Promise((resolve) => {
            resolvePermission = resolve;
          }),
        );
        await session.sendUpdate({
          sessionUpdate: 'plan',
          entries: [
            {
              content: 'Ship',
              priority: 'medium',
              status: 'pending',
              _meta: { qwenTodo: { id: 'ship' } },
            },
          ],
          _meta: {
            qwenSessionWorkflow: true,
            qwenTodoPlan: { id: 'plan-1' },
            qwenTranscript: { planToolCallId: 'todo-call-1' },
          },
        });

        const prompt = runExitPlanModeApprovalPrompt();
        await vi.waitFor(() =>
          expect(mockClient.requestPermission).toHaveBeenCalledOnce(),
        );
        expect(
          vi.mocked(mockClient.requestPermission).mock.calls[0]?.[0].toolCall
            ._meta,
        ).toEqual(
          expect.objectContaining({
            qwenTodoApproval: {
              planId: 'plan-1',
              sourceCallId: 'todo-call-1',
            },
          }),
        );

        await invalidateRevision();
        resolvePermission({
          outcome: {
            outcome: 'selected',
            optionId: core.ToolConfirmationOutcome.ProceedOnce,
          },
        });
        await prompt;

        expect(
          vi
            .mocked(mockClient.sessionUpdate)
            .mock.calls.filter(
              ([params]) =>
                params.update.sessionUpdate === 'current_mode_update',
            ),
        ).toHaveLength(0);
        expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
          expect.arrayContaining([
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                response: {
                  error: expect.stringContaining('Workflow revision changed'),
                },
              }),
            }),
          ]),
          expect.objectContaining({
            status: 'cancelled',
            executionStatus: 'not_started',
          }),
        );
      },
    );

    it('rechecks a revision-bound plan exit after the invocation guard', async () => {
      enableSessionWorkflowRevisionContext();
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
      let resolveGuard!: (decision: { allowed: boolean }) => void;
      const guard = vi.fn().mockReturnValueOnce(
        new Promise((resolve) => {
          resolveGuard = resolve;
        }),
      );
      mockConfig.getToolInvocationGuard = vi.fn().mockReturnValue(guard);
      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          {
            content: 'Ship',
            priority: 'medium',
            status: 'pending',
            _meta: { qwenTodo: { id: 'ship' } },
          },
        ],
        _meta: {
          qwenSessionWorkflow: true,
          qwenTodoPlan: { id: 'plan-1' },
          qwenTranscript: { planToolCallId: 'todo-call-1' },
        },
      });

      const prompt = runExitPlanModeApprovalPrompt();
      await vi.waitFor(() => expect(guard).toHaveBeenCalledOnce());
      session.clearActiveTodoPlanRevision();
      resolveGuard({ allowed: true });
      await prompt;

      expect(
        vi
          .mocked(mockClient.sessionUpdate)
          .mock.calls.filter(
            ([params]) => params.update.sessionUpdate === 'current_mode_update',
          ),
      ).toHaveLength(0);
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            functionResponse: expect.objectContaining({
              response: {
                error: expect.stringContaining('Workflow revision changed'),
              },
            }),
          }),
        ]),
        expect.objectContaining({
          status: 'cancelled',
          executionStatus: 'not_started',
        }),
      );
    });

    it('clears the captured revision when enter_plan_mode execution enters plan mode', async () => {
      let mode = ApprovalMode.DEFAULT;
      const executeSpy = vi.fn().mockImplementation(async () => {
        mode = ApprovalMode.PLAN;
        return { llmContent: 'entered', returnDisplay: 'entered' };
      });
      const invocation = {
        params: {},
        getDefaultPermission: vi.fn().mockResolvedValue('allow'),
        getConfirmationDetails: vi.fn(),
        getDescription: vi.fn().mockReturnValue('Enter plan mode'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: core.ToolNames.ENTER_PLAN_MODE,
        kind: core.Kind.Think,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi.fn(() => mode);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getMessageBus = vi.fn().mockReturnValue({});
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-enter-plan',
                  name: core.ToolNames.ENTER_PLAN_MODE,
                  args: {},
                },
              ],
            },
          },
        ]),
      );
      await session.sendUpdate({
        sessionUpdate: 'plan',
        entries: [
          { content: 'Old cycle', priority: 'medium', status: 'pending' },
        ],
        _meta: {
          qwenTodoPlan: { id: 'old-plan' },
          qwenTranscript: { planToolCallId: 'old-call' },
        },
      });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'plan this' }],
      });

      expect(executeSpy).toHaveBeenCalled();
      const request = await runExitPlanModeApprovalPrompt();
      expect(request.toolCall._meta).toEqual(
        expect.not.objectContaining({
          qwenTodoApproval: expect.anything(),
        }),
      );
    });

    it('routes ACP protected L4 allow writes through AUTO review', async () => {
      const cwd = '/repo';
      let denialState = {
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 0,
        totalUnavailable: 0,
      };
      const baseLlmClient = {
        generateJson: vi.fn().mockResolvedValue({ shouldBlock: false }),
      };
      const getHistoryTail = vi.fn().mockReturnValue([]);
      const permissionManager = {
        isToolEnabled: vi.fn().mockResolvedValue(true),
        hasRelevantRules: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockResolvedValue('allow'),
        hasMatchingAskRule: vi.fn().mockReturnValue(false),
        findMatchingDenyRule: vi.fn(),
      };
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const invocation = {
        params: { file_path: '/repo/.qwen/settings.json', content: '{}' },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'edit',
          title: 'Confirm file write',
          fileName: '/repo/.qwen/settings.json',
          fileDiff: 'diff',
          onConfirm: vi.fn(),
        }),
        getDescription: vi.fn().mockReturnValue('Write file'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: core.ToolNames.WRITE_FILE,
        kind: core.Kind.Edit,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.AUTO);
      mockConfig.getTargetDir = vi.fn().mockReturnValue(cwd);
      mockConfig.getCwd = vi.fn().mockReturnValue(cwd);
      mockConfig.getPermissionManager = vi
        .fn()
        .mockReturnValue(permissionManager);
      mockConfig.getAutoModeDenialState = vi
        .fn()
        .mockImplementation(() => denialState);
      mockConfig.setAutoModeDenialState = vi
        .fn()
        .mockImplementation((next: typeof denialState) => {
          denialState = next;
        });
      mockConfig.getBaseLlmClient = vi.fn().mockReturnValue(baseLlmClient);
      mockConfig.getLlmClient = vi
        .fn()
        .mockReturnValue({ ...mockLlmClient, getHistoryTail });
      mockConfig.getAutoModeSettings = vi.fn().mockReturnValue({});
      mockConfig.getModel = vi.fn().mockReturnValue('test-model');
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getMessageBus = vi.fn().mockReturnValue(undefined);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-protected-write',
                  name: core.ToolNames.WRITE_FILE,
                  args: {
                    file_path: '/repo/.qwen/settings.json',
                    content: '{}',
                  },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run shell command' }],
      });

      expect(permissionManager.evaluate).toHaveBeenCalled();
      expect(getHistoryTail).toHaveBeenCalled();
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalled();
    });

    it('routes ACP Bash(*) protected writes through AUTO review', async () => {
      const cwd = '/repo';
      const command = "echo '{}' > .qwen/settings.json";
      let denialState = {
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 0,
        totalUnavailable: 0,
      };
      const baseLlmClient = {
        generateJson: vi.fn().mockResolvedValue({ shouldBlock: false }),
      };
      const getHistoryTail = vi.fn().mockReturnValue([]);
      const permissionManager = new core.PermissionManager({
        getPermissionsAllow: () => ['Bash(*)'],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [],
        getCoreTools: () => undefined,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getProjectRoot: () => cwd,
        getCwd: () => cwd,
      });
      permissionManager.initialize();

      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const invocation = {
        params: { command },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell command',
          command,
          rootCommand: 'echo',
          onConfirm: vi.fn(),
        }),
        getDescription: vi.fn().mockReturnValue('Run shell command'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.AUTO);
      mockConfig.getTargetDir = vi.fn().mockReturnValue(cwd);
      mockConfig.getCwd = vi.fn().mockReturnValue(cwd);
      mockConfig.getPermissionManager = vi
        .fn()
        .mockReturnValue(permissionManager);
      mockConfig.getAutoModeDenialState = vi
        .fn()
        .mockImplementation(() => denialState);
      mockConfig.setAutoModeDenialState = vi
        .fn()
        .mockImplementation((next: typeof denialState) => {
          denialState = next;
        });
      mockConfig.getBaseLlmClient = vi.fn().mockReturnValue(baseLlmClient);
      mockConfig.getLlmClient = vi
        .fn()
        .mockReturnValue({ ...mockLlmClient, getHistoryTail });
      mockConfig.getAutoModeSettings = vi.fn().mockReturnValue({});
      mockConfig.getModel = vi.fn().mockReturnValue('test-model');
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getMessageBus = vi.fn().mockReturnValue(undefined);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-protected-shell-write',
                  name: core.ToolNames.SHELL,
                  args: { command },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run shell command' }],
      });

      expect(baseLlmClient.generateJson).toHaveBeenCalled();
      expect(getHistoryTail).toHaveBeenCalled();
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(executeSpy).toHaveBeenCalled();
    });

    it('blocks ACP Bash(*) protected writes when AUTO classifier denies', async () => {
      const cwd = '/repo';
      const command = "echo '{}' > .qwen/settings.json";
      let denialState = {
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 0,
        totalUnavailable: 0,
      };
      const baseLlmClient = {
        generateJson: vi
          .fn()
          .mockResolvedValueOnce({ shouldBlock: true })
          .mockResolvedValueOnce({
            thinking: 'protected self-modification write',
            shouldBlock: true,
            reason: 'protected write',
          }),
      };
      const getHistoryTail = vi.fn().mockReturnValue([]);
      const permissionManager = new core.PermissionManager({
        getPermissionsAllow: () => ['Bash(*)'],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [],
        getCoreTools: () => undefined,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getProjectRoot: () => cwd,
        getCwd: () => cwd,
      });
      permissionManager.initialize();
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const invocation = {
        params: { command },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell command',
          command,
          rootCommand: 'echo',
          onConfirm: vi.fn(),
        }),
        getDescription: vi.fn().mockReturnValue('Run shell command'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.AUTO);
      mockConfig.getTargetDir = vi.fn().mockReturnValue(cwd);
      mockConfig.getCwd = vi.fn().mockReturnValue(cwd);
      mockConfig.getPermissionManager = vi
        .fn()
        .mockReturnValue(permissionManager);
      mockConfig.getAutoModeDenialState = vi
        .fn()
        .mockImplementation(() => denialState);
      mockConfig.setAutoModeDenialState = vi
        .fn()
        .mockImplementation((next: typeof denialState) => {
          denialState = next;
        });
      mockConfig.getBaseLlmClient = vi.fn().mockReturnValue(baseLlmClient);
      mockConfig.getLlmClient = vi
        .fn()
        .mockReturnValue({ ...mockLlmClient, getHistoryTail });
      mockConfig.getAutoModeSettings = vi.fn().mockReturnValue({});
      mockConfig.getModel = vi.fn().mockReturnValue('test-model');
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getMessageBus = vi.fn().mockReturnValue(undefined);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-protected-shell-write',
                  name: core.ToolNames.SHELL,
                  args: { command },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run shell command' }],
      });

      expect(baseLlmClient.generateJson).toHaveBeenCalled();
      expect(getHistoryTail).toHaveBeenCalled();
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(executeSpy).not.toHaveBeenCalled();
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            functionResponse: expect.objectContaining({
              name: core.ToolNames.SHELL,
              response: expect.objectContaining({
                error: expect.stringContaining('protected write'),
              }),
            }),
          }),
        ]),
        expect.objectContaining({ callId: 'call-protected-shell-write' }),
      );
    });

    it('asks when the AUTO classifier is unavailable and can switch to Default', async () => {
      const cwd = '/repo';
      const command = "echo '{}' > .qwen/settings.json";
      let approvalMode = ApprovalMode.AUTO;
      let denialState = {
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 0,
        totalUnavailable: 0,
      };
      const baseLlmClient = {
        generateJson: vi.fn().mockRejectedValue(new Error('classifier 503')),
      };
      const getHistoryTail = vi.fn().mockReturnValue([]);
      const permissionManager = new core.PermissionManager({
        getPermissionsAllow: () => ['Bash(*)'],
        getPermissionsAsk: () => [],
        getPermissionsDeny: () => [],
        getCoreTools: () => undefined,
        getApprovalMode: () => ApprovalMode.DEFAULT,
        getProjectRoot: () => cwd,
        getCwd: () => cwd,
      });
      permissionManager.initialize();
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const invocation = {
        params: { command },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Confirm shell command',
          command,
          rootCommand: 'echo',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue('Run shell command'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi
        .fn()
        .mockImplementation(() => approvalMode);
      mockConfig.setApprovalMode = vi.fn().mockImplementation((mode) => {
        approvalMode = mode;
      });
      mockConfig.getTargetDir = vi.fn().mockReturnValue(cwd);
      mockConfig.getCwd = vi.fn().mockReturnValue(cwd);
      mockConfig.getPermissionManager = vi
        .fn()
        .mockReturnValue(permissionManager);
      mockConfig.getAutoModeDenialState = vi
        .fn()
        .mockImplementation(() => denialState);
      mockConfig.setAutoModeDenialState = vi
        .fn()
        .mockImplementation((next: typeof denialState) => {
          denialState = next;
        });
      mockConfig.getBaseLlmClient = vi.fn().mockReturnValue(baseLlmClient);
      mockConfig.getLlmClient = vi
        .fn()
        .mockReturnValue({ ...mockLlmClient, getHistoryTail });
      mockConfig.getAutoModeSettings = vi.fn().mockReturnValue({});
      mockConfig.getModel = vi.fn().mockReturnValue('test-model');
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getMessageBus = vi.fn().mockReturnValue(undefined);
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: {
          outcome: 'selected',
          optionId: core.ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
        },
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-classifier-unavailable',
                  name: core.ToolNames.SHELL,
                  args: { command },
                },
              ],
            },
          },
        ]),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run shell command' }],
      });

      expect(mockClient.requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          options: [
            expect.objectContaining({
              optionId: core.ToolConfirmationOutcome.ProceedOnce,
            }),
            expect.objectContaining({
              optionId:
                core.ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
              name: expect.stringContaining('recommended'),
            }),
            expect.objectContaining({
              optionId: core.ToolConfirmationOutcome.Cancel,
            }),
          ],
          toolCall: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                content: expect.objectContaining({
                  text: expect.stringContaining(
                    "Auto Mode couldn't classify this action",
                  ),
                }),
              }),
            ]),
          }),
        }),
      );
      expect(onConfirmSpy).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.ProceedOnce,
        { answers: undefined },
      );
      expect(mockConfig.setApprovalMode).toHaveBeenCalledWith(
        ApprovalMode.DEFAULT,
      );
      expect(approvalMode).toBe(ApprovalMode.DEFAULT);
      expect(executeSpy).toHaveBeenCalled();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'current_mode_update',
            currentModeId: ApprovalMode.DEFAULT,
          }),
        }),
      );
    });

    it('resets AUTO denial counters when the user approves a denialTracking fallback prompt', async () => {
      const executeSpy = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirmSpy = vi.fn().mockResolvedValue(undefined);
      const setAutoModeDenialState = vi.fn();
      const invocation = {
        params: { command: 'python -c "print(1)"' },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Need permission',
          command: 'python',
          rootCommand: 'python',
          onConfirm: onConfirmSpy,
        }),
        getDescription: vi.fn().mockReturnValue('Run command'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute: executeSpy,
      };
      const tool = {
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn().mockReturnValue(invocation),
      };

      mockToolRegistry.getTool.mockReturnValue(tool);
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.AUTO);
      mockConfig.getCwd = vi.fn().mockReturnValue('/repo');
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getMessageBus = vi.fn().mockReturnValue(undefined);
      mockConfig.getAutoModeSettings = vi.fn().mockReturnValue({});
      mockConfig.getAutoModeDenialState = vi.fn().mockReturnValue({
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 20,
        totalUnavailable: 0,
      });
      mockConfig.setAutoModeDenialState = setAutoModeDenialState;
      (
        mockLlmClient as unknown as {
          getHistoryTail: ReturnType<typeof vi.fn>;
        }
      ).getHistoryTail = vi.fn().mockReturnValue([]);
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: 'call-auto-fallback-hook-approved',
                  name: core.ToolNames.SHELL,
                  args: { command: 'python -c "print(1)"' },
                },
              ],
            },
          },
        ]),
      );
      debugLoggerWarnSpy.mockClear();

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run tool' }],
      });

      await vi.waitFor(() => {
        expect(mockClient.requestPermission).toHaveBeenCalled();
        expect(onConfirmSpy).toHaveBeenCalledWith(
          core.ToolConfirmationOutcome.ProceedOnce,
          { answers: undefined },
        );
        expect(setAutoModeDenialState).toHaveBeenCalledWith({
          consecutiveBlock: 0,
          consecutiveUnavailable: 0,
          totalBlock: 0,
          totalUnavailable: 0,
        });
        expect(executeSpy).toHaveBeenCalled();
      });
      expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Auto mode denial counters reset after fallback approval',
        ),
      );
    });

    function configureAutoModeShellFallback(options: {
      callId: string;
      command: string;
      denialState: core.AutoModeDenialState;
      classifierResults?: Array<Record<string, unknown>>;
    }) {
      let denialState = options.denialState;
      const generateJson = vi.fn();
      for (const result of options.classifierResults ?? []) {
        generateJson.mockResolvedValueOnce(result);
      }
      const execute = vi.fn().mockResolvedValue({
        llmContent: 'ok',
        returnDisplay: 'ok',
      });
      const onConfirm = vi.fn().mockResolvedValue(undefined);
      const invocation = {
        params: { command: options.command },
        getDefaultPermission: vi.fn().mockResolvedValue('ask'),
        getConfirmationDetails: vi.fn().mockResolvedValue({
          type: 'exec',
          title: 'Need permission',
          command: options.command,
          rootCommand: 'python',
          onConfirm,
        }),
        getDescription: vi.fn().mockReturnValue('Run command'),
        toolLocations: vi.fn().mockReturnValue([]),
        execute,
      };
      mockToolRegistry.getTool.mockReturnValue({
        name: core.ToolNames.SHELL,
        kind: core.Kind.Execute,
        build: vi.fn((params: Record<string, unknown>) => ({
          ...invocation,
          params,
        })),
      });
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.AUTO);
      mockConfig.getCwd = vi.fn().mockReturnValue('/repo');
      mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);
      mockConfig.getMessageBus = vi.fn().mockReturnValue(undefined);
      mockConfig.getAutoModeSettings = vi.fn().mockReturnValue({});
      mockConfig.getBaseLlmClient = vi.fn().mockReturnValue({ generateJson });
      mockConfig.getAutoModeDenialState = vi
        .fn()
        .mockImplementation(() => denialState);
      mockConfig.setAutoModeDenialState = vi
        .fn()
        .mockImplementation((next: core.AutoModeDenialState) => {
          denialState = next;
        });
      (
        mockLlmClient as unknown as {
          getHistoryTail: ReturnType<typeof vi.fn>;
        }
      ).getHistoryTail = vi.fn().mockReturnValue([]);
      vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
        outcome: {
          outcome: 'selected',
          optionId: core.ToolConfirmationOutcome.ProceedOnce,
        },
      });
      mockChat.sendMessageStream = vi.fn().mockResolvedValue(
        createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              functionCalls: [
                {
                  id: options.callId,
                  name: core.ToolNames.SHELL,
                  args: { command: options.command },
                },
              ],
            },
          },
        ]),
      );

      return {
        execute,
        generateJson,
        getDenialState: () => denialState,
        onConfirm,
      };
    }

    it.each([
      {
        label: 'direct destructive escalation',
        command: 'git reset --hard',
        state: { totalBlock: 19 },
        updatedInput: undefined,
        allow: true,
        asks: true,
      },
      {
        label: 'destructive hook replacement',
        command: 'python -c "print(1)"',
        state: { totalBlock: 20 },
        updatedInput: { command: 'git reset --hard' },
        allow: true,
        asks: true,
      },
      {
        label: 'ordinary fallback hook allow',
        command: 'python -c "print(1)"',
        state: { totalBlock: 20 },
        updatedInput: undefined,
        allow: true,
        asks: false,
      },
      {
        label: 'destructive fallback hook deny',
        command: 'git reset --hard',
        state: { totalBlock: 19 },
        updatedInput: undefined,
        allow: false,
        asks: false,
      },
    ])(
      'keeps ACP manual approval for $label',
      async ({ command, state, updatedInput, allow, asks }) => {
        const { execute, onConfirm } = configureAutoModeShellFallback({
          callId: 'destructive-fallback',
          command,
          denialState: {
            consecutiveBlock: 0,
            consecutiveUnavailable: 0,
            totalUnavailable: 0,
            ...state,
          },
        });
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.getMessageBus = vi.fn().mockReturnValue({
          request: vi.fn().mockResolvedValue({ success: true, output: {} }),
        });
        const permissionHook = vi
          .spyOn(core, 'firePermissionRequestHook')
          .mockResolvedValue({
            hasDecision: true,
            shouldAllow: allow,
            updatedInput,
          });
        vi.mocked(mockClient.requestPermission)
          .mockReset()
          .mockImplementation(async (request) => {
            expect(execute).not.toHaveBeenCalled();
            expect(onConfirm).not.toHaveBeenCalled();
            expect(request.toolCall.rawInput).toEqual({
              command: 'git reset --hard',
            });
            return {
              outcome: {
                outcome: 'selected',
                optionId: core.ToolConfirmationOutcome.ProceedOnce,
              },
            };
          });

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'run tool' }],
        });

        expect(permissionHook).toHaveBeenCalledOnce();
        expect(mockClient.requestPermission).toHaveBeenCalledTimes(
          asks ? 1 : 0,
        );
        expect(execute).toHaveBeenCalledTimes(allow ? 1 : 0);
      },
    );

    it('routes an exact ACP retry to manual approval without reclassifying it', async () => {
      const command = 'python -c "print(1)"';
      const { execute, generateJson, getDenialState, onConfirm } =
        configureAutoModeShellFallback({
          callId: 'call-exact-auto-retry',
          command,
          denialState: {
            consecutiveBlock: 1,
            consecutiveUnavailable: 0,
            totalBlock: 1,
            totalUnavailable: 0,
            pendingManualRetryFingerprint: core.getAutoModeActionFingerprint(
              core.ToolNames.SHELL,
              { command },
              '/repo',
            ),
          },
        });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'retry tool' }],
      });

      expect(generateJson).not.toHaveBeenCalled();
      expect(mockClient.requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCall: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                content: expect.objectContaining({
                  text: expect.stringContaining('previously blocked'),
                }),
              }),
            ]),
          }),
        }),
      );
      const permissionRequest = vi.mocked(mockClient.requestPermission).mock
        .calls[0][0];
      expect(permissionRequest.options).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            optionId:
              core.ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
          }),
        ]),
      );
      expect(onConfirm).toHaveBeenCalledWith(
        core.ToolConfirmationOutcome.ProceedOnce,
        { answers: undefined },
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(getDenialState()).toEqual({
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 1,
        totalUnavailable: 0,
      });
    });

    it('routes the current ACP threshold block to manual approval', async () => {
      const command = 'python -c "print(1)"';
      const { execute, generateJson, getDenialState } =
        configureAutoModeShellFallback({
          callId: 'call-current-threshold',
          command,
          denialState: {
            consecutiveBlock: 2,
            consecutiveUnavailable: 0,
            totalBlock: 2,
            totalUnavailable: 0,
          },
          classifierResults: [
            { shouldBlock: true },
            {
              thinking: 'confirmed',
              shouldBlock: true,
              reason: 'unsafe command',
            },
          ],
        });

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'run tool' }],
      });

      expect(generateJson).toHaveBeenCalledTimes(2);
      expect(mockClient.requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCall: expect.objectContaining({
            content: expect.arrayContaining([
              expect.objectContaining({
                content: expect.objectContaining({
                  text: expect.stringContaining('consecutive denial limit'),
                }),
              }),
            ]),
          }),
        }),
      );
      expect(execute).toHaveBeenCalledOnce();
      expect(getDenialState()).toEqual({
        consecutiveBlock: 0,
        consecutiveUnavailable: 0,
        totalBlock: 3,
        totalUnavailable: 0,
      });
    });

    describe('in-session cron MessageDisplay', () => {
      /** Mock scheduler that delivers exactly one in-session job through `start`. */
      function schedulerFiring(job: { prompt: string }) {
        return {
          size: 1,
          hasPendingWork: true,
          start: vi.fn((callback: (j: typeof job) => void) => callback(job)),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
      }

      it('fires MessageDisplay with cumulative text and a single is_final for an in-session cron fire', async () => {
        // The cron loop (Session.ts #executeCronPromptInner) creates its own
        // MessageDisplayDispatcher, independent of the ACP prompt path's -
        // a regression here would not be caught by the prompt-path test alone.
        const messageBus = { request: vi.fn().mockResolvedValue({}) };
        const scheduler = schedulerFiring({ prompt: 'nightly report' });
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation(
            (eventName: string) => eventName === 'MessageDisplay',
          );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [
                    { content: { parts: [{ text: 'cron result' }] } },
                  ],
                },
              },
            ]),
          );

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        await vi.waitFor(() => {
          const finals = messageBus.request.mock.calls.filter(
            ([request]) =>
              request.eventName === 'MessageDisplay' && request.input.is_final,
          );
          expect(finals).toHaveLength(1);
        });

        const messageDisplayCalls = messageBus.request.mock.calls.filter(
          ([request]) => request.eventName === 'MessageDisplay',
        );
        const finalCall =
          messageDisplayCalls[messageDisplayCalls.length - 1][0];
        expect(finalCall.input).toMatchObject({
          displayed_text: 'cron result',
          is_final: true,
        });
      });

      it('suppresses is_final for MessageDisplay when a cron fire is cancelled mid-stream', async () => {
        let releaseCron: () => void;
        const cronGate = new Promise<void>((resolve) => {
          releaseCron = resolve;
        });
        const cronStreamStarted = vi.fn();
        async function* cronStream() {
          cronStreamStarted();
          yield {
            type: core.StreamEventType.CHUNK,
            value: {
              candidates: [
                { content: { parts: [{ text: 'partial cron result' }] } },
              ],
            },
          };
          await cronGate;
        }

        const messageBus = { request: vi.fn().mockResolvedValue({}) };
        const scheduler = schedulerFiring({ prompt: 'nightly report' });
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation(
            (eventName: string) => eventName === 'MessageDisplay',
          );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(cronStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });

        // Wait until the cron fire's own streamed send has started (the
        // dispatcher exists and has received the first chunk) rather than
        // for a mid-stream MessageDisplay flush, which is debounced
        // (~200ms) and may not be due yet by the time we cancel.
        await vi.waitFor(() =>
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2),
        );
        expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalledTimes(
          1,
        );
        expect(
          mockChatRecordingService.recordCronPrompt.mock.invocationCallOrder[0],
        ).toBeGreaterThan(
          vi.mocked(mockChat.sendMessageStream).mock.invocationCallOrder[1]!,
        );
        expect(
          mockChatRecordingService.recordCronPrompt.mock.invocationCallOrder[0],
        ).toBeLessThan(cronStreamStarted.mock.invocationCallOrder[0]!);

        await session.cancelPendingPrompt();
        releaseCron!();

        expect(scheduler.stop).toHaveBeenCalled();
        expect(mockChatRecordingService.recordCronPrompt).toHaveBeenCalledTimes(
          1,
        );
        const finals = messageBus.request.mock.calls.filter(
          ([request]) =>
            request.eventName === 'MessageDisplay' && request.input.is_final,
        );
        expect(finals).toHaveLength(0);
      });
    });
    describe('hooks', () => {
      describe('PermissionDenied hook', () => {
        it('fires PermissionDenied hooks for AUTO classifier blocks', async () => {
          const hookSystem = {
            firePermissionDeniedEvent: vi.fn().mockResolvedValue(undefined),
          };
          mockConfig.getHookSystem = vi.fn().mockReturnValue(hookSystem);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          const signal = new AbortController().signal;

          await fireSessionPermissionDeniedForAutoMode(
            mockConfig,
            {
              via: 'classifier',
              shouldBlock: true,
              reason: 'dangerous shell command',
              unavailable: false,
              stage: 'fast',
              durationMs: 20,
            },
            {
              kind: 'blocked',
              errorMessage: 'blocked',
              reason: 'classifier_blocked',
            },
            core.ToolNames.SHELL,
            { command: 'rm -rf /tmp/example' },
            'auto-denied-acp',
            signal,
          );

          expect(hookSystem.firePermissionDeniedEvent).toHaveBeenCalledWith(
            core.ToolNames.SHELL,
            { command: 'rm -rf /tmp/example' },
            'auto-denied-acp',
            'classifier_blocked',
            signal,
            'auto-denied-acp',
          );
        });

        it('does not fire PermissionDenied hooks for classifier unavailability', async () => {
          const hookSystem = {
            firePermissionDeniedEvent: vi.fn().mockResolvedValue(undefined),
          };
          mockConfig.getHookSystem = vi.fn().mockReturnValue(hookSystem);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);

          await fireSessionPermissionDeniedForAutoMode(
            mockConfig,
            {
              via: 'classifier',
              shouldBlock: true,
              reason: 'classifier timeout',
              unavailable: true,
              stage: 'fast',
              durationMs: 3000,
            },
            {
              kind: 'fallback',
              reason: 'classifier_unavailable',
              message: 'Classifier unavailable.',
            },
            core.ToolNames.SHELL,
            { command: 'rm -rf /tmp/example' },
            'auto-denied-acp',
            new AbortController().signal,
          );

          expect(hookSystem.firePermissionDeniedEvent).not.toHaveBeenCalled();
        });

        it('continues AUTO block handling when PermissionDenied hook fails', async () => {
          const hookSystem = {
            firePermissionDeniedEvent: vi
              .fn()
              .mockRejectedValueOnce(new Error('hook failed')),
          };
          mockConfig.getHookSystem = vi.fn().mockReturnValue(hookSystem);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);

          await fireSessionPermissionDeniedForAutoMode(
            mockConfig,
            {
              via: 'classifier',
              shouldBlock: true,
              reason: 'dangerous shell command',
              unavailable: false,
              stage: 'fast',
              durationMs: 20,
            },
            {
              kind: 'blocked',
              errorMessage: 'blocked',
              reason: 'classifier_blocked',
            },
            core.ToolNames.SHELL,
            { command: 'rm -rf /tmp/example' },
            'auto-denied-acp',
            new AbortController().signal,
          );

          expect(hookSystem.firePermissionDeniedEvent).toHaveBeenCalled();
        });

        it('skips PermissionDenied hooks when hooks are disabled', async () => {
          const hookSystem = {
            firePermissionDeniedEvent: vi.fn().mockResolvedValue(undefined),
          };
          mockConfig.getHookSystem = vi.fn().mockReturnValue(hookSystem);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);

          await fireSessionPermissionDeniedForAutoMode(
            mockConfig,
            {
              via: 'classifier',
              shouldBlock: true,
              reason: 'dangerous shell command',
              unavailable: false,
              stage: 'fast',
              durationMs: 20,
            },
            {
              kind: 'blocked',
              errorMessage: 'blocked',
              reason: 'classifier_blocked',
            },
            core.ToolNames.SHELL,
            { command: 'rm -rf /tmp/example' },
            'auto-denied-acp',
            new AbortController().signal,
          );

          expect(hookSystem.firePermissionDeniedEvent).not.toHaveBeenCalled();
        });

        it('skips PermissionDenied hooks when AUTO outcome is not blocked', async () => {
          const hookSystem = {
            firePermissionDeniedEvent: vi.fn().mockResolvedValue(undefined),
          };
          mockConfig.getHookSystem = vi.fn().mockReturnValue(hookSystem);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);

          await fireSessionPermissionDeniedForAutoMode(
            mockConfig,
            {
              via: 'classifier',
              shouldBlock: true,
              reason: 'dangerous shell command',
              unavailable: false,
              stage: 'fast',
              durationMs: 20,
            },
            { kind: 'fallback', reason: 'safety_check' },
            core.ToolNames.SHELL,
            { command: 'rm -rf /tmp/example' },
            'auto-denied-acp',
            new AbortController().signal,
          );

          expect(hookSystem.firePermissionDeniedEvent).not.toHaveBeenCalled();
        });
      });

      describe('UserPromptSubmit hook', () => {
        it('fires UserPromptSubmit hook before sending prompt', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);

          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [{ content: { parts: [{ text: 'response' }] } }],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'UserPromptSubmit',
              input: { prompt: 'hello' },
            }),
            expect.anything(),
          );
        });

        it.each<{
          name: string;
          prompt: PromptRequest['prompt'];
          submitted?: string;
          declared?: unknown;
          displayText?: string;
          modelPrompt?: string;
          retry?: boolean;
          metaRetry?: boolean;
          channel?: boolean;
        }>([
          {
            name: 'text blocks without resource bodies',
            prompt: [
              { type: 'text', text: '  check' },
              {
                type: 'resource',
                resource: {
                  uri: 'file:///notes.txt',
                  text: 'PRIVATE RESOURCE',
                },
              },
              { type: 'text', text: 'this\n' },
            ],
            submitted: '  check this\n',
            declared: '  check this\n',
          },
          {
            name: 'explicit submission overrides unrelated display text',
            prompt: [{ type: 'text', text: 'internal channel instructions' }],
            displayText: 'display label',
            submitted: 'original question',
            declared: 'original question',
          },
          {
            name: 'display projection cannot declare submission provenance',
            prompt: [{ type: 'text', text: 'internal channel instructions' }],
            displayText: 'display text without a declaration',
          },
          {
            name: 'model-only delegation excluded',
            prompt: [{ type: 'text', text: 'original question' }],
            modelPrompt:
              '<realtime_delegation>private model context</realtime_delegation>',
            submitted: 'original question',
            declared: 'original question',
          },
          { name: 'blank text', prompt: [{ type: 'text', text: ' \n ' }] },
          {
            name: 'resource-only submission',
            prompt: [
              {
                type: 'resource',
                resource: {
                  uri: 'file:///notes.txt',
                  text: 'PRIVATE RESOURCE',
                },
              },
            ],
          },
          {
            name: 'legacy retry',
            prompt: [{ type: 'text', text: 'retry question' }],
            retry: true,
            declared: 'retry question',
          },
          {
            name: 'daemon retry',
            prompt: [{ type: 'text', text: 'retry question' }],
            metaRetry: true,
            declared: 'retry question',
          },
          {
            name: 'channel turn with display projection',
            prompt: [{ type: 'text', text: 'composed channel wrapper' }],
            displayText: 'Issue assigned: broken build',
            channel: true,
            declared: 'human channel message',
          },
          {
            name: 'channel turn without display projection',
            prompt: [{ type: 'text', text: 'composed channel wrapper' }],
            channel: true,
            declared: 'human channel message',
          },
          {
            name: 'machine dispatch without a declaration',
            prompt: [{ type: 'text', text: 'Run this scheduled task now' }],
          },
          {
            name: 'empty declaration never falls back to request text',
            prompt: [{ type: 'text', text: 'internal wrapper' }],
            declared: '',
          },
          {
            name: 'blank declaration',
            prompt: [{ type: 'text', text: 'internal wrapper' }],
            declared: '  \n',
          },
          {
            name: 'invalid declaration',
            prompt: [{ type: 'text', text: 'internal wrapper' }],
            declared: { text: 'not a string' },
          },
        ])(
          'preserves submission provenance: $name',
          async ({
            prompt,
            submitted,
            declared,
            displayText,
            modelPrompt,
            retry,
            metaRetry,
            channel,
          }) => {
            const messageBus = {
              request: vi.fn().mockResolvedValue({ success: true, output: {} }),
            };
            mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
            mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
            mockConfig.hasHooksForEvent = vi
              .fn()
              .mockImplementation(
                (eventName: string) => eventName === 'UserPromptSubmit',
              );
            mockChat.sendMessageStream = vi
              .fn()
              .mockResolvedValue(createEmptyStream());

            await session.prompt(
              {
                sessionId: 'test-session-id',
                prompt,
                ...(retry ? { retry: true } : {}),
                _meta: {
                  ...(declared !== undefined
                    ? { 'qwen.daemon.submittedPrompt': declared }
                    : {}),
                  ...(channel ? { [CHANNEL_PROMPT_META_KEY]: true } : {}),
                  ...(displayText !== undefined
                    ? { 'qwen.daemon.promptDisplayText': displayText }
                    : {}),
                  ...(metaRetry ? { 'qwen.daemon.retry': true } : {}),
                },
              } as PromptRequest,
              modelPrompt === undefined
                ? undefined
                : {
                    version: 1,
                    sessionId: 'test-session-id',
                    promptId: 'daemon-prompt-id',
                  },
              undefined,
              modelPrompt,
            );

            expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
            expect(messageBus.request).toHaveBeenCalledWith(
              expect.objectContaining({
                eventName: 'UserPromptSubmit',
                input: {
                  prompt: prompt
                    .filter((block) => block.type === 'text')
                    .map((block) => (block.type === 'text' ? block.text : ''))
                    .join(' '),
                  ...(submitted === undefined
                    ? {}
                    : { submitted_prompt: submitted }),
                },
              }),
              expect.anything(),
            );
          },
        );

        it('blocks prompt when UserPromptSubmit hook returns blocking decision', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: { decision: 'block', reason: 'Blocked by hook' },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);

          mockChat.sendMessageStream = vi.fn();

          const result = await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'blocked prompt' }],
          });

          expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
          expect(result.stopReason).toBe('end_turn');
          expect(
            mockLlmClient.beginManagedAutoMemoryRecall,
          ).not.toHaveBeenCalled();
          expect(mockMemoryManager.scheduleExtract).not.toHaveBeenCalled();
        });

        it('wraps additionalContext in the reserved tag before sending', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: 'extra hook context',
                },
              },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);

          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [{ content: { parts: [{ text: 'response' }] } }],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const sent = firstSentMessage();
          expect(textParts(sent)[0]).toBe('hello');
          expect(
            core.isUserPromptSubmitContextPartText(textParts(sent).at(-1)!),
          ).toBe(true);
          expect(textParts(sent).at(-1)).toContain('extra hook context');
          expect(
            mockLlmClient.beginManagedAutoMemoryRecall,
          ).toHaveBeenCalledWith('hello', expect.any(AbortSignal));
        });

        it('does not re-append an unchanged UserPromptSubmit context block already delivered in history', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: 'extra hook context',
                },
              },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());
          mockChat.getHistory = vi.fn().mockReturnValue([
            {
              role: 'user',
              parts: [
                { text: 'an earlier prompt' },
                createUserPromptSubmitContextPart('extra hook context'),
              ],
            },
          ]);

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(textParts(firstSentMessage())).toEqual(['hello']);
        });

        it('re-appends a suppressed hook block when pre-send compaction replaces history', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: 'extra hook context',
                },
              },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);
          mockChat.getHistory = vi.fn().mockReturnValue([
            {
              role: 'user',
              parts: [
                { text: 'an earlier prompt' },
                createUserPromptSubmitContextPart('extra hook context'),
              ],
            },
          ]);
          mockLlmClient.tryCompressChat.mockResolvedValue({
            originalTokenCount: 1000,
            newTokenCount: 200,
            compressionStatus: core.CompressionStatus.COMPRESSED,
          });
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const sentText = textParts(firstSentMessage());
          expect(
            sentText.filter((text) => text.includes('extra hook context')),
          ).toHaveLength(1);
          expect(sentText.at(-1)).toBe(
            core.wrapUserPromptSubmitContext('extra hook context'),
          );
          // Still forwarded: a second compaction inside this send destroys the
          // copy just appended, and LlmChat's already-present scan is what
          // keeps the forwarding from becoming a duplicate.
          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[0]?.[4],
          ).toEqual(
            expect.objectContaining({
              suppressedHookContext: 'extra hook context',
            }),
          );
        });

        it('forwards a suppressed hook block to the send when Session does not compact', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: 'extra hook context',
                },
              },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);
          mockChat.getHistory = vi.fn().mockReturnValue([
            {
              role: 'user',
              parts: [
                { text: 'an earlier prompt' },
                createUserPromptSubmitContextPart('extra hook context'),
              ],
            },
          ]);
          // No pre-send compaction here: a compaction inside the send (LlmChat's
          // hard-tier rescue or reactive overflow) is what would drop the
          // block, and only the forwarded option lets LlmChat re-append it.
          mockLlmClient.tryCompressChat.mockResolvedValue({
            originalTokenCount: 1000,
            newTokenCount: 1000,
            compressionStatus: core.CompressionStatus.NOOP,
          });
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(
            vi.mocked(mockChat.sendMessageStream).mock.calls[0]?.[4],
          ).toEqual(
            expect.objectContaining({
              suppressedHookContext: 'extra hook context',
            }),
          );
        });

        it('still appends when an ACP prompt block reproduces the injection shape', async () => {
          // A client can submit two text blocks whose persisted entry looks
          // exactly like a hook delivery. Without injector-owned provenance
          // that shape is not a receipt, so the fresh hook context is sent.
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {
                hookSpecificOutput: {
                  hookEventName: 'UserPromptSubmit',
                  additionalContext: 'extra hook context',
                },
              },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());
          mockChat.getHistory = vi.fn().mockReturnValue([
            {
              role: 'user',
              parts: [
                { text: 'an earlier prompt' },
                {
                  text: core.wrapUserPromptSubmitContext('extra hook context'),
                },
              ],
            },
          ]);

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(textParts(firstSentMessage())).toEqual([
            'hello',
            core.wrapUserPromptSubmitContext('extra hook context'),
          ]);
        });
      });

      describe('Stop hook', () => {
        it('fires Stop hook after model response completes', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {},
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((eventName: string) => eventName === 'Stop');
          mockChat.getHistory = vi
            .fn()
            .mockReturnValue([
              { role: 'model', parts: [{ text: 'response text' }] },
            ]);
          mockChat.getLastModelMessageText = vi
            .fn()
            .mockReturnValue('response text');

          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  candidates: [{ content: { parts: [{ text: 'response' }] } }],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'Stop',
              input: expect.objectContaining({
                stop_hook_active: false,
                last_assistant_message: 'response text',
              }),
            }),
            expect.anything(),
          );
        });

        it('reports stop_hook_active only on a continuation a Stop hook forced', async () => {
          const messageBus = {
            request: vi
              .fn()
              .mockResolvedValueOnce({
                success: true,
                output: { decision: 'block', reason: 'Keep working' },
              })
              .mockResolvedValue({ success: true, output: {} }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((eventName: string) => eventName === 'Stop');
          mockChat.getHistory = vi
            .fn()
            .mockReturnValue([
              { role: 'model', parts: [{ text: 'response text' }] },
            ]);
          mockChat.getLastModelMessageText = vi
            .fn()
            .mockReturnValue('response text');
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const stopInputs = messageBus.request.mock.calls
            .filter(([request]) => request.eventName === 'Stop')
            .map(([request]) => request.input);
          expect(stopInputs).toHaveLength(2);
          expect(stopInputs[0]).toMatchObject({ stop_hook_active: false });
          expect(stopInputs[1]).toMatchObject({ stop_hook_active: true });
        });

        it('continues with the stop reason when a blocking Stop hook also gives a reason', async () => {
          const messageBus = {
            request: vi
              .fn()
              .mockResolvedValueOnce({
                success: true,
                output: {
                  decision: 'block',
                  continue: false,
                  stopReason: 'External stop hook feedback',
                  reason: 'Keep working on the active goal',
                },
              })
              .mockResolvedValueOnce({
                success: true,
                output: {},
              }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((eventName: string) => eventName === 'Stop');
          mockChat.getHistory = vi
            .fn()
            .mockReturnValue([
              { role: 'model', parts: [{ text: 'response text' }] },
            ]);
          mockChat.getLastModelMessageText = vi
            .fn()
            .mockReturnValue('response text');
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          const continuation = vi.mocked(mockChat.sendMessageStream).mock
            .calls[1]?.[1] as { message: Part[] };
          expect(textParts(continuation.message)).toEqual([
            'External stop hook feedback',
          ]);
        });

        it('ends Stop hook continuation when the blocking cap is reached', async () => {
          const messageBus = {
            request: vi.fn().mockImplementation(async (request) => ({
              success: true,
              output:
                request.eventName === 'Stop'
                  ? {
                      decision: 'block',
                      reason: 'Continue after Stop hook',
                    }
                  : {},
            })),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((eventName: string) => eventName === 'Stop');
          mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(2);
          mockChat.getHistory = vi
            .fn()
            .mockReturnValue([
              { role: 'model', parts: [{ text: 'response text' }] },
            ]);
          mockChat.getLastModelMessageText = vi
            .fn()
            .mockReturnValue('response text');
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());

          const result = await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(result).toEqual({ stopReason: 'end_turn' });
          expect(messageBus.request).toHaveBeenCalledTimes(2);
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Stop hook blocked continuation 2 consecutive times; overriding and ending the turn.',
              },
            },
          });
        });

        it('emits the cap warning without retrying when the blocking cap is one', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after Stop hook',
              },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((eventName: string) => eventName === 'Stop');
          mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(1);
          mockChat.getHistory = vi
            .fn()
            .mockReturnValue([
              { role: 'model', parts: [{ text: 'response text' }] },
            ]);
          mockChat.getLastModelMessageText = vi
            .fn()
            .mockReturnValue('response text');
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());

          const result = await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(result).toEqual({ stopReason: 'end_turn' });
          expect(messageBus.request).toHaveBeenCalledTimes(1);
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(1);
          expect(mockClient.sessionUpdate).toHaveBeenCalledWith({
            sessionId: 'test-session-id',
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: {
                type: 'text',
                text: 'Stop hook blocked continuation 1 consecutive time; overriding and ending the turn.',
              },
            },
          });
        });

        it('pauses the canonical Goal runtime when the blocking cap fires', async () => {
          // Without the pause the goal stays active, the runtime mints the
          // next continuation, and a Stop hook that always blocks loops the
          // session forever.
          const permit: core.GoalTurnPermit = {
            goalId: 'goal-1',
            revision: 3,
            turnId: 'user-turn',
          };
          mockGoalRuntime.getSnapshot.mockReturnValue({
            v: 2,
            activity: 'idle',
            goal: {
              goalId: 'goal-1',
              revision: 3,
              objective: 'check weather',
              status: 'active',
              evidenceCursor: { recordId: 'cursor-1' },
              turnCount: 0,
              activeTimeMs: 0,
              tokensUsed: 0,
              createdAt: 1234,
              updatedAt: 1234,
            },
          });
          mockGoalRuntime.beginTurn.mockReturnValue(permit);
          mockGoalRuntime.permitForTurn.mockReturnValue(permit);
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after Stop hook',
              },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation((eventName: string) => eventName === 'Stop');
          mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(1);
          mockChat.getHistory = vi
            .fn()
            .mockReturnValue([
              { role: 'model', parts: [{ text: 'response text' }] },
            ]);
          mockChat.getLastModelMessageText = vi
            .fn()
            .mockReturnValue('response text');
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValue(createEmptyStream());

          const result = await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          expect(result).toEqual({ stopReason: 'end_turn' });
          expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
            action: 'pause',
            expectedGoalId: 'goal-1',
            expectedRevision: 3,
            reason: GOAL_PAUSE_REASON_STOP_HOOK_CAP,
          });
        });

        it('fires MessageDisplay with cumulative text and a single is_final during Stop hook continuation', async () => {
          // The Stop-hook continuation loop (Session.ts ~line 2282) creates
          // its own MessageDisplayDispatcher, independent of the main prompt
          // loop's — a regression here would not be caught by the
          // ACP-prompt-path test alone.
          let stopHookCalls = 0;
          const messageBus = {
            request: vi.fn().mockImplementation(async (request) => {
              if (request.eventName === 'Stop') {
                stopHookCalls++;
                return stopHookCalls === 1
                  ? {
                      success: true,
                      output: { decision: 'block', reason: 'keep going' },
                    }
                  : { success: true, output: {} };
              }
              return { success: true, output: {} };
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation(
              (eventName: string) =>
                eventName === 'Stop' || eventName === 'MessageDisplay',
            );
          mockChat.getHistory = vi
            .fn()
            .mockReturnValue([
              { role: 'model', parts: [{ text: 'response text' }] },
            ]);
          mockChat.getLastModelMessageText = vi
            .fn()
            .mockReturnValue('response text');
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(createEmptyStream())
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    candidates: [
                      { content: { parts: [{ text: 'continued reply' }] } },
                    ],
                  },
                },
              ]),
            );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          const messageDisplayCalls = messageBus.request.mock.calls.filter(
            ([request]) => request.eventName === 'MessageDisplay',
          );
          expect(messageDisplayCalls.length).toBeGreaterThan(0);
          const finalCall =
            messageDisplayCalls[messageDisplayCalls.length - 1][0];
          expect(finalCall.input).toMatchObject({
            displayed_text: 'continued reply',
            is_final: true,
          });
          expect(
            messageDisplayCalls.filter(([request]) => request.input.is_final),
          ).toHaveLength(1);
        });

        it('suppresses is_final for MessageDisplay when the turn is cancelled mid Stop-hook continuation', async () => {
          let releaseContinuation: () => void;
          const continuationGate = new Promise<void>((resolve) => {
            releaseContinuation = resolve;
          });
          async function* continuationStream() {
            yield {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'partial continuation' }] } },
                ],
              },
            };
            await continuationGate;
          }

          const messageBus = {
            request: vi.fn().mockImplementation(async (request) => {
              if (request.eventName === 'Stop') {
                return {
                  success: true,
                  output: { decision: 'block', reason: 'keep going' },
                };
              }
              return { success: true, output: {} };
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi
            .fn()
            .mockImplementation(
              (eventName: string) =>
                eventName === 'Stop' || eventName === 'MessageDisplay',
            );
          mockChat.getHistory = vi
            .fn()
            .mockReturnValue([
              { role: 'model', parts: [{ text: 'response text' }] },
            ]);
          mockChat.getLastModelMessageText = vi
            .fn()
            .mockReturnValue('response text');
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(createEmptyStream())
            .mockResolvedValueOnce(continuationStream());

          const promptPromise = session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          });

          // Wait until the continuation's own streamed send has started
          // (the dispatcher exists and has received the first chunk) rather
          // than for a mid-stream MessageDisplay flush, which is debounced
          // (~200ms) and may not be due yet by the time we cancel.
          await vi.waitFor(() =>
            expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2),
          );

          await session.cancelPendingPrompt();
          releaseContinuation!();
          await promptPromise;

          const finals = messageBus.request.mock.calls.filter(
            ([request]) =>
              request.eventName === 'MessageDisplay' && request.input.is_final,
          );
          expect(finals).toHaveLength(0);
        });
      });

      describe('PreToolUse hook', () => {
        it('fires PreToolUse hook before tool execution', async () => {
          const seen: string[] = [];
          const definition = (label: string): core.HookDefinition[] => [
            {
              hooks: [
                {
                  type: core.HookType.Function,
                  name: label,
                  errorMessage: 'failed',
                  callback: async () => {
                    seen.push(label);
                    return true;
                  },
                },
              ],
            },
          ];
          Object.assign(mockConfig, {
            getAllowedHttpHookUrls: () => [],
            getAllowPrivateNetworkHooks: () => false,
            getSystemHooks: () => ({}),
            getUserHooks: () => ({ PreToolUse: definition('G') }),
            getProjectHooks: () => ({}),
            getExtensions: () => [],
            isTrustedFolder: () => true,
            getTranscriptPath: () => '/tmp/transcript',
            getWorkingDir: () => '/tmp',
            getSessionSourceType: () => undefined,
            getSessionSourceId: () => undefined,
          });
          const system = new core.HookSystem(mockConfig);
          mockConfig.getHookSystem = vi.fn().mockReturnValue(system);
          await system.initialize();
          const owner = {
            runtimeId: system.runtimeId,
            sessionId: mockConfig.getSessionId(),
            agentId: 'agent-A',
          };
          for (const agentId of ['agent-A', 'agent-B'])
            system
              .getRegistry()
              .addAgentHooks({ PreToolUse: definition(agentId) }, agentId, {
                owner: { ...owner, agentId },
              });
          const messageBus = {
            publish: vi.fn(),
            request: vi.fn(async (request: core.HookExecutionRequest) => {
              if (request.eventName === 'PreToolUse')
                await core.runWithHookExecutionOwner(request.owner, () =>
                  system.firePreToolUseEvent(
                    String(request.input['tool_name']),
                    request.input['tool_input'] as Record<string, unknown>,
                    String(request.input['tool_use_id']),
                    core.PermissionMode.Default,
                  ),
                );
              return { success: true, output: {} };
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi.fn().mockResolvedValue({
            llmContent: 'result',
            returnDisplay: 'done',
          });
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await core.runWithHookExecutionOwner(owner, () =>
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'read the file' }],
            }),
          );

          expect(seen.sort()).toEqual(['G', 'agent-A']);
          expect(executeSpy).toHaveBeenCalled();
          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'PreToolUse',
              owner,
              input: expect.objectContaining({
                tool_name: 'read_file',
                tool_input: { path: '/tmp/test.txt' },
              }),
            }),
            expect.anything(),
          );
        });

        describe('updatedInput', () => {
          const ok = { llmContent: 'ok', returnDisplay: 'ok' };

          /** A write tool whose invocations carry their own params and spies. */
          function writeTool(
            extra: (params: Record<string, unknown>) => object = () => ({}),
          ) {
            const executed: unknown[] = [];
            // Inputs whose confirmation callback ran, with its outcome.
            const confirmed: unknown[][] = [];
            const tool = {
              name: 'write_file',
              kind: core.Kind.Edit,
              build: vi.fn((params: Record<string, unknown>) => {
                const onConfirm = vi.fn(async (outcome: unknown) => {
                  confirmed.push([params['path'], outcome]);
                });
                return {
                  params,
                  getDefaultPermission: vi.fn().mockResolvedValue('ask'),
                  getConfirmationDetails: vi.fn().mockResolvedValue({
                    type: 'info',
                    title: 'Write',
                    prompt: `write ${params['path']}`,
                    onConfirm,
                  }),
                  getDescription: vi
                    .fn()
                    .mockReturnValue(`write ${params['path']}`),
                  toolLocations: vi
                    .fn()
                    .mockReturnValue([{ path: params['path'] }]),
                  execute: vi.fn(async () => {
                    executed.push(params['path']);
                    return ok;
                  }),
                  ...extra(params),
                };
              }),
            };
            mockToolRegistry.getTool.mockReturnValue(tool);
            return { tool, executed, confirmed };
          }

          async function promptWith(
            args: Record<string, unknown>,
            approvalMode = ApprovalMode.DEFAULT,
          ) {
            mockConfig.getApprovalMode = vi.fn().mockReturnValue(approvalMode);
            mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
            mockConfig.getMessageBus = vi.fn().mockReturnValue({});
            mockChat.sendMessageStream = vi.fn().mockResolvedValue(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    functionCalls: [{ id: 'call-r', name: 'write_file', args }],
                  },
                },
              ]),
            );
            await session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'write' }],
            });
          }

          const recordedError = (text: string) =>
            expect(
              mockChatRecordingService.recordToolResult,
            ).toHaveBeenCalledWith(
              expect.arrayContaining([
                expect.objectContaining({
                  functionResponse: expect.objectContaining({
                    response: { error: expect.stringContaining(text) },
                  }),
                }),
              ]),
              expect.objectContaining({ status: 'error' }),
            );

          it('builds, confirms and runs the replacement once', async () => {
            const pre = vi.spyOn(core, 'firePreToolUseHook').mockResolvedValue({
              shouldProceed: true,
              updatedInput: { path: '/tmp/b.txt' },
            });
            const post = vi
              .spyOn(core, 'firePostToolUseHook')
              .mockResolvedValue({ shouldStop: false });
            mockClient.requestPermission = vi.fn().mockResolvedValue({
              outcome: {
                outcome: 'selected',
                optionId: core.ToolConfirmationOutcome.ProceedOnce,
              },
            });
            const { tool, executed } = writeTool();
            const args = { path: '/tmp/a.txt' };
            await promptWith(args);

            expect(pre).toHaveBeenCalledOnce();
            expect(pre.mock.calls[0][2]).toEqual({ path: '/tmp/a.txt' });
            expect(pre.mock.invocationCallOrder[0]).toBeLessThan(
              tool.build.mock.invocationCallOrder[0],
            );
            expect(tool.build.mock.calls[0][0]).toEqual({ path: '/tmp/b.txt' });
            expect(mockClient.requestPermission).toHaveBeenCalledOnce();
            expect(
              vi.mocked(mockClient.requestPermission).mock.calls[0][0].toolCall
                .rawInput,
            ).toEqual({ path: '/tmp/b.txt' });
            expect(executed).toEqual(['/tmp/b.txt']);
            expect(post.mock.calls[0][2]).toEqual({ path: '/tmp/b.txt' });
            expect(args).toEqual({ path: '/tmp/a.txt' });
          });

          describe('from a PermissionRequest hook', () => {
            beforeEach(() => {
              vi.spyOn(core, 'firePreToolUseHook').mockResolvedValue({
                shouldProceed: true,
              });
              vi.spyOn(core, 'firePermissionRequestHook').mockResolvedValue({
                hasDecision: true,
                shouldAllow: true,
                updatedInput: { path: '/tmp/c.txt' },
              });
            });

            it('runs a valid replacement with its own confirmation', async () => {
              const { tool, executed, confirmed } = writeTool();
              await promptWith({ path: '/tmp/a.txt' });

              expect(tool.build).toHaveBeenCalledWith({ path: '/tmp/c.txt' });
              expect(confirmed).toEqual([
                ['/tmp/c.txt', core.ToolConfirmationOutcome.ProceedOnce],
              ]);
              expect(executed).toEqual(['/tmp/c.txt']);
              expect(core.firePermissionRequestHook).toHaveBeenCalledOnce();
              expect(mockClient.requestPermission).not.toHaveBeenCalled();
            });

            it('denies a replacement that a permission rule denies', async () => {
              mockConfig.getPermissionManager = vi.fn().mockReturnValue({
                isToolEnabled: vi.fn().mockResolvedValue(true),
                hasRelevantRules: () => true,
                hasMatchingAskRule: () => false,
                evaluate: async (ctx: { filePath?: string }) =>
                  ctx.filePath === '/tmp/c.txt' ? 'deny' : 'default',
                findMatchingDenyRule: () => 'Write(/tmp/c.txt)',
              });
              const { executed, confirmed } = writeTool();
              await promptWith({ path: '/tmp/a.txt' });

              expect(executed).toEqual([]);
              expect(confirmed).toEqual([]);
              expect(mockClient.requestPermission).not.toHaveBeenCalled();
              recordedError('Write(/tmp/c.txt)');
            });

            it('rejects a replacement that needs a user decision', async () => {
              const { executed, confirmed } = writeTool((params) => ({
                requiresUserInteraction: () => params['path'] === '/tmp/c.txt',
              }));
              await promptWith({ path: '/tmp/a.txt' });

              expect(executed).toEqual([]);
              expect(confirmed).toEqual([]);
              recordedError('needs a user decision');
            });

            it.each([
              ['blocked', { shouldBlock: true, unavailable: false }, []],
              [
                'approved',
                { shouldBlock: false, unavailable: false },
                ['/tmp/c.txt'],
              ],
              [
                'unavailable',
                { shouldBlock: true, unavailable: true },
                ['/tmp/c.txt'],
              ],
            ])(
              'classifies a replacement in AUTO mode (%s) before its one-time allow',
              async (_label, verdict, expectedExecuted) => {
                let denialState: core.AutoModeDenialState = {
                  consecutiveBlock: 0,
                  consecutiveUnavailable: 0,
                  totalBlock: 0,
                  totalUnavailable: 0,
                };
                mockConfig.getCwd = vi.fn().mockReturnValue('/repo');
                mockConfig.getAutoModeSettings = vi.fn().mockReturnValue({});
                mockConfig.getAutoModeDenialState = vi.fn(() => denialState);
                mockConfig.setAutoModeDenialState = vi.fn((next) => {
                  denialState = next;
                });
                mockConfig.getLlmClient = vi.fn().mockReturnValue({
                  ...mockLlmClient,
                  getHistoryTail: () => [],
                });
                const decision = (value: {
                  shouldBlock: boolean;
                  unavailable: boolean;
                }) => ({
                  via: 'classifier' as const,
                  reason: 'test decision',
                  stage: 'fast' as const,
                  durationMs: 1,
                  ...value,
                });
                const classify = vi
                  .spyOn(core, 'evaluateAutoMode')
                  .mockResolvedValueOnce(
                    decision({ shouldBlock: true, unavailable: true }),
                  )
                  .mockResolvedValueOnce(decision(verdict));
                const { executed } = writeTool();
                await promptWith({ path: '/tmp/a.txt' }, ApprovalMode.AUTO);

                expect(
                  classify.mock.calls.map(([input]) => input.toolParams),
                ).toEqual([{ path: '/tmp/a.txt' }, { path: '/tmp/c.txt' }]);
                expect(mockClient.requestPermission).not.toHaveBeenCalled();
                expect(core.firePermissionRequestHook).toHaveBeenCalledOnce();
                expect(core.firePreToolUseHook).toHaveBeenCalledOnce();
                expect(executed).toEqual(expectedExecuted);
                if (expectedExecuted.length === 0) {
                  recordedError('test decision');
                }
              },
            );

            it("resets AUTO recovery from the replacement's fallback once it is approved", async () => {
              let denialState: core.AutoModeDenialState = {
                consecutiveBlock: 0,
                consecutiveUnavailable: 1,
                totalBlock: 0,
                totalUnavailable: 1,
              };
              mockConfig.getCwd = vi.fn().mockReturnValue('/repo');
              mockConfig.getAutoModeSettings = vi.fn().mockReturnValue({});
              mockConfig.getAutoModeDenialState = vi.fn(() => denialState);
              mockConfig.setAutoModeDenialState = vi.fn((next) => {
                denialState = next;
              });
              mockConfig.getLlmClient = vi.fn().mockReturnValue({
                ...mockLlmClient,
                getHistoryTail: () => [],
              });
              vi.spyOn(core, 'evaluateAutoMode')
                // The original input needs an ask-rule confirmation...
                .mockResolvedValueOnce({ via: 'fallback', reason: 'ask_rule' })
                // ...while the replacement meets an unavailable classifier.
                .mockResolvedValueOnce({
                  via: 'classifier',
                  shouldBlock: true,
                  unavailable: true,
                  reason: 'classifier timeout',
                  stage: 'fast',
                  durationMs: 1,
                });
              const { executed } = writeTool();
              await promptWith({ path: '/tmp/a.txt' }, ApprovalMode.AUTO);

              expect(executed).toEqual(['/tmp/c.txt']);
              expect(denialState.consecutiveUnavailable).toBe(0);
            });

            it.each([null, false, 0, ''])(
              'rejects an invalid replacement %j without running any input',
              async (updatedInput) => {
                vi.mocked(core.firePermissionRequestHook).mockRestore();
                mockConfig.getMessageBus = vi.fn().mockReturnValue({
                  request: vi.fn(async (request: { eventName: string }) => ({
                    success: true,
                    output:
                      request.eventName === 'PermissionRequest'
                        ? {
                            hookSpecificOutput: {
                              decision: { behavior: 'allow', updatedInput },
                            },
                          }
                        : {},
                  })),
                });
                const { executed, confirmed } = writeTool();
                mockConfig.getApprovalMode = vi
                  .fn()
                  .mockReturnValue(ApprovalMode.DEFAULT);
                mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
                mockChat.sendMessageStream = vi.fn().mockResolvedValue(
                  createStreamWithChunks([
                    {
                      type: core.StreamEventType.CHUNK,
                      value: {
                        functionCalls: [
                          {
                            id: 'call-r',
                            name: 'write_file',
                            args: { path: '/tmp/a.txt' },
                          },
                        ],
                      },
                    },
                  ]),
                );
                await session.prompt({
                  sessionId: 'test-session-id',
                  prompt: [{ type: 'text', text: 'write' }],
                });

                expect(executed).toEqual([]);
                expect(confirmed).toEqual([]);
                recordedError('invalid updatedInput');
              },
            );

            it('rejects a replacement that fails validation', async () => {
              const { tool, executed } = writeTool();
              const build = tool.build.getMockImplementation()!;
              tool.build.mockImplementation((params) => {
                if (params['path'] === '/tmp/c.txt') {
                  throw new Error('invalid replacement');
                }
                return build(params);
              });
              await promptWith({ path: '/tmp/a.txt' });

              expect(executed).toEqual([]);
              recordedError('invalid replacement');
            });

            describe('releases both invocations', () => {
              function releasingWriteTool(
                extra: (params: Record<string, unknown>) => object = () => ({}),
              ) {
                const released: unknown[] = [];
                const spies = writeTool((params) => ({
                  release: vi.fn(async () => {
                    released.push(params['path']);
                  }),
                  ...extra(params),
                }));
                return { ...spies, released };
              }

              it('when the replacement runs', async () => {
                const { executed, released } = releasingWriteTool();
                await promptWith({ path: '/tmp/a.txt' });

                expect(executed).toEqual(['/tmp/c.txt']);
                await vi.waitFor(() =>
                  expect(released.sort()).toEqual(['/tmp/a.txt', '/tmp/c.txt']),
                );
              });

              it('when a permission rule denies the replacement', async () => {
                mockConfig.getPermissionManager = vi.fn().mockReturnValue({
                  isToolEnabled: vi.fn().mockResolvedValue(true),
                  hasRelevantRules: () => true,
                  hasMatchingAskRule: () => false,
                  evaluate: async (ctx: { filePath?: string }) =>
                    ctx.filePath === '/tmp/c.txt' ? 'deny' : 'default',
                  findMatchingDenyRule: () => 'Write(/tmp/c.txt)',
                });
                const { executed, released } = releasingWriteTool();
                await promptWith({ path: '/tmp/a.txt' });

                expect(executed).toEqual([]);
                recordedError('Write(/tmp/c.txt)');
                await vi.waitFor(() =>
                  expect(released.sort()).toEqual(['/tmp/a.txt', '/tmp/c.txt']),
                );
              });

              it('when the call is cancelled while checking the replacement', async () => {
                const { executed, released } = releasingWriteTool((params) => ({
                  getDefaultPermission: vi.fn(async () => {
                    if (params['path'] === '/tmp/c.txt') {
                      await session.cancelPendingPrompt();
                    }
                    return 'ask';
                  }),
                }));
                await promptWith({ path: '/tmp/a.txt' });

                expect(executed).toEqual([]);
                expect(
                  mockChatRecordingService.recordToolResult,
                ).toHaveBeenCalledWith(
                  expect.anything(),
                  expect.objectContaining({ status: 'cancelled' }),
                );
                await vi.waitFor(() =>
                  expect(released.sort()).toEqual(['/tmp/a.txt', '/tmp/c.txt']),
                );
              });
            });
          });
        });

        it('blocks tool execution when PreToolUse hook returns blocking decision', async () => {
          const messageBus = {
            request: vi.fn().mockResolvedValue({
              success: true,
              output: { decision: 'deny', reason: 'Tool blocked by hook' },
            }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi.fn();
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(executeSpy).not.toHaveBeenCalled();
        });

        it('runs the host guard with final params and denies before execution', async () => {
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          const guard = vi.fn().mockResolvedValue({
            allowed: false,
            reason: 'host policy denied',
          });
          mockConfig.getToolInvocationGuard = vi.fn().mockReturnValue(guard);

          const executeSpy = vi.fn();
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/normalized/final.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-guard',
                      name: 'read_file',
                      args: { path: './original.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(guard).toHaveBeenCalledWith({
            callId: 'call-guard',
            toolName: 'read_file',
            args: { path: '/normalized/final.txt' },
            signal: expect.any(AbortSignal),
            permissionChecked: true,
            // The daemon policy falls back to the session and needs to know
            // where the tool will run.
            sessionId: 'test-session-id',
            cwd: process.cwd(),
          });
          expect(executeSpy).not.toHaveBeenCalled();
          expect(
            mockChatRecordingService.recordToolResult,
          ).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({
              callId: 'call-guard',
              status: 'error',
              executionStatus: 'not_started',
              errorType: core.ToolErrorType.EXECUTION_DENIED,
            }),
          );
        });

        it('executes once when the host guard allows the final invocation', async () => {
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          const guard = vi.fn().mockResolvedValue({ allowed: true });
          mockConfig.getToolInvocationGuard = vi.fn().mockReturnValue(guard);

          const executeSpy = vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'success',
          });
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/normalized/final.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-guard-allowed',
                      name: 'read_file',
                      args: { path: './original.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(guard).toHaveBeenCalledWith({
            callId: 'call-guard-allowed',
            toolName: 'read_file',
            args: { path: '/normalized/final.txt' },
            signal: expect.any(AbortSignal),
            permissionChecked: true,
            // The daemon policy falls back to the session and needs to know
            // where the tool will run.
            sessionId: 'test-session-id',
            cwd: process.cwd(),
          });
          expect(executeSpy).toHaveBeenCalledOnce();
        });

        it('cancels without execution when aborted while awaiting the host guard', async () => {
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          let resolveGuard!: (decision: { allowed: true }) => void;
          const guard = vi.fn(
            () =>
              new Promise<{ allowed: true }>((resolve) => {
                resolveGuard = resolve;
              }),
          );
          mockConfig.getToolInvocationGuard = vi.fn().mockReturnValue(guard);

          const executeSpy = vi.fn();
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-guard-aborted',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          const prompt = session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });
          await vi.waitFor(() => expect(guard).toHaveBeenCalledOnce());
          const cancel = session.cancelPendingPrompt();
          resolveGuard({ allowed: true });

          await cancel;
          await prompt;
          expect(executeSpy).not.toHaveBeenCalled();
          expect(
            mockChatRecordingService.recordToolResult,
          ).toHaveBeenCalledWith(
            expect.any(Array),
            expect.objectContaining({
              callId: 'call-guard-aborted',
              status: 'cancelled',
              executionStatus: 'not_started',
            }),
          );
        });
      });

      describe('PostToolUse hook', () => {
        it('fires PostToolUse hook after successful tool execution', async () => {
          const messageBus = {
            request: vi
              .fn()
              .mockImplementation(async (request: { eventName: string }) => ({
                success: true,
                output:
                  request.eventName === 'PostToolUse'
                    ? {
                        hookSpecificOutput: {
                          artifacts: [
                            {
                              title: 'Success report',
                              workspacePath: 'reports/success.html',
                            },
                          ],
                        },
                      }
                    : { decision: 'allow' },
              })),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'success',
          });
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'PostToolUse',
              input: expect.objectContaining({
                tool_name: 'read_file',
                tool_response: expect.objectContaining({
                  llmContent: 'file contents',
                  returnDisplay: 'success',
                }),
              }),
            }),
            expect.anything(),
          );
          expect(mockClient.extNotification).toHaveBeenCalledWith(
            'qwen/notify/session/artifact-event',
            expect.objectContaining({
              sessionId: 'test-session-id',
              source: 'hook',
              hookEventName: 'PostToolUse',
              toolName: 'read_file',
              toolCallId: 'call-1',
              artifacts: [
                {
                  title: 'Success report',
                  workspacePath: 'reports/success.html',
                },
              ],
            }),
          );
        });

        it('stops execution when PostToolUse hook returns shouldStop', async () => {
          const messageBus = {
            request: vi
              .fn()
              .mockImplementation(async (request: { eventName?: string }) => ({
                success: true,
                output:
                  request.eventName === 'PostToolUse'
                    ? {
                        decision: 'allow',
                        continue: false,
                        stopReason: 'Stopping per hook request',
                      }
                    : { decision: 'allow' },
              })),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'success',
          });
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);

          // Only one call expected since shouldStop prevents continuation
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          // Tool should have been executed
          expect(executeSpy).toHaveBeenCalled();
          // PostToolUse hook should have been called
          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'PostToolUse',
            }),
            expect.anything(),
          );
          // The stop must produce an observable error result
          expect(
            mockChatRecordingService.recordToolResult,
          ).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              callId: 'call-1',
              status: 'error',
              executionStatus: 'success',
              errorType: core.ToolErrorType.EXECUTION_DENIED,
            }),
          );
        });
      });

      describe('Managed Runtime outcome', () => {
        it('fails the turn, reporting no result, when a call outcome is unknown', async () => {
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          const unknown = new ManagedRuntimeOutcomeUnknownError(
            'The Runtime worker stopped answering for a tool call.',
            { cause: new Error('read ECONNRESET') },
          );
          const tool = {
            name: 'write_file',
            kind: core.Kind.Edit,
            build: vi.fn().mockReturnValue({
              params: { file_path: '/tmp/test.txt', content: 'x' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: vi.fn().mockRejectedValue(unknown),
            }),
          };
          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'write_file',
                      args: { file_path: '/tmp/test.txt', content: 'x' },
                    },
                  ],
                },
              },
            ]),
          );

          await expect(
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'write the file' }],
            }),
          ).rejects.toMatchObject({
            code: -32603,
            // The cause tells an operator why the outcome was lost.
            message: `${unknown.message} (read ECONNRESET)`,
            data: { errorKind: 'managed_runtime_outcome_unknown' },
          });
          // No failure result for the model to act on, and no next request.
          expect(
            mockChatRecordingService.recordToolResult,
          ).not.toHaveBeenCalled();
          expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
        });

        it.each([false, true])(
          'fails a cancelled turn whose call outcome became unknown (daemon context: %s)',
          async (withContext) => {
            mockConfig.getApprovalMode = vi
              .fn()
              .mockReturnValue(ApprovalMode.YOLO);
            const unknown = new ManagedRuntimeOutcomeUnknownError(
              'A cancelled Runtime tool call did not settle.',
            );
            let started!: () => void;
            const executing = new Promise<void>((resolve) => {
              started = resolve;
            });
            const tool = {
              name: 'run_shell_command',
              kind: core.Kind.Execute,
              build: vi.fn().mockReturnValue({
                params: { command: 'sleep 100' },
                getDefaultPermission: vi.fn().mockResolvedValue('allow'),
                execute: vi.fn((signal: AbortSignal) => {
                  started();
                  return new Promise((_resolve, reject) => {
                    // The worker never settles the cancel.
                    signal.addEventListener('abort', () => reject(unknown), {
                      once: true,
                    });
                  });
                }),
              }),
            };
            mockToolRegistry.getTool.mockReturnValue(tool);
            mockChat.sendMessageStream = vi.fn().mockResolvedValue(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    functionCalls: [
                      {
                        id: 'call-1',
                        name: 'run_shell_command',
                        args: { command: 'sleep 100' },
                      },
                    ],
                  },
                },
              ]),
            );
            const running = session.prompt(
              {
                sessionId: 'test-session-id',
                prompt: [{ type: 'text', text: 'run' }],
              },
              withContext
                ? {
                    version: 1,
                    sessionId: 'test-session-id',
                    promptId: 'daemon-prompt-id',
                    originatorClientId: 'client-1',
                  }
                : undefined,
            );
            const outcome = running.catch((error: unknown) => error);
            await executing;
            void session.cancelPendingPrompt();
            // Not a cancellation: the session is blocked.
            expect(await outcome).toMatchObject({
              code: -32603,
              data: { errorKind: 'managed_runtime_outcome_unknown' },
            });
            expect(mockChat.sendMessageStream).toHaveBeenCalledOnce();
            expect(
              mockChatRecordingService.recordToolResult,
            ).not.toHaveBeenCalled();
          },
        );

        it('releases a prepared call the user rejected', async () => {
          const release = vi.fn().mockResolvedValue(undefined);
          const execute = vi.fn();
          const tool = {
            name: 'write_file',
            kind: core.Kind.Edit,
            build: vi.fn().mockReturnValue({
              params: { file_path: '/tmp/test.txt', content: 'x' },
              getDefaultPermission: vi.fn().mockResolvedValue('ask'),
              getConfirmationDetails: vi.fn().mockResolvedValue({
                type: 'info',
                title: 'Confirm write',
                prompt: 'write',
                onConfirm: vi.fn(),
              }),
              getDescription: vi.fn().mockReturnValue('write'),
              toolLocations: vi.fn().mockReturnValue([]),
              execute,
              release,
            }),
          };
          mockToolRegistry.getTool.mockReturnValue(tool);
          vi.mocked(mockClient.requestPermission).mockResolvedValue({
            outcome: { outcome: 'cancelled' },
          });
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    functionCalls: [
                      {
                        id: 'call-1',
                        name: 'write_file',
                        args: { file_path: '/tmp/test.txt', content: 'x' },
                      },
                    ],
                  },
                },
              ]),
            )
            .mockResolvedValue(createStreamWithChunks([]));

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'write the file' }],
          });

          expect(mockClient.requestPermission).toHaveBeenCalledOnce();
          await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
          expect(execute).not.toHaveBeenCalled();
        });

        it('releases a prepared call that permission denied', async () => {
          const release = vi.fn().mockResolvedValue(undefined);
          const tool = {
            name: 'write_file',
            kind: core.Kind.Edit,
            build: vi.fn().mockReturnValue({
              params: { file_path: '/tmp/test.txt', content: 'x' },
              getDefaultPermission: vi.fn().mockResolvedValue('deny'),
              getDescription: vi.fn().mockReturnValue('write'),
              toolLocations: vi.fn().mockReturnValue([]),
              execute: vi.fn(),
              release,
            }),
          };
          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    functionCalls: [
                      {
                        id: 'call-1',
                        name: 'write_file',
                        args: { file_path: '/tmp/test.txt', content: 'x' },
                      },
                    ],
                  },
                },
              ]),
            )
            .mockResolvedValue(createStreamWithChunks([]));

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'write the file' }],
          });

          // The execution environment's slot does not outlive the call.
          await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
          expect(
            tool.build.mock.results[0]!.value.execute,
          ).not.toHaveBeenCalled();
        });

        it('refuses a turn in a session that is blocked', async () => {
          const unknown = new ManagedRuntimeOutcomeUnknownError(
            'A cancelled Runtime tool call did not settle.',
          );
          mockConfig.getManagedSessionBlock = vi.fn().mockReturnValue(unknown);
          mockChat.sendMessageStream = vi.fn();

          await expect(
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'continue' }],
            }),
          ).rejects.toMatchObject({
            data: { errorKind: 'managed_runtime_outcome_unknown' },
          });
          expect(mockChat.sendMessageStream).not.toHaveBeenCalled();
          expect(
            mockChatRecordingService.recordUserMessage,
          ).not.toHaveBeenCalled();
        });
      });

      describe('PostToolUseFailure hook', () => {
        it('fires PostToolUseFailure hook when tool execution fails', async () => {
          const startExecutionSpanSpy = vi.spyOn(
            core,
            'startToolExecutionSpan',
          );
          const endExecutionSpanSpy = vi.spyOn(core, 'endToolExecutionSpan');
          const messageBus = {
            request: vi
              .fn()
              .mockImplementation(async (request: { eventName: string }) => ({
                success: true,
                output:
                  request.eventName === 'PostToolUseFailure'
                    ? {
                        hookSpecificOutput: {
                          artifacts: [
                            {
                              title: 'Failure report',
                              workspacePath: 'reports/failure.html',
                            },
                          ],
                        },
                      }
                    : { decision: 'allow' },
              })),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);

          const executeSpy = vi
            .fn()
            .mockRejectedValue(new Error('Tool failed'));
          const tool = {
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute: executeSpy,
            }),
          };

          mockToolRegistry.getTool.mockReturnValue(tool);
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-1',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });

          expect(messageBus.request).toHaveBeenCalledWith(
            expect.objectContaining({
              eventName: 'PostToolUseFailure',
              input: expect.objectContaining({
                tool_name: 'read_file',
                error: 'Tool failed',
              }),
            }),
            expect.anything(),
          );
          expect(
            mockChatRecordingService.recordToolResult,
          ).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              callId: 'call-1',
              status: 'error',
              executionStatus: 'error',
              errorType: core.ToolErrorType.UNHANDLED_EXCEPTION,
            }),
          );
          expect(startExecutionSpanSpy).toHaveBeenCalledOnce();
          expect(startExecutionSpanSpy).toHaveBeenCalledWith({
            toolName: 'read_file',
            callId: 'call-1',
          });
          expect(endExecutionSpanSpy).toHaveBeenCalledOnce();
          expect(endExecutionSpanSpy).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              executionStatus: 'error',
              errorType: core.ToolErrorType.UNHANDLED_EXCEPTION,
            }),
          );
          expect(mockClient.extNotification).toHaveBeenCalledWith(
            'qwen/notify/session/artifact-event',
            expect.objectContaining({
              sessionId: 'test-session-id',
              source: 'hook',
              hookEventName: 'PostToolUseFailure',
              toolName: 'read_file',
              toolCallId: 'call-1',
              artifacts: [
                {
                  title: 'Failure report',
                  workspacePath: 'reports/failure.html',
                },
              ],
            }),
          );
        });
      });

      describe('hook additionalContext delivery', () => {
        function contextBus(outputs: Record<string, unknown>) {
          return {
            request: vi
              .fn()
              .mockImplementation(async (request: { eventName: string }) => ({
                success: true,
                output: outputs[request.eventName] ?? {},
              })),
          };
        }

        async function runReadFile(
          messageBus: ReturnType<typeof contextBus>,
          execute: ReturnType<typeof vi.fn>,
          truncateThreshold = 25_000,
          expectedModelRequests = 2,
        ) {
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          mockConfig.getTruncateToolOutputThreshold = vi
            .fn()
            .mockReturnValue(truncateThreshold);
          mockToolRegistry.getTool.mockReturnValue({
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute,
            }),
          });
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-ctx',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );
          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });
          expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(
            expectedModelRequests,
          );
          const message = (vi.mocked(mockChat.sendMessageStream).mock
            .calls[1]?.[1].message ?? []) as Part[];
          const response = message.find(
            (part) => part.functionResponse?.id === 'call-ctx',
          )?.functionResponse?.response;
          return { message, response };
        }

        function count(value: unknown, needle: string): number {
          return JSON.stringify(value).split(needle).length - 1;
        }

        function uiUpdates(): string {
          return JSON.stringify(
            vi
              .mocked(mockClient.sessionUpdate)
              .mock.calls.map(([params]) => params.update),
          );
        }

        const preContext = (extra: Record<string, unknown> = {}) => ({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: 'P02A_PRE <x>',
            ...extra,
          },
        });
        const failureContext = {
          hookSpecificOutput: {
            hookEventName: 'PostToolUseFailure',
            additionalContext: 'P02A_FAIL',
          },
        };

        it('delivers PreToolUse context with a successful tool result', async () => {
          const execute = vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'success',
          });
          const { message, response } = await runReadFile(
            contextBus({ PreToolUse: preContext() }),
            execute,
          );

          expect(execute).toHaveBeenCalledOnce();
          expect(response).toEqual({
            output: 'file contents\n\nP02A_PRE &lt;x&gt;',
          });
          expect(count(message, 'P02A_PRE')).toBe(1);
          expect(uiUpdates()).not.toContain('P02A_PRE');
          expect(
            mockChatRecordingService.recordToolResult,
          ).toHaveBeenCalledWith(
            expect.arrayContaining([
              expect.objectContaining({
                functionResponse: expect.objectContaining({
                  response: { output: 'file contents\n\nP02A_PRE &lt;x&gt;' },
                }),
              }),
            ]),
            expect.objectContaining({ callId: 'call-ctx', status: 'success' }),
          );
        });

        it('delivers PreToolUse context on a denied result without executing', async () => {
          const execute = vi.fn();
          const { response } = await runReadFile(
            contextBus({
              PreToolUse: preContext({
                permissionDecision: 'deny',
                permissionDecisionReason: 'no reads',
              }),
            }),
            execute,
          );

          expect(execute).not.toHaveBeenCalled();
          expect(response).toEqual({
            error: 'no reads\n\nP02A_PRE &lt;x&gt;',
          });
          expect(uiUpdates()).not.toContain('P02A_PRE');
        });

        it('delivers Pre and failure context when the tool returns an error', async () => {
          const execute = vi.fn().mockResolvedValue({
            llmContent: 'Error: disk gone',
            returnDisplay: 'disk gone',
            error: {
              message: 'disk gone',
              type: core.ToolErrorType.EXECUTION_FAILED,
            },
          });
          const { message, response } = await runReadFile(
            contextBus({
              PreToolUse: preContext(),
              PostToolUseFailure: failureContext,
            }),
            execute,
          );

          expect(count(message, 'P02A_PRE')).toBe(1);
          expect(count(message, 'P02A_FAIL')).toBe(1);
          const text = JSON.stringify(response);
          expect(text.indexOf('P02A_PRE')).toBeLessThan(
            text.indexOf('P02A_FAIL'),
          );
          expect(uiUpdates()).not.toContain('P02A_FAIL');
          expect(
            mockChatRecordingService.recordToolResult,
          ).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              callId: 'call-ctx',
              status: 'error',
              error: new Error('disk gone'),
            }),
          );
        });

        it('delivers Pre and failure context when the tool throws', async () => {
          const execute = vi.fn().mockRejectedValue(new Error('Tool failed'));
          const { message, response } = await runReadFile(
            contextBus({
              PreToolUse: preContext(),
              PostToolUseFailure: failureContext,
            }),
            execute,
          );

          expect(response).toEqual({
            error: 'Tool failed\n\nP02A_PRE &lt;x&gt;\n\nP02A_FAIL',
          });
          expect(count(message, 'P02A_FAIL')).toBe(1);
          expect(uiUpdates()).not.toContain('P02A_FAIL');
          expect(
            mockChatRecordingService.recordToolResult,
          ).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              callId: 'call-ctx',
              status: 'error',
              errorType: core.ToolErrorType.UNHANDLED_EXCEPTION,
              error: new Error('Tool failed'),
            }),
          );
        });

        it('bounds the delivered context by the truncation threshold', async () => {
          const execute = vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'success',
          });
          const { response } = await runReadFile(
            contextBus({
              PreToolUse: {
                hookSpecificOutput: {
                  hookEventName: 'PreToolUse',
                  additionalContext: 'P'.repeat(200),
                },
              },
            }),
            execute,
            60,
          );

          const output = response?.['output'] as string;
          const delivered = output.slice('file contents\n\n'.length);
          expect(output.startsWith('file contents\n\nPPP')).toBe(true);
          expect(delivered).toHaveLength(60);
          expect(delivered).toContain('[hook additional context truncated]');
        });

        it('drops PreToolUse context when the call is cancelled', async () => {
          const execute = vi.fn();
          let cancel: Promise<void> | undefined;
          const messageBus = {
            request: vi
              .fn()
              .mockImplementation(async (request: { eventName: string }) => {
                if (request.eventName === 'PreToolUse') {
                  cancel = session.cancelPendingPrompt();
                  return { success: true, output: preContext() };
                }
                return { success: true, output: {} };
              }),
          };
          mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.YOLO);
          mockConfig.getTruncateToolOutputThreshold = vi
            .fn()
            .mockReturnValue(25_000);
          mockToolRegistry.getTool.mockReturnValue({
            name: 'read_file',
            kind: core.Kind.Read,
            build: vi.fn().mockReturnValue({
              params: { path: '/tmp/test.txt' },
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              execute,
            }),
          });
          mockChat.sendMessageStream = vi.fn().mockResolvedValue(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-cancel',
                      name: 'read_file',
                      args: { path: '/tmp/test.txt' },
                    },
                  ],
                },
              },
            ]),
          );

          await session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'read the file' }],
          });
          await cancel;

          expect(execute).not.toHaveBeenCalled();
          expect(
            mockChatRecordingService.recordToolResult,
          ).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              callId: 'call-cancel',
              status: 'cancelled',
            }),
          );
          expect(
            JSON.stringify(
              mockChatRecordingService.recordToolResult.mock.calls,
            ),
          ).not.toContain('P02A_PRE');
          expect(
            JSON.stringify(vi.mocked(mockChat.sendMessageStream).mock.calls),
          ).not.toContain('P02A_PRE');
        });

        it.each([
          ['a completed result', {}, 'completed', 'success'],
          [
            'a denied result',
            { permissionDecision: 'deny', permissionDecisionReason: 'no' },
            'failed',
            'error',
          ],
        ] as const)(
          'drops PreToolUse context when the turn is cancelled while notifying %s',
          async (_label, decision, updateStatus, recordedStatus) => {
            const execute = vi.fn().mockResolvedValue({
              llmContent: 'done',
              returnDisplay: 'done',
            });
            let cancel: Promise<void> | undefined;
            vi.mocked(mockClient.sessionUpdate).mockImplementation(
              async (params) => {
                const update = params.update as {
                  sessionUpdate?: string;
                  status?: string;
                };
                if (
                  !cancel &&
                  update.sessionUpdate === 'tool_call_update' &&
                  update.status === updateStatus
                ) {
                  cancel = session.cancelPendingPrompt();
                }
              },
            );
            mockChat.addHistory = vi.fn();

            // The cancelled turn sends no follow-up model request.
            await runReadFile(
              contextBus({ PreToolUse: preContext(decision) }),
              execute,
              25_000,
              1,
            );
            await cancel;

            expect(cancel).toBeDefined();
            expect(execute).toHaveBeenCalledTimes(
              recordedStatus === 'success' ? 1 : 0,
            );
            expect(
              mockChatRecordingService.recordToolResult,
            ).toHaveBeenCalledWith(
              expect.anything(),
              expect.objectContaining({
                callId: 'call-ctx',
                status: recordedStatus,
              }),
            );
            expect(
              JSON.stringify(
                mockChatRecordingService.recordToolResult.mock.calls,
              ),
            ).not.toContain('P02A_PRE');
            expect(
              JSON.stringify(vi.mocked(mockChat.addHistory).mock.calls),
            ).not.toContain('P02A_PRE');
            expect(
              JSON.stringify(vi.mocked(mockChat.sendMessageStream).mock.calls),
            ).not.toContain('P02A_PRE');
          },
        );

        it('leaves results unchanged when hooks return no context', async () => {
          const execute = vi.fn().mockResolvedValue({
            llmContent: 'file contents',
            returnDisplay: 'success',
          });
          const { response } = await runReadFile(contextBus({}), execute);
          expect(response).toEqual({ output: 'file contents' });
        });
      });

      describe('StopFailure hook', () => {
        it('forwards quota display context through the ACP error envelope', async () => {
          const subscriptionQuota = {
            type: 'subscription_quota',
            memberType: 'pro',
          };
          const error = Object.assign(new Error('quota fallback'), {
            status: 402,
            code: 'insufficient_quota',
            subscriptionQuota,
          });
          mockChat.sendMessageStream = vi.fn().mockImplementation(async () => {
            throw error;
          });
          await expect(
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'hello' }],
            }),
          ).rejects.toMatchObject({
            code: -32603,
            message: 'quota fallback',
            data: { details: 'quota fallback', subscriptionQuota },
          });
        });
        it('preserves the subscription backend rate-limit message', async () => {
          mockConfig.getAuthType = vi
            .fn()
            .mockReturnValue(AuthType.QWEN_SUBSCRIPTION);
          const error = Object.assign(
            new Error('Concurrent request limit exceeded (principal scope)'),
            { status: 429 },
          );
          mockChat.sendMessageStream = vi.fn().mockImplementation(async () => {
            throw error;
          });
          await expect(
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'hello' }],
            }),
          ).rejects.toThrow(
            'Concurrent request limit exceeded (principal scope)',
          );
        });
        it('fires StopFailure hook when API error occurs during sendMessageStream', async () => {
          const mockFireStopFailureEvent = vi.fn().mockResolvedValue({
            success: true,
          });
          mockConfig.getHookSystem = vi.fn().mockReturnValue({
            fireStopFailureEvent: mockFireStopFailureEvent,
          });
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
          mockConfig.hasHooksForEvent = vi.fn().mockReturnValue(true);

          // Simulate API error (rate limit)
          const apiError = new Error('Rate limit exceeded') as Error & {
            status: number;
          };
          apiError.status = 429;

          mockChat.sendMessageStream = vi.fn().mockImplementation(async () => {
            throw apiError;
          });

          await expect(
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'hello' }],
            }),
          ).rejects.toThrow();

          // StopFailure hook should be called with rate_limit error type
          expect(mockFireStopFailureEvent).toHaveBeenCalledWith(
            'rate_limit',
            'Rate limit exceeded',
          );
        });

        it('does not fire StopFailure hook when hooks are disabled', async () => {
          const mockFireStopFailureEvent = vi.fn();
          mockConfig.getHookSystem = vi.fn().mockReturnValue({
            fireStopFailureEvent: mockFireStopFailureEvent,
          });
          mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(true);

          const apiError = new Error('Rate limit exceeded') as Error & {
            status: number;
          };
          apiError.status = 429;

          mockChat.sendMessageStream = vi.fn().mockImplementation(async () => {
            throw apiError;
          });

          await expect(
            session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'hello' }],
            }),
          ).rejects.toThrow();

          expect(mockFireStopFailureEvent).not.toHaveBeenCalled();
        });
      });
    });

    describe('tool call concurrency', () => {
      it('keeps bridged Goal calls sequential', async () => {
        const { ToolCallTool } = await import(
          '@qwen-code/qwen-code-core/tools/tool-call.js'
        );
        const bridge = new ToolCallTool();
        const order: string[] = [];
        const goal = {
          name: core.ToolNames.GET_GOAL,
          kind: core.Kind.Other,
          // The schema-review gate fingerprints name + parametersJsonSchema.
          schema: {
            name: 'GetGoal',
            parametersJsonSchema: { type: 'object', properties: {} },
          },
          build: vi.fn((params: Record<string, unknown>) => ({
            params,
            getDefaultPermission: async () => 'allow',
            getDescription: () => 'Read goal',
            toolLocations: () => [],
            execute: async () => {
              const id = String(params['id']);
              order.push(`${id}:start`);
              await new Promise<void>((resolve) => setImmediate(resolve));
              order.push(`${id}:end`);
              return { llmContent: id, returnDisplay: id };
            },
          })),
        };
        const findTool = (name: string) =>
          name === core.ToolNames.TOOL_CALL
            ? bridge
            : name === core.ToolNames.TOOL_SEARCH
              ? { name }
              : name === goal.name
                ? goal
                : undefined;
        mockToolRegistry.getTool.mockImplementation(findTool);
        mockToolRegistry.ensureTool.mockImplementation(async (name: string) =>
          findTool(name),
        );
        mockToolRegistry.isDeferredAndHidden.mockReturnValue(true);
        // Exercise the production schema-review gate: the recorded review
        // matches the live target's fingerprint.
        mockToolRegistry.getReviewedDeclaration = vi.fn((name: string) => {
          const tool = findTool(name);
          return tool && 'build' in tool
            ? core.deferredDeclarationFingerprint(tool as never)
            : undefined;
        });
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: ['a', 'b'].map((id) => ({
                    id,
                    name: core.ToolNames.TOOL_CALL,
                    args: { name: goal.name, arguments: { id } },
                  })),
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());
        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'read goal twice' }],
        });
        expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
        expect(mockConfig.takeActiveTodoReminder).not.toHaveBeenCalledWith(
          'test-session-id########1',
          true,
        );
      });

      it('refuses a bridged call whose recorded review no longer matches', async () => {
        // The schema-review gate the other bridge cases now exercise: a
        // stale recorded fingerprint (the tool changed since tool_search
        // returned it) must refuse the call rather than run arguments
        // written against a schema the model no longer has.
        const { ToolCallTool } = await import(
          '@qwen-code/qwen-code-core/tools/tool-call.js'
        );
        const bridge = new ToolCallTool();
        const execute = vi.fn().mockResolvedValue({
          llmContent: 'agent done',
          returnDisplay: 'agent done',
        });
        const agentTool = {
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          schema: {
            name: 'Agent',
            parametersJsonSchema: { type: 'object', properties: {} },
          },
          build: vi.fn().mockReturnValue({
            params: {},
            execute,
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: () => 'Agent',
            toolLocations: () => [],
          }),
        };
        const findTool = (name: string) =>
          name === core.ToolNames.TOOL_CALL
            ? bridge
            : name === core.ToolNames.TOOL_SEARCH
              ? { name }
              : name === core.ToolNames.AGENT
                ? agentTool
                : undefined;
        mockToolRegistry.getTool.mockImplementation(findTool);
        mockToolRegistry.ensureTool.mockImplementation(async (name: string) =>
          findTool(name),
        );
        mockToolRegistry.isDeferredAndHidden.mockReturnValue(true);
        mockToolRegistry.getReviewedDeclaration = vi.fn(
          () => 'stale-fingerprint-from-an-older-schema',
        );
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-stale',
                      name: core.ToolNames.TOOL_CALL,
                      args: { name: core.ToolNames.AGENT, arguments: {} },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'delegate' }],
        });

        expect(execute).not.toHaveBeenCalled();
        const followUp = vi
          .mocked(mockChat.sendMessageStream)
          .mock.calls.at(-1)?.[1] as { message: Part[] };
        const response = followUp.message.find(
          (part) => part.functionResponse?.id === 'call-stale',
        )?.functionResponse?.response;
        expect(JSON.stringify(response)).toContain(
          'changed since tool_search last returned it',
        );
      });

      it('stops bridge classification for the rest of the batch once the turn is cancelled', async () => {
        // The partition loop resolves each bridged envelope through awaited
        // registry work; once the turn is cancelled the remaining envelopes
        // must not pay that for a batch the execution path will discard.
        // Driver: the first resolution's ensureTool aborts the turn, so a
        // batch of two bridged delegations resolves exactly one with the
        // gate and both without it.
        const { ToolCallTool } = await import(
          '@qwen-code/qwen-code-core/tools/tool-call.js'
        );
        const bridge = new ToolCallTool();
        const execute = vi.fn().mockResolvedValue({
          llmContent: 'agent done',
          returnDisplay: 'agent done',
        });
        const agentTool = {
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          build: vi.fn().mockReturnValue({
            params: {},
            execute,
            getDefaultPermission: vi.fn().mockResolvedValue('allow'),
            getDescription: () => 'Agent',
            toolLocations: () => [],
          }),
        };
        const findTool = (name: string) =>
          name === core.ToolNames.TOOL_CALL
            ? bridge
            : name === core.ToolNames.TOOL_SEARCH
              ? { name }
              : name === core.ToolNames.AGENT
                ? agentTool
                : undefined;
        mockToolRegistry.getTool.mockImplementation(findTool);
        const cancellation = new AbortController();
        let firstResolution = true;
        mockToolRegistry.ensureTool.mockImplementation(async (name: string) => {
          if (firstResolution) {
            firstResolution = false;
            // The cancel lands mid-partition, after the first envelope's
            // resolution has started.
            cancellation.abort();
          }
          return findTool(name);
        });
        mockToolRegistry.isDeferredAndHidden.mockReturnValue(true);
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
        mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);

        mockChat.sendMessageStream = vi.fn().mockImplementation(() =>
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: ['a', 'b'].map((id) => ({
                  id,
                  name: core.ToolNames.TOOL_CALL,
                  args: { name: core.ToolNames.AGENT, arguments: {} },
                })),
              },
            },
          ]),
        );

        await session.prompt(
          {
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'delegate twice' }],
          },
          undefined,
          cancellation.signal,
        );

        const ensuredAgent = mockToolRegistry.ensureTool.mock.calls.filter(
          (call) => call[0] === core.ToolNames.AGENT,
        ).length;
        expect(ensuredAgent).toBe(1);
        expect(execute).not.toHaveBeenCalled();
      });

      it('runs multiple Agent tool calls concurrently (issue #2516)', async () => {
        // Each Agent call has two controllable async boundaries:
        //   - `called`  — resolves *when* the test code reaches `execute()`
        //   - `result`  — the promise `execute()` returns, resolved by the
        //                 test after observing both `called` signals.
        //
        // Under the old sequential for-loop, call-b's `execute()` would
        // only run after call-a's `execute()` promise resolved — so the
        // `await Promise.all([called-a, called-b])` below deadlocks and
        // the test hits vitest's default per-test timeout. Under the
        // concurrent implementation both `called` signals fire before
        // either `result` is resolved.
        type Deferred<T> = {
          promise: Promise<T>;
          resolve: (v: T) => void;
        };
        const makeDeferred = <T>(): Deferred<T> => {
          let resolve!: (v: T) => void;
          const promise = new Promise<T>((r) => {
            resolve = r;
          });
          return { promise, resolve };
        };

        const called: Record<string, Deferred<void>> = {
          'call-a': makeDeferred<void>(),
          'call-b': makeDeferred<void>(),
        };
        const result: Record<string, Deferred<core.ToolResult>> = {
          'call-a': makeDeferred<core.ToolResult>(),
          'call-b': makeDeferred<core.ToolResult>(),
        };

        const agentTool = {
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            const id = args['_test_id'] as string;
            return {
              params: args,
              eventEmitter: undefined,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue(`agent ${id}`),
              toolLocations: vi.fn().mockReturnValue([]),
              execute: vi.fn().mockImplementation(() => {
                called[id].resolve();
                return result[id].promise;
              }),
            };
          }),
        };

        mockToolRegistry.getTool.mockImplementation((name: string) =>
          name === core.ToolNames.AGENT ? agentTool : undefined,
        );
        mockConfig.getApprovalMode = vi
          .fn()
          .mockReturnValue(ApprovalMode.DEFAULT);
        mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);

        // Model returns two Agent calls, then an empty stream once results
        // are fed back (to terminate the prompt loop).
        const sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(
            createStreamWithChunks([
              {
                type: core.StreamEventType.CHUNK,
                value: {
                  functionCalls: [
                    {
                      id: 'call-a',
                      name: core.ToolNames.AGENT,
                      args: { _test_id: 'call-a', subagent_type: 'explore' },
                    },
                    {
                      id: 'call-b',
                      name: core.ToolNames.AGENT,
                      args: { _test_id: 'call-b', subagent_type: 'explore' },
                    },
                  ],
                },
              },
            ]),
          )
          .mockResolvedValueOnce(createEmptyStream());
        mockChat.sendMessageStream = sendMessageStream;

        const promptPromise = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'spawn two agents' }],
        });

        // Wait until both `execute()` bodies have been entered. Sequential
        // behaviour deadlocks here → vitest times out the test → failure.
        await Promise.all([called['call-a'].promise, called['call-b'].promise]);

        // Resolve out of order to also verify that final part ordering
        // follows the original functionCalls order, not resolution order.
        result['call-b'].resolve({ llmContent: 'B-done', returnDisplay: 'B' });
        result['call-a'].resolve({ llmContent: 'A-done', returnDisplay: 'A' });

        await promptPromise;

        // The second sendMessageStream invocation carries the tool responses
        // that will be fed back to the model — assert their order matches
        // the original function-call order (A before B).
        expect(sendMessageStream).toHaveBeenCalledTimes(2);
        const followUp = sendMessageStream.mock.calls[1][1] as {
          message: Array<{ functionResponse?: { id?: string } }>;
        };
        const ids = followUp.message
          .filter((p) => p.functionResponse)
          .map((p) => p.functionResponse?.id);
        expect(ids).toEqual(['call-a', 'call-b']);
      });

      it.each([core.ToolNames.AGENT, 'task', core.ToolNames.TOOL_CALL])(
        'starts every %s call of a fan-out concurrently, past the loop-detection threshold',
        async (callName) => {
          const previousMaxConcurrency =
            process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
          delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
          try {
            // Regression: the daemon once serialized the first three calls of a
            // large batch before widening concurrency, which stretched /review
            // fan-outs into several serial multi-minute agent runs. All five
            // calls here must reach execute() before any result resolves; under
            // the old serial prefix the fourth would not start until one of the
            // first three finished, and the race below reports that regression
            // with a named assertion instead of an opaque vitest timeout. The
            // `task` variant pins the legacy-alias branch of the agent
            // classifier: an aliased fan-out must still land in one concurrent
            // batch, not drop back onto the serial path.
            type Deferred<T> = {
              promise: Promise<T>;
              resolve: (v: T) => void;
            };
            const makeDeferred = <T>(): Deferred<T> => {
              let resolve!: (v: T) => void;
              const promise = new Promise<T>((r) => {
                resolve = r;
              });
              return { promise, resolve };
            };

            const ids = ['call-a', 'call-b', 'call-c', 'call-d', 'call-e'];
            const called: Record<string, Deferred<void>> = {};
            const result: Record<string, Deferred<core.ToolResult>> = {};
            for (const id of ids) {
              called[id] = makeDeferred<void>();
              result[id] = makeDeferred<core.ToolResult>();
            }

            const agentTool = {
              name: core.ToolNames.AGENT,
              kind: core.Kind.Think,
              // The schema-review gate fingerprints name +
              // parametersJsonSchema.
              schema: {
                name: 'Agent',
                parametersJsonSchema: { type: 'object', properties: {} },
              },
              build: vi
                .fn()
                .mockImplementation((args: Record<string, unknown>) => {
                  const id = args['_test_id'] as string;
                  return {
                    params: args,
                    eventEmitter: undefined,
                    getDefaultPermission: vi.fn().mockResolvedValue('allow'),
                    getDescription: vi.fn().mockReturnValue(`agent ${id}`),
                    toolLocations: vi.fn().mockReturnValue([]),
                    execute: vi.fn().mockImplementation(() => {
                      called[id].resolve();
                      return result[id].promise;
                    }),
                  };
                }),
            };

            mockToolRegistry.getTool.mockImplementation((name: string) =>
              name === callName ? agentTool : undefined,
            );
            if (callName === core.ToolNames.TOOL_CALL) {
              const { ToolCallTool } = await import(
                '@qwen-code/qwen-code-core/tools/tool-call.js'
              );
              const bridge = new ToolCallTool();
              const findTool = (name: string) =>
                name === core.ToolNames.TOOL_CALL
                  ? bridge
                  : name === core.ToolNames.TOOL_SEARCH
                    ? { name }
                    : name === core.ToolNames.AGENT
                      ? agentTool
                      : undefined;
              mockToolRegistry.getTool.mockImplementation(findTool);
              mockToolRegistry.ensureTool.mockImplementation(
                async (name: string) => findTool(name),
              );
              mockToolRegistry.isDeferredAndHidden.mockReturnValue(true);
              // Exercise the production schema-review gate: the recorded
              // review matches the live target's fingerprint.
              mockToolRegistry.getReviewedDeclaration = vi.fn(
                (name: string) => {
                  const tool = findTool(name);
                  return tool && 'build' in tool
                    ? core.deferredDeclarationFingerprint(tool as never)
                    : undefined;
                },
              );
            }
            mockConfig.getApprovalMode = vi
              .fn()
              .mockReturnValue(ApprovalMode.DEFAULT);
            mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);

            const sendMessageStream = vi
              .fn()
              .mockResolvedValueOnce(
                createStreamWithChunks([
                  {
                    type: core.StreamEventType.CHUNK,
                    value: {
                      functionCalls: ids.map((id) => ({
                        id,
                        name: callName,
                        args:
                          callName === core.ToolNames.TOOL_CALL
                            ? {
                                name: core.ToolNames.AGENT,
                                arguments: {
                                  _test_id: id,
                                  subagent_type: 'explore',
                                },
                              }
                            : { _test_id: id, subagent_type: 'explore' },
                      })),
                    },
                  },
                ]),
              )
              .mockResolvedValueOnce(createEmptyStream());
            mockChat.sendMessageStream = sendMessageStream;

            const promptPromise = session.prompt({
              sessionId: 'test-session-id',
              prompt: [{ type: 'text', text: 'spawn five agents' }],
            });

            let fanOutTimer: ReturnType<typeof setTimeout> | undefined;
            const fanOutDeadline = new Promise<never>((_, reject) => {
              fanOutTimer = setTimeout(
                () =>
                  reject(
                    new Error(
                      'Agent fan-out did not start concurrently ' +
                        '(serial-prefix regression).',
                    ),
                  ),
                10_000,
              );
            });
            await Promise.race([
              Promise.all(ids.map((id) => called[id].promise)),
              fanOutDeadline,
            ]);
            clearTimeout(fanOutTimer);

            for (const id of ids) {
              result[id].resolve({
                llmContent: `${id}-done`,
                returnDisplay: id,
              });
            }

            await promptPromise;

            expect(sendMessageStream).toHaveBeenCalledTimes(2);
            const followUp = sendMessageStream.mock.calls[1][1] as {
              message: Array<{ functionResponse?: { id?: string } }>;
            };
            expect(
              followUp.message
                .filter((p) => p.functionResponse)
                .map((p) => p.functionResponse?.id),
            ).toEqual(ids);
          } finally {
            if (previousMaxConcurrency === undefined) {
              delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
            } else {
              process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] =
                previousMaxConcurrency;
            }
          }
        },
      );

      it('fans bridged envelopes out when a live permission manager allows the bridge', async () => {
        // The batcher consults pm.isToolEnabled(tool_call) before resolving
        // the envelope; every production session has a non-null PM. The
        // deny arm is pinned elsewhere — this pins the allow arm: resolution
        // must still happen and the bridged delegations must fan out.
        const { ToolCallTool } = await import(
          '@qwen-code/qwen-code-core/tools/tool-call.js'
        );
        const bridge = new ToolCallTool();
        const isToolEnabled = vi.fn().mockResolvedValue(true);
        mockConfig.getPermissionManager = vi.fn().mockReturnValue({
          isToolEnabled,
          findMatchingDenyRule: vi.fn().mockReturnValue(undefined),
          hasRelevantRules: vi.fn().mockReturnValue(false),
          evaluate: vi.fn().mockResolvedValue('default'),
          hasMatchingAskRule: vi.fn().mockReturnValue(false),
        });
        type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
        const makeDeferred = <T>(): Deferred<T> => {
          let resolve!: (v: T) => void;
          const promise = new Promise<T>((r) => {
            resolve = r;
          });
          return { promise, resolve };
        };
        const called: Record<string, Deferred<void>> = {
          'call-a': makeDeferred<void>(),
          'call-b': makeDeferred<void>(),
        };
        const result: Record<string, Deferred<core.ToolResult>> = {
          'call-a': makeDeferred<core.ToolResult>(),
          'call-b': makeDeferred<core.ToolResult>(),
        };
        const agentTool = {
          name: core.ToolNames.AGENT,
          kind: core.Kind.Think,
          schema: {
            name: 'Agent',
            parametersJsonSchema: { type: 'object', properties: {} },
          },
          build: vi.fn().mockImplementation((args: Record<string, unknown>) => {
            const id = args['_test_id'] as string;
            return {
              params: args,
              getDefaultPermission: vi.fn().mockResolvedValue('allow'),
              getDescription: vi.fn().mockReturnValue(`agent ${id}`),
              toolLocations: vi.fn().mockReturnValue([]),
              execute: vi.fn().mockImplementation(() => {
                called[id].resolve();
                return result[id].promise;
              }),
            };
          }),
        };
        const findTool = (name: string) =>
          name === core.ToolNames.TOOL_CALL
            ? bridge
            : name === core.ToolNames.TOOL_SEARCH
              ? { name }
              : name === core.ToolNames.AGENT
                ? agentTool
                : undefined;
        mockToolRegistry.getTool.mockImplementation(findTool);
        mockToolRegistry.ensureTool.mockImplementation(async (name: string) =>
          findTool(name),
        );
        mockToolRegistry.isDeferredAndHidden.mockReturnValue(true);
        mockToolRegistry.getReviewedDeclaration = vi.fn((name: string) => {
          const tool = findTool(name);
          return tool && 'build' in tool
            ? core.deferredDeclarationFingerprint(tool as never)
            : undefined;
        });
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);

        const toolLoopState = {
          totalToolCalls: 0,
          invalidToolParamErrors: new Map<string, number>(),
          toolCallKeyCounts: new Map<string, number>(),
          maxToolCallKeyRepeat: 0,
          loopDetected: false,
        };
        const runPromise = (
          session as unknown as {
            runToolCalls: (
              abortSignal: AbortSignal,
              promptId: string,
              calls: FunctionCall[],
              loopState: typeof toolLoopState,
            ) => Promise<{ parts: Part[] }>;
          }
        ).runToolCalls(
          new AbortController().signal,
          'prompt-bridged-allow',
          ['call-a', 'call-b'].map((id) => ({
            id,
            name: core.ToolNames.TOOL_CALL,
            args: {
              name: core.ToolNames.AGENT,
              arguments: { _test_id: id, subagent_type: 'explore' },
            },
          })),
          toolLoopState,
        );

        // Serial classification would start call-b only after call-a's
        // execute resolves — the race below deadlocks in that shape.
        await Promise.all([called['call-a'].promise, called['call-b'].promise]);
        result['call-a'].resolve({ llmContent: 'A', returnDisplay: 'A' });
        result['call-b'].resolve({ llmContent: 'B', returnDisplay: 'B' });
        await runPromise;

        expect(isToolEnabled).toHaveBeenCalledWith(core.ToolNames.TOOL_CALL);
      });

      it('ignores malformed QWEN_CODE_MAX_TOOL_CONCURRENCY values', async () => {
        const previousMaxConcurrency =
          process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
        process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] = '1abc';
        try {
          type Deferred<T> = {
            promise: Promise<T>;
            resolve: (v: T) => void;
          };
          const makeDeferred = <T>(): Deferred<T> => {
            let resolve!: (v: T) => void;
            const promise = new Promise<T>((r) => {
              resolve = r;
            });
            return { promise, resolve };
          };

          const called: Record<string, Deferred<void>> = {
            'call-a': makeDeferred<void>(),
            'call-b': makeDeferred<void>(),
          };
          const result: Record<string, Deferred<core.ToolResult>> = {
            'call-a': makeDeferred<core.ToolResult>(),
            'call-b': makeDeferred<core.ToolResult>(),
          };

          const agentTool = {
            name: core.ToolNames.AGENT,
            kind: core.Kind.Think,
            build: vi
              .fn()
              .mockImplementation((args: Record<string, unknown>) => {
                const id = args['_test_id'] as string;
                return {
                  params: args,
                  eventEmitter: undefined,
                  getDefaultPermission: vi.fn().mockResolvedValue('allow'),
                  getDescription: vi.fn().mockReturnValue(`agent ${id}`),
                  toolLocations: vi.fn().mockReturnValue([]),
                  execute: vi.fn().mockImplementation(() => {
                    called[id].resolve();
                    return result[id].promise;
                  }),
                };
              }),
          };

          mockToolRegistry.getTool.mockImplementation((name: string) =>
            name === core.ToolNames.AGENT ? agentTool : undefined,
          );
          mockConfig.getApprovalMode = vi
            .fn()
            .mockReturnValue(ApprovalMode.DEFAULT);
          mockConfig.getPermissionManager = vi.fn().mockReturnValue(null);
          mockChat.sendMessageStream = vi
            .fn()
            .mockResolvedValueOnce(
              createStreamWithChunks([
                {
                  type: core.StreamEventType.CHUNK,
                  value: {
                    functionCalls: [
                      {
                        id: 'call-a',
                        name: core.ToolNames.AGENT,
                        args: { _test_id: 'call-a', subagent_type: 'explore' },
                      },
                      {
                        id: 'call-b',
                        name: core.ToolNames.AGENT,
                        args: { _test_id: 'call-b', subagent_type: 'explore' },
                      },
                    ],
                  },
                },
              ]),
            )
            .mockResolvedValueOnce(createEmptyStream());

          const promptPromise = session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'spawn two agents' }],
          });

          await Promise.all([
            called['call-a'].promise,
            called['call-b'].promise,
          ]);

          result['call-a'].resolve({
            llmContent: 'A-done',
            returnDisplay: 'A',
          });
          result['call-b'].resolve({
            llmContent: 'B-done',
            returnDisplay: 'B',
          });

          await promptPromise;
        } finally {
          if (previousMaxConcurrency === undefined) {
            delete process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'];
          } else {
            process.env['QWEN_CODE_MAX_TOOL_CONCURRENCY'] =
              previousMaxConcurrency;
          }
        }
      });
    });

    describe('system reminders', () => {
      // Captures the `message` parts fed into chat.sendMessageStream on the
      // first turn so individual tests can assert what the model saw.
      const captureFirstTurnMessage = () => {
        const capture: { parts: Array<{ text?: string }> } = { parts: [] };
        (mockChat.sendMessageStream as ReturnType<typeof vi.fn>) = vi
          .fn()
          .mockImplementation(async (_model, req) => {
            capture.parts = req.message ?? [];
            return createEmptyStream();
          });
        return capture;
      };

      it('prepends plan-mode reminder when approval mode is PLAN (#1151)', async () => {
        mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.PLAN);
        const capture = captureFirstTurnMessage();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'research this' }],
        });

        const reminderPart = capture.parts.find(
          (p) => p.text && p.text.includes('Plan mode is active'),
        );
        expect(reminderPart).toBeTruthy();
        expect(reminderPart!.text).toContain('exit_plan_mode');
        // Reminder comes before the user text, matching client.ts ordering.
        const reminderIdx = capture.parts.indexOf(reminderPart!);
        const userIdx = capture.parts.findIndex(
          (p) => p.text === 'research this',
        );
        expect(reminderIdx).toBeLessThan(userIdx);
      });

      it('does not prepend plan-mode reminder in default approval mode', async () => {
        mockConfig.getApprovalMode = vi
          .fn()
          .mockReturnValue(ApprovalMode.DEFAULT);
        const capture = captureFirstTurnMessage();

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hi' }],
        });

        const hasPlanReminder = capture.parts.some(
          (p) => p.text && p.text.includes('Plan mode is active'),
        );
        expect(hasPlanReminder).toBe(false);
      });
    });

    describe('ask_user_question cancellation turn stop', () => {
      function createAskUserQuestionResponseStream() {
        return createStreamWithChunks([
          {
            type: core.StreamEventType.CHUNK,
            value: {
              usageMetadata: {
                totalTokenCount: 10,
                promptTokenCount: 5,
              },
              functionCalls: [
                {
                  id: 'ask-user-question-call',
                  name: core.ToolNames.ASK_USER_QUESTION,
                  args: {
                    questions: [{ header: 'Continue?', question: 'Continue?' }],
                  },
                },
              ],
            },
          },
        ]);
      }

      async function* createAbortingEmptyStream() {
        await session.cancelPendingPrompt();
        yield* createEmptyStream();
      }

      it('waits for pending rewrites before ending after cancelled ask_user_question', async () => {
        let releaseRewrite!: () => void;
        const flushTurn = vi.fn().mockResolvedValue(undefined);
        const waitForPendingRewrites = vi.fn(
          () =>
            new Promise<void>((resolve) => {
              releaseRewrite = resolve;
            }),
        );
        session.messageRewriter = {
          interceptUpdate: vi.fn().mockResolvedValue(undefined),
          flushTurn,
          waitForPendingRewrites,
        } as unknown as Session['messageRewriter'];
        mockToolRegistry.getTool.mockReturnValue(
          mockConfirmingTool(core.ToolNames.ASK_USER_QUESTION, vi.fn()),
        );
        vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
          outcome: { outcome: 'cancelled' },
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createAskUserQuestionResponseStream());
        vi.mocked(mockClient.extMethod).mockResolvedValueOnce({
          messages: ['follow-up while waiting'],
        });

        const promptPromise = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'question' }],
        });
        let promptSettled = false;
        void promptPromise.then(() => {
          promptSettled = true;
        });

        await vi.waitFor(() => {
          expect(waitForPendingRewrites).toHaveBeenCalledTimes(1);
        });
        await Promise.resolve();

        expect(flushTurn).toHaveBeenCalledTimes(1);
        expect(promptSettled).toBe(false);

        releaseRewrite();
        await expect(promptPromise).resolves.toEqual({
          stopReason: 'end_turn',
        });
        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'ask-user-question-call',
                name: core.ToolNames.ASK_USER_QUESTION,
              }),
            }),
            {
              text: '\n[User message received during tool execution]: follow-up while waiting',
            },
          ],
        });
        expect(
          mockChatRecordingService.recordMidTurnUserMessage,
        ).toHaveBeenCalledWith(
          [
            {
              text: '\n[User message received during tool execution]: follow-up while waiting',
            },
          ],
          'follow-up while waiting',
        );
      });

      it('waits for pending rewrites before cron stops after cancelled ask_user_question', async () => {
        const scheduler = {
          size: 1,
          hasPendingWork: true,
          start: vi.fn((callback: (job: { prompt: string }) => void) => {
            callback({ prompt: 'scheduled question' });
          }),
          stop: vi.fn(),
          getExitSummary: vi.fn().mockReturnValue(undefined),
        };
        mockConfig.isCronEnabled = vi.fn().mockReturnValue(true);
        mockConfig.getCronScheduler = vi.fn().mockReturnValue(scheduler);

        let releaseCronRewrite!: () => void;
        const waitForPendingRewrites = vi
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(
            () =>
              new Promise<void>((resolve) => {
                releaseCronRewrite = resolve;
              }),
          );
        session.messageRewriter = {
          interceptUpdate: vi.fn().mockResolvedValue(undefined),
          flushTurn: vi.fn().mockResolvedValue(undefined),
          waitForPendingRewrites,
        } as unknown as Session['messageRewriter'];
        mockToolRegistry.getTool.mockReturnValue(
          mockConfirmingTool(core.ToolNames.ASK_USER_QUESTION, vi.fn()),
        );
        vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
          outcome: { outcome: 'cancelled' },
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createAskUserQuestionResponseStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start cron' }],
        });

        await vi.waitFor(() => {
          expect(waitForPendingRewrites).toHaveBeenCalledTimes(2);
        });

        const internals = session as unknown as {
          cronCompletion: Promise<void> | null;
        };
        const cronCompletion = internals.cronCompletion;
        expect(cronCompletion).toBeTruthy();
        let cronSettled = false;
        void cronCompletion?.then(() => {
          cronSettled = true;
        });
        await Promise.resolve();

        expect(cronSettled).toBe(false);

        releaseCronRewrite();
        await vi.waitFor(() => {
          expect(internals.cronCompletion).toBeNull();
        });
      });

      it('ends Stop-hook continuation after cancelled ask_user_question', async () => {
        const execute = vi.fn();
        mockToolRegistry.getTool.mockReturnValue(
          mockConfirmingTool(core.ToolNames.ASK_USER_QUESTION, execute),
        );
        vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
          outcome: { outcome: 'cancelled' },
        });
        const messageBus = {
          request: vi
            .fn()
            .mockResolvedValueOnce({
              success: true,
              output: {
                decision: 'block',
                reason: 'Continue after Stop hook',
              },
            })
            .mockResolvedValueOnce({
              success: true,
              output: {},
            }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'response text' }] },
          ]);
        mockChat.getLastModelMessageText = vi
          .fn()
          .mockReturnValue('response text');
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createAskUserQuestionResponseStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'end_turn' });

        expect(execute).not.toHaveBeenCalled();
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(
          messageBus.request.mock.calls.filter(
            ([request]) =>
              typeof request === 'object' &&
              request !== null &&
              'eventName' in request &&
              request.eventName === 'Stop',
          ),
        ).toHaveLength(1);
        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'ask-user-question-call',
                name: core.ToolNames.ASK_USER_QUESTION,
              }),
            }),
          ],
        });
      });

      it('preserves parent cancellation during Stop-hook permission', async () => {
        const execute = vi.fn();
        mockToolRegistry.getTool.mockReturnValue(
          mockConfirmingTool(core.ToolNames.ASK_USER_QUESTION, execute),
        );
        vi.mocked(mockClient.requestPermission).mockImplementationOnce(
          () => new Promise(() => {}),
        );
        const messageBus = {
          request: vi.fn().mockResolvedValueOnce({
            success: true,
            output: {
              decision: 'block',
              reason: 'Continue after Stop hook',
            },
          }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'response text' }] },
          ]);
        mockChat.getLastModelMessageText = vi
          .fn()
          .mockReturnValue('response text');
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createAskUserQuestionResponseStream());

        const prompt = session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'hello' }],
        });
        await vi.waitFor(() => {
          expect(mockClient.requestPermission).toHaveBeenCalledOnce();
        });
        await session.cancelPendingPrompt();

        await expect(prompt).resolves.toEqual({ stopReason: 'cancelled' });
        expect(execute).not.toHaveBeenCalled();
      });

      it('reports cancellation when abort lands between Stop-hook iterations', async () => {
        const messageBus = {
          request: vi.fn().mockResolvedValueOnce({
            success: true,
            output: {
              decision: 'block',
              reason: 'Continue after Stop hook',
            },
          }),
        };
        mockConfig.getMessageBus = vi.fn().mockReturnValue(messageBus);
        mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
        mockConfig.hasHooksForEvent = vi
          .fn()
          .mockImplementation((eventName: string) => eventName === 'Stop');
        mockChat.getHistory = vi
          .fn()
          .mockReturnValue([
            { role: 'model', parts: [{ text: 'response text' }] },
          ]);
        mockChat.getLastModelMessageText = vi
          .fn()
          .mockReturnValue('response text');
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createAbortingEmptyStream());

        await expect(
          session.prompt({
            sessionId: 'test-session-id',
            prompt: [{ type: 'text', text: 'hello' }],
          }),
        ).resolves.toEqual({ stopReason: 'cancelled' });
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
        expect(messageBus.request).toHaveBeenCalledTimes(1);
      });

      it('ends background notification processing after cancelled ask_user_question', async () => {
        const execute = vi.fn();
        mockToolRegistry.getTool.mockReturnValue(
          mockConfirmingTool(core.ToolNames.ASK_USER_QUESTION, execute),
        );
        vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
          outcome: { outcome: 'cancelled' },
        });
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createAskUserQuestionResponseStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start background work' }],
        });

        const callback = mockBackgroundTaskRegistry.setNotificationCallback.mock
          .calls[0][0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string; toolUseId?: string },
        ) => void;

        callback('done', '<task-notification />', {
          agentId: 'agent-1',
          status: 'completed',
        });

        await vi.waitFor(() => {
          expect(mockClient.extNotification).toHaveBeenCalledWith(
            '_qwencode/end_turn',
            {
              sessionId: 'test-session-id',
              reason: 'end_turn',
              source: 'background_notification',
              turnId: expect.stringMatching(
                /^test-session-id########notification[\w-]+$/,
              ),
            },
          );
        });

        expect(execute).not.toHaveBeenCalled();
        expect(mockChat.addHistory).toHaveBeenCalledWith({
          role: 'user',
          parts: [
            expect.objectContaining({
              functionResponse: expect.objectContaining({
                id: 'ask-user-question-call',
                name: core.ToolNames.ASK_USER_QUESTION,
              }),
            }),
          ],
        });
      });

      it('reports cancellation while a background notification awaits permission', async () => {
        const execute = vi.fn();
        mockToolRegistry.getTool.mockReturnValue(
          mockConfirmingTool(core.ToolNames.ASK_USER_QUESTION, execute),
        );
        vi.mocked(mockClient.requestPermission).mockImplementationOnce(
          () => new Promise(() => {}),
        );
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createAskUserQuestionResponseStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start background work' }],
        });

        const callback = mockBackgroundTaskRegistry.setNotificationCallback.mock
          .calls[0][0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string; toolUseId?: string },
        ) => void;
        callback('done', '<task-notification />', {
          agentId: 'agent-1',
          status: 'completed',
        });
        await vi.waitFor(() => {
          expect(mockClient.requestPermission).toHaveBeenCalledOnce();
        });
        await session.cancelPendingPrompt();

        await vi.waitFor(() => {
          expect(mockClient.extNotification).toHaveBeenCalledWith(
            '_qwencode/end_turn',
            {
              sessionId: 'test-session-id',
              reason: 'cancelled',
              source: 'background_notification',
              turnId: expect.stringMatching(
                /^test-session-id########notification[\w-]+$/,
              ),
            },
          );
        });
        expect(execute).not.toHaveBeenCalled();
      });

      it('reports cancellation when a background stream ends after abort', async () => {
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(createEmptyStream())
          .mockResolvedValueOnce(createAbortingEmptyStream());

        await session.prompt({
          sessionId: 'test-session-id',
          prompt: [{ type: 'text', text: 'start background work' }],
        });

        const callback = mockBackgroundTaskRegistry.setNotificationCallback.mock
          .calls[0][0] as (
          displayText: string,
          modelText: string,
          meta: { agentId: string; status: string; toolUseId?: string },
        ) => void;
        callback('done', '<task-notification />', {
          agentId: 'agent-1',
          status: 'completed',
        });

        await vi.waitFor(() => {
          expect(mockClient.extNotification).toHaveBeenCalledWith(
            '_qwencode/end_turn',
            {
              sessionId: 'test-session-id',
              reason: 'cancelled',
              source: 'background_notification',
              turnId: expect.stringMatching(
                /^test-session-id########notification[\w-]+$/,
              ),
            },
          );
        });
      });
    });
  });

  describe('ordinary-turn Goal proposals', () => {
    const objective = 'Outcome: tests pass. Done when: npm test exits 0.';
    let pending: core.PendingGoalProposal | undefined;

    function useRealApprovalState() {
      const config = new core.Config({
        cwd: '/tmp',
        targetDir: '/tmp',
        model: 'test-model',
        approvalMode: ApprovalMode.DEFAULT,
        debugMode: false,
        chatRecording: false,
        usageStatisticsEnabled: false,
        overrideExtensions: [],
      });
      Object.assign(mockConfig, {
        getApprovalMode: config.getApprovalMode.bind(config),
        setApprovalMode: config.setApprovalMode.bind(config),
        hasPendingGoalProposal: config.hasPendingGoalProposal.bind(config),
        setPendingGoalProposal: config.setPendingGoalProposal.bind(config),
        takePendingGoalProposal: config.takePendingGoalProposal.bind(config),
      });
      return config;
    }

    function proposalStream() {
      return createStreamWithChunks([
        {
          type: core.StreamEventType.CHUNK,
          value: {
            functionCalls: [
              {
                id: 'goal-proposal',
                name: 'propose_goal',
                args: { objective },
              },
            ],
          },
        },
      ]);
    }

    function prompt(invocationContext?: core.InvocationContextV1) {
      return session.prompt(
        {
          sessionId: 'test-session-id',
          _meta: { 'qwen.goalProposalApproval': true },
          prompt: [
            { type: 'text', text: 'Draft a Goal to make the tests pass.' },
          ],
        },
        invocationContext,
      );
    }

    beforeEach(() => {
      pending = undefined;
      mockConfig.getGoalProposalHostSupported = vi.fn().mockReturnValue(true);
      mockConfig.hasPendingGoalProposal = vi.fn(() => pending !== undefined);
      mockConfig.setPendingGoalProposal = vi.fn((proposal) => {
        if (pending) return false;
        pending = proposal;
        return true;
      });
      mockConfig.takePendingGoalProposal = vi.fn((turnKey) => {
        if (turnKey !== undefined && pending?.turnKey !== turnKey) {
          return undefined;
        }
        const proposal = pending;
        pending = undefined;
        return proposal;
      });
      const tool = new core.ProposeGoalTool(mockConfig);
      mockToolRegistry.getTool.mockImplementation((name) =>
        name === 'propose_goal' ? tool : undefined,
      );
      mockGoalRuntime.dispatch.mockResolvedValue({
        snapshot: {
          v: 2,
          activity: 'idle',
          goal: { goalId: 'approved-goal', revision: 1, status: 'active' },
        },
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(proposalStream())
        .mockImplementation(async () => createEmptyStream());
    });

    it('requires explicit approval in YOLO even with an allow rule, then applies after acknowledgement exactly once', async () => {
      mockConfig.getApprovalMode = vi.fn().mockReturnValue(ApprovalMode.YOLO);
      mockConfig.getPermissionManager = vi.fn().mockReturnValue({
        isToolEnabled: vi.fn().mockResolvedValue(true),
        hasRelevantRules: vi.fn().mockReturnValue(true),
        evaluate: vi.fn().mockResolvedValue('allow'),
      });
      let releaseAcknowledgement!: () => void;
      const acknowledgement = new Promise<void>((resolve) => {
        releaseAcknowledgement = resolve;
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(proposalStream())
        .mockImplementationOnce(async () => {
          expect(pending?.objective).toBe(objective);
          expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
          return (async function* () {
            await acknowledgement;
            yield {
              type: core.StreamEventType.CHUNK,
              value: {
                candidates: [
                  { content: { parts: [{ text: 'Goal approved.' }] } },
                ],
              },
            };
          })();
        })
        .mockImplementation(async () => createEmptyStream());

      const result = prompt();
      await vi.waitFor(() => {
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      });
      expect(mockClient.requestPermission).toHaveBeenCalledOnce();
      expect(mockClient.requestPermission).toHaveBeenCalledWith(
        expect.objectContaining({
          toolCall: expect.objectContaining({
            content: [
              expect.objectContaining({
                content: expect.objectContaining({
                  text: expect.stringContaining(objective),
                }),
              }),
            ],
          }),
          options: [
            expect.objectContaining({ kind: 'allow_once' }),
            expect.objectContaining({ kind: 'reject_once' }),
          ],
        }),
      );
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      releaseAcknowledgement();
      await expect(result).resolves.toEqual({ stopReason: 'end_turn' });
      expect(mockGoalRuntime.dispatch).toHaveBeenCalledExactlyOnceWith({
        action: 'create',
        objective,
      });
      expect(pending).toBeUndefined();
      expect(mockChatRecordingService.recordToolResult).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            functionResponse: expect.objectContaining({
              id: 'goal-proposal',
              name: 'propose_goal',
            }),
          }),
        ]),
        expect.anything(),
      );
      await prompt();
      expect(mockGoalRuntime.dispatch).toHaveBeenCalledTimes(1);
    });

    it.each(['plan', 'default'])(
      'revokes an approved Goal after entering Plan, even if the final mode is %s',
      async (finalMode) => {
        const config = useRealApprovalState();
        mockChat.sendMessageStream = vi
          .fn()
          .mockResolvedValueOnce(proposalStream())
          .mockImplementationOnce(async () => {
            expect(config.hasPendingGoalProposal()).toBe(true);
            await session.setMode({
              sessionId: 'test-session-id',
              modeId: 'plan',
            });
            if (finalMode === 'default') {
              await session.setMode({
                sessionId: 'test-session-id',
                modeId: 'default',
              });
            }
            return createEmptyStream();
          });

        await prompt();

        expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
        expect(config.hasPendingGoalProposal()).toBe(false);
        expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            update: expect.objectContaining({
              sessionUpdate: 'agent_message_chunk',
              content: expect.objectContaining({
                text: expect.stringContaining('approval was revoked'),
              }),
            }),
          }),
        );
      },
    );

    it('revokes approval when Plan mode begins during runtime loading', async () => {
      useRealApprovalState();
      vi.mocked(mockConfig.getGoalRuntimeReady)
        .mockReset()
        .mockResolvedValueOnce(mockGoalRuntime as unknown as core.GoalRuntime)
        .mockResolvedValueOnce(mockGoalRuntime as unknown as core.GoalRuntime)
        .mockImplementationOnce(async () => {
          await session.setMode({
            sessionId: 'test-session-id',
            modeId: 'plan',
          });
          return mockGoalRuntime as unknown as core.GoalRuntime;
        });

      await prompt();

      expect(mockConfig.getGoalRuntimeReady).toHaveBeenCalledTimes(3);
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
    });

    it('pauses a Goal when Plan mode begins during creation persistence', async () => {
      useRealApprovalState();
      mockGoalRuntime.dispatch.mockImplementationOnce(async () => {
        await session.setMode({ sessionId: 'test-session-id', modeId: 'plan' });
        return {
          snapshot: {
            goal: { goalId: 'approved-goal', revision: 1, status: 'active' },
          },
        };
      });

      await prompt();

      expect(mockGoalRuntime.dispatch).toHaveBeenNthCalledWith(2, {
        action: 'pause',
        expectedGoalId: 'approved-goal',
        expectedRevision: 1,
        reason: GOAL_PAUSE_REASON_USER_INTERRUPT,
      });
    });

    it('arms and clears declarations only for an approval-capable user turn', async () => {
      mockConfig.getGoalProposalHostSupported = vi.fn().mockReturnValue(true);

      await prompt();

      expect(mockConfig.setGoalProposalTurnKey).toHaveBeenNthCalledWith(
        1,
        'test-session-id########1',
      );
      expect(mockConfig.setGoalProposalTurnKey).toHaveBeenNthCalledWith(
        2,
        undefined,
      );
      expect(mockLlmClient.setTools).toHaveBeenCalledTimes(2);
      // propose_goal is natively deferred: the arm/clear pair must also
      // reveal/unreveal it, or the tool is filtered out of every
      // announcement and no ACP/daemon model can ever discover it.
      expect(mockToolRegistry.revealDeferredTool).toHaveBeenCalledWith(
        'propose_goal',
      );
      expect(mockToolRegistry.unrevealDeferredTool).toHaveBeenCalledWith(
        'propose_goal',
      );
      vi.mocked(mockConfig.setGoalProposalTurnKey).mockClear();
      mockLlmClient.setTools.mockClear();
      mockToolRegistry.revealDeferredTool.mockClear();
      mockToolRegistry.unrevealDeferredTool.mockClear();
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'An unarmed turn.' }],
      });
      expect(mockConfig.setGoalProposalTurnKey).toHaveBeenCalledTimes(2);
      expect(mockConfig.setGoalProposalTurnKey).toHaveBeenNthCalledWith(
        1,
        undefined,
      );
      expect(mockConfig.setGoalProposalTurnKey).toHaveBeenNthCalledWith(
        2,
        undefined,
      );
      expect(mockLlmClient.setTools).not.toHaveBeenCalled();
      expect(mockToolRegistry.revealDeferredTool).not.toHaveBeenCalled();
      expect(mockToolRegistry.unrevealDeferredTool).not.toHaveBeenCalled();
    });

    it('applies an approved proposal when a sibling permission is rejected', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(
          createStreamWithChunks([
            {
              type: core.StreamEventType.CHUNK,
              value: {
                functionCalls: [
                  {
                    id: 'goal-proposal',
                    name: 'propose_goal',
                    args: { objective },
                  },
                  {
                    id: 'question',
                    name: core.ToolNames.ASK_USER_QUESTION,
                    args: { questions: [] },
                  },
                ],
              },
            },
          ]),
        )
        .mockImplementation(async () => createEmptyStream());
      const proposalTool = new core.ProposeGoalTool(mockConfig);
      mockToolRegistry.getTool.mockImplementation((name) =>
        name === 'propose_goal'
          ? proposalTool
          : mockConfirmingTool(name, vi.fn()),
      );
      vi.mocked(mockClient.requestPermission)
        .mockResolvedValueOnce({
          outcome: { outcome: 'selected', optionId: 'proceed_once' },
        })
        .mockResolvedValueOnce({
          outcome: {
            outcome: 'selected',
            optionId: core.ToolConfirmationOutcome.Cancel,
          },
        });

      await expect(prompt()).resolves.toEqual({ stopReason: 'end_turn' });
      expect(mockGoalRuntime.dispatch).toHaveBeenCalledWith({
        action: 'create',
        objective,
      });
    });

    it.each(['reject', 'cancel'] as const)(
      'does not create a Goal after permission %s',
      async (outcome) => {
        vi.mocked(mockClient.requestPermission).mockResolvedValueOnce({
          outcome:
            outcome === 'reject'
              ? {
                  outcome: 'selected',
                  optionId: core.ToolConfirmationOutcome.Cancel,
                }
              : { outcome: 'cancelled' },
        });
        await prompt();
        expect(mockClient.requestPermission).toHaveBeenCalledOnce();
        expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
        expect(pending).toBeUndefined();
      },
    );

    it('discards approval when the acknowledgement fails', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(proposalStream())
        .mockRejectedValueOnce(new Error('provider failed'));
      await expect(prompt()).rejects.toThrow('provider failed');
      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
      expect(mockConfig.setGoalProposalTurnKey).toHaveBeenLastCalledWith(
        undefined,
      );
      expect(mockLlmClient.setTools).toHaveBeenCalled();
    });

    it('discards approval on cancellation before acknowledgement ends', async () => {
      let finishStream!: () => void;
      const gate = new Promise<void>((resolve) => {
        finishStream = resolve;
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(proposalStream())
        .mockResolvedValueOnce(
          (async function* () {
            await gate;
            yield* createEmptyStream();
          })(),
        );
      const result = prompt();
      await vi.waitFor(() =>
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2),
      );
      await session.cancelPendingPrompt();
      finishStream();
      await expect(result).resolves.toEqual({ stopReason: 'cancelled' });
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
    });

    it('does not apply after cancellation while the Goal runtime loads', async () => {
      let finishRuntimeLoad!: () => void;
      const runtimeLoad = new Promise<core.GoalRuntime>((resolve) => {
        finishRuntimeLoad = () =>
          resolve(mockGoalRuntime as unknown as core.GoalRuntime);
      });
      vi.mocked(mockConfig.getGoalRuntimeReady)
        .mockReset()
        .mockResolvedValueOnce(mockGoalRuntime as unknown as core.GoalRuntime)
        .mockResolvedValueOnce(mockGoalRuntime as unknown as core.GoalRuntime)
        .mockReturnValueOnce(runtimeLoad);

      const result = prompt();
      await vi.waitFor(() =>
        expect(mockConfig.getGoalRuntimeReady).toHaveBeenCalledTimes(3),
      );
      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      await session.cancelPendingPrompt();
      finishRuntimeLoad();

      await expect(result).resolves.toEqual({ stopReason: 'end_turn' });
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: `The approved Goal was not started because the turn did not finish normally. To start it, run:\n/goal set ${objective}`,
            }),
          }),
        }),
      );
    });

    it('pauses a Goal if cancellation arrives while its creation is persisted', async () => {
      let completeCreate!: () => void;
      const gate = new Promise<void>((resolve) => {
        completeCreate = resolve;
      });
      mockGoalRuntime.dispatch.mockImplementationOnce(async () => {
        await gate;
        return {
          snapshot: {
            goal: { goalId: 'approved-goal', revision: 1, status: 'active' },
          },
        };
      });
      const result = prompt();
      await vi.waitFor(() =>
        expect(mockGoalRuntime.dispatch).toHaveBeenCalledOnce(),
      );
      await session.cancelPendingPrompt();
      completeCreate();
      await result;
      expect(mockGoalRuntime.dispatch).toHaveBeenNthCalledWith(2, {
        action: 'pause',
        expectedGoalId: 'approved-goal',
        expectedRevision: 1,
        reason: GOAL_PAUSE_REASON_USER_INTERRUPT,
      });
    });

    it('attributes a close during Goal creation to session disposal', async () => {
      let completeCreate!: () => void;
      const gate = new Promise<void>((resolve) => {
        completeCreate = resolve;
      });
      mockGoalRuntime.dispatch.mockImplementationOnce(async () => {
        await gate;
        return {
          snapshot: {
            goal: { goalId: 'approved-goal', revision: 1, status: 'active' },
          },
        };
      });
      const result = prompt();
      await vi.waitFor(() =>
        expect(mockGoalRuntime.dispatch).toHaveBeenCalledOnce(),
      );
      const releaseClose = session.beginClose();
      completeCreate();
      await result;

      expect(mockGoalRuntime.dispatch).toHaveBeenNthCalledWith(2, {
        action: 'pause',
        expectedGoalId: 'approved-goal',
        expectedRevision: 1,
        reason: GOAL_PAUSE_REASON_SESSION_DISPOSED,
      });
      releaseClose();
    });

    it('reports when the approved proposal no longer matches the Goal', async () => {
      mockGoalRuntime.getSnapshot.mockReturnValue({
        v: 2,
        activity: 'idle',
        goal: null,
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(proposalStream())
        .mockImplementationOnce(async () => {
          mockGoalRuntime.getSnapshot.mockReturnValue({
            v: 2,
            activity: 'idle',
            goal: { goalId: 'newer-goal', revision: 2, status: 'paused' },
          });
          return createEmptyStream();
        });

      await prompt();

      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(debugLoggerDebugSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'The Goal changed after the proposal was shown',
        ),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: expect.stringContaining(
                'Goal changed after the proposal was shown',
              ),
            }),
          }),
        }),
      );
      expect(mockClient.sessionUpdate).not.toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: expect.stringContaining('/goal set'),
            }),
          }),
        }),
      );
    });

    it('reports when applying the approved proposal fails', async () => {
      mockGoalRuntime.dispatch.mockRejectedValueOnce(
        new Error('goal journal unavailable'),
      );

      await prompt();

      expect(mockGoalRuntime.dispatch).toHaveBeenCalledOnce();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: `The approved Goal could not be started. Check the Goal status before trying again, or run:\n/goal set ${objective}`,
            }),
          }),
        }),
      );
    });

    it('holds a cancelled Goal when pause persistence fails, then permits a user pause and resume', async () => {
      const goal = {
        goalId: 'approved-goal',
        revision: 1,
        objective,
        status: 'active' as const,
        evidenceCursor: { recordId: 'created-goal' },
        turnCount: 0,
        activeTimeMs: 0,
        tokensUsed: 0,
        createdAt: 1,
        updatedAt: 1,
      };
      const snapshot = { v: 2 as const, activity: 'idle' as const, goal };
      const listener = mockGoalRuntime.subscribe.mock.calls[0][0] as (
        snapshot: core.GoalSnapshotV2,
        cause: core.GoalStateCause,
      ) => void;
      let completeCreate!: () => void;
      const gate = new Promise<void>((resolve) => {
        completeCreate = resolve;
      });
      mockGoalRuntime.dispatch
        .mockImplementationOnce(async () => {
          await gate;
          mockGoalRuntime.getSnapshot.mockReturnValue(snapshot);
          listener(snapshot, 'create');
          await boundGoalHost!.startGoalTurn({
            permit: {
              goalId: goal.goalId,
              revision: 1,
              turnId: 'cancelled-start',
            },
            continuationContext: objective,
          });
          return { snapshot };
        })
        .mockRejectedValueOnce(new Error('pause journal write failed'));

      const result = prompt();
      await vi.waitFor(() =>
        expect(mockGoalRuntime.dispatch).toHaveBeenCalledOnce(),
      );
      await session.cancelPendingPrompt();
      completeCreate();
      await result;
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(2);
      expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: 'The Goal was created, but its cancellation could not be saved. Automatic execution is held in this session. Run:\n/goal pause\nThen, when ready:\n/goal resume',
            }),
          }),
        }),
      );

      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'What is the weather?' }],
      });
      expect(mockGoalRuntime.beginTurn).not.toHaveBeenCalled();
      expect(mockGoalRuntime.finishTurn).not.toHaveBeenCalled();
      expect(mockGoalRuntime.releaseTurn).toHaveBeenCalledWith(
        'goal-runtime:cancelled-start',
        { requeue: false },
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: 'Automatic Goal execution is still held. Run:\n/goal pause\nThen, when ready:\n/goal resume',
            }),
          }),
        }),
      );

      const paused = {
        ...snapshot,
        goal: { ...goal, status: 'paused' as const },
      };
      mockGoalRuntime.getSnapshot.mockReturnValue(paused);
      listener(paused, 'pause');
      await boundGoalHost!.preemptGoalTurn('Goal pause');
      mockGoalRuntime.getSnapshot.mockReturnValue(snapshot);
      listener(snapshot, 'resume');
      const permit = {
        goalId: goal.goalId,
        revision: 1,
        turnId: 'resumed-start',
      };
      mockGoalRuntime.permitForTurn.mockReturnValue(permit);
      await boundGoalHost!.startGoalTurn({
        permit,
        continuationContext: objective,
      });
      await vi.waitFor(() =>
        expect(mockChat.sendMessageStream).toHaveBeenCalledTimes(3),
      );
      await vi.waitFor(() =>
        expect(mockGoalRuntime.finishTurn).toHaveBeenCalledWith(permit),
      );
    });

    it('does not settle a proposal owned by another turn', async () => {
      mockConfig.setPendingGoalProposal = vi.fn((proposal) => {
        pending = { ...proposal, turnKey: 'another-turn' };
        return true;
      });
      await prompt();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending?.turnKey).toBe('another-turn');
    });

    it('does not start a Goal when a protective Stop-hook cap returns end_turn', async () => {
      mockConfig.getStopHookBlockingCap = vi.fn().mockReturnValue(1);
      mockConfig.getDisableAllHooks = vi.fn().mockReturnValue(false);
      mockConfig.hasHooksForEvent = vi.fn((event) => event === 'Stop');
      mockConfig.getMessageBus = vi.fn().mockReturnValue({
        request: vi.fn().mockImplementation(async (request) => ({
          success: true,
          output:
            request.eventName === 'Stop'
              ? {
                  decision: 'block',
                  reason: 'The requested work is unfinished',
                }
              : {},
        })),
      });

      await expect(prompt()).resolves.toEqual({ stopReason: 'end_turn' });

      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: expect.stringContaining('/goal set'),
            }),
          }),
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            content: expect.objectContaining({
              text: expect.stringContaining(objective),
            }),
          }),
        }),
      );
    });

    it('does not start a Goal when a queued prompt takes priority', async () => {
      const internals = session as unknown as {
        todoStopGuardQueuedPromptPriority: boolean;
      };
      const coreSettler = new core.LlmClient(mockConfig) as unknown as {
        settlePendingGoalProposal: (
          turnEnded: boolean,
          signal: AbortSignal,
          loadGoalRuntime: (
            required: boolean,
          ) => Promise<core.GoalRuntime | undefined>,
          turnKey: string,
          reportFailure: (message: string) => void,
        ) => Promise<void>;
      };
      mockConfig.setPendingGoalProposal = vi.fn((proposal) => {
        pending = proposal;
        internals.todoStopGuardQueuedPromptPriority = true;
        return true;
      });
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(proposalStream())
        .mockImplementationOnce(async () => {
          await coreSettler.settlePendingGoalProposal(
            true,
            new AbortController().signal,
            async () => mockGoalRuntime as unknown as core.GoalRuntime,
            'test-session-id########1',
            vi.fn(),
          );
          return createEmptyStream();
        });

      await expect(prompt()).resolves.toEqual({ stopReason: 'end_turn' });

      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
    });

    it('does not start a Goal when an empty drain yields to a queued prompt', async () => {
      const internals = session as unknown as {
        todoStopGuard: DaemonTodoStopGuard;
      };
      Object.defineProperty(internals.todoStopGuard, 'needsStopInspection', {
        configurable: true,
        get: () => true,
      });
      vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
        if (method === 'craft/drainMidTurnQueue') {
          return { messages: [], hasQueuedPrompt: true };
        }
        if (method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD) {
          return { claimed: false, hasQueuedPrompt: true };
        }
        return {};
      });

      await expect(
        prompt({
          version: 1,
          sessionId: 'test-session-id',
          promptId: 'queued-prompt-owner',
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });

      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
    });

    it('does not start a Goal when a guard continuation yields to a queued prompt before sending', async () => {
      const internals = session as unknown as {
        todoStopGuard: DaemonTodoStopGuard;
      };
      vi.spyOn(internals.todoStopGuard, 'decide').mockReturnValue({
        kind: 'continue',
        attempt: 1,
        maxAttempts: 2,
        unfinishedCount: 1,
      });
      vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
        if (method === 'craft/drainMidTurnQueue') {
          return { messages: [], hasQueuedPrompt: true };
        }
        if (method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD) {
          return { claimed: false, hasQueuedPrompt: true };
        }
        return {};
      });

      await expect(
        prompt({
          version: 1,
          sessionId: 'test-session-id',
          promptId: 'queued-prompt-owner',
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });

      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: expect.stringContaining('/goal set'),
            }),
          }),
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            content: expect.objectContaining({
              text: expect.stringContaining(objective),
            }),
          }),
        }),
      );
    });

    it('does not start a Goal when a guard continuation stops on an unreliable queue drain', async () => {
      const internals = session as unknown as {
        todoStopGuard: DaemonTodoStopGuard;
      };
      vi.spyOn(internals.todoStopGuard, 'decide').mockReturnValue({
        kind: 'continue',
        attempt: 1,
        maxAttempts: 2,
        unfinishedCount: 1,
      });
      // A response with no 'messages'/'items' payload fails validation, so
      // the continuation is skipped without ever consulting the claim.
      vi.mocked(mockClient.extMethod).mockImplementation(async () => ({}));

      await expect(prompt()).resolves.toEqual({ stopReason: 'end_turn' });

      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: expect.stringContaining('/goal set'),
            }),
          }),
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            content: expect.objectContaining({
              text: expect.stringContaining(objective),
            }),
          }),
        }),
      );
    });

    it('does not start a Goal when a queued prompt claims the guard continuation at send time', async () => {
      const internals = session as unknown as {
        todoStopGuard: DaemonTodoStopGuard;
      };
      vi.spyOn(internals.todoStopGuard, 'decide').mockReturnValue({
        kind: 'continue',
        attempt: 1,
        maxAttempts: 2,
        unfinishedCount: 1,
      });
      vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
        if (method === 'craft/drainMidTurnQueue') {
          return { messages: [], hasQueuedPrompt: false };
        }
        if (method === TODO_STOP_GUARD_CONTINUATION_CLAIM_METHOD) {
          return { claimed: false, hasQueuedPrompt: true };
        }
        return {};
      });

      await expect(
        prompt({
          version: 1,
          sessionId: 'test-session-id',
          promptId: 'queued-prompt-owner',
        }),
      ).resolves.toEqual({ stopReason: 'end_turn' });

      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: expect.stringContaining('/goal set'),
            }),
          }),
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            content: expect.objectContaining({
              text: expect.stringContaining(objective),
            }),
          }),
        }),
      );
    });

    it('does not start a Goal when the Todo Stop Guard is exhausted', async () => {
      const internals = session as unknown as {
        todoStopGuard: {
          decide: () => {
            kind: 'exhausted';
            attempt: number;
            maxAttempts: number;
            unfinishedCount: number;
          };
        };
      };
      vi.spyOn(internals.todoStopGuard, 'decide').mockReturnValue({
        kind: 'exhausted',
        attempt: 2,
        maxAttempts: 2,
        unfinishedCount: 1,
      });

      await expect(prompt()).resolves.toEqual({ stopReason: 'end_turn' });

      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
    });

    it('discards approval when new user input is injected after the tool result', async () => {
      vi.mocked(mockClient.extMethod).mockImplementation(async (method) => {
        if (method === 'craft/drainMidTurnQueue' && pending) {
          return {
            messages: ['Do not start yet; first change the objective.'],
            hasQueuedPrompt: false,
          };
        }
        return { messages: [], hasQueuedPrompt: false };
      });

      await prompt();

      expect(mockConfig.setPendingGoalProposal).toHaveBeenCalledOnce();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(pending).toBeUndefined();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'agent_message_chunk',
            content: expect.objectContaining({
              text: expect.stringContaining('/goal set'),
            }),
          }),
        }),
      );
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            content: expect.objectContaining({
              text: expect.stringContaining(objective),
            }),
          }),
        }),
      );
    });

    it('refuses proposals from an automatic background-notification turn', async () => {
      mockChat.sendMessageStream = vi
        .fn()
        .mockResolvedValueOnce(createEmptyStream())
        .mockResolvedValueOnce(proposalStream())
        .mockImplementation(async () => createEmptyStream());
      await prompt();
      const notify = mockBackgroundTaskRegistry.setNotificationCallback.mock
        .calls[0][0] as (
        displayText: string,
        modelText: string,
        meta: { agentId: string; status: string; toolUseId?: string },
      ) => void;
      notify('Background work finished', '<task-notification />', {
        agentId: 'background-agent',
        status: 'completed',
      });
      await vi.waitFor(() =>
        expect(mockClient.extNotification).toHaveBeenCalledWith(
          '_qwencode/end_turn',
          expect.objectContaining({ source: 'background_notification' }),
        ),
      );
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(mockConfig.setPendingGoalProposal).not.toHaveBeenCalled();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
      expect(mockClient.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            content: expect.arrayContaining([
              expect.objectContaining({
                content: expect.objectContaining({
                  text: expect.stringContaining('/goal set'),
                }),
              }),
            ]),
          }),
        }),
      );
    });

    it('refuses a prompt without a trusted approval responder', async () => {
      await session.prompt({
        sessionId: 'test-session-id',
        prompt: [{ type: 'text', text: 'Draft a Goal.' }],
      });
      expect(mockClient.requestPermission).not.toHaveBeenCalled();
      expect(mockConfig.setPendingGoalProposal).not.toHaveBeenCalled();
      expect(mockGoalRuntime.dispatch).not.toHaveBeenCalled();
    });
  });
});
